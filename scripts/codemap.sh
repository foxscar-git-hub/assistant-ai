#!/bin/bash
# Генерирует CODE_INDEX.md — карту всех ключевых блоков кода для быстрого поиска

set -e
cd /Volumes/data/ассистент-new
OUT="CODE_INDEX.md"

echo "# Code Index — AI Ассистент" > "$OUT"
echo "> Обновлено: $(date '+%Y-%m-%d %H:%M')" >> "$OUT"
echo "" >> "$OUT"

# ── server.js routes ──
echo "## server.js — API маршруты" >> "$OUT"
echo '```' >> "$OUT"
grep -n "app\.\(get\|post\|put\|delete\|use\)" server.js 2>/dev/null \
  | sed 's/^/  /' | head -80 >> "$OUT" || true
echo '```' >> "$OUT"
echo "" >> "$OUT"

# ── index.html — JS functions ──
echo "## public/index.html — JS функции" >> "$OUT"
echo '```' >> "$OUT"
grep -n "^function \|^async function \|^  function \|^  async function " public/index.html 2>/dev/null \
  | sed 's/^/  /' | head -150 >> "$OUT" || true
echo '```' >> "$OUT"
echo "" >> "$OUT"

# ── index.html — Modal IDs ──
echo "## public/index.html — Модальные окна (id)" >> "$OUT"
echo '```' >> "$OUT"
grep -n 'id="modal-' public/index.html 2>/dev/null \
  | sed 's/^/  /' >> "$OUT" || true
echo '```' >> "$OUT"
echo "" >> "$OUT"

# ── services/ ──
echo "## services/ — модули бэкенда" >> "$OUT"
for f in services/*.js; do
  [ -f "$f" ] || continue
  echo "" >> "$OUT"
  echo "### $f" >> "$OUT"
  echo '```' >> "$OUT"
  grep -n "^function \|^async function \|^const \|^module\.exports\|exports\." "$f" 2>/dev/null \
    | sed 's/^/  /' | head -40 >> "$OUT" || true
  echo '```' >> "$OUT"
done

# ── scripts/ ──
echo "" >> "$OUT"
echo "## scripts/ — вспомогательные скрипты" >> "$OUT"
echo '```' >> "$OUT"
ls scripts/*.sh scripts/*.js 2>/dev/null | sed 's/^/  /' >> "$OUT" || true
echo '```' >> "$OUT"

echo "✅ Создан $OUT ($(wc -l < "$OUT") строк)"
