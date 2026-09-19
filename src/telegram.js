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

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelayMs(response, result, attempt, baseMs) {
  const apiSeconds = Number(result?.parameters?.retry_after);
  if (Number.isFinite(apiSeconds) && apiSeconds >= 0) return apiSeconds * 1000;

  const retryAfter = response?.headers?.get?.('retry-after');
  const headerSeconds = Number(retryAfter);
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) return headerSeconds * 1000;
  if (retryAfter) {
    const dateDelay = new Date(retryAfter).getTime() - Date.now();
    if (Number.isFinite(dateDelay) && dateDelay > 0) return dateDelay;
  }
  return Math.min(baseMs * (2 ** attempt), 60_000);
}

async function callTelegram(method, payload, {
  timeoutMs = 20_000,
  maxRetries = config.telegramMaxRetries,
  retryBaseMs = config.telegramRetryBaseMs,
  fetchImpl = globalThis.fetch,
  sleep = wait,
} = {}) {
  if (!config.telegramBotToken) throw new Error('Falta TELEGRAM_BOT_TOKEN');

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response;
    let result = {};
    try {
      response = await fetchImpl(`${API_BASE}/bot${config.telegramBotToken}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      result = await response.json().catch(() => ({}));
      if (response.ok && result.ok) return result.result;
    } catch (error) {
      if (attempt >= maxRetries) throw error;
      await sleep(Math.min(retryBaseMs * (2 ** attempt), 60_000));
      continue;
    }

    const status = Number(result.error_code || response.status);
    const retryable = status === 429 || status >= 500;
    if (!retryable || attempt >= maxRetries) {
      throw new Error(`Telegram rechazó ${method}: ${result.description || response.status}`);
    }
    await sleep(retryDelayMs(response, result, attempt, retryBaseMs));
  }

  throw new Error(`Telegram rechazó ${method}.`);
}

const VOID_TAGS = new Set(['br', 'hr']);

function tagInfo(token) {
  const closing = /^<\s*\/\s*([a-z0-9]+)\s*>$/i.exec(token);
  if (closing) return { type: 'close', name: closing[1].toLowerCase() };
  const opening = /^<\s*([a-z0-9]+)\b[^>]*>$/i.exec(token);
  if (!opening) return null;
  const name = opening[1].toLowerCase();
  if (VOID_TAGS.has(name) || /\/\s*>$/.test(token)) return { type: 'void', name };
  return { type: 'open', name };
}

function closingTags(stack) {
  return [...stack].reverse().map(({ name }) => `</${name}>`).join('');
}

function openingTags(stack) {
  return stack.map(({ token }) => token).join('');
}

// Parte HTML sin perder contenido ni dejar etiquetas abiertas. Si un elemento
// cruza el limite, se cierra en el fragmento actual y se vuelve a abrir en el
// siguiente para que Telegram acepte ambos mensajes.
function splitLongHtmlLine(text, limit) {
  const source = String(text);
  if (source.length <= limit) return [source];

  const tokens = source.match(/<[^>]*>|&(?:#\d+|#x[\da-f]+|[a-z][\w]+);|\s+|[^\s<&]+|[<&]/giu) || [];
  const chunks = [];
  const stack = [];
  let current = '';

  function flush() {
    if (!current) return;
    chunks.push(current + closingTags(stack));
    current = openingTags(stack);
  }

  function appendText(token) {
    let characters = Array.from(token);
    while (characters.length) {
      const capacity = limit - current.length - closingTags(stack).length;
      if (capacity <= 0) {
        flush();
        continue;
      }
      let take = 0;
      let codeUnits = 0;
      while (take < characters.length && codeUnits + characters[take].length <= capacity) {
        codeUnits += characters[take].length;
        take += 1;
      }
      if (!take) {
        if (current.length > openingTags(stack).length) {
          flush();
          continue;
        }
        throw new Error(`Un caracter no cabe en el limite de Telegram (${limit} caracteres).`);
      }
      current += characters.slice(0, take).join('');
      characters = characters.slice(take);
      if (characters.length) flush();
    }
  }

  for (const token of tokens) {
    const info = token.startsWith('<') ? tagInfo(token) : null;
    if (!info) {
      if (/^&(?:#\d+|#x[\da-f]+|[a-z][\w]+);$/iu.test(token)) {
        if (current.length + token.length + closingTags(stack).length > limit) flush();
        if (current.length + token.length + closingTags(stack).length > limit) {
          throw new Error(`Una entidad HTML supera el limite de Telegram (${limit} caracteres).`);
        }
        current += token;
        continue;
      }
      appendText(token);
      continue;
    }

    let nextStack = stack;
    if (info.type === 'open') nextStack = [...stack, { name: info.name, token }];
    if (info.type === 'close') {
      const index = stack.map((entry) => entry.name).lastIndexOf(info.name);
      nextStack = index === -1 ? stack : stack.slice(0, index);
    }

    if (current.length + token.length + closingTags(nextStack).length > limit
      && current.length > openingTags(stack).length) {
      flush();
    }
    if (current.length + token.length + closingTags(nextStack).length > limit) {
      throw new Error(`Una etiqueta HTML supera el limite de Telegram (${limit} caracteres).`);
    }
    current += token;
    stack.splice(0, stack.length, ...nextStack);
  }

  if (current) chunks.push(current + closingTags(stack));
  return chunks;
}

// Conserva las lineas completas siempre que sea posible. Solo usa el divisor
// HTML para una linea que por si sola excede el limite.
function splitMessage(text, limit = MESSAGE_LIMIT) {
  const source = String(text);
  if (source.length <= limit) return [source];

  const chunks = [];
  let current = '';
  for (const line of source.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current) chunks.push(current);
    if (line.length <= limit) {
      current = line;
      continue;
    }

    const parts = splitLongHtmlLine(line, limit);
    chunks.push(...parts.slice(0, -1));
    current = parts.at(-1) || '';
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendTelegramMessage(text, {
  chatId = config.telegramChatId,
  keyboard = null,
  startChunk = 0,
  onChunkSent = null,
} = {}) {
  if (config.telegramDryRun) {
    console.log(`[TELEGRAM DRY RUN]\n${text}\n`);
    return { dryRun: true };
  }

  const chunks = splitMessage(text);
  let last = null;
  for (let index = startChunk; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    last = await callTelegram('sendMessage', {
      chat_id: chatId,
      text: chunk,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      // Los botones van solo en el ultimo trozo para no repetirlos.
      ...(keyboard && index === chunks.length - 1 ? { reply_markup: keyboard } : {}),
    });
    if (onChunkSent) await onChunkSent(index + 1, chunks.length);
  }
  return { dryRun: false, result: last, chunks: chunks.length };
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
