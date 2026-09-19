const config = require('./config');

const API_BASE = 'https://api.telegram.org';
// Telegram rechaza cualquier mensaje de mas de 4096 caracteres.
const MESSAGE_LIMIT = 4096;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

async function callTelegram(method, payload, { timeoutMs = 20_000 } = {}) {
  if (!config.telegramBotToken) throw new Error('Falta TELEGRAM_BOT_TOKEN');

  const response = await fetch(`${API_BASE}/bot${config.telegramBotToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram rechazó ${method}: ${result.description || response.status}`);
  }
  return result.result;
}

// Parte el texto en trozos que Telegram acepte, cortando por lineas para no
// romper una etiqueta HTML a la mitad.
function splitMessage(text, limit = MESSAGE_LIMIT) {
  if (text.length <= limit) return [text];

  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = line.length <= limit ? line : line.slice(0, limit);
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendTelegramMessage(text, { chatId = config.telegramChatId, keyboard = null } = {}) {
  if (config.telegramDryRun) {
    console.log(`[TELEGRAM DRY RUN]\n${text}\n`);
    return { dryRun: true };
  }

  const chunks = splitMessage(text);
  let last = null;
  for (const [index, chunk] of chunks.entries()) {
    last = await callTelegram('sendMessage', {
      chat_id: chatId,
      text: chunk,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      // Los botones van solo en el ultimo trozo para no repetirlos.
      ...(keyboard && index === chunks.length - 1 ? { reply_markup: keyboard } : {}),
    });
  }
  return { dryRun: false, result: last };
}

function answerCallbackQuery(callbackQueryId, text) {
  return callTelegram('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

// Quita los botones de un aviso ya atendido para que se vea resuelto.
function clearKeyboard(chatId, messageId) {
  return callTelegram('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  });
}

async function downloadFile(fileId, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const file = await callTelegram('getFile', { file_id: fileId });
  if (file.file_size && file.file_size > maxBytes) {
    throw new Error(`El archivo pesa ${file.file_size} bytes; el límite es ${maxBytes}.`);
  }

  const url = `${API_BASE}/file/bot${config.telegramBotToken}/${file.file_path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`No se pudo descargar el archivo (HTTP ${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

function getUpdates(offset, timeoutSeconds) {
  return callTelegram(
    'getUpdates',
    { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'callback_query'] },
    // El margen evita que el fetch expire antes que el long polling.
    { timeoutMs: (timeoutSeconds + 15) * 1000 },
  );
}

function setMyCommands(commands) {
  return callTelegram('setMyCommands', { commands });
}

module.exports = {
  answerCallbackQuery,
  callTelegram,
  clearKeyboard,
  downloadFile,
  escapeHtml,
  getUpdates,
  sendTelegramMessage,
  setMyCommands,
  splitMessage,
};
