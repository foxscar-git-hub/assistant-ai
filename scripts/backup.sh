#!/bin/bash
# Автоматический коммит и push изменений проекта
# Запуск: ./scripts/backup.sh [сообщение]
# Cron пример (каждый час): 0 * * * * /Volumes/data/ассистент-new/scripts/backup.sh

set -e
cd /Volumes/data/ассистент-new

MSG="${1:-auto: backup $(date '+%Y-%m-%d %H:%M')}"

# Проверяем есть ли изменения
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "Нет изменений для коммита"
  exit 0
fi

git add -A
git commit -m "$MSG"
git push origin main 2>&1 && echo "✅ Отправлено на GitHub" || echo "⚠️  Push не удался (проверьте интернет)"
