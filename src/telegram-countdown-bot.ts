import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramChat {
  id: number;
}

interface TelegramMessage {
  chat: TelegramChat;
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramMe {
  id: number;
  username?: string;
}

interface ChatSubscription {
  chatId: number;
  startDate: string;
  lastSentDate?: string;
  enabled: boolean;
  completed: boolean;
}

interface BotState {
  offset: number;
  chats: Record<string, ChatSubscription>;
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('Missing TELEGRAM_BOT_TOKEN in .env');
}

const START_DAYS = readEnvInteger('COUNTDOWN_START_DAYS', 60, 1);
const SEND_HOUR = readEnvInteger('COUNTDOWN_SEND_HOUR', 7, 0, 23);
const TIMEZONE = process.env.COUNTDOWN_TIMEZONE ?? 'Europe/Moscow';

const POLL_TIMEOUT_SECONDS = 30;
const RETRY_DELAY_MS = 5_000;
const SCHEDULER_INTERVAL_MS = 20_000;
const MS_PER_DAY = 86_400_000;

const START_COMMAND = /^\/start(?:@\w+)?(?:\s|$)/i;
const STOP_COMMAND = /^\/stop(?:@\w+)?(?:\s|$)/i;
const STATUS_COMMAND = /^\/status(?:@\w+)?(?:\s|$)/i;
const HELP_COMMAND = /^\/help(?:@\w+)?(?:\s|$)/i;

const STOIC_QUOTES = [
  '«Не трать время на споры о том, каким должен быть хороший человек. Будь им.» — Марк Аврелий',
  '«Ты властен над своим умом, но не над внешними событиями.» — Марк Аврелий',
  '«Препятствие на пути становится самим путём.» — Марк Аврелий',
  '«Счастье жизни зависит от качества твоих мыслей.» — Марк Аврелий',
  '«Делай каждое дело так, будто оно последнее в жизни.» — Марк Аврелий',
  '«Нам мешают не вещи, а наши суждения о вещах.» — Эпиктет',
  '«Не требуй, чтобы события шли, как ты хочешь. Желай, чтобы они шли как идут.» — Эпиктет',
  '«Свобода начинается там, где заканчивается страх.» — Эпиктет',
  '«Сначала скажи себе, кем хочешь быть, а потом делай то, что должен.» — Эпиктет',
  '«Ни один великий человек не жалуется на обстоятельства.» — Сенека',
  '«Пока мы откладываем, жизнь проходит.» — Сенека',
  '«Трудно не потому, что не смеем; не смеем, потому что трудно.» — Сенека',
  '«Кто везде, тот нигде.» — Сенека',
  '«Удача — это момент, когда подготовка встречает возможность.» — Сенека',
  '«Больше всего времени у нас отнимает то, что мы сами считаем пустяками.» — Сенека',
  '«Сколько бы ты ни жил, вся жизнь — это сегодняшний день.» — Марк Аврелий',
  '«Лучшее возмездие — не быть похожим на обидчика.» — Марк Аврелий',
  '«Не позволяй будущему тревожить тебя раньше времени.» — Марк Аврелий',
  '«Сила состоит в правильном использовании настоящего момента.» — Эпиктет',
  '«Если хочешь быть непобедимым — не вступай в борьбу, где победа зависит не от тебя.» — Эпиктет',
  '«Не объясняй свою философию. Воплощай её.» — Эпиктет',
  '«Кто научился умирать, тот разучился быть рабом.» — Сенека',
  '«Не тот беден, у кого мало, а тот, кому мало.» — Сенека',
  '«Смелость ведёт к звёздам, страх — к смерти.» — Сенека',
  '«Каждый новый день — новая жизнь, если использовать его по назначению.» — Сенека',
  '«Цени то, что можешь сделать сейчас.» — Марк Аврелий',
  '«Собери себя в одно целое и делай ближайшее дело.» — Марк Аврелий',
  '«Человек стоит столько, во сколько он сам себя ценит делами.» — Марк Аврелий',
  '«Дисциплина важнее вдохновения.» — Эпиктет',
  '«Терпи и воздерживайся.» — Эпиктет',
  '«Если хочешь расти, будь готов казаться глупым.» — Эпиктет',
  '«Планируй так, будто живёшь долго, действуй так, будто времени мало.» — Сенека',
  '«Мужество начинается с первого шага.» — Сенека',
  '«Главное богатство — зависеть от малого.» — Сенека',
  '«Не жди идеального часа. Используй этот.» — Марк Аврелий'
] as const;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_STATE_PATH = path.resolve(__dirname, '..', 'data', 'telegram-countdown-state.json');
const STATE_PATH = path.resolve(process.env.COUNTDOWN_STATE_PATH ?? DEFAULT_STATE_PATH);
const API_BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

const zonedFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

let schedulerBusy = false;

function readEnvInteger(name: string, fallback: number, min?: number, max?: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  if (min !== undefined && parsed < min) {
    throw new Error(`${name} must be >= ${min}`);
  }
  if (max !== undefined && parsed > max) {
    throw new Error(`${name} must be <= ${max}`);
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function dateKeyFromParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

function parseDateKey(dateKey: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }

  const yearRaw = match[1];
  const monthRaw = match[2];
  const dayRaw = match[3];
  if (!yearRaw || !monthRaw || !dayRaw) {
    throw new Error(`Invalid date key groups: ${dateKey}`);
  }

  const year = Number.parseInt(yearRaw, 10);
  const month = Number.parseInt(monthRaw, 10);
  const day = Number.parseInt(dayRaw, 10);
  return { year, month, day };
}

function dateKeyToDayNumber(dateKey: string): number {
  const { year, month, day } = parseDateKey(dateKey);
  const utc = Date.UTC(year, month - 1, day);
  return Math.floor(utc / MS_PER_DAY);
}

function diffDays(fromDateKey: string, toDateKey: string): number {
  return dateKeyToDayNumber(toDateKey) - dateKeyToDayNumber(fromDateKey);
}

function addDays(dateKey: string, days: number): string {
  const nextDayNumber = dateKeyToDayNumber(dateKey) + days;
  const utcDate = new Date(nextDayNumber * MS_PER_DAY);
  return dateKeyFromParts(
    utcDate.getUTCFullYear(),
    utcDate.getUTCMonth() + 1,
    utcDate.getUTCDate()
  );
}

function extractPart(parts: Intl.DateTimeFormatPart[], partType: string): string {
  const part = parts.find((entry) => entry.type === partType);
  if (!part) {
    throw new Error(`Missing ${partType} from date formatter`);
  }
  return part.value;
}

function getNowInTimezone(now: Date = new Date()): { dateKey: string; hour: number; minute: number } {
  const parts = zonedFormatter.formatToParts(now);
  const year = Number.parseInt(extractPart(parts, 'year'), 10);
  const month = Number.parseInt(extractPart(parts, 'month'), 10);
  const day = Number.parseInt(extractPart(parts, 'day'), 10);
  const hour = Number.parseInt(extractPart(parts, 'hour'), 10);
  const minute = Number.parseInt(extractPart(parts, 'minute'), 10);

  return {
    dateKey: dateKeyFromParts(year, month, day),
    hour,
    minute
  };
}

function calculateRemainingDays(startDate: string, today: string): number {
  const elapsed = diffDays(startDate, today);
  if (elapsed <= 0) {
    return START_DAYS;
  }
  if (elapsed >= START_DAYS) {
    return 0;
  }
  return START_DAYS - elapsed;
}

function quoteByDayIndex(dayIndex: number): string {
  const safeIndex = ((dayIndex % STOIC_QUOTES.length) + STOIC_QUOTES.length) % STOIC_QUOTES.length;
  return STOIC_QUOTES[safeIndex] ?? STOIC_QUOTES[0];
}

function dayWord(value: number): string {
  const abs = Math.abs(value) % 100;
  const lastDigit = abs % 10;
  if (abs > 10 && abs < 20) {
    return 'дней';
  }
  if (lastDigit === 1) {
    return 'день';
  }
  if (lastDigit >= 2 && lastDigit <= 4) {
    return 'дня';
  }
  return 'дней';
}

function buildCountdownMessage(remainingDays: number, quote: string): string {
  const lines = [
    `День ${remainingDays}.`,
    `До нуля осталось ${remainingDays} ${dayWord(remainingDays)}.`,
    '',
    `Цитата стоика дня:`,
    quote
  ];

  if (remainingDays === 0) {
    lines.unshift('Финиш: ты дошёл до дня 0.');
  }

  return lines.join('\n');
}

function buildHelpMessage(): string {
  const hour = pad2(SEND_HOUR);
  return [
    `Команды:`,
    `/start — запустить отсчёт ${START_DAYS} -> 0`,
    '/status — показать текущий день',
    '/stop — остановить отсчёт',
    '',
    `Авто-сообщение приходит каждый день в ${hour}:00 по Москве.`
  ].join('\n');
}

function getLastCountdownDate(startDate: string): string {
  return addDays(startDate, START_DAYS);
}

async function loadState(): Promise<BotState> {
  try {
    const raw = await readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<BotState>;
    return normalizeState(parsed);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return { offset: 0, chats: {} };
    }
    throw error;
  }
}

function normalizeState(input: Partial<BotState>): BotState {
  const state: BotState = {
    offset: Number.isInteger(input.offset) && (input.offset ?? 0) >= 0 ? (input.offset ?? 0) : 0,
    chats: {}
  };

  if (!input.chats || typeof input.chats !== 'object') {
    return state;
  }

  for (const subscription of Object.values(input.chats)) {
    if (!subscription || typeof subscription !== 'object') {
      continue;
    }

    const maybeSubscription = subscription as Partial<ChatSubscription>;
    if (typeof maybeSubscription.chatId !== 'number' || !Number.isFinite(maybeSubscription.chatId)) {
      continue;
    }
    if (typeof maybeSubscription.startDate !== 'string') {
      continue;
    }

    const chatId = Math.trunc(maybeSubscription.chatId);
    const normalized: ChatSubscription = {
      chatId,
      startDate: maybeSubscription.startDate,
      lastSentDate: typeof maybeSubscription.lastSentDate === 'string' ? maybeSubscription.lastSentDate : undefined,
      enabled: typeof maybeSubscription.enabled === 'boolean' ? maybeSubscription.enabled : true,
      completed: typeof maybeSubscription.completed === 'boolean' ? maybeSubscription.completed : false
    };

    state.chats[String(chatId)] = normalized;
  }

  return state;
}

async function saveState(state: BotState): Promise<void> {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

async function telegramRequest<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Telegram HTTP ${response.status} on ${method}`);
  }

  const payload = (await response.json()) as TelegramApiResponse<T>;
  if (!payload.ok || payload.result === undefined) {
    throw new Error(payload.description ?? `Telegram API error on ${method}`);
  }

  return payload.result;
}

async function sendMessage(chatId: number, text: string): Promise<void> {
  await telegramRequest('sendMessage', {
    chat_id: chatId,
    text
  });
}

function createSubscription(now: { dateKey: string; hour: number }): ChatSubscription {
  const startDate = now.hour < SEND_HOUR ? now.dateKey : addDays(now.dateKey, 1);
  return {
    chatId: 0,
    startDate,
    enabled: true,
    completed: false
  };
}

function shouldDisableChatOnError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message.toLowerCase() : '';
  return (
    msg.includes('bot was blocked by the user') ||
    msg.includes('chat not found') ||
    msg.includes('user is deactivated') ||
    msg.includes('forbidden')
  );
}

async function handleMessage(state: BotState, message: TelegramMessage): Promise<boolean> {
  const chatId = message.chat.id;
  const text = (message.text ?? '').trim();
  const key = String(chatId);
  const now = getNowInTimezone();

  if (START_COMMAND.test(text)) {
    const subscription = createSubscription({ dateKey: now.dateKey, hour: now.hour });
    subscription.chatId = chatId;
    state.chats[key] = subscription;

    const firstDate = subscription.startDate;
    const firstDay = START_DAYS;
    const hour = pad2(SEND_HOUR);
    const firstLine =
      firstDate === now.dateKey
        ? `Первое ежедневное сообщение придёт сегодня в ${hour}:00 (Москва): день ${firstDay}.`
        : `Первое ежедневное сообщение придёт завтра в ${hour}:00 (Москва): день ${firstDay}.`;

    await sendMessage(
      chatId,
      [
        `Отсчёт запущен: ${START_DAYS} -> 0.`,
        firstLine,
        '',
        `Текущий день: ${START_DAYS}.`,
        '',
        buildHelpMessage()
      ].join('\n')
    );

    return true;
  }

  if (STOP_COMMAND.test(text)) {
    const subscription = state.chats[key];
    if (!subscription || !subscription.enabled) {
      await sendMessage(chatId, 'Отсчёт уже остановлен. Чтобы начать снова, отправь /start.');
      return false;
    }
    subscription.enabled = false;
    await sendMessage(chatId, 'Отсчёт остановлен. Чтобы запустить заново, отправь /start.');
    return true;
  }

  if (STATUS_COMMAND.test(text)) {
    const subscription = state.chats[key];
    if (!subscription) {
      await sendMessage(chatId, `Отсчёт ещё не запущен.\n\n${buildHelpMessage()}`);
      return false;
    }

    const remaining = calculateRemainingDays(subscription.startDate, now.dateKey);
    const dayIndex = START_DAYS - remaining;
    const quote = quoteByDayIndex(dayIndex);

    let statusLine = 'Статус: активен.';
    if (subscription.completed) {
      statusLine = 'Статус: завершён (день 0 уже отправлен).';
    } else if (!subscription.enabled) {
      statusLine = 'Статус: остановлен командой /stop.';
    } else if (diffDays(subscription.startDate, now.dateKey) < 0) {
      const hour = pad2(SEND_HOUR);
      statusLine = `Статус: ожидает старт (первое сообщение в ${hour}:00 по Москве).`;
    }

    await sendMessage(
      chatId,
      [
        statusLine,
        `Текущий день: ${remaining}.`,
        `До нуля осталось ${remaining} ${dayWord(remaining)}.`,
        '',
        'Цитата дня:',
        quote
      ].join('\n')
    );
    return false;
  }

  if (HELP_COMMAND.test(text)) {
    await sendMessage(chatId, buildHelpMessage());
    return false;
  }

  await sendMessage(chatId, `Не понял команду.\n\n${buildHelpMessage()}`);
  return false;
}

async function sendDailyIfNeeded(state: BotState): Promise<void> {
  const now = getNowInTimezone();
  if (now.hour < SEND_HOUR) {
    return;
  }

  const today = now.dateKey;
  let changed = false;

  for (const subscription of Object.values(state.chats)) {
    if (!subscription.enabled) {
      continue;
    }
    if (subscription.lastSentDate === today) {
      continue;
    }

    const elapsed = diffDays(subscription.startDate, today);
    if (elapsed < 0) {
      continue;
    }

    let dayIndex = elapsed;
    let remaining = START_DAYS - elapsed;

    if (elapsed > START_DAYS) {
      const lastCountdownDate = getLastCountdownDate(subscription.startDate);
      if (subscription.lastSentDate === lastCountdownDate) {
        subscription.enabled = false;
        subscription.completed = true;
        changed = true;
        continue;
      }
      dayIndex = START_DAYS;
      remaining = 0;
    }

    const quote = quoteByDayIndex(dayIndex);
    const text = buildCountdownMessage(remaining, quote);

    try {
      await sendMessage(subscription.chatId, text);
      subscription.lastSentDate = today;
      changed = true;

      if (remaining === 0) {
        subscription.enabled = false;
        subscription.completed = true;
      }
    } catch (error) {
      console.error(`Failed to send to chat ${subscription.chatId}:`, error);
      if (shouldDisableChatOnError(error)) {
        subscription.enabled = false;
        changed = true;
      }
    }
  }

  if (changed) {
    await saveState(state);
  }
}

async function schedulerTick(state: BotState): Promise<void> {
  if (schedulerBusy) {
    return;
  }
  schedulerBusy = true;
  try {
    await sendDailyIfNeeded(state);
  } finally {
    schedulerBusy = false;
  }
}

async function getUpdates(offset: number): Promise<TelegramUpdate[]> {
  return telegramRequest<TelegramUpdate[]>('getUpdates', {
    offset,
    timeout: POLL_TIMEOUT_SECONDS,
    allowed_updates: ['message']
  });
}

async function runPolling(state: BotState): Promise<void> {
  while (true) {
    try {
      const updates = await getUpdates(state.offset);
      if (updates.length === 0) {
        continue;
      }

      let changed = false;
      for (const update of updates) {
        state.offset = Math.max(state.offset, update.update_id + 1);
        changed = true;

        if (update.message) {
          const messageChanged = await handleMessage(state, update.message);
          if (messageChanged) {
            changed = true;
          }
        }
      }

      if (changed) {
        await saveState(state);
      }
    } catch (error) {
      console.error('Polling error:', error);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function main(): Promise<void> {
  const state = await loadState();
  const me = await telegramRequest<TelegramMe>('getMe', {});

  console.log(`Telegram bot started as @${me.username ?? me.id}`);
  console.log(`Timezone: ${TIMEZONE}, daily send hour: ${pad2(SEND_HOUR)}:00, countdown: ${START_DAYS} -> 0`);
  console.log(`State file: ${STATE_PATH}`);

  await schedulerTick(state);
  setInterval(() => {
    void schedulerTick(state);
  }, SCHEDULER_INTERVAL_MS);

  await runPolling(state);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
