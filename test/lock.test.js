const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/config');
const { acquireLock } = require('../src/checker');

test('solo un proceso reclama un lock obsoleto y libera por propietario', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-lock-test-'));
  const original = { lockFile: config.lockFile, lockStaleMinutes: config.lockStaleMinutes };
  config.lockFile = path.join(directory, 'check.lock');
  config.lockStaleMinutes = 1;
  t.after(async () => {
    Object.assign(config, original);
    await fs.rm(directory, { recursive: true, force: true });
  });

  await fs.writeFile(config.lockFile, JSON.stringify({ token: 'viejo' }), 'utf8');
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(config.lockFile, old, old);

  const contenders = await Promise.all([acquireLock(), acquireLock()]);
  const winners = contenders.filter(Boolean);
  assert.equal(winners.length, 1);
  assert.equal(await acquireLock(), null);
  await winners[0].release();

  const next = await acquireLock();
  assert.ok(next);
  await next.release();
});

