const express = require('express');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── KIE helpers ──
const KIE_BASE = 'https://api.kie.ai/api/v1';
function kieKey() {
  return process.env.KIE_AI_API_KEY || '';
}
function kieHeaders(key) {
  return { 'Authorization': 'Bearer ' + (key || kieKey()), 'Content-Type': 'application/json' };
}
async function kiePost(endpoint, body, key) {
  const r = await fetch(KIE_BASE + endpoint, { method: 'POST', headers: kieHeaders(key), body: JSON.stringify(body) });
  return r.json();
}
async function kieGet(endpoint, key) {
  const r = await fetch(KIE_BASE + endpoint, { headers: kieHeaders(key) });
  return r.json();
}

// Health check
app.get('/api/status', (req, res) => {
  res.json({ ok: true, project: 'ассистент-new', port: PORT });
});

// ── KIE: проверка ключа ──
app.post('/api/kie/check-key', async (req, res) => {
  const key = req.body?.key;
  if (!key) return res.json({ ok: false, error: 'Ключ не передан' });
  try {
    const data = await kieGet('/chat/credit', key);
    if (data?.code === 401 || data?.code === 403) {
      return res.json({ ok: false, error: data?.msg || 'Неверный ключ' });
    }
    res.json({ ok: true, credits: data?.data?.credits ?? data?.credits ?? null });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── KIE: баланс ──
app.get('/api/kie/balance', async (req, res) => {
  try {
    const data = await kieGet('/chat/credit');
    if (data?.code === 401) return res.json({ ok: false, error: 'Неверный ключ' });
    res.json({ ok: true, credits: data?.data?.credits ?? data?.credits ?? null });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── KIE: сохранить ключ в .env ──
app.post('/api/kie/save-key', async (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.json({ ok: false, error: 'Ключ пуст' });
  try {
    const envPath = path.join(__dirname, '.env');
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch {}
    if (content.match(/^KIE_AI_API_KEY=.*/m)) {
      content = content.replace(/^KIE_AI_API_KEY=.*/m, `KIE_AI_API_KEY=${key}`);
    } else {
      content += (content.endsWith('\n') ? '' : '\n') + `KIE_AI_API_KEY=${key}\n`;
    }
    fs.writeFileSync(envPath, content);
    process.env.KIE_AI_API_KEY = key;
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── KIE: загрузка изображения (base64 → URL через KIE) ──
app.post('/api/kie/upload-image', async (req, res) => {
  const { base64, filename = 'image.jpg' } = req.body || {};
  if (!base64) return res.json({ ok: false, error: 'base64 не передан' });
  try {
    // KIE принимает multipart — используем fetch с FormData через Buffer
    const { FormData, File } = await import('formdata-node');
    const buf = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    const form = new FormData();
    form.set('file', new File([buf], filename, { type: 'image/jpeg' }));
    const r = await fetch(KIE_BASE + '/upload', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + kieKey() },
      body: form
    });
    const data = await r.json();
    if (data?.data?.url) return res.json({ ok: true, url: data.data.url });
    res.json({ ok: false, error: data?.msg || 'Ошибка загрузки' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Enhance prompt via Claude (Anthropic direct or OpenRouter) ──

function buildTimeMarkers(duration) {
  const d = parseInt(duration) || 5;
  if (d <= 4)  return `0–${d}s: [full scene]`;
  if (d <= 6)  return `0–2s: [opening], 2–${d}s: [main action]`;
  if (d <= 8)  return `0–2s: [opening], 2–5s: [main action], 5–${d}s: [closing/payoff]`;
  if (d <= 10) return `0–3s: [opening/establish], 3–6s: [main action], 6–${d}s: [climax/payoff]`;
  if (d <= 15) return `0–3s: [opening], 3–7s: [build-up], 7–11s: [climax], 11–${d}s: [resolution]`;
  return `0–4s: [opening], 4–8s: [build-up], 8–13s: [climax], 13–${d}s: [resolution/payoff]`;
}

const ENHANCE_SYSTEM = {
  seedance: (duration, format) => `You are an expert video prompt engineer for Seedance 2.0 (ByteDance).
The video is ${duration} seconds long. Format: ${format}.
Rules:
- Open FIRST with the shot structure for this format:
  • cinematic/ad: "Montage, multi-shot Hollywood production, don't use one angle, cinematic lighting, photorealistic, 35mm film, ARRI ALEXA aesthetic"
  • viral: "Fast-cut viral social media video, high-energy multi-shot, trending aesthetic, dopamine-paced editing"
  • cartoon: "Animated cartoon style, vibrant colors, stylized characters, smooth 2D animation"
  • documentary: "Single continuous observational shot, naturalistic handheld, documentary realism"
- Use EXACT time markers for ${duration}s: ${buildTimeMarkers(duration)}
- Use cinematic camera language: dolly, tilt, arc, crane, handheld, rack focus, whip pan
- Describe lighting, textures, atmosphere in vivid detail
- Add audio description LAST: ambient sounds, music tone, SFX
- End with style tags: "photorealistic, 35mm film grain, ARRI ALEXA aesthetic, no 3D, no cartoon" (skip for cartoon format)
- Output ONLY the prompt text in English. No explanations. No intro lines.`,

  veo: (duration, format) => `You are an expert video prompt engineer for Google Veo 3.
The video is ${duration} seconds long (Veo supports 4, 6, or 8 seconds — use closest). Format: ${format}.
Rules:
- CRITICAL: ZERO Russian or Cyrillic text allowed inside the video frame. No Russian signs, labels, subtitles, banners.
- English infographics, charts, data visualizations ARE allowed and encouraged (especially for documentary/ad)
- Veo generates native audio — describe the soundscape explicitly and in detail
- Specify precise camera movement: "slow pan left", "zoom out from close-up to wide", "static locked shot", "handheld follow"
- Fit all action into exactly ${duration} seconds — be specific about pacing
- For format "${format}": ${
    format === 'viral' ? 'fast paced, quick visual hook in first 2s, high energy' :
    format === 'cartoon' ? 'animated style, bright colors, describe as animation' :
    format === 'documentary' ? 'observational, authentic, real-world setting' :
    format === 'ad' ? 'product-focused, aspirational, clean and polished' :
    'cinematic quality, dramatic lighting, professional'
  }
- Describe visual style, color palette, lighting explicitly
- Output ONLY the prompt text in English. No explanations.`,

  omni: (duration, format) => `You are an expert video prompt engineer for Google Gemini Omni video.
The video is ${duration} seconds long. Format: ${format}.
Rules:
- Describe scene opening with rich visual detail: colors, textures, exact lighting conditions
- State camera angle and movement explicitly at the start
- Add time-based progression for this ${duration}s clip: ${buildTimeMarkers(duration)}
- For format "${format}": ${
    format === 'viral' ? 'eye-catching hook, high visual contrast, trending aesthetic' :
    format === 'cartoon' ? 'animation style, stylized visuals, bright palette' :
    format === 'documentary' ? 'naturalistic realism, observational perspective' :
    format === 'ad' ? 'product spotlight, clean composition, aspirational' :
    'cinematic depth, professional lighting'
  }
- English text overlays are allowed if they add value
- Describe mood, emotional tone, atmosphere
- Output ONLY the prompt text in English. No explanations.`,
};

const FORMAT_NAMES = {
  cinematic: 'Cinematic', viral: 'Viral Social Media', cartoon: 'Animated Cartoon',
  documentary: 'Documentary', ad: 'Advertisement',
};

app.post('/api/enhance-prompt', async (req, res) => {
  try {
    const { prompt, model = 'seedance', format = 'cinematic', duration = 5,
            hasFirstFrame = false, hasLastFrame = false } = req.body;
    if (!prompt) return res.json({ ok: false, error: 'prompt пуст' });

    const anthropicKey  = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY || '';
    const openrouterKey = req.headers['x-openrouter-key'] || process.env.OPENROUTER_API_KEY || '';

    if (!anthropicKey && !openrouterKey) {
      return res.json({ ok: false, error: 'Добавьте Anthropic или OpenRouter API ключ в настройках ⚙️' });
    }

    const systemFn = ENHANCE_SYSTEM[model] || ENHANCE_SYSTEM.seedance;
    const systemPrompt = systemFn(duration, format);
    const modelName = model === 'veo' ? 'Veo 3' : model === 'omni' ? 'Gemini Omni' : 'Seedance 2.0';

    const refLines = [];
    if (hasFirstFrame) refLines.push('- FIRST FRAME reference image is provided (the video starts from this image — describe how the scene opens FROM this visual)');
    if (hasLastFrame)  refLines.push('- LAST FRAME reference image is provided (the video ends ON this image — describe how the scene transitions INTO this final visual)');
    const refNote = refLines.length > 0
      ? `\nReference images:\n${refLines.join('\n')}\nIMPORTANT: Integrate reference image instructions naturally into the prompt using "[reference_image: first_frame]" or "[reference_image: last_frame]" bracket tags where appropriate.`
      : '';

    const userMsg = `Original idea (may be in Russian or any language): "${prompt}"

Model: ${modelName}
Duration: ${duration} seconds
Format: ${FORMAT_NAMES[format] || format}${refNote}

Rewrite into an optimized ${modelName} video generation prompt. Include precise time markers for ${duration}s. Output only the prompt.`;

    let enhanced = '';

    if (anthropicKey) {
      // Direct Anthropic API
      const client = new Anthropic({ apiKey: anthropicKey });
      const message = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
      });
      enhanced = message.content[0]?.text?.trim() || '';
    } else {
      // OpenRouter fallback (OpenAI-compatible)
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + openrouterKey,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'AI Assistant',
        },
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4-5',
          max_tokens: 1200,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userMsg },
          ],
        }),
      });
      const data = await r.json();
      enhanced = data.choices?.[0]?.message?.content?.trim() || '';
      if (!enhanced && data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    }

    res.json({ ok: true, enhanced });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── KIE: логи задач (история) ──
app.get('/api/kie/logs', async (req, res) => {
  try {
    const reqKey = req.headers['x-kie-key'] || kieKey();
    if (!reqKey) return res.json({ ok: false, error: 'KIE API ключ не задан' });
    // KIE logs endpoint: /jobs/records — page=1, pageSize=20
    const data = await kieGet('/jobs/records?page=1&pageSize=50', reqKey);
    if (data?.code === 401 || data?.code === 403) return res.json({ ok: false, error: 'Неверный ключ' });
    const logs = data?.data?.list || data?.data?.records || data?.data || [];
    res.json({ ok: true, logs: Array.isArray(logs) ? logs : [] });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── KIE: создать задачу генерации видео (Seedance 2.0) ──
app.post('/api/videogen', async (req, res) => {
  try {
    const reqKey = req.headers['x-kie-key'] || kieKey();
    const { prompt, quality = 'fast', resolution = '720p', aspect_ratio = '16:9',
            duration = 5, image_url, end_image_url, model: modelType = 'seedance' } = req.body;
    if (!prompt) return res.json({ ok: false, error: 'prompt обязателен' });
    if (!reqKey) return res.json({ ok: false, error: 'KIE API ключ не задан' });

    // Model ID mapping (verified from KIE playground pages)
    const MODEL_IDS = {
      seedance_pro:  'bytedance/seedance-2',
      seedance_fast: 'bytedance/seedance-2-fast',
      veo:           'veo-3-1',
      omni_video:    'gemini-omni-video',
      omni_audio:    'gemini-omni-audio',
      omni_char:     'gemini-omni-character',
    };
    let modelId;
    if (modelType === 'veo')  modelId = MODEL_IDS.veo;
    else if (modelType === 'omni') modelId = MODEL_IDS.omni_video;
    else modelId = quality === 'pro' ? MODEL_IDS.seedance_pro : MODEL_IDS.seedance_fast;

    const input = { prompt, resolution, aspect_ratio, duration: parseInt(duration), nsfw_checker: true };
    if (image_url) input.first_frame_url = image_url;
    if (end_image_url) input.last_frame_url = end_image_url;
    const data = await kiePost('/jobs/createTask', { model: modelId, input }, reqKey);
    if (data.code !== 200 && !data.data?.taskId) {
      return res.json({ ok: false, error: data.msg || JSON.stringify(data) });
    }
    res.json({ ok: true, taskId: data.data?.taskId || data.taskId });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── KIE: статус задачи ──
app.get('/api/videogen/status/:taskId', async (req, res) => {
  try {
    const reqKey = req.headers['x-kie-key'] || kieKey();
    const data = await kieGet('/jobs/recordInfo?taskId=' + req.params.taskId, reqKey);
    const task = data.data || data;
    if (task.state === 'success') {
      let resultUrls = [];
      try { resultUrls = JSON.parse(task.resultJson || '{}').resultUrls || []; } catch {}
      return res.json({ status: 'success', url: resultUrls[0] || '', credits: task.creditsConsumed, costTime: task.costTime });
    }
    if (task.state === 'fail') return res.json({ status: 'failed', error: task.failMsg || 'Ошибка генерации' });
    res.json({ status: 'pending', state: task.state });
  } catch (e) {
    res.json({ status: 'error', error: e.message });
  }
});

app.listen(PORT, () => {
  // Load .env if exists
  try {
    const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    env.split('\n').forEach(line => {
      const [k, ...v] = line.split('=');
      if (k && v.length) process.env[k.trim()] = v.join('=').trim();
    });
  } catch {}
  console.log(`Ассистент запущен: http://localhost:${PORT}`);
});
