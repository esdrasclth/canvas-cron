const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { callTelegram, sendTelegramMessage } = require('../src/telegram');

function response(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    json: async () => body,
  };
}

test('Telegram respeta retry_after y reintenta un 429', async (t) => {
  const originalToken = config.telegramBotToken;
  config.telegramBotToken = 'token-de-prueba';
  t.after(() => { config.telegramBotToken = originalToken; });

  let calls = 0;
  const delays = [];
  const result = await callTelegram('sendMessage', { text: 'hola' }, {
    maxRetries: 1,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? response(429, { ok: false, error_code: 429, parameters: { retry_after: 2 } })
        : response(200, { ok: true, result: { message_id: 7 } });
    },
    sleep: async (ms) => delays.push(ms),
  });

  assert.equal(result.message_id, 7);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [2000]);
});

test('Telegram no reintenta errores permanentes 400', async (t) => {
  const originalToken = config.telegramBotToken;
  config.telegramBotToken = 'token-de-prueba';
  t.after(() => { config.telegramBotToken = originalToken; });
  let calls = 0;
  await assert.rejects(callTelegram('sendMessage', {}, {
    maxRetries: 3,
    fetchImpl: async () => {
      calls += 1;
      return response(400, { ok: false, description: 'Bad Request' });
    },
    sleep: async () => {},
  }), /Bad Request/);
  assert.equal(calls, 1);
});

test('reanuda un mensaje multipartes desde el fragmento persistido', async (t) => {
  const original = {
    token: config.telegramBotToken,
    chatId: config.telegramChatId,
    dryRun: config.telegramDryRun,
  };
  const originalFetch = globalThis.fetch;
  Object.assign(config, { telegramBotToken: 'token', telegramChatId: '123', telegramDryRun: false });
  t.after(() => {
    Object.assign(config, {
      telegramBotToken: original.token,
      telegramChatId: original.chatId,
      telegramDryRun: original.dryRun,
    });
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return response(200, { ok: true, result: { message_id: calls } });
  };
  const progress = [];
  const result = await sendTelegramMessage('x'.repeat(5000), {
    startChunk: 1,
    onChunkSent: async (next) => progress.push(next),
  });
  assert.equal(result.chunks, 2);
  assert.equal(calls, 1);
  assert.deepEqual(progress, [2]);
});

