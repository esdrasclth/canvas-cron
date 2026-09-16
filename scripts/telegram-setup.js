const config = require('../src/config');

async function telegram(method) {
  const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`);
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram HTTP ${response.status}`);
  return result.result;
}

async function main() {
  if (!config.telegramBotToken) throw new Error('Define TELEGRAM_BOT_TOKEN antes de ejecutar este comando');
  const bot = await telegram('getMe');
  const updates = await telegram('getUpdates');
  const chats = new Map();
  for (const update of updates) {
    const chat = update.message?.chat ?? update.edited_message?.chat ?? update.channel_post?.chat;
    if (chat) chats.set(String(chat.id), chat);
  }

  console.log(`Bot conectado: @${bot.username}`);
  if (!chats.size) {
    console.log('No hay chats disponibles. Envía /start al bot y ejecuta el comando otra vez.');
    return;
  }
  console.log('Chats encontrados:');
  for (const [id, chat] of chats) {
    console.log(`- TELEGRAM_CHAT_ID=${id} (${chat.username ? `@${chat.username}` : chat.title || chat.first_name || chat.type})`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

