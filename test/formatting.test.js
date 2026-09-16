const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDigest, buildGroupedList, dueBucket, formatPoints, relativeTime } = require('../src/notifications');
const { splitMessage } = require('../src/telegram');
const { parseCommand } = require('../src/bot');

// 2026-09-16T18:00Z son las 12:00 en America/Tegucigalpa (UTC-6).
const now = new Date('2026-09-16T18:00:00.000Z');

function task(overrides = {}) {
  return {
    key: '1:2',
    title: 'Proyecto final',
    course: 'Programación II',
    dueAt: '2026-09-16T23:00:00.000Z',
    status: 'upcoming',
    url: 'https://example.com/task',
    points: 20,
    type: 'assignment',
    ...overrides,
  };
}

test('clasifica cada actividad en su franja de urgencia', () => {
  assert.equal(dueBucket(task({ dueAt: '2026-09-16T10:00:00.000Z' }), now), 'overdue');
  assert.equal(dueBucket(task({ dueAt: '2026-09-16T23:00:00.000Z' }), now), 'today');
  assert.equal(dueBucket(task({ dueAt: '2026-09-17T15:00:00.000Z' }), now), 'tomorrow');
  assert.equal(dueBucket(task({ dueAt: '2026-09-20T15:00:00.000Z' }), now), 'week');
  assert.equal(dueBucket(task({ dueAt: '2026-10-30T15:00:00.000Z' }), now), 'later');
});

test('el resumen agrupa por franja y ordena lo mas urgente primero', () => {
  const text = buildDigest([
    task({ key: 'a', title: 'Lejana', dueAt: '2026-10-30T15:00:00.000Z' }),
    task({ key: 'b', title: 'Vencida', dueAt: '2026-09-15T15:00:00.000Z' }),
    task({ key: 'c', title: 'De hoy', dueAt: '2026-09-16T23:00:00.000Z' }),
  ], now);

  assert.match(text, /3 pendientes/);
  assert.match(text, /1 vencida/);
  assert.ok(text.indexOf('VENCIDAS') < text.indexOf('HOY'), 'las vencidas van antes que las de hoy');
  assert.ok(text.indexOf('HOY') < text.indexOf('MÁS ADELANTE'), 'hoy va antes que lo lejano');
});

test('el resumen sin pendientes no deja secciones vacias', () => {
  const text = buildDigest([], now);
  assert.match(text, /Canvas al día/);
  assert.doesNotMatch(text, /VENCIDAS|HOY|ESTA SEMANA/);
});

test('cada ficha muestra curso, tiempo relativo, puntos y enlace', () => {
  const text = buildGroupedList([task()], now, { header: 'x', empty: 'y' });
  assert.match(text, /Programación II/);
  assert.match(text, /en 5 h/);
  assert.match(text, /20 pts/);
  assert.match(text, /<a href="https:\/\/example\.com\/task">abrir<\/a>/);
});

test('escapa el HTML de los titulos que vienen de Canvas', () => {
  const text = buildGroupedList([task({ title: 'Tarea <script>' })], now, { header: 'x', empty: 'y' });
  assert.match(text, /Tarea &lt;script&gt;/);
  assert.doesNotMatch(text, /<script>/);
});

test('el tiempo relativo distingue pasado y futuro', () => {
  assert.equal(relativeTime('2026-09-16T18:30:00.000Z', now), 'en 30 min');
  assert.equal(relativeTime('2026-09-16T15:00:00.000Z', now), 'hace 3 h');
  assert.equal(relativeTime('2026-09-18T18:00:00.000Z', now), 'en 2 días');
});

test('los puntos se muestran sin decimales inutiles', () => {
  assert.equal(formatPoints(20), '20 pts');
  assert.equal(formatPoints(12.5), '12.5 pts');
  assert.equal(formatPoints(null), null);
});

test('parte los mensajes largos por lineas completas', () => {
  const text = Array.from({ length: 60 }, (_, i) => `linea ${i} ${'x'.repeat(100)}`).join('\n');
  const chunks = splitMessage(text, 1000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 1000);
  assert.equal(chunks.join('\n'), text);
});

test('reconoce los comandos, incluso con el nombre del bot', () => {
  assert.equal(parseCommand('/tareas'), 'tareas');
  assert.equal(parseCommand('/Estado@canvas_ceutec_bot'), 'estado');
  assert.equal(parseCommand('hola'), null);
});
