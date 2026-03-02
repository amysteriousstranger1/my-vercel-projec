import 'dotenv/config';
import { getWebhookInfo, setWebhook } from '../api/_lib/countdown.js';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function normalizeBaseUrl(url) {
  return url.replace(/\/+$/, '');
}

async function main() {
  required('TELEGRAM_BOT_TOKEN');
  const baseUrl = normalizeBaseUrl(required('VERCEL_PROJECT_URL'));
  const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET;
  const webhookUrl = `${baseUrl}/api/telegram-webhook`;

  await setWebhook(webhookUrl, secretToken, true);
  const info = await getWebhookInfo();

  console.log('Webhook configured');
  console.log(JSON.stringify(info, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
