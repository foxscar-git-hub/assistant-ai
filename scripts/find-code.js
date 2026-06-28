#!/usr/bin/env node
/**
 * Поиск кода по карте проекта.
 * Использование: node scripts/find-code.js <запрос>
 * Пример:  node scripts/find-code.js "меню видео"
 *          node scripts/find-code.js parser
 */
const path = require('path');
const map = require('../.claude/code-map.json');

const query = process.argv.slice(2).join(' ').toLowerCase().trim();
if (!query) {
  console.log('Использование: node scripts/find-code.js <запрос>\n');
  console.log('Доступные разделы:');
  Object.keys(map.features).forEach(k => {
    const f = map.features[k];
    console.log(`  • ${k.padEnd(20)} — ${f.description}`);
  });
  process.exit(0);
}

// Score each feature by how well it matches the query
const scores = Object.entries(map.features).map(([key, feat]) => {
  let score = 0;
  const text = [key, feat.description, ...(feat.aliases || [])].join(' ').toLowerCase();
  if (key.toLowerCase() === query) score += 100;
  if (text.includes(query)) score += 50;
  // partial word match
  query.split(' ').forEach(word => {
    if (text.includes(word)) score += 10;
  });
  return { key, feat, score };
}).filter(x => x.score > 0).sort((a, b) => b.score - a.score);

if (!scores.length) {
  console.log(`❌ Ничего не найдено для: "${query}"`);
  console.log('   Попробуйте: ' + Object.keys(map.features).slice(0, 5).join(', '));
  process.exit(1);
}

const { key, feat } = scores[0];
const projectRoot = path.resolve(__dirname, '..');

console.log('\n' + '═'.repeat(60));
console.log(`📍 ${key.toUpperCase()}  —  ${feat.description}`);
if (feat.aliases) console.log(`   Алиасы: ${feat.aliases.join(', ')}`);
console.log('═'.repeat(60));

// HTML UI
if (feat.html_ui) {
  console.log('\n🖼  HTML/CSS  →  ' + feat.html_ui.file);
  feat.html_ui.sections.forEach(s => {
    console.log(`   line ${String(s.line).padStart(5)}  ${s.what}`);
  });
}

// JS functions
if (feat.js_functions) {
  const file = feat.js_functions.file || feat.html_ui?.file;
  console.log('\n⚙️  JS функции  →  ' + file);
  feat.js_functions.functions.forEach(fn => {
    const what = fn.what ? `  // ${fn.what}` : '';
    console.log(`   line ${String(fn.line).padStart(5)}  ${fn.name}${what}`);
  });
}

// Sidebar trigger
if (feat.sidebar_trigger) {
  console.log('\n🔀 Sidebar trigger  →  ' + feat.sidebar_trigger.file);
  feat.sidebar_trigger.lines.forEach(l =>
    console.log(`   line ${String(l).padStart(5)}  ${feat.sidebar_trigger.what}`)
  );
}

// Server routes
if (feat.server_routes) {
  console.log('\n🌐 Server routes  →  ' + feat.server_routes.file);
  feat.server_routes.routes.forEach(r => {
    const what = r.what ? `  // ${r.what}` : '';
    console.log(`   line ${String(r.line).padStart(5)}  ${r.method.padEnd(7)} ${r.path}${what}`);
  });
}

// Service files
const services = [feat.service_file, ...(feat.service_files || [])].filter(Boolean);
if (services.length) {
  console.log('\n📦 Сервисы:');
  services.forEach(s => console.log('   ' + s));
}

// Data file
if (feat.data_file) {
  console.log('\n💾 Файл данных:  ' + feat.data_file);
}

if (feat.server_const) {
  console.log('\n📌 Константа  →  ' + feat.server_const.file + ':' + feat.server_const.line);
  console.log('   ' + feat.server_const.what);
}

console.log('\n' + '─'.repeat(60));

// Show other matches
if (scores.length > 1) {
  console.log('Также совпали: ' + scores.slice(1, 4).map(x => x.key).join(', '));
}
console.log();
