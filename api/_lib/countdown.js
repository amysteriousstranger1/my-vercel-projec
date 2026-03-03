import { Redis } from '@upstash/redis';

const START_COMMAND = /^\/start(?:@\w+)?(?:\s|$)/i;
const STOP_COMMAND = /^\/stop(?:@\w+)?(?:\s|$)/i;
const STATUS_COMMAND = /^\/status(?:@\w+)?(?:\s|$)/i;
const HELP_COMMAND = /^\/help(?:@\w+)?(?:\s|$)/i;

const MS_PER_DAY = 86_400_000;

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
];

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function readEnvInteger(name, fallback, min, max) {
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

function getConfig() {
  return {
    startDays: readEnvInteger('COUNTDOWN_START_DAYS', 60, 1),
    sendHour: readEnvInteger('COUNTDOWN_SEND_HOUR', 7, 0, 23),
    timezone: process.env.COUNTDOWN_TIMEZONE ?? 'Europe/Moscow',
    chatsSetKey: process.env.COUNTDOWN_CHATS_SET_KEY ?? 'countdown:chat_ids:v1',
    chatPrefix: process.env.COUNTDOWN_CHAT_KEY_PREFIX ?? 'countdown:chat:v1:'
  };
}

let redisClient;

function isRedisConfigured() {
  return Boolean(
    (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
      (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN)
  );
}

function ensureVercelEnvConfigured() {
  if (!process.env.VERCEL_API_TOKEN || !process.env.VERCEL_PROJECT_ID) {
    throw new Error(
      'Storage is not configured. Set either Upstash Redis env vars or VERCEL_API_TOKEN + VERCEL_PROJECT_ID.'
    );
  }
}

function getRedis() {
  if (!isRedisConfigured()) {
    throw new Error('Redis is not configured');
  }
  if (!redisClient) {
    redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
    });
  }
  return redisClient;
}

function getStateEnvConfig() {
  ensureVercelEnvConfigured();
  return {
    projectId: process.env.VERCEL_PROJECT_ID,
    teamId: process.env.VERCEL_TEAM_ID,
    apiToken: process.env.VERCEL_API_TOKEN,
    key: process.env.COUNTDOWN_STATE_ENV_KEY || 'COUNTDOWN_STATE_JSON',
    target: process.env.COUNTDOWN_STATE_ENV_TARGET || 'production'
  };
}

function buildProjectEnvPath(projectId, teamId, queryParams = {}) {
  const params = new URLSearchParams();
  if (teamId) {
    params.set('teamId', teamId);
  }
  for (const [key, value] of Object.entries(queryParams)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  return query ? `https://api.vercel.com/v10/projects/${projectId}/env?${query}` : `https://api.vercel.com/v10/projects/${projectId}/env`;
}

async function vercelApiRequest(url, apiToken, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${apiToken}`,
      'content-type': 'application/json',
      ...(init.headers || {})
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Vercel API ${response.status}: ${body}`);
  }

  return response.json();
}

function normalizeStatePayload(payload) {
  if (!payload || typeof payload !== 'object' || !payload.chats || typeof payload.chats !== 'object') {
    return { chats: {} };
  }

  const chats = {};
  for (const [chatId, value] of Object.entries(payload.chats)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    chats[chatId] = value;
  }

  return { chats };
}

async function loadVercelEnvState() {
  const envCfg = getStateEnvConfig();
  const url = buildProjectEnvPath(envCfg.projectId, envCfg.teamId, { decrypt: 'true' });
  const payload = await vercelApiRequest(url, envCfg.apiToken);
  const envs = Array.isArray(payload.envs) ? payload.envs : [];

  const stateEnv = envs.find(
    (entry) => entry && entry.key === envCfg.key && Array.isArray(entry.target) && entry.target.includes(envCfg.target)
  );

  if (!stateEnv || typeof stateEnv.value !== 'string') {
    return { chats: {} };
  }

  try {
    return normalizeStatePayload(JSON.parse(stateEnv.value));
  } catch {
    return { chats: {} };
  }
}

