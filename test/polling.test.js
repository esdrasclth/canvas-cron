const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/config');
const { pollOnce } = require('../src/bot');
const { openDatabase } = require('../src/database');

test('el offset de Telegram avanza solamente tras procesar el update', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-poll-test-'));
  const originalDatabaseFile = config.databaseFile;
  config.databaseFile = path.join(directory, 'notifications.db');
  t.after(async () => {
    config.databaseFile = originalDatabaseFile;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const fetchUpdates = async () => [{ update_id: 10, message: { text: '/estado' } }];
  await assert.rejects(pollOnce({
    fetchUpdates,
    onMessage: async () => { throw new Error('fallo durante el handler'); },
  }), /fallo durante el handler/);

  let database = openDatabase();
  assert.equal(database.getState('telegram_offset'), null);
  database.close();

  let handled = 0;
  await pollOnce({ fetchUpdates, onMessage: async () => { handled += 1; } });
  database = openDatabase();
  assert.equal(handled, 1);
  assert.equal(database.getState('telegram_offset'), '11');
  assert.ok(database.getState('telegram_last_poll_at'));
  database.close();
});

