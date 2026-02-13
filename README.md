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
