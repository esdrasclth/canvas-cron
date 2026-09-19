const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AuthenticationRequiredError, CanvasHttpError, fetchAll, mapWithConcurrency,
} = require('../src/canvas');

function response(status, body, headers = {}) {
  return {
    status: () => status,
    ok: () => status >= 200 && status < 300,
    headers: () => ({ 'content-type': 'application/json', ...headers }),
    json: async () => body,
  };
}

test('Canvas reintenta errores temporales antes de devolver la pagina', async () => {
  let calls = 0;
  const delays = [];
  const api = {
    get: async () => {
      calls += 1;
      return calls === 1 ? response(500, {}) : response(200, [{ id: 1 }]);
    },
  };

  const items = await fetchAll(api, 'https://canvas.test/items', {
    requestOptions: { maxRetries: 1, sleep: async (ms) => delays.push(ms) },
  });
  assert.deepEqual(items, [{ id: 1 }]);
  assert.equal(calls, 2);
  assert.equal(delays.length, 1);
});

test('un error HTML 500 no se confunde con una sesion vencida', async () => {
  const api = { get: async () => response(500, '<html>Error</html>', { 'content-type': 'text/html' }) };
  await assert.rejects(
    fetchAll(api, 'https://canvas.test/items', { requestOptions: { maxRetries: 0 } }),
    (error) => error instanceof CanvasHttpError && !(error instanceof AuthenticationRequiredError) && error.status === 500,
  );
});

test('la paginacion falla explicitamente antes de guardar datos parciales', async () => {
  const api = {
    get: async (url) => response(200, [{ url }], { link: `<${url}/next>; rel="next"` }),
  };
  await assert.rejects(
    fetchAll(api, 'https://canvas.test/page', { maxPages: 2, requestOptions: { maxRetries: 0 } }),
    /excedio el limite de 2 paginas/,
  );
});

test('limita la concurrencia conservando el orden de resultados', async () => {
  let active = 0;
  let maximum = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.equal(maximum, 2);
});

