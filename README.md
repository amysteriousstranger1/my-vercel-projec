# Poker Vision (macOS)

Node.js/TypeScript CLI для распознавания покерных столов в реальном времени через скриншоты и Overshoot Vision (модель `Qwen/Qwen3-VL-32B-Instruct-FP8`).

## 1. Установка

```bash
npm install
cp .env.example .env
```

## 2. API ключ

Укажите ключ в `.env`:

```env
OVERSHOOT_API_KEY=your_overshoot_key
```

Или через CLI:

```bash
npx tsx src/index.ts config --api-key sk-xxx
```

## 3. macOS разрешения Screen Recording

Если скриншоты не создаются:

1. Откройте `System Settings`
2. Перейдите в `Privacy & Security`
3. Откройте `Screen Recording`
4. Включите доступ для терминала/приложения, где запускается `poker-vision`
5. Перезапустите приложение

## 4. Команды

Запуск мониторинга в фоне:

```bash
npx tsx src/index.ts start --interval 2000 --monitor 0 --output ./data
```

Остановка:

```bash
npx tsx src/index.ts stop
```

Анализ одного изображения:

```bash
npx tsx src/index.ts analyze ./screenshot.png
```

Сохранить API key и другие настройки:

```bash
npx tsx src/index.ts config --api-key sk-xxx --interval 2000 --monitor 0 --output ./data --base-url https://api.overshoot.ai/v0.2
```

Выбор region:

```bash
npx tsx src/index.ts set-region
```

Список мониторов:

```bash
npx tsx src/index.ts monitors
```

## 5. Формат данных

Результаты сохраняются в `OUTPUT_DIR`:

- `OUTPUT_DIR/<session-id>/events/<timestamp>.json`
- `OUTPUT_DIR/<session-id>/screenshots/<timestamp>.png` (если `SAVE_SCREENSHOTS=true`)
- `OUTPUT_DIR/<session-id>/summary.json`

## 6. Troubleshooting

`Missing OVERSHOOT_API_KEY`
- Укажите ключ через `.env` или `config --api-key`.

`No Screen Recording permission on macOS`
- Дайте доступ в `System Settings -> Privacy & Security -> Screen Recording`.

`Rate limited`
- Приложение автоматически делает retry/backoff и увеличивает интервал.

`Parser warnings`
- Сырые ответы сохраняются в `rawResponse` каждого события; включите `SAVE_SCREENSHOTS=true` для отладки.

## 7. Build

```bash
npm run build
npm run typecheck
```

Для глобального CLI:

```bash
npm run build
npm link
poker-vision --help
```

## 8. OCR Web GUI через `file://` (Python API + HTML)

Промпт берётся из `config/poker_prompt.txt`.

Установка Python-зависимостей:

```bash
pip3 install groq==0.9.0 httpx==0.27.2 "pydantic<2"
```

1. Запуск API-сервера:

```bash
GROQ_API_KEY=your_groq_key python3 groq_poker_ocr_gui.py --no-open --port 8765
```

2. Открой HTML UX из файла:

`file:///Users/romanduenin/Documents/New%20project/data/ocr_result.html`

В этом файле работают кнопки:
- `Start OCR` — запускает цикл OCR
- `Stop OCR` — останавливает цикл OCR
- `Run Once` — один OCR-цикл
- `Interval` — интервал между циклами (по умолчанию 1 сек)

Каждый цикл:
- делает временный скриншот экрана
- отправляет изображение в Groq API
- обновляет результат в GUI и `data/ocr_result.txt`
- удаляет временный скриншот после обработки

## 9. Telegram бот на Vercel: webhook + cron + Redis

Архитектура:
- Telegram отправляет апдейты в `POST /api/telegram-webhook`
- Vercel Cron дёргает `GET /api/cron/daily` каждый день в `04:00 UTC` (это `07:00` Москва)
- Состояние чатов хранится в Upstash Redis

### Файлы

- `api/telegram-webhook.js` — команды `/start`, `/status`, `/stop`, `/help`
- `api/cron/daily.js` — ежедневная отправка дня отсчёта + цитаты
- `api/_lib/countdown.js` — общая логика отсчёта и интеграции с Telegram
- `vercel.json` — cron расписание
- `scripts/setup-telegram-webhook.mjs` — установка webhook в Telegram API

### Переменные окружения (Vercel Project Settings)

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_WEBHOOK_SECRET=...
CRON_SECRET=...
COUNTDOWN_START_DAYS=60
COUNTDOWN_SEND_HOUR=7
COUNTDOWN_TIMEZONE=Europe/Moscow
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
COUNTDOWN_CHATS_SET_KEY=countdown:chat_ids:v1
COUNTDOWN_CHAT_KEY_PREFIX=countdown:chat:v1:
VERCEL_PROJECT_URL=https://your-project.vercel.app
```

### Деплой

1. Импортируйте репозиторий в Vercel и сделайте deploy.
2. Подключите `Upstash Redis` в Vercel Marketplace для проекта.
3. Добавьте env-переменные выше в проекте Vercel.
4. После первого деплоя установите webhook:

```bash
npm run telegram:webhook:set
```

5. В чате с ботом используйте:
- `/start` — запускает отсчёт от 60 до 0
- `/status` — показывает текущий день и цитату
- `/stop` — останавливает отсчёт

Если `CRON_SECRET` задан, endpoint `api/cron/daily` принимает только `Authorization: Bearer <CRON_SECRET>`.
