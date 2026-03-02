import { runDailyDispatch } from '../_lib/countdown.js';

function isAuthorized(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return true;
  }
  const authHeader = req.headers.authorization;
  return authHeader === `Bearer ${cronSecret}`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }

  if (!isAuthorized(req)) {
    res.status(401).json({ ok: false, error: 'Unauthorized cron call' });
    return;
  }

  try {
    const summary = await runDailyDispatch();
    res.status(200).json({ ok: true, summary });
  } catch (error) {
    console.error('Daily cron error:', error);
    res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
}
