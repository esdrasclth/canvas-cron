const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/config');
const { decodeAuthState, installAuthState } = require('../src/storage');

const state = { cookies: [], origins: [] };
const base64 = Buffer.from(JSON.stringify(state)).toString('base64');

test('decodifica un base64 en una sola linea', () => {
  assert.deepEqual(JSON.parse(decodeAuthState(base64)), state);
});

test('tolera saltos de linea y espacios al pegar la variable', () => {
  const partido = `${base64.slice(0, 8)}\n  ${base64.slice(8)}\n`;
  assert.deepEqual(JSON.parse(decodeAuthState(partido)), state);
});

test('explica el problema cuando el base64 no produce JSON valido', () => {
  assert.throws(() => decodeAuthState('no-es-json-valido'), /AUTH_STATE_B64 no contiene un JSON valido/);
});

test('rechaza un base64 truncado en lugar de aceptarlo a medias', () => {
  assert.throws(() => decodeAuthState(base64.slice(0, base64.length - 8)), /AUTH_STATE_B64/);
});

test('verifica una sesion candidata antes de reemplazar la activa', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-auth-test-'));
  const original = {
    authFile: config.authFile,
    profileDir: config.profileDir,
    outputDir: config.outputDir,
  };
  config.authFile = path.join(directory, 'auth', 'unitec.json');
  config.profileDir = path.join(directory, 'profile');
  config.outputDir = path.join(directory, 'output');
  t.after(async () => {
    Object.assign(config, original);
    await fs.rm(directory, { recursive: true, force: true });
  });

  const active = { cookies: [{ name: 'active', value: 'old' }], origins: [] };
  const candidate = { cookies: [{ name: 'candidate', value: 'new' }], origins: [] };
  await fs.mkdir(path.dirname(config.authFile), { recursive: true });
  await fs.writeFile(config.authFile, JSON.stringify(active), 'utf8');

  await assert.rejects(
    installAuthState(JSON.stringify(candidate), { verify: async () => { throw new Error('Canvas rechazo la sesion'); } }),
    /Canvas rechazo/,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(config.authFile, 'utf8')), active);

  let verifiedPath;
  const summary = await installAuthState(JSON.stringify(candidate), {
    verify: async (candidatePath) => {
      verifiedPath = candidatePath;
      assert.notEqual(candidatePath, config.authFile);
      assert.deepEqual(JSON.parse(await fs.readFile(candidatePath, 'utf8')), candidate);
      return { tasks: [{ key: '1:2' }] };
    },
  });

  assert.equal(summary.verification.tasks.length, 1);
  assert.ok(verifiedPath.endsWith('.candidate'));
  assert.deepEqual(JSON.parse(await fs.readFile(config.authFile, 'utf8')), candidate);
  assert.deepEqual(JSON.parse(await fs.readFile(`${config.authFile}.previous`, 'utf8')), active);
});
