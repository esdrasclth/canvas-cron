const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeAuthState } = require('../src/storage');

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
