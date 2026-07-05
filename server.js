const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');

const FFMPEG = path.join(__dirname, 'node_modules/ffmpeg-static/ffmpeg');

// ── multer for cut uploads ──
const cutStorage = multer.diskStorage({
  destination(req, file, cb) {
    const projectId = req.body?.projectId || req.query?.projectId || ('proj_' + Date.now());
    req._cutProjectId = projectId;
    const dir = path.join(__dirname, 'data', 'cut-uploads', projectId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, 'original' + ext);
  }
});
const cutUpload = multer({ storage: cutStorage });

const app = express();
const PORT = process.env.PORT || 3000;

// ── Local video gen logs ──
const LOCAL_LOGS_FILE = path.join(__dirname, 'data', 'videogen-logs.json');
function localLogsRead() {
  try { return JSON.parse(fs.readFileSync(LOCAL_LOGS_FILE, 'utf8')); } catch { return []; }
}
function localLogAppend(entry) {
  try {
    fs.mkdirSync(path.dirname(LOCAL_LOGS_FILE), { recursive: true });
    const logs = localLogsRead();
    logs.unshift(entry); // newest first
    if (logs.length > 200) logs.length = 200;
    fs.writeFileSync(LOCAL_LOGS_FILE, JSON.stringify(logs, null, 2));
  } catch {}
}
function localLogUpdate(taskId, patch) {
  try {
    const logs = localLogsRead();
    const idx = logs.findIndex(l => l.taskId === taskId);
    if (idx !== -1) { Object.assign(logs[idx], patch); fs.writeFileSync(LOCAL_LOGS_FILE, JSON.stringify(logs, null, 2)); }
  } catch {}
}
function localLogDelete(taskId) {
  try {
    const logs = localLogsRead().filter(l => l.taskId !== taskId);
    fs.writeFileSync(LOCAL_LOGS_FILE, JSON.stringify(logs, null, 2));
  } catch {}
}

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
    // GET /chat/credit возвращает { code, msg, data: <number> } — data сразу число,
    // а не объект с полем credits (см. docs.kie.ai/common-api/get-account-credits)
    res.json({ ok: true, credits: typeof data?.data === 'number' ? data.data : (data?.data?.credits ?? null) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── KIE: баланс ──
app.get('/api/kie/balance', async (req, res) => {
  try {
    const reqKey = req.headers['x-kie-key'] || kieKey();
    if (!reqKey) return res.json({ ok: false, error: 'Ключ не задан' });
    const data = await kieGet('/chat/credit', reqKey);
    if (data?.code === 401) return res.json({ ok: false, error: 'Неверный ключ' });
    res.json({ ok: true, credits: typeof data?.data === 'number' ? data.data : (data?.data?.credits ?? null) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── OpenRouter: баланс (GET /api/v1/credits → { data: { total_credits, total_usage } }) ──
app.get('/api/openrouter/balance', async (req, res) => {
  try {
    const reqKey = req.headers['x-openrouter-key'];
    if (!reqKey) return res.json({ ok: false, error: 'Ключ не задан' });
    const r = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { 'Authorization': 'Bearer ' + reqKey }
    });
    const data = await r.json();
    if (data?.error) return res.json({ ok: false, error: data.error.message || 'Неверный ключ' });
    const total = data?.data?.total_credits;
    const used = data?.data?.total_usage;
    if (typeof total !== 'number' || typeof used !== 'number') {
      return res.json({ ok: false, error: 'Неожиданный формат ответа OpenRouter' });
    }
    res.json({ ok: true, credits: Math.max(0, total - used) });
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

// ── Shared: привести вход (data URI / raw base64 / локальный путь / http URL) к data URI ──
function localFileFromUrl(u) {
  if (u.startsWith('/vref-processed/')) return path.join(__dirname, 'data', 'vref-processed', path.basename(u));
  if (u.startsWith('/cut-files/')) return path.join(__dirname, 'data', 'cut-uploads', path.basename(u));
  return null;
}
async function resolveImageInput(input) {
  if (!input || typeof input !== 'string' || input.startsWith('data:')) return input;
  const lf = localFileFromUrl(input);
  if (lf && fs.existsSync(lf)) {
    const ext = path.extname(lf).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,` + fs.readFileSync(lf).toString('base64');
  }
  if (/^https?:\/\//i.test(input)) {
    const r = await fetch(input);
    if (!r.ok) throw new Error('Не удалось скачать изображение: HTTP ' + r.status);
    const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
    return `data:${ct};base64,` + Buffer.from(await r.arrayBuffer()).toString('base64');
  }
  return input; // raw base64
}

// ── Shared: загрузка base64 на KIE, возвращает URL ──
// Актуальный эндпоинт (проверено на docs.kie.ai/file-upload-api/upload-file-base-64,
// старый multipart /api/v1/upload отдаёт 404 — KIE его убрали)
async function kieUploadBase64(base64, reqKey, filename = 'image.jpg') {
  const r = await fetch('https://kieai.redpandaai.co/api/file-base64-upload', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + reqKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64Data: base64, uploadPath: 'images/videogen', fileName: filename })
  });
  const data = await r.json();
  if (data?.data?.downloadUrl) return data.data.downloadUrl;
  throw new Error(data?.msg || JSON.stringify(data));
}

// ── KIE: загрузка изображения (base64 → URL через KIE) ──
app.post('/api/kie/upload-image', async (req, res) => {
  const { base64, filename = 'image.jpg' } = req.body || {};
  if (!base64) return res.json({ ok: false, error: 'base64 не передан' });
  const reqKey = req.headers['x-kie-key'] || kieKey();
  if (!reqKey) return res.json({ ok: false, error: 'KIE API ключ не задан' });
  try {
    const resolved = await resolveImageInput(base64);
    const url = await kieUploadBase64(resolved, reqKey, filename);
    return res.json({ ok: true, url });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── GPT-4 Vision: анализ фото товара ──
app.post('/api/analyze-image', async (req, res) => {
  try {
    const { base64, openaiKey } = req.body || {};
    const key = openaiKey || process.env.OPENAI_API_KEY || '';
    if (!base64) return res.json({ ok: false, error: 'base64 не передан' });
    if (!key) return res.json({ ok: false, error: 'Нужен OpenAI API ключ' });

    // Принимает http(s)-URL, локальный путь библиотеки (/vref-processed/...) или base64
    const dataUrl = /^https?:\/\//.test(base64) ? base64 : await resolveImageInput(base64);

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analyze this product image in detail for use as a video generation reference.
Describe in English:
1. Product type and name
2. Exact colors (primary, secondary, accents)
3. Materials and textures visible
4. Design details, patterns, logos, text
5. Shape, dimensions impression, style
6. Any unique distinguishing features
Be specific and detailed. Focus on visual details that must be preserved in video generation.
Output ONLY the description, no intro phrases.`
            },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }
          ]
        }]
      })
    });
    const data = await r.json();
    if (data.error) return res.json({ ok: false, error: data.error.message });
    const description = data.choices?.[0]?.message?.content?.trim() || '';
    res.json({ ok: true, description });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── OpenAI image editing: апскейл / мультиракурс ──
const VREF_PROCESSED_DIR = path.join(__dirname, 'data', 'vref-processed');
if (!fs.existsSync(VREF_PROCESSED_DIR)) fs.mkdirSync(VREF_PROCESSED_DIR, { recursive: true });
app.use('/vref-processed/', express.static(VREF_PROCESSED_DIR));

async function openaiImageEdit(images, prompt, openaiKey, size = '1024x1024', preferHighRes = false) {
  const { Blob } = require('buffer');
  // images может быть одной base64-строкой (старые вызовы) или массивом — для
  // мультиракурса из нескольких референсов сразу
  const toBlob = (base64) => {
    const mimeMatch = base64.match(/^data:([^;]+);base64,/);
    const mime = mimeMatch?.[1] || 'image/jpeg';
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    const buf = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    // OpenAI edits API requires image < 4MB
    if (buf.length > 3.9 * 1024 * 1024) throw new Error('Изображение слишком большое (>4MB). Сожмите перед обработкой.');
    return { blob: new Blob([buf], { type: mime }), ext };
  };
  const imageList = (Array.isArray(images) ? images : [images]).map(toBlob);

  const tryEdit = async (model, list, sz, extraParams = {}) => {
    const form = new FormData();
    // OpenAI ожидает повторяющееся поле image[] при нескольких картинках
    list.forEach(({ blob, ext }, i) => form.append(list.length > 1 ? 'image[]' : 'image', blob, `image${i}.${ext}`));
    form.append('prompt', prompt.slice(0, model === 'dall-e-2' ? 1000 : 32000));
    form.append('model', model);
    form.append('n', '1');
    form.append('size', sz);
    // dall-e-2 needs response_format; gpt-image-1/2 do NOT accept it
    if (model === 'dall-e-2') form.append('response_format', 'b64_json');
    Object.entries(extraParams).forEach(([k, v]) => form.append(k, v));
    const r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + openaiKey },
      body: form
    });
    return { r, data: await r.json() };
  };

  let r, data;
  // gpt-image-2 (апрель 2026) — единственная модель с честным 4K; пробуем её первой,
  // только когда запрошено высокое разрешение. При любой ошибке (модель недоступна на
  // аккаунте, другой формат ответа и т.п.) откатываемся на проверенный gpt-image-1.
  if (preferHighRes) {
    ({ r, data } = await tryEdit('gpt-image-2', imageList, '3840x2160'));
  }
  if (!preferHighRes || data?.error) {
    ({ r, data } = await tryEdit('gpt-image-1', imageList, size));
  }
  // dall-e-2 принимает только одно исходное изображение — фолбэк только на первом
  if (data.error) {
    ({ r, data } = await tryEdit('dall-e-2', imageList.slice(0, 1), '1024x1024'));
  }
  if (data.error) throw new Error(data.error.message);
  const b64 = data.data?.[0]?.b64_json || data.data?.[0]?.url;
  if (!b64) throw new Error('Нет данных изображения в ответе: ' + JSON.stringify(data).slice(0, 200));
  // If URL returned (dall-e-2 default), fetch it
  let imgBuf;
  if (b64.startsWith('http')) {
    const ir = await fetch(b64);
    imgBuf = Buffer.from(await ir.arrayBuffer());
  } else {
    imgBuf = Buffer.from(b64, 'base64');
  }
  const filename = Date.now() + '_' + Math.random().toString(36).slice(2) + '.png';
  fs.writeFileSync(path.join(VREF_PROCESSED_DIR, filename), imgBuf);
  return '/vref-processed/' + filename;
}

