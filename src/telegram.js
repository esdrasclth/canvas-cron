const config = require('./config');

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

async function sendTelegramMessage(text) {
  if (config.telegramDryRun) {
    console.log(`[TELEGRAM DRY RUN]\n${text}\n`);
    return { dryRun: true };
  }

  const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram rechazó el mensaje: ${result.description || response.status}`);
  return result;
}

module.exports = { escapeHtml, sendTelegramMessage };
