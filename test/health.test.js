const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/config');
const { openDatabase } = require('../src/database');
const { buildStatus } = require('../scripts/health-server');

test('/health valida sesion, SQLite y frescura de la revision', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-health-test-'));
  const original = {
    authFile: config.authFile,
    databaseFile: config.databaseFile,
    profileDir: config.profileDir,
    outputDir: config.outputDir,
    heartbeatMinutes: config.heartbeatMinutes,
  };
  Object.assign(config, {
    authFile: path.join(directory, 'auth', 'unitec.json'),
    databaseFile: path.join(directory, 'notifications.db'),
    profileDir: path.join(directory, 'profile'),
    outputDir: path.join(directory, 'output'),
    heartbeatMinutes: 90,
  });
  t.after(async () => {
    Object.assign(config, original);
    await fs.rm(directory, { recursive: true, force: true });
  });

  await fs.mkdir(path.dirname(config.authFile), { recursive: true });
  await fs.writeFile(config.authFile, JSON.stringify({
    cookies: [{ name: 'session', value: 'x', expires: 2_000_000_000 }], origins: [],
  }), 'utf8');

  const now = new Date('2026-09-18T18:00:00.000Z');
  let database = openDatabase();
  database.setState('last_success_at', new Date(now.getTime() - 30 * 60_000).toISOString());
  assert.equal(database.db.pragma('user_version', { simple: true }), 2);
  assert.equal(database.db.pragma('busy_timeout', { simple: true }), config.sqliteBusyTimeoutMs);
  database.close();

  const ready = await buildStatus(now);
  assert.equal(ready.code, 200);
  assert.equal(ready.body.status, 'ready');
  assert.equal(ready.body.monitor.stale, false);

  database = openDatabase();
  database.setState('last_error', 'CANVAS_HTTP_ERROR:HTTP 500');
  database.close();
  const failed = await buildStatus(now);
  assert.equal(failed.code, 503);
  assert.equal(failed.body.status, 'degraded');

  database = openDatabase();
  database.setState('last_error', '');
  database.setState('last_success_at', new Date(now.getTime() - 120 * 60_000).toISOString());
  database.close();
  const stale = await buildStatus(now);
  assert.equal(stale.code, 503);
  assert.equal(stale.body.status, 'degraded');

  await fs.writeFile(config.authFile, '{no-json', 'utf8');
  const invalid = await buildStatus(now);
  assert.equal(invalid.code, 503);
  assert.equal(invalid.body.status, 'invalid_session');
});
