import { handleWebhookUpdate } from './_lib/countdown.js';

function getBody(req) {
  if (!req.body) {
    return null;
  }
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return req.body;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }

  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const actualSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (actualSecret !== expectedSecret) {
      res.status(401).json({ ok: false, error: 'Unauthorized webhook call' });
      return;
    }
  }

  const body = getBody(req);
  if (!body) {
    res.status(400).json({ ok: false, error: 'Invalid JSON payload' });
    return;
  }

  try {
    await handleWebhookUpdate(body);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook handler error:', error);
    res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
}
