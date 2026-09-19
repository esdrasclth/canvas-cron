const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const configPath = path.resolve(__dirname, '../src/config.js');

test('carga .env local sin reemplazar variables explicitas', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-config-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, '.env'), 'DAILY_DIGEST_HOUR=7\n', 'utf8');

  const environment = { ...process.env };
  delete environment.DAILY_DIGEST_HOUR;
  const loaded = spawnSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(configPath)}).digestHour)`], {
    cwd: directory,
    env: environment,
    encoding: 'utf8',
  });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(loaded.stdout.trim(), '7');

  const explicit = spawnSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(configPath)}).digestHour)`], {
    cwd: directory,
    env: { ...environment, DAILY_DIGEST_HOUR: '9' },
    encoding: 'utf8',
  });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(explicit.stdout.trim(), '9');
});

test('rechaza configuracion fuera de rango al arrancar', () => {
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(configPath)})`], {
    env: { ...process.env, DAILY_DIGEST_HOUR: '99' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DAILY_DIGEST_HOUR/);
});