app.post('/api/kie/upscale-image', async (req, res) => {
  try {
    const { base64, openaiKey: clientOpenaiKey } = req.body || {};
    const openaiKey = clientOpenaiKey || process.env.OPENAI_API_KEY || '';
    if (!base64) return res.json({ ok: false, error: 'base64 не передан' });
    if (!openaiKey) return res.json({ ok: false, error: 'Нужен OpenAI API ключ в настройках' });

    const url = await openaiImageEdit(
      await resolveImageInput(base64),
      'Upscale and enhance this product image to maximum quality. Preserve every detail exactly — colors, textures, patterns, logos, composition. Make it sharper and cleaner. Do not change or add anything.',
      openaiKey, '1024x1024'
    );
    res.json({ ok: true, url });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/kie/multiangle-image', async (req, res) => {
  try {
    const { base64, openaiKey: clientOpenaiKey, productDescription = '' } = req.body || {};
    const openaiKey = clientOpenaiKey || process.env.OPENAI_API_KEY || '';
    if (!base64) return res.json({ ok: false, error: 'base64 не передан' });
    if (!openaiKey) return res.json({ ok: false, error: 'Нужен OpenAI API ключ в настройках' });

    const desc = productDescription ? ` Product details: ${productDescription.slice(0, 300)}.` : '';
    const url = await openaiImageEdit(
      await resolveImageInput(base64),
      `Create a product reference sheet showing this exact product from 4 angles arranged in a 2x2 grid: front view (top-left), right side view (top-right), back view (bottom-left), 45-degree angle view (bottom-right). Clean white background, professional studio lighting, product photography style.${desc} Preserve all product details, colors, textures, logos exactly.`,
      openaiKey, '1024x1024'
    );
    res.json({ ok: true, url });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Мультиракурс из НЕСКОЛЬКИХ загруженных референсов сразу (first/last frame формы
// генерации видео) — не из одной библиотечной карточки, а комбинируя все переданные
// фото в один референс-лист. Пробуем честный 4K через gpt-image-2 (апрель 2026),
// с откатом на gpt-image-1 (1536x1024), если модель недоступна на аккаунте.
app.post('/api/kie/multiangle-multi', async (req, res) => {
  try {
    const { images, openaiKey: clientOpenaiKey, productDescription = '' } = req.body || {};
    const openaiKey = clientOpenaiKey || process.env.OPENAI_API_KEY || '';
    if (!Array.isArray(images) || !images.length) return res.json({ ok: false, error: 'Нужно хотя бы одно референсное изображение' });
    if (!openaiKey) return res.json({ ok: false, error: 'Нужен OpenAI API ключ в настройках' });

    const resolved = await Promise.all(images.slice(0, 6).map(img => resolveImageInput(img)));
    const desc = productDescription ? ` Product details: ${productDescription.slice(0, 300)}.` : '';
    const multiNote = resolved.length > 1 ? ' These are multiple reference photos of the SAME exact product from different angles/contexts — use all of them together to accurately reconstruct its true appearance.' : '';
    const url = await openaiImageEdit(
      resolved,
      `Using the provided reference photo(s), create a single product reference sheet showing this exact product from 4 angles arranged in a 2x2 grid: front view (top-left), right side view (top-right), back view (bottom-left), 45-degree angle view (bottom-right). Clean white background, professional studio lighting, product photography style.${multiNote}${desc} Preserve all product details, colors, textures, logos exactly.`,
      openaiKey, '1536x1024', true
    );
    res.json({ ok: true, url });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Загрузка произвольной картинки на диск, без обращения к OpenAI/KIE (для аутро и т.п.) ──
// Хранить такие картинки как base64 в localStorage нельзя — на этом уже ловили
// QuotaExceededError (см. коммит "fix localStorage quota") — поэтому сразу на диск.
app.post('/api/upload-image', (req, res) => {
  try {
    const { base64 } = req.body || {};
    if (!base64) return res.json({ ok: false, error: 'base64 не передан' });
    const mimeMatch = base64.match(/^data:([^;]+);base64,/);
    const mime = mimeMatch?.[1] || 'image/jpeg';
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    const buf = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    const filename = Date.now() + '_' + Math.random().toString(36).slice(2) + '.' + ext;
    fs.writeFileSync(path.join(VREF_PROCESSED_DIR, filename), buf);
    res.json({ ok: true, url: '/vref-processed/' + filename });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Wildberries: импорт карточки товара по ссылке (для видео-генерации) ──
const WB_PRODUCTS_FILE = path.join(__dirname, 'data', 'wb-products.json');
function wbProductsRead() {
  try { return JSON.parse(fs.readFileSync(WB_PRODUCTS_FILE, 'utf8')); } catch { return []; }
}
function wbProductsWrite(list) {
  fs.mkdirSync(path.dirname(WB_PRODUCTS_FILE), { recursive: true });
  fs.writeFileSync(WB_PRODUCTS_FILE, JSON.stringify(list, null, 2));
}
function wbExtractNmId(input) {
  const s = String(input || '').trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = s.match(/(?:catalog\/|[?&]nm=)(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
// WB шардирует товары по basket-NN.wbbasket.ru без официального способа узнать номер
// по nmId — пробуем хосты параллельно и берём первый, где реально есть карточка.
async function wbResolveBasket(nmId) {
  const vol = Math.floor(nmId / 100000);
  const part = Math.floor(nmId / 1000);
  // WB постоянно добавляет новые basket-хосты по мере роста (на момент проверки дошло
  // до basket-46) — берём запас, чтобы диапазон не протухал за пару недель.
  const results = await Promise.allSettled(
    Array.from({ length: 60 }, (_, i) => {
      const base = `https://basket-${String(i + 1).padStart(2, '0')}.wbbasket.ru/vol${vol}/part${part}/${nmId}`;
      return fetch(base + '/info/ru/card.json', { method: 'HEAD' }).then(r => (r.ok ? base : Promise.reject()));
    })
  );
  const found = results.find(r => r.status === 'fulfilled');
  if (!found) throw new Error('Не удалось найти карточку товара на CDN Wildberries (проверьте ссылку или товар снят с продажи)');
  return found.value;
}
async function wbFetchCard(url) {
  const nmId = wbExtractNmId(url);
  if (!nmId) throw new Error('Не удалось распознать артикул в ссылке');
  const base = await wbResolveBasket(nmId);
  // Один повтор на случай кратковременного сетевого сбоя сразу после 60 параллельных
  // проверок хостов в wbResolveBasket()
  let cardRes;
  try {
    cardRes = await fetch(base + '/info/ru/card.json');
  } catch {
    cardRes = await fetch(base + '/info/ru/card.json');
  }
  if (!cardRes.ok) throw new Error('Карточка товара не найдена (HTTP ' + cardRes.status + ')');
  const card = await cardRes.json();
  const photoCount = card?.media?.photo_count || 0;
  const images = [];
  for (let i = 1; i <= Math.min(photoCount, 10); i++) images.push(`${base}/images/big/${i}.webp`);
  return {
    nmId,
    name: card.imt_name || '',
    description: card.description || '',
    characteristics: (card.options || []).map(o => ({ name: o.name, value: o.value })),
    vendorCode: card.vendor_code || '',
    category: card.subj_name || '',
    images,
    url: `https://www.wildberries.ru/catalog/${nmId}/detail.aspx`,
  };
}

app.get('/api/wb/products', (req, res) => {
  const { projectId } = req.query;
  const all = wbProductsRead();
  res.json({ ok: true, products: projectId ? all.filter(p => p.projectId === projectId) : all });
});

app.post('/api/wb/products', async (req, res) => {
  try {
    const { projectId, url, name } = req.body || {};
    if (!projectId) return res.json({ ok: false, error: 'projectId обязателен' });
    let card;
    if (url) {
      card = { type: 'wb', ...(await wbFetchCard(url)) };
    } else if (name && name.trim()) {
      // Кастомный под-проект (услуга/товар без карточки WB) — просто именованная сущность
      card = { type: 'custom', name: name.trim(), description: '', characteristics: [], images: [], url: null, nmId: null };
    } else {
      return res.json({ ok: false, error: 'Нужна ссылка или название' });
    }
    const entry = { id: 'wb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), projectId, addedAt: new Date().toISOString(), ...card };
    const list = wbProductsRead();
    list.unshift(entry);
    wbProductsWrite(list);
    res.json({ ok: true, product: entry });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.delete('/api/wb/products/:id', (req, res) => {
  wbProductsWrite(wbProductsRead().filter(p => p.id !== req.params.id));
  res.json({ ok: true });
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

// Голос за кадром всегда стартует на 2с и заканчивается за 1-2с до конца ролика;
// длину текста считаем в словах под этот тайминг (естественный темп русской речи ~2-2.6 слов/с),
// чтобы модель не писала реплику длиннее или короче отведённого окна.
function omniVoiceoverRule(segLen) {
  const start = 2;
  const end = Math.max(start + 1, segLen - 1.5);
  const speechSec = end - start;
  const wordsLo = Math.max(1, Math.round(speechSec * 2.0));
  const wordsHi = Math.max(wordsLo, Math.round(speechSec * 2.6));
  return `AUDIO/VOICEOVER: voiceover MUST be in Russian, starting at exactly ${start}s and ending by ${end.toFixed(1)}s (1-2s before the ${segLen}s clip ends) — write it as "Голос за кадром: «...»" directly in the prompt. Keep it to ${wordsLo}-${wordsHi} Russian words total so it fits naturally at conversational pace inside that ${speechSec.toFixed(1)}s window — writing more will make it get cut off mid-sentence. Background music/SFX describe in English.`;
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
  • ugc: "Single continuous handheld selfie-style shot, raw UGC content-creator video shot on a phone front camera, imperfect framing, natural handshake, unpolished home/room/outdoor setting, no professional lighting rig or crew"
- Use EXACT time markers for ${duration}s: ${buildTimeMarkers(duration)}
- Use cinematic camera language: dolly, tilt, arc, crane, handheld, rack focus, whip pan (for ugc: keep it to natural handheld micro-movements only, no crane/dolly)
- Describe lighting, textures, atmosphere in vivid detail
${format === 'ugc' ? '- The creator talks directly to camera the whole time — genuine excited reaction, casual conversational tone, like unboxing/reviewing the product for friends; end on an engaging call-to-action (e.g. "grab yours now", "link in bio", "trust me on this one")\n' : ''}- Add audio description LAST: ambient sounds, music tone, SFX
- End with style tags: "photorealistic, 35mm film grain, ARRI ALEXA aesthetic, no 3D, no cartoon" (skip for cartoon and ugc formats — ugc should end with "shot on iPhone front camera, authentic UGC aesthetic, no cinematic grading" instead)
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
    format === 'ugc' ? 'raw handheld selfie-style UGC review/unboxing video shot on a phone front camera, creator talking directly to camera the whole time, genuine excited reaction, casual authentic home setting, imperfect natural lighting, NOT cinematic or polished; end on an engaging call-to-action' :
    'cinematic quality, dramatic lighting, professional'
  }
- Describe visual style, color palette, lighting explicitly
- Output ONLY the prompt text in English. No explanations.`,

  omni: (duration, format) => {
    const formatNote = format === 'viral' ? 'eye-catching hook, high visual contrast, trending aesthetic' :
      format === 'cartoon' ? 'animation style, stylized visuals, bright palette' :
      format === 'documentary' ? 'naturalistic realism, observational perspective' :
      format === 'ad' ? 'product spotlight, clean composition, aspirational' :
      format === 'ugc' ? 'raw handheld selfie-style UGC review/unboxing, creator talking directly to camera the whole time, genuine excited reaction, casual authentic home setting, imperfect natural lighting, NOT cinematic or polished; end on an engaging call-to-action' :
      'cinematic depth, professional lighting';
    const ugcVoiceNote = format === 'ugc' ? ' For UGC: write the creator\'s spoken lines as natural casual speech (not scripted-sounding), including the closing call-to-action line.' : '';

    if (Number(duration) === 16) {
      // 16с = два отдельных Omni-запроса по 8с, склеенные на сервере; первый кадр
      // части 2 = последний кадр части 1 (см. /api/videogen/omni16) — прошиваем это
      // в промпт как требование визуальной непрерывности между частями.
      return `You are an expert video prompt engineer for Google Gemini Omni video.
This is a 16-second video assembled from TWO separately generated 8-second Omni clips that get stitched together automatically — the first frame of Part 2 is set to the actual last frame of Part 1, so the cut must feel invisible: same pose, same environment, same lighting, action continuing exactly where Part 1 left off.
Format: ${format}.

Output EXACTLY two prompts separated by a line containing only: ===PART2===
Nothing else on that separator line, and that exact string must not appear anywhere else in the output.

Part 1 (seconds 0–8 of the story):
- Describe scene opening with rich visual detail: colors, textures, exact lighting conditions
- State camera angle and movement explicitly at the start
- Add time-based progression for this 8s segment: ${buildTimeMarkers(8)}
- End on a clear, precisely describable pose/moment — this exact frame becomes the opening of Part 2
- ${omniVoiceoverRule(8)}${ugcVoiceNote}

Part 2 (seconds 8–16 of the story, continues seamlessly from Part 1's ending frame):
- Open by re-stating the continuation frame explicitly (same subject pose, same framing, same lighting Part 1 ended on) so the model anchors to it, then progress the story forward with new action or a reveal — do not repeat Part 1's beats
- Add time-based progression treating this as its own 0–8s segment: ${buildTimeMarkers(8)}
- ${omniVoiceoverRule(8)}${ugcVoiceNote}
- End with a clear payoff / call-to-action appropriate for format "${format}"

For format "${format}" (applies to both parts): ${formatNote}
- English text overlays allowed if they add value
- Output ONLY the two prompts and the ===PART2=== separator line, in English (except Russian voiceover lines). No explanations, no "Part 1:"/"Part 2:" labels.`;
    }

    return `You are an expert video prompt engineer for Google Gemini Omni video.
The video is ${duration} seconds long. Format: ${format}.
Rules:
- Describe scene opening with rich visual detail: colors, textures, exact lighting conditions
- State camera angle and movement explicitly at the start
- Add time-based progression for this ${duration}s clip: ${buildTimeMarkers(duration)}
- For format "${format}": ${formatNote}
- ${omniVoiceoverRule(Number(duration) || 8)}${ugcVoiceNote}
- English text overlays are allowed if they add value
- Describe mood, emotional tone, atmosphere
- Output ONLY the prompt text in English (except Russian voiceover lines). No explanations.`;
  },
};

const FORMAT_NAMES = {
  cinematic: 'Cinematic', viral: 'Viral Social Media', cartoon: 'Animated Cartoon',
  documentary: 'Documentary', ad: 'Advertisement', ugc: 'UGC Creator Review',
};

// ── Придумать идею ролика (креативный концепт, не технический промпт) ──
const IDEA_SYSTEM = `You are a world-class creative director for short-form video advertising, famous for viral, attention-grabbing concepts.

Rules:
- Output ONE specific, vivid creative concept in Russian, 2–4 sentences. This is a creative BRIEF/HOOK, not a technical shot-by-shot video prompt — no camera directions, no time markers.
- The concept MUST fit the requested format:
  • viral: reference a real, currently recognizable internet/TikTok/Reels trend, meme structure or challenge format (name it specifically) and adapt it to the product
  • cinematic: recreate a short, recognizable moment/scene style from a well-known film genre (be specific — genre, mood, or a type of iconic movie scene) reimagined around the product
  • cartoon: a fun, imaginative animated short-story concept
  • documentary: a compelling mini human-interest or investigative-style documentary angle
  • ad: a classic, polished, aspirational commercial concept
  • ugc: a relatable, everyday-person story or testimonial hook
- Be concrete and inspiring — a director should get excited reading it, not generic marketing fluff.
- The idea must be realistically executable within the given duration.
- Output only the idea itself in Russian. No preamble, no headers, no quotes, no markdown.`;

app.post('/api/generate-idea', async (req, res) => {
  try {
    const { model = 'seedance', format = 'cinematic', duration = 5, productName = '' } = req.body || {};

    const anthropicKey  = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY || '';
    const openrouterKey = req.headers['x-openrouter-key'] || process.env.OPENROUTER_API_KEY || '';
    if (!anthropicKey && !openrouterKey) {
      return res.json({ ok: false, error: 'Добавьте Anthropic или OpenRouter API ключ в настройках ⚙️' });
    }

    const modelName = model === 'veo' ? 'Veo 3' : model === 'omni' ? 'Gemini Omni' : 'Seedance 2.0';
    const formatName = FORMAT_NAMES[format] || format;
    const userMsg = `Товар: ${productName ? productName : 'товар (конкретное название не указано — придумай под универсальный потребительский продукт)'}
Формат ролика: ${formatName}
Длительность: ${duration} секунд
Модель генерации: ${modelName}

Придумай одну яркую, конкретную креативную идею для короткого рекламного видео с этим товаром.`;

    let idea = '';
    if (anthropicKey) {
      const client = new Anthropic({ apiKey: anthropicKey });
      const message = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: IDEA_SYSTEM,
        messages: [{ role: 'user', content: userMsg }],
      });
      idea = message.content[0]?.text?.trim() || '';
    } else {
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
          max_tokens: 400,
          messages: [
            { role: 'system', content: IDEA_SYSTEM },
            { role: 'user', content: userMsg },
          ],
        }),
      });
      const data = await r.json();
      idea = data.choices?.[0]?.message?.content?.trim() || '';
      if (!idea && data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    }
    if (!idea) throw new Error('Пустой ответ от модели');
    res.json({ ok: true, idea });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

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

    // Промпт может содержать тег [PRODUCT REFERENCE: ...] — из анализа фото (🔍 Анализ)
    // или из карточки товара WB. При вольном пересказе идеи модель легко теряет точные
    // детали (цвет, текст на упаковке, материал), поэтому выносим их отдельно и требуем
    // сохранить дословно, а не растворять в общей формулировке.
    const productMatch = prompt.match(/\[PRODUCT REFERENCE:\s*([\s\S]*?)\]/i);
    const productNote = productMatch
      ? `\n\nEXACT PRODUCT DETAILS (from photo analysis or product card) — these specifics MUST be preserved precisely in the rewritten prompt, do not generalize, paraphrase away, or drop any of them (colors, text/logos, materials, shape, packaging):\n"${productMatch[1].trim()}"`
      : '';

    const userMsg = `Original idea (may be in Russian or any language): "${prompt}"

Model: ${modelName}
Duration: ${duration} seconds
Format: ${FORMAT_NAMES[format] || format}${refNote}${productNote}

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

// ── KIE: логи задач (история) — local + KIE merged ──
app.get('/api/kie/logs', async (req, res) => {
  const localLogs = localLogsRead();
  const reqKey = req.headers['x-kie-key'] || kieKey();

  // Auto-update status of local pending tasks
  if (reqKey) {
    const pending = localLogs.filter(l => l.state === 'processing');
    await Promise.all(pending.map(async (l) => {
      try {
        const d = await kieGet('/jobs/recordInfo?taskId=' + l.taskId, reqKey);
        const task = d.data || d;
        if (task.state === 'success' || task.state === 'fail') {
          localLogUpdate(l.taskId, {
            state: task.state,
            resultJson: task.resultJson || null,
            creditsConsumed: task.creditsConsumed,
            failMsg: task.failMsg || null,
            model: task.model || l.model,
            createdAt: task.createdAt || l.createdAt,
          });
        }
      } catch {}
    }));
  }

  const updatedLocal = localLogsRead();
  if (!reqKey) return res.json({ ok: true, logs: updatedLocal });

  try {
    const data = await kieGet('/jobs/records?page=1&pageSize=50', reqKey);
    if (data?.code === 401 || data?.code === 403) return res.json({ ok: true, logs: updatedLocal });
    const kieLogs = data?.data?.list || data?.data?.records || (Array.isArray(data?.data) ? data.data : []);
    // Local entries not yet in KIE (very recent) appear first
    const kieIds = new Set(kieLogs.map(l => l.taskId));
    const onlyLocal = updatedLocal.filter(l => !kieIds.has(l.taskId));
    res.json({ ok: true, logs: [...onlyLocal, ...kieLogs] });
  } catch (e) {
    res.json({ ok: true, logs: updatedLocal });
  }
});

// ── KIE: создать задачу генерации видео (Seedance 2.0) ──
app.post('/api/videogen', async (req, res) => {
  try {
    const reqKey = req.headers['x-kie-key'] || kieKey();
    const { prompt, quality = 'fast', resolution = '720p', aspect_ratio = '16:9',
            duration = 5, image_url, end_image_url, image_urls,
            model: modelType = 'seedance' } = req.body;
    if (!prompt) return res.json({ ok: false, error: 'prompt обязателен' });
    if (!reqKey) return res.json({ ok: false, error: 'KIE API ключ не задан' });

    // Model ID mapping (verified from docs.kie.ai/market)
    const MODEL_IDS = {
      seedance_pro:  'bytedance/seedance-2',
      seedance_fast: 'bytedance/seedance-2-fast',
      seedance_mini: 'bytedance/seedance-2-mini',
      veo:           'veo-3-1',
      omni_video:    'gemini-omni-video',
      omni_audio:    'gemini-omni-audio',
      omni_char:     'gemini-omni-character',
    };
    let modelId;
    if (modelType === 'veo')  modelId = MODEL_IDS.veo;
    else if (modelType === 'omni') modelId = MODEL_IDS.omni_video;
    else modelId = quality === 'pro' ? MODEL_IDS.seedance_pro
               : quality === 'mini' ? MODEL_IDS.seedance_mini
               : MODEL_IDS.seedance_fast;

    // Normalize resolution and duration per model
    let resolNorm = (resolution || '720p').toLowerCase();
    let dur = parseInt(duration) || 5;
    let input;

    if (modelType === 'omni') {
      // Omni (gemini-omni-video): resolution 720p/1080p/4k, duration 4/6/8/10,
      // aspect only 16:9 | 9:16, images go as image_urls array (up to 7)
      if (!['720p','1080p','4k'].includes(resolNorm)) resolNorm = '720p';
      const omniDurs = [4, 6, 8, 10];
      dur = omniDurs.reduce((prev, curr) => Math.abs(curr - dur) < Math.abs(prev - dur) ? curr : prev);
      const ar = ['16:9','9:16'].includes(aspect_ratio) ? aspect_ratio : '16:9';
      input = { prompt, resolution: resolNorm, aspect_ratio: ar, duration: String(dur) };
      const urls = [...(Array.isArray(image_urls) ? image_urls : []),
                    ...(image_url ? [image_url] : []),
                    ...(end_image_url ? [end_image_url] : [])].filter(Boolean);
      if (urls.length) input.image_urls = urls.slice(0, 7);
    } else if (modelType === 'veo') {
      // Veo: only 720p / 1080p, duration 4/6/8
      if (!['720p','1080p'].includes(resolNorm)) resolNorm = '720p';
      const veoDurs = [4, 6, 8];
      dur = veoDurs.reduce((prev, curr) => Math.abs(curr - dur) < Math.abs(prev - dur) ? curr : prev);
      input = { prompt, resolution: resolNorm, aspect_ratio, duration: String(dur), nsfw_checker: true };
      if (image_url) input.first_frame_url = image_url;
      if (end_image_url) input.last_frame_url = end_image_url;
    } else {
      // Seedance: pro (seedance-2) 480p-4k; fast/mini only 480p/720p; duration 4-15
      const allowedRes = quality === 'pro' ? ['480p','720p','1080p','4k'] : ['480p','720p'];
      if (!allowedRes.includes(resolNorm)) resolNorm = '720p';
      dur = Math.max(4, Math.min(15, dur));
      input = { prompt, resolution: resolNorm, aspect_ratio, duration: String(dur), nsfw_checker: true };
      if (image_url) input.first_frame_url = image_url;
      if (end_image_url) input.last_frame_url = end_image_url;
    }
    const data = await kiePost('/jobs/createTask', { model: modelId, input }, reqKey);
    if (data.code !== 200 && !data.data?.taskId) {
      return res.json({ ok: false, error: data.msg || JSON.stringify(data) });
    }
    const taskId = data.data?.taskId || data.taskId;
    // Save local log immediately so it appears in logs tab without delay
    localLogAppend({
      taskId,
      model: modelId,
      state: 'processing',
      createdAt: new Date().toISOString(),
      input: JSON.stringify(input),
      resultJson: null,
    });
    res.json({ ok: true, taskId });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── KIE: статус задачи ──
app.get('/api/videogen/status/:taskId', async (req, res) => {
  if (req.params.taskId.startsWith('omni16_')) return handleOmni16Status(req, res);
  try {
    const reqKey = req.headers['x-kie-key'] || kieKey();
    const data = await kieGet('/jobs/recordInfo?taskId=' + req.params.taskId, reqKey);
    const task = data.data || data;
    if (task.state === 'success') {
      let resultUrls = [];
      try { resultUrls = JSON.parse(task.resultJson || '{}').resultUrls || []; } catch {}
      localLogUpdate(req.params.taskId, { state: 'success', resultJson: task.resultJson, creditsConsumed: task.creditsConsumed });
      return res.json({ status: 'success', url: resultUrls[0] || '', credits: task.creditsConsumed, costTime: task.costTime });
    }
    if (task.state === 'fail') {
      localLogUpdate(req.params.taskId, { state: 'fail', failMsg: task.failMsg });
      return res.json({ status: 'failed', error: task.failMsg || 'Ошибка генерации' });
    }
    res.json({ status: 'pending', state: task.state });
  } catch (e) {
    res.json({ status: 'error', error: e.message });
  }
});

// ── Удалить запись задачи из локального лога (KIE запись видео не хранит — только на своём CDN) ──
app.delete('/api/videogen/logs/:taskId', (req, res) => {
  localLogDelete(req.params.taskId);
  res.json({ ok: true });
});

// ── Очистить весь локальный лог генераций (все проекты) ──
app.delete('/api/videogen/logs', (req, res) => {
  try {
    fs.mkdirSync(path.dirname(LOCAL_LOGS_FILE), { recursive: true });
    fs.writeFileSync(LOCAL_LOGS_FILE, '[]');
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Omni 16 сек = 2×8с клипа + бесшовная склейка ──
// Первый кадр второй части — последний кадр первой (для бесшовного перехода).
// Промпт от /api/enhance-prompt при duration=16 приходит с разделителем ===PART2===.
const OMNI16_DIR = path.join(__dirname, 'data', 'videogen-output');
if (!fs.existsSync(OMNI16_DIR)) fs.mkdirSync(OMNI16_DIR, { recursive: true });
app.use('/videogen-output', express.static(OMNI16_DIR));

const omni16Jobs = new Map(); // compoundId -> { phase, clip1TaskId, clip2TaskId, partB, refUrls, ... }

async function downloadToFile(url, destPath) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Не удалось скачать файл: HTTP ' + r.status);
  fs.writeFileSync(destPath, Buffer.from(await r.arrayBuffer()));
}

async function extractLastFrame(videoPath, outImagePath) {
  // Берём кадр в последних ~2с ролика, а не буквально самый последний —
  // некоторые энкодеры обрезают хвостовой GOP при seek вплотную к EOF
  await ffmpegExec(['-y', '-sseof', '-2', '-i', videoPath, '-update', '1', '-q:v', '2', '-frames:v', '1', outImagePath]);
}

async function concatVideos(clip1Path, clip2Path, outPath) {
  const listPath = outPath + '.list.txt';
  fs.writeFileSync(listPath, `file '${clip1Path}'\nfile '${clip2Path}'\n`);
  try {
    await ffmpegExec(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
  } catch {
    // Стрим-копия не сработала (разные параметры кодека между клипами) — перекодируем
    await ffmpegExec(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', outPath]);
  } finally {
    try { fs.unlinkSync(listPath); } catch {}
  }
}

async function createOmniClipTask(prompt, imageUrls, aspectRatio, resolution, reqKey) {
  const ar = ['16:9', '9:16'].includes(aspectRatio) ? aspectRatio : '16:9';
  const resolNorm = ['720p', '1080p', '4k'].includes((resolution || '720p').toLowerCase()) ? resolution.toLowerCase() : '720p';
  const input = { prompt, resolution: resolNorm, aspect_ratio: ar, duration: '8' };
  if (imageUrls?.length) input.image_urls = imageUrls.slice(0, 7);
  const data = await kiePost('/jobs/createTask', { model: 'gemini-omni-video', input }, reqKey);
  if (data.code !== 200 && !data.data?.taskId) throw new Error(data.msg || JSON.stringify(data));
  return data.data?.taskId || data.taskId;
}

app.post('/api/videogen/omni16', async (req, res) => {
  try {
    const reqKey = req.headers['x-kie-key'] || kieKey();
    const { prompt, resolution = '720p', aspect_ratio = '16:9', image_url, end_image_url, image_urls } = req.body;
    if (!prompt) return res.json({ ok: false, error: 'prompt обязателен' });
    if (!reqKey) return res.json({ ok: false, error: 'KIE API ключ не задан' });

    const [partA, partB] = prompt.includes('===PART2===')
      ? prompt.split('===PART2===').map(s => s.trim())
      : [prompt.trim(), prompt.trim()];

    const refUrls = [...(Array.isArray(image_urls) ? image_urls : []),
                      ...(image_url ? [image_url] : []),
                      ...(end_image_url ? [end_image_url] : [])].filter(Boolean);

    const clip1TaskId = await createOmniClipTask(partA, refUrls, aspect_ratio, resolution, reqKey);

    const compoundId = 'omni16_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    omni16Jobs.set(compoundId, { phase: 'clip1', clip1TaskId, partB, refUrls, aspect_ratio, resolution, reqKey });

    localLogAppend({
      taskId: compoundId,
      model: 'gemini-omni-video (16s · 2×8с склейка)',
      state: 'processing',
      createdAt: new Date().toISOString(),
      input: JSON.stringify({ prompt, resolution, aspect_ratio, duration: '16' }),
      resultJson: null,
    });

    res.json({ ok: true, taskId: compoundId });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

async function handleOmni16Status(req, res) {
  const compoundId = req.params.taskId;
  const job = omni16Jobs.get(compoundId);
  if (!job) return res.json({ status: 'error', error: 'Задача не найдена (сервер перезапускался, состояние не сохраняется)' });

  try {
    if (job.phase === 'clip1') {
      const data = await kieGet('/jobs/recordInfo?taskId=' + job.clip1TaskId, job.reqKey);
      const task = data.data || data;
      if (task.state === 'fail') {
        omni16Jobs.delete(compoundId);
        localLogUpdate(compoundId, { state: 'fail', failMsg: task.failMsg });
        return res.json({ status: 'failed', error: 'Часть 1 из 2: ' + (task.failMsg || 'ошибка генерации') });
      }
      if (task.state !== 'success') return res.json({ status: 'pending', stage: 'Генерация части 1 из 2...' });

      let clip1Url = '';
      try { clip1Url = JSON.parse(task.resultJson || '{}').resultUrls?.[0] || ''; } catch {}
      if (!clip1Url) throw new Error('Часть 1 завершилась без результата');

      const clip1Path = path.join(OMNI16_DIR, compoundId + '_part1.mp4');
      await downloadToFile(clip1Url, clip1Path);
      const framePath = path.join(OMNI16_DIR, compoundId + '_lastframe.jpg');
      await extractLastFrame(clip1Path, framePath);
      const frameKieUrl = await kieUploadBase64(
        'data:image/jpeg;base64,' + fs.readFileSync(framePath).toString('base64'),
        job.reqKey, 'continuity.jpg'
      );
      try { fs.unlinkSync(framePath); } catch {}

      // Кадр-продолжение первым (задаёт стартовый кадр части 2), затем исходные
      // референсы товара — чтобы часть 2 сохранила его внешний вид
      const part2Refs = [frameKieUrl, ...job.refUrls].slice(0, 7);
      const clip2TaskId = await createOmniClipTask(job.partB, part2Refs, job.aspect_ratio, job.resolution, job.reqKey);

      job.phase = 'clip2';
      job.clip1Path = clip1Path;
      job.clip2TaskId = clip2TaskId;
      job.clip1Credits = task.creditsConsumed || 0;
      job.clip1CostTime = task.costTime || 0;
      return res.json({ status: 'pending', stage: 'Часть 1 готова, запускаю часть 2 из 2...' });
    }

    if (job.phase === 'clip2') {
      const data = await kieGet('/jobs/recordInfo?taskId=' + job.clip2TaskId, job.reqKey);
      const task = data.data || data;
      if (task.state === 'fail') {
        omni16Jobs.delete(compoundId);
        localLogUpdate(compoundId, { state: 'fail', failMsg: task.failMsg });
        return res.json({ status: 'failed', error: 'Часть 2 из 2: ' + (task.failMsg || 'ошибка генерации') });
      }
      if (task.state !== 'success') return res.json({ status: 'pending', stage: 'Генерация части 2 из 2...' });

      let clip2Url = '';
      try { clip2Url = JSON.parse(task.resultJson || '{}').resultUrls?.[0] || ''; } catch {}
      if (!clip2Url) throw new Error('Часть 2 завершилась без результата');

      const clip2Path = path.join(OMNI16_DIR, compoundId + '_part2.mp4');
      await downloadToFile(clip2Url, clip2Path);
      const outPath = path.join(OMNI16_DIR, compoundId + '.mp4');
      await concatVideos(job.clip1Path, clip2Path, outPath);

      try { fs.unlinkSync(job.clip1Path); } catch {}
      try { fs.unlinkSync(clip2Path); } catch {}

      const finalUrl = '/videogen-output/' + compoundId + '.mp4';
      const totalCredits = (job.clip1Credits || 0) + (task.creditsConsumed || 0);
      const totalCostTime = (job.clip1CostTime || 0) + (task.costTime || 0);
      omni16Jobs.delete(compoundId);
      localLogUpdate(compoundId, { state: 'success', resultJson: JSON.stringify({ resultUrls: [finalUrl] }), creditsConsumed: totalCredits });
      return res.json({ status: 'success', url: finalUrl, credits: totalCredits, costTime: totalCostTime });
    }

    res.json({ status: 'error', error: 'Неизвестная фаза задачи' });
  } catch (e) {
    res.json({ status: 'error', error: e.message });
  }
}

// ── Video Cutting endpoints ──

// Static serve for cut clips
app.use('/cut-files', express.static(path.join(__dirname, 'data', 'cut-uploads')));

// Helper: run ffmpeg command
function ffmpegExec(args) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve({ stdout, stderr });
    });
  });
}

// Helper: get video duration + dimensions via ffmpeg
function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    // No output args: ffmpeg prints stream info to stderr and exits instantly
    // (decoding the whole file just to read dimensions would take minutes on 3 GB video)
    execFile(FFMPEG, ['-i', filePath], { maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      const s = stderr || '';
      const m = s.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      if (!m) return reject(new Error('Cannot read video duration'));
      const duration = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
      const vm = s.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
      let width = vm ? parseInt(vm[1]) : 0;
      let height = vm ? parseInt(vm[2]) : 0;
      // Phone videos are often stored rotated with metadata
      const rot = s.match(/rotation of (-?\d+)/) || s.match(/rotate\s*:\s*(-?\d+)/);
      if (rot && Math.abs(parseInt(rot[1])) % 180 === 90) [width, height] = [height, width];
      resolve({ duration, width, height });
    });
  });
}

// POST /api/cut/upload
app.post('/api/cut/upload', (req, res, next) => {
  // Parse projectId from query or body before multer reads body
  const projectId = req.query.projectId || ('proj_' + Date.now());
  req._cutProjectId = projectId;
  next();
}, cutUpload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.json({ ok: false, error: 'Файл не передан' });
    const projectId = req.body?.projectId || req._cutProjectId || ('proj_' + Date.now());
    const filePath = req.file.path;
    const size = req.file.size;
    const info = await getVideoInfo(filePath);
    try { fs.writeFileSync(path.join(path.dirname(filePath), 'video-info.json'), JSON.stringify(info)); } catch {}
    res.json({ ok: true, projectId, filePath, duration: info.duration, size, width: info.width, height: info.height });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /api/cut/transcribe
app.post('/api/cut/transcribe', async (req, res) => {
  try {
    const { projectId, openaiKey } = req.body || {};
    if (!projectId) return res.json({ ok: false, error: 'projectId обязателен' });
    if (!openaiKey) return res.json({ ok: false, error: 'openaiKey обязателен' });

    const dir = path.join(__dirname, 'data', 'cut-uploads', projectId);
    // Find original file
    const files = fs.readdirSync(dir).filter(f => f.startsWith('original.'));
    if (!files.length) return res.json({ ok: false, error: 'Видео не найдено. Загрузите файл.' });
    const videoPath = path.join(dir, files[0]);

    // Extract compressed mono audio: video can exceed Node's 2 GiB buffer limit,
    // and Whisper API accepts max 25 MB anyway
    const audioPath = path.join(dir, 'whisper-audio.mp3');
    if (!fs.existsSync(audioPath)) {
      await ffmpegExec(['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', audioPath]);
    }
    const audioSize = fs.statSync(audioPath).size;
    if (audioSize > 25 * 1024 * 1024) {
      return res.json({ ok: false, error: `Аудиодорожка ${(audioSize / 1024 / 1024).toFixed(1)} МБ превышает лимит Whisper 25 МБ. Видео слишком длинное — разбейте его на части.` });
    }
    const fileBuffer = fs.readFileSync(audioPath);

    const form = new FormData();
    form.append('file', new Blob([fileBuffer], { type: 'audio/mpeg' }), 'whisper-audio.mp3');
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + openaiKey },
      body: form,
    });
    const data = await r.json();
    if (data.error) return res.json({ ok: false, error: data.error.message || JSON.stringify(data.error) });

    const transcript = data.text || '';
    const segments = data.segments || [];
    fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify({ transcript, segments }, null, 2));
    res.json({ ok: true, transcript, segments });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /api/cut/analyze
app.post('/api/cut/analyze', async (req, res) => {
  try {
    const { projectId, count = 5, duration = 30, format = 'vertical', openrouterKey, anthropicKey } = req.body || {};
    if (!projectId) return res.json({ ok: false, error: 'projectId обязателен' });

    const dir = path.join(__dirname, 'data', 'cut-uploads', projectId);
    const transcriptPath = path.join(dir, 'transcript.json');
    if (!fs.existsSync(transcriptPath)) return res.json({ ok: false, error: 'Транскрипция не найдена. Сначала транскрибируйте видео.' });
    const { transcript, segments } = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));

    const systemPrompt = `You are an expert video editor specializing in viral short-form content. Analyze a video transcript and suggest the best cut points for engaging clips.`;
    const userMsg = `Transcript:
${transcript}

${segments.length ? `Segments with timestamps:
${segments.map(s => `[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s]: ${s.text}`).join('\n')}` : ''}

Task: Find the ${count} most engaging moments to cut into short viral clips.
Target clip duration: approximately ${duration} seconds each.
Format: ${format === 'vertical' ? '9:16 vertical (TikTok/Reels)' : '16:9 horizontal (YouTube)'}

Return ONLY a JSON array (no markdown, no explanation) with exactly ${count} objects:
[{"start": 10.5, "end": 40.5, "title": "Clip title", "description": "Why this clip works"}]

Rules:
- start/end are seconds (floats)
- Each clip must be ${Math.max(5, duration - 10)}-${duration + 15} seconds long
- Pick the most engaging, self-contained moments
- Titles should be catchy, under 60 chars`;

    let resultText = '';

    if (anthropicKey) {
      const client = new Anthropic({ apiKey: anthropicKey });
      const message = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
      });
      resultText = message.content[0]?.text?.trim() || '';
    } else if (openrouterKey) {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + openrouterKey,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3000',
        },
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4-5',
          max_tokens: 2000,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMsg },
          ],
        }),
      });
      const data = await r.json();
      resultText = data.choices?.[0]?.message?.content?.trim() || '';
      if (!resultText && data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    } else {
      return res.json({ ok: false, error: 'Добавьте Anthropic или OpenRouter API ключ в настройках' });
    }

    // Parse JSON from response
    const jsonMatch = resultText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.json({ ok: false, error: 'AI не вернул корректный JSON. Ответ: ' + resultText.slice(0, 200) });
    const cuts = JSON.parse(jsonMatch[0]);
    res.json({ ok: true, cuts });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /api/cut/execute
app.post('/api/cut/execute', async (req, res) => {
  try {
    const { projectId, cuts, format = 'vertical', smartCrop = null } = req.body || {};
    if (!projectId || !cuts?.length) return res.json({ ok: false, error: 'projectId и cuts обязательны' });

    const dir = path.join(__dirname, 'data', 'cut-uploads', projectId);
    const files = fs.readdirSync(dir).filter(f => f.startsWith('original.'));
    if (!files.length) return res.json({ ok: false, error: 'Видео не найдено' });
    const videoPath = path.join(dir, files[0]);

    const clipsDir = path.join(dir, 'clips');
    fs.mkdirSync(clipsDir, { recursive: true });

    const isVertical = format === 'vertical';
    const [W, H] = isVertical ? [1080, 1920] : [1920, 1080];
    // Filter/scale for output format: default = center crop filling the frame
    const vfFilter = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
    // Smart crop: crop only P% of the excess, fit the rest over a blurred background
    // (стандартный приём CapCut/OpusClip для гор.→верт. конвертации)
    const p = smartCrop === null || smartCrop === undefined ? null : Math.max(0, Math.min(100, Number(smartCrop))) / 100;
    const useSmart = p !== null && p < 1;
    const smartFilter = useSmart
      ? `[0:v]split=2[bgsrc][fgsrc];`
        + `[bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:2[bg];`
        + `[fgsrc]crop=w='if(gt(iw/ih,${W}/${H}),iw-(iw-ih*${W}/${H})*${p},iw)':h='if(gt(iw/ih,${W}/${H}),ih,ih-(ih-iw*${H}/${W})*${p})',`
        + `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg];`
        + `[bg][fg]overlay=(W-w)/2:(H-h)/2`
      : null;

    const resultClips = [];
    for (let i = 0; i < cuts.length; i++) {
      const cut = cuts[i];
      const outPath = path.join(clipsDir, `clip_${i + 1}.mp4`);
      const start = parseFloat(cut.start);
      const end = parseFloat(cut.end);
      const duration = end - start;
      if (duration <= 0) continue;

      await ffmpegExec([
        '-ss', String(start),
        '-i', videoPath,
        '-t', String(duration),
        ...(useSmart ? ['-filter_complex', smartFilter] : ['-vf', vfFilter]),
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        '-y',
        outPath,
      ]);

      const url = `/cut-files/${projectId}/clips/clip_${i + 1}.mp4`;
      resultClips.push({ path: outPath, url, title: cut.title || `Клип ${i + 1}` });
    }

    // Save clip titles so the gallery can show meaningful names
    const metaPath = path.join(clipsDir, 'meta.json');
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
    resultClips.forEach(c => { meta[path.basename(c.path)] = c.title; });
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    res.json({ ok: true, clips: resultClips });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /api/cut/projects/:projectId/probe — размеры и ориентация оригинала (с кэшем)
app.get('/api/cut/projects/:projectId/probe', async (req, res) => {
  try {
    const dir = path.join(__dirname, 'data', 'cut-uploads', path.basename(req.params.projectId));
    const infoPath = path.join(dir, 'video-info.json');
    try {
      const cached = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
      if (cached.width) return res.json({ ok: true, ...cached });
    } catch {}
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.startsWith('original.')) : [];
    if (!files.length) return res.json({ ok: false, error: 'Видео не найдено. Загрузите файл.' });
    const info = await getVideoInfo(path.join(dir, files[0]));
    fs.writeFileSync(infoPath, JSON.stringify(info));
    res.json({ ok: true, ...info });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /api/cut/projects/:projectId/files — список оригинальных файлов проекта
app.get('/api/cut/projects/:projectId/files', (req, res) => {
  try {
    const dir = path.join(__dirname, 'data', 'cut-uploads', req.params.projectId);
    if (!fs.existsSync(dir)) return res.json({ ok: true, files: [] });
    const files = fs.readdirSync(dir).filter(f => f.startsWith('original.')).map(f => {
      const fp = path.join(dir, f);
      const stat = fs.statSync(fp);
      return { filename: f, size: stat.size, mtime: stat.mtimeMs, url: `/cut-files/${req.params.projectId}/${f}` };
    });
    res.json({ ok: true, files });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /api/cut/projects/:projectId/clips
app.get('/api/cut/projects/:projectId/clips', (req, res) => {
  try {
    const clipsDir = path.join(__dirname, 'data', 'cut-uploads', req.params.projectId, 'clips');
    if (!fs.existsSync(clipsDir)) return res.json({ ok: true, clips: [] });
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(clipsDir, 'meta.json'), 'utf8')); } catch {}
    const files = fs.readdirSync(clipsDir).filter(f => f.endsWith('.mp4')).sort();
    const clips = files.map(f => ({
      filename: f,
      url: `/cut-files/${req.params.projectId}/clips/${f}`,
      title: meta[f] || f.replace('.mp4', '').replace(/_/g, ' '),
      mtime: fs.statSync(path.join(clipsDir, f)).mtimeMs,
    }));
    res.json({ ok: true, clips });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// DELETE /api/cut/projects/:projectId/clips/:filename — удалить клип с диска
app.delete('/api/cut/projects/:projectId/clips/:filename', (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    if (!/^[\w.-]+\.mp4$/.test(filename)) return res.json({ ok: false, error: 'Некорректное имя файла' });
    const clipsDir = path.join(__dirname, 'data', 'cut-uploads', path.basename(req.params.projectId), 'clips');
    const fp = path.join(clipsDir, filename);
    if (!fs.existsSync(fp)) return res.json({ ok: false, error: 'Файл не найден' });
    fs.unlinkSync(fp);
    const metaPath = path.join(clipsDir, 'meta.json');
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      delete meta[filename];
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Era Peremen (eraperemen.info) endpoints ──

const ERA_DIR = path.join(__dirname, 'data', 'era');
const ERA_TEXTS_DIR = path.join(ERA_DIR, 'texts');
fs.mkdirSync(ERA_TEXTS_DIR, { recursive: true });
const ERA_BASE = 'https://eraperemen.info';
const ERA_CATEGORIES = {
  politics: 'Политическая аналитика и прогнозы',
  'ispolnennye-prognozy': 'Исполненные прогнозы',
  'fin-markets': 'Рыночная аналитика',
  kriptoanalitika: 'Аналитика блокчейн-индустрии',
  'crypto-markets': 'Новости криптоиндустрии',
};
const ERA_PAYWALL_MARKER = 'необходимо приобрести подписку';

const eraArticlesPath = path.join(ERA_DIR, 'articles.json');
const eraLoadArticles = () => { try { return JSON.parse(fs.readFileSync(eraArticlesPath, 'utf8')); } catch { return []; } };
const eraSaveArticles = list => fs.writeFileSync(eraArticlesPath, JSON.stringify(list, null, 2));
const eraCookiePath = path.join(ERA_DIR, 'session.json');
const eraCookie = () => { try { return JSON.parse(fs.readFileSync(eraCookiePath, 'utf8')).cookie || ''; } catch { return ''; } };

async function eraFetch(urlPath) {
  const r = await fetch(ERA_BASE + urlPath, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      ...(eraCookie() ? { Cookie: eraCookie() } : {}),
    },
  });
  return r.text();
}

function eraStripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#8212;/g, '—').replace(/&#8211;/g, '–').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// GET /api/era/articles — список статей (без полных текстов)
app.get('/api/era/articles', (req, res) => {
  const list = eraLoadArticles().map(a => ({ ...a, text: undefined }));
  res.json({ ok: true, articles: list, hasCookie: !!eraCookie() });
});

// GET /api/era/article/:slug — полный текст
app.get('/api/era/article/:slug', (req, res) => {
  const slug = path.basename(req.params.slug);
  const a = eraLoadArticles().find(x => x.slug === slug);
  if (!a) return res.json({ ok: false, error: 'Статья не найдена' });
  let text = '';
  try { text = fs.readFileSync(path.join(ERA_TEXTS_DIR, slug + '.txt'), 'utf8'); } catch {}
  res.json({ ok: true, article: { ...a, text } });
});

// POST /api/era/session { cookie } — сохранить cookie авторизации с сайта
app.post('/api/era/session', async (req, res) => {
  try {
    const { cookie } = req.body || {};
    if (!cookie) return res.json({ ok: false, error: 'cookie обязателен' });
    fs.writeFileSync(eraCookiePath, JSON.stringify({ cookie, savedAt: Date.now() }));
    // Проверяем доступ: платная статья не должна показывать пейволл
    const list = eraLoadArticles();
    const probe = list.find(a => a.locked) || list[0];
    let valid = null;
    if (probe) {
      const html = await eraFetch('/' + probe.slug);
      valid = !html.includes(ERA_PAYWALL_MARKER);
    }
    res.json({ ok: true, valid });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /api/era/scrape-list { categories? } — собрать список статей по категориям
app.post('/api/era/scrape-list', async (req, res) => {
  try {
    const cats = req.body?.categories?.length ? req.body.categories : Object.keys(ERA_CATEGORIES);
    const list = eraLoadArticles();
    const known = new Set(list.map(a => a.slug));
    let added = 0, scanned = 0;
    for (const cat of cats) {
      for (let page = 1; page <= 60; page++) {
        const html = await eraFetch('/' + cat + (page > 1 ? '?page=' + page : ''));
        const items = [...html.matchAll(/<h2><a href="\/([^"]+)">([\s\S]*?)<\/a><\/h2>[\s\S]{0,400}?article-date'>📅([\d.]+)/g)];
        if (!items.length) break;
        scanned += items.length;
        let newOnPage = 0;
        for (const m of items) {
          const slug = m[1];
          if (known.has(slug)) continue;
          known.add(slug);
          newOnPage++;
          added++;
          list.push({
            slug,
            title: eraStripTags(m[2]),
            date: m[3],
            category: cat,
            categoryName: ERA_CATEGORIES[cat] || cat,
            url: ERA_BASE + '/' + slug,
            source: 'site',
            hasText: fs.existsSync(path.join(ERA_TEXTS_DIR, slug + '.txt')),
            locked: null,
          });
        }
        if (page > 1 && newOnPage === 0) break; // дальше только уже известные
      }
    }
    // Сортировка по дате (DD.MM.YYYY) по убыванию
    const key = d => (d || '').split('.').reverse().join('');
    list.sort((a, b) => key(b.date).localeCompare(key(a.date)));
    eraSaveArticles(list);
    res.json({ ok: true, added, scanned, total: list.length });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /api/era/scrape-texts { limit? } — скачать тексты статей (нужен cookie для платных)
// POST /api/era/scrape-texts { slug } — скачать текст одной конкретной статьи
app.post('/api/era/scrape-texts', async (req, res) => {
  try {
    const limit = Math.min(Number(req.body?.limit) || 30, 300);
    const list = eraLoadArticles();
    const todo = req.body?.slug
      ? list.filter(a => a.slug === req.body.slug)
      : list.filter(a => !a.hasText).slice(0, limit);
    let done = 0, locked = 0;
    for (const a of todo) {
      eraLog(`📄 «${a.title.slice(0, 60)}» (${a.date}) — скачиваю статью...`);
      const html = await eraFetch('/' + a.slug);
      const isLocked = html.includes(ERA_PAYWALL_MARKER);
      a.locked = isLocked;
      if (isLocked) { locked++; eraLog(`🔒 «${a.title.slice(0, 60)}» — закрыта пейволлом (нужен cookie)`); continue; }
      // Контент между </h1> и блоком тегов/шаринга
      let body = html.split('</h1>')[1] || '';
      body = body.split('<ul class="container tag-menu"')[0].split('<div class="social"')[0];
      const text = eraStripTags(body);
      if (text.length < 200) { a.locked = true; locked++; continue; }
      const tags = [...html.matchAll(/href='\/prognozy\/([^']+)'>([^<]+)</g)].map(m => m[2]);
      a.tags = [...new Set(tags)];
      fs.writeFileSync(path.join(ERA_TEXTS_DIR, a.slug + '.txt'), text);
      a.hasText = true;
      a.textLen = text.length;
      done++;
      eraLog(`✅ «${a.title.slice(0, 60)}» — текст сохранён, ${Math.round(text.length / 1000)}к символов`);
      await new Promise(r => setTimeout(r, 400)); // не долбим сайт
    }
    eraSaveArticles(list);
    res.json({ ok: true, done, locked, remaining: list.filter(x => !x.hasText).length });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Era Peremen: журнал прогресса ──
const eraProgressLog = [];
function eraLog(msg) {
  eraProgressLog.push({ t: Date.now(), msg });
  if (eraProgressLog.length > 200) eraProgressLog.splice(0, eraProgressLog.length - 200);
}

// GET /api/era/progress?after=<ts> — журнал операций
app.get('/api/era/progress', (req, res) => {
  const after = Number(req.query.after) || 0;
  res.json({ ok: true, log: eraProgressLog.filter(e => e.t > after) });
});

// ── Era Peremen: чат по базе знаний ──

// Примитивный полнотекстовый поиск: обрезаем окончания слов (грубый стемминг),
// считаем вхождения, заголовок весит втрое, свежесть — тай-брейкер
function eraSearchDocs(query, limit = 10) {
  const list = eraLoadArticles().filter(a => a.hasText);
  const terms = (query.toLowerCase().match(/[а-яёa-z0-9]{3,}/gi) || [])
    .map(t => (t.length > 5 ? t.slice(0, Math.ceil(t.length * 0.75)) : t));
  const scored = [];
  for (const a of list) {
    let text = '';
    try { text = fs.readFileSync(path.join(ERA_TEXTS_DIR, a.slug + '.txt'), 'utf8'); } catch { continue; }
    const titleLower = a.title.toLowerCase();
    const lower = titleLower + '\n' + text.toLowerCase();
    let score = 0;
    for (const t of terms) {
      const matches = lower.split(t).length - 1;
      if (matches) score += Math.min(matches, 10) + (titleLower.includes(t) ? 3 : 0);
    }
    if (score > 0) scored.push({ a, text, score, dateKey: (a.date || '').split('.').reverse().join('') });
  }
  scored.sort((x, y) => y.score - x.score || y.dateKey.localeCompare(x.dateKey));
  return scored.slice(0, limit);
}

// POST /api/era/chat { question, anthropicKey, history? }
app.post('/api/era/chat', async (req, res) => {
  try {
    const { question, anthropicKey, openrouterKey, history = [] } = req.body || {};
    if (!question) return res.json({ ok: false, error: 'question обязателен' });
    if (!anthropicKey && !openrouterKey) return res.json({ ok: false, error: 'Нужен Anthropic или OpenRouter API ключ (⚙️ Настройки API)' });

    const docs = eraSearchDocs(question, 10);
    if (!docs.length) {
      return res.json({ ok: true, answer: 'В базе пока нет материалов по этому вопросу. Скачайте тексты статей или транскрибируйте видео (вкладка «Статьи») — и я смогу ответить.', sources: [] });
    }

    const context = docs.map((d, i) =>
      `[Источник ${i + 1}] ${d.a.title}\nДата: ${d.a.date} · ${d.a.source === 'youtube' ? 'Видео' : 'Статья'} · ${d.a.url}\n${d.text.slice(0, 4000)}`
    ).join('\n\n════════\n\n');

    const system = `Ты — аналитик проекта «Эра Перемен» (eraperemen.info). Твоя задача — отвечать на вопросы в стиле автора проекта, опираясь ИСКЛЮЧИТЕЛЬНО на предоставленные материалы (статьи сайта и транскрипты видео).

Стиль автора: системный макроанализ, причинно-следственные цепочки, прямые смелые прогнозы с конкретными горизонтами (недели/месяцы/кварталы), уверенный тон без обтекаемых формулировок, внимание к структурным кризисам и переломным точкам.

Правила:
- Опирайся только на материалы из контекста. Если в них нет ответа — скажи прямо, не выдумывай.
- Ссылайся на источники по номерам [1], [2] прямо в тексте.
- Если автор в разных материалах менял оценку — покажи эволюцию по датам.
- Учитывай даты материалов: свежие важнее старых.
- Отвечай на русском.`;

    const msgs = [
      ...history.slice(-6).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: `Материалы базы знаний:\n\n${context}\n\n════════\n\nВопрос: ${question}` },
    ];

    let answer = '';
    if (anthropicKey) {
      const client = new Anthropic({ apiKey: anthropicKey });
      const message = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2500,
        system,
        messages: msgs,
      });
      answer = message.content[0]?.text?.trim() || '';
    } else {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + openrouterKey,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3000',
        },
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4-5',
          max_tokens: 2500,
          messages: [{ role: 'system', content: system }, ...msgs],
        }),
      });
      const data = await r.json();
      answer = data.choices?.[0]?.message?.content?.trim() || '';
      if (!answer && data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    }
    res.json({
      ok: true,
      answer,
      sources: docs.map((d, i) => ({ n: i + 1, title: d.a.title, date: d.a.date, url: d.a.url, source: d.a.source })),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Era Peremen: YouTube канал ──

const ERA_AUDIO_DIR = path.join(ERA_DIR, 'audio');
fs.mkdirSync(ERA_AUDIO_DIR, { recursive: true });
const ERA_CHANNEL = 'https://www.youtube.com/@eraperemen/videos';
const YTDLP = process.env.YTDLP_PATH || [
  path.join(__dirname, 'bin', 'yt-dlp'),
  path.join(process.env.HOME || '/Users/imac27-5k', 'Library/Python/3.9/bin/yt-dlp'),
].find(p => fs.existsSync(p)) || 'yt-dlp';

function ytdlpExec(args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, args, { maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).slice(-500)));
      else resolve(stdout);
    });
  });
}

// POST /api/era/yt-list — добавить в базу все новые видео канала (канал целиком — несколько сотен роликов)
// Шаг 1: --flat-playlist быстро (~1 мин) даёт ID всех видео канала, без даты/названия на русском.
// Шаг 2: полную карточку (дата, длительность, оригинальный заголовок) тянем только для реально новых ID —
// иначе на канале из 300+ роликов полное сканирование занимает много минут при каждом клике.
app.post('/api/era/yt-list', async (req, res) => {
  try {
    const list = eraLoadArticles();
    const known = new Set(list.map(a => a.slug));

    const idsOut = await ytdlpExec([
      '--flat-playlist', '--skip-download', '--no-warnings',
      '--print', '%(id)s',
      ERA_CHANNEL,
    ], 300000);
    const allIds = [...new Set(idsOut.trim().split('\n').filter(Boolean))];
    const newIds = allIds.filter(id => !known.has('yt-' + id));

    let added = 0;
    if (newIds.length) {
      const urls = newIds.map(id => 'https://www.youtube.com/watch?v=' + id);
      const out = await ytdlpExec([
        '--skip-download', '--no-warnings', '--ignore-errors',
        '--print', '%(id)s\t%(upload_date)s\t%(duration)s\t%(title)s',
        ...urls,
      ], 1200000);
      for (const line of out.trim().split('\n')) {
        const [id, ud, dur, ...t] = line.split('\t');
        if (!id || known.has('yt-' + id)) continue;
        const date = ud && ud.length === 8 ? `${ud.slice(6, 8)}.${ud.slice(4, 6)}.${ud.slice(0, 4)}` : '';
        list.push({
          slug: 'yt-' + id,
          title: (t.join('\t') || id).trim(),
          date,
          category: 'youtube',
          categoryName: 'YouTube-канал',
          url: 'https://www.youtube.com/watch?v=' + id,
          source: 'youtube',
          videoId: id,
          duration: Number(dur) || null,
          hasText: fs.existsSync(path.join(ERA_TEXTS_DIR, 'yt-' + id + '.txt')),
          locked: false,
        });
        known.add('yt-' + id);
        added++;
      }
    }
    const key = d => (d || '').split('.').reverse().join('');
    list.sort((a, b) => key(b.date).localeCompare(key(a.date)));
    eraSaveArticles(list);
    res.json({ ok: true, added, scanned: allIds.length, total: list.filter(a => a.source === 'youtube').length });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /api/era/yt-transcribe { videoId?, openaiKey? } — скачать аудио и транскрибировать одно видео
// Без openaiKey только скачивает аудио. Без videoId берёт первое ютуб-видео без текста.
app.post('/api/era/yt-transcribe', async (req, res) => {
  try {
    const { openaiKey } = req.body || {};
    const list = eraLoadArticles();
    const item = req.body?.videoId
      ? list.find(a => a.videoId === req.body.videoId)
      // без ключа режим "только скачивание" — берём видео, у которого ещё нет и аудио
      : list.find(a => a.source === 'youtube' && !a.hasText
          && (req.body?.openaiKey || !fs.existsSync(path.join(ERA_AUDIO_DIR, a.videoId + '.mp3'))));
    if (!item) return res.json({ ok: true, done: true, message: 'Все видео обработаны' });

    // 1. Скачиваем аудио (кэшируется)
    const mp3Path = path.join(ERA_AUDIO_DIR, item.videoId + '.mp3');
    if (!fs.existsSync(mp3Path)) {
      const rawPath = path.join(ERA_AUDIO_DIR, item.videoId + '.raw');
      eraLog(`▶️ «${item.title.slice(0, 60)}» — скачиваю аудио с YouTube...`);
      await ytdlpExec(['-f', 'bestaudio', '--no-warnings', '-o', rawPath, item.url], 600000);
      eraLog(`🎚 «${item.title.slice(0, 60)}» — сжимаю аудио для Whisper...`);
      await ffmpegExec(['-y', '-i', rawPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', mp3Path]);
      fs.unlinkSync(rawPath);
    }
    if (!openaiKey) {
      eraLog(`✓ «${item.title.slice(0, 60)}» — аудио готово (без транскрибации)`);
      return res.json({ ok: true, downloaded: item.videoId, transcribed: false, remaining: list.filter(a => a.source === 'youtube' && !a.hasText).length });
    }

    // 2. Whisper
    const size = fs.statSync(mp3Path).size;
    if (size > 25 * 1024 * 1024) return res.json({ ok: false, error: `Аудио ${item.videoId}: ${(size / 1e6).toFixed(0)} МБ > лимита Whisper 25 МБ` });
    eraLog(`🎙 «${item.title.slice(0, 60)}» — транскрибирую через Whisper (${(size / 1e6).toFixed(1)} МБ)...`);
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(mp3Path)], { type: 'audio/mpeg' }), item.videoId + '.mp3');
    form.append('model', 'whisper-1');
    form.append('language', 'ru');
    form.append('response_format', 'verbose_json');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + openaiKey },
      body: form,
    });
    const data = await r.json();
    if (data.error) return res.json({ ok: false, error: data.error.message || JSON.stringify(data.error) });

    fs.writeFileSync(path.join(ERA_TEXTS_DIR, item.slug + '.txt'), data.text || '');
    fs.writeFileSync(path.join(ERA_TEXTS_DIR, item.slug + '.segments.json'), JSON.stringify(data.segments || []));
    item.hasText = true;
    item.textLen = (data.text || '').length;
    eraSaveArticles(list);
    eraLog(`✅ «${item.title.slice(0, 60)}» — транскрипт готов, ${Math.round(item.textLen / 1000)}к символов. Осталось видео: ${list.filter(a => a.source === 'youtube' && !a.hasText).length}`);
    res.json({ ok: true, transcribed: item.videoId, title: item.title, textLen: item.textLen, remaining: list.filter(a => a.source === 'youtube' && !a.hasText).length });
  } catch (e) {
    res.json({ ok: false, error: e.message });
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