async function saveVercelEnvState(nextState) {
  const envCfg = getStateEnvConfig();
  const body = {
    type: 'plain',
    key: envCfg.key,
    value: JSON.stringify(normalizeStatePayload(nextState)),
    target: [envCfg.target]
  };

  const url = buildProjectEnvPath(envCfg.projectId, envCfg.teamId, { upsert: 'true' });
  await vercelApiRequest(url, envCfg.apiToken, {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function dateKeyFromParts(year, month, day) {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

function parseDateKey(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }

  return {
    year: Number.parseInt(match[1], 10),
    month: Number.parseInt(match[2], 10),
    day: Number.parseInt(match[3], 10)
  };
}

function dateKeyToDayNumber(dateKey) {
  const { year, month, day } = parseDateKey(dateKey);
  const utc = Date.UTC(year, month - 1, day);
  return Math.floor(utc / MS_PER_DAY);
}

function diffDays(fromDateKey, toDateKey) {
  return dateKeyToDayNumber(toDateKey) - dateKeyToDayNumber(fromDateKey);
}

function addDays(dateKey, days) {
  const nextDayNumber = dateKeyToDayNumber(dateKey) + days;
  const utcDate = new Date(nextDayNumber * MS_PER_DAY);
  return dateKeyFromParts(
    utcDate.getUTCFullYear(),
    utcDate.getUTCMonth() + 1,
    utcDate.getUTCDate()
  );
}

const formatterCache = new Map();

function getFormatter(timezone) {
  const existing = formatterCache.get(timezone);
  if (existing) {
    return existing;
  }

  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  formatterCache.set(timezone, formatter);
  return formatter;
}

function getNowInTimezone(timezone, now = new Date()) {
  const parts = getFormatter(timezone).formatToParts(now);
  const getPart = (type) => {
    const part = parts.find((item) => item.type === type);
    if (!part) {
      throw new Error(`Missing ${type} part for timezone conversion`);
    }
    return Number.parseInt(part.value, 10);
  };

  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  const hour = getPart('hour');
  const minute = getPart('minute');

  return {
    dateKey: dateKeyFromParts(year, month, day),
    hour,
    minute
  };
}

function calculateRemainingDays(startDate, today, startDays) {
  const elapsed = diffDays(startDate, today);
  if (elapsed <= 0) {
    return startDays;
  }
  if (elapsed >= startDays) {
    return 0;
  }
  return startDays - elapsed;
}

function quoteByDayIndex(dayIndex) {
  const safeIndex = ((dayIndex % STOIC_QUOTES.length) + STOIC_QUOTES.length) % STOIC_QUOTES.length;
  return STOIC_QUOTES[safeIndex];
}

function dayWord(value) {
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

function buildCountdownMessage(remainingDays, quote) {
  const lines = [
    `День ${remainingDays}.`,
    `До нуля осталось ${remainingDays} ${dayWord(remainingDays)}.`,
    '',
    'Цитата стоика дня:',
    quote
  ];

  if (remainingDays === 0) {
    lines.unshift('Финиш: ты дошёл до дня 0.');
  }

  return lines.join('\n');
}

function buildHelpMessage(sendHour, startDays) {
  return [
    'Команды:',
    `/start — запустить отсчёт ${startDays} -> 0`,
    '/status — показать текущий день',
    '/stop — остановить отсчёт',
    '',
    `Авто-сообщение приходит каждый день в ${pad2(sendHour)}:00 по Москве.`
  ].join('\n');
}

function normalizeChat(chatId, raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (typeof raw.startDate !== 'string') {
    return null;
  }

  return {
    chatId,
    startDate: raw.startDate,
    lastSentDate: typeof raw.lastSentDate === 'string' ? raw.lastSentDate : undefined,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    completed: typeof raw.completed === 'boolean' ? raw.completed : false
  };
}

function chatKey(chatId, config) {
  return `${config.chatPrefix}${chatId}`;
}

async function loadChat(chatId, config) {
  if (isRedisConfigured()) {
    const raw = await getRedis().get(chatKey(chatId, config));
    return normalizeChat(chatId, raw);
  }

  const state = await loadVercelEnvState();
  return normalizeChat(chatId, state.chats[String(chatId)]);
}

async function saveChat(chat, config) {
  if (isRedisConfigured()) {
    await getRedis().set(chatKey(chat.chatId, config), chat);
    await getRedis().sadd(config.chatsSetKey, String(chat.chatId));
    return;
  }

  const state = await loadVercelEnvState();
  state.chats[String(chat.chatId)] = chat;
  await saveVercelEnvState(state);
}

async function listChatIds(config) {
  if (isRedisConfigured()) {
    const items = await getRedis().smembers(config.chatsSetKey);
    if (!Array.isArray(items)) {
      return [];
    }

    const ids = [];
    for (const item of items) {
      const value = Number.parseInt(String(item), 10);
      if (Number.isInteger(value) && value !== 0) {
        ids.push(value);
      }
    }

    return ids;
  }

  const state = await loadVercelEnvState();
  const ids = [];
  for (const key of Object.keys(state.chats)) {
    const value = Number.parseInt(key, 10);
    if (Number.isInteger(value) && value !== 0) {
      ids.push(value);
    }
  }
  return ids;
}

async function telegramRequest(method, body) {
  const token = requiredEnv('TELEGRAM_BOT_TOKEN');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Telegram HTTP ${response.status} on ${method}`);
  }

  const payload = await response.json();
  if (!payload.ok || payload.result === undefined) {
    throw new Error(payload.description || `Telegram API error on ${method}`);
  }

  return payload.result;
}

async function sendMessage(chatId, text) {
  await telegramRequest('sendMessage', { chat_id: chatId, text });
}

function createSubscription(chatId, now, config) {
  const startDate = now.hour < config.sendHour ? now.dateKey : addDays(now.dateKey, 1);
  return {
    chatId,
    startDate,
    enabled: true,
    completed: false
  };
}

function shouldDisableChatOnError(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return (
    message.includes('bot was blocked by the user') ||
    message.includes('chat not found') ||
    message.includes('user is deactivated') ||
    message.includes('forbidden')
  );
}

async function handleTextCommand(chatId, text) {
  const config = getConfig();
  const now = getNowInTimezone(config.timezone);
  const keyText = (text ?? '').trim();

  if (START_COMMAND.test(keyText)) {
    const subscription = createSubscription(chatId, now, config);
    await saveChat(subscription, config);

    const firstLine =
      subscription.startDate === now.dateKey
        ? `Первое ежедневное сообщение придёт сегодня в ${pad2(config.sendHour)}:00 (Москва): день ${config.startDays}.`
        : `Первое ежедневное сообщение придёт завтра в ${pad2(config.sendHour)}:00 (Москва): день ${config.startDays}.`;

    await sendMessage(
      chatId,
      [
        `Отсчёт запущен: ${config.startDays} -> 0.`,
        firstLine,
        '',
        `Текущий день: ${config.startDays}.`,
        '',
        buildHelpMessage(config.sendHour, config.startDays)
      ].join('\n')
    );
    return;
  }

  if (STOP_COMMAND.test(keyText)) {
    const subscription = await loadChat(chatId, config);
    if (!subscription || !subscription.enabled) {
      await sendMessage(chatId, 'Отсчёт уже остановлен. Чтобы начать снова, отправь /start.');
      return;
    }

    subscription.enabled = false;
    await saveChat(subscription, config);
    await sendMessage(chatId, 'Отсчёт остановлен. Чтобы запустить заново, отправь /start.');
    return;
  }

  if (STATUS_COMMAND.test(keyText)) {
    const subscription = await loadChat(chatId, config);
    if (!subscription) {
      await sendMessage(chatId, `Отсчёт ещё не запущен.\n\n${buildHelpMessage(config.sendHour, config.startDays)}`);
      return;
    }

    const remaining = calculateRemainingDays(subscription.startDate, now.dateKey, config.startDays);
    const dayIndex = config.startDays - remaining;
    const quote = quoteByDayIndex(dayIndex);
    const startDelta = diffDays(subscription.startDate, now.dateKey);

    let statusLine = 'Статус: активен.';
    if (subscription.completed) {
      statusLine = 'Статус: завершён (день 0 уже отправлен).';
    } else if (!subscription.enabled) {
      statusLine = 'Статус: остановлен командой /stop.';
    } else if (startDelta < 0) {
      statusLine = `Статус: ожидает старт (первое сообщение в ${pad2(config.sendHour)}:00 по Москве).`;
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
    return;
  }

  if (HELP_COMMAND.test(keyText)) {
    await sendMessage(chatId, buildHelpMessage(config.sendHour, config.startDays));
    return;
  }

  await sendMessage(chatId, `Не понял команду.\n\n${buildHelpMessage(config.sendHour, config.startDays)}`);
}

export async function handleWebhookUpdate(update) {
  if (!update || typeof update !== 'object') {
    return { handled: false };
  }

  const message = update.message;
  if (!message || typeof message !== 'object' || !message.chat || typeof message.chat.id !== 'number') {
    return { handled: false };
  }

  await handleTextCommand(message.chat.id, typeof message.text === 'string' ? message.text : '');
  return { handled: true };
}

export async function runDailyDispatch(nowDate = new Date()) {
  const config = getConfig();
  const now = getNowInTimezone(config.timezone, nowDate);
  const summary = {
    date: now.dateKey,
    timezone: config.timezone,
    sendHour: config.sendHour,
    totalChats: 0,
    sent: 0,
    skipped: 0,
    disabled: 0,
    errors: 0,
    reason: 'ok'
  };

  if (now.hour < config.sendHour) {
    summary.reason = 'before_send_hour';
    return summary;
  }

  const chatIds = await listChatIds(config);
  summary.totalChats = chatIds.length;

  for (const chatId of chatIds) {
    const subscription = await loadChat(chatId, config);
    if (!subscription || !subscription.enabled) {
      summary.skipped += 1;
      continue;
    }
    if (subscription.lastSentDate === now.dateKey) {
      summary.skipped += 1;
      continue;
    }

    const elapsed = diffDays(subscription.startDate, now.dateKey);
    if (elapsed < 0) {
      summary.skipped += 1;
      continue;
    }

    let dayIndex = elapsed;
    let remaining = config.startDays - elapsed;

    if (elapsed > config.startDays) {
      const lastCountdownDate = addDays(subscription.startDate, config.startDays);
      if (subscription.lastSentDate === lastCountdownDate) {
        subscription.enabled = false;
        subscription.completed = true;
        await saveChat(subscription, config);
        summary.disabled += 1;
        continue;
      }
      dayIndex = config.startDays;
      remaining = 0;
    }

    try {
      const quote = quoteByDayIndex(dayIndex);
      const text = buildCountdownMessage(remaining, quote);
      await sendMessage(chatId, text);

      subscription.lastSentDate = now.dateKey;
      if (remaining === 0) {
        subscription.enabled = false;
        subscription.completed = true;
        summary.disabled += 1;
      }
      await saveChat(subscription, config);
      summary.sent += 1;
    } catch (error) {
      console.error(`Failed to send daily update to chat ${chatId}:`, error);
      summary.errors += 1;

      if (shouldDisableChatOnError(error)) {
        subscription.enabled = false;
        await saveChat(subscription, config);
        summary.disabled += 1;
      }
    }
  }

  return summary;
}

export async function setWebhook(url, secretToken, dropPendingUpdates = true) {
  const payload = {
    url,
    drop_pending_updates: dropPendingUpdates
  };

  if (secretToken) {
    payload.secret_token = secretToken;
  }

  return telegramRequest('setWebhook', payload);
}

export async function getWebhookInfo() {
  return telegramRequest('getWebhookInfo', {});
}
