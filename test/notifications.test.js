const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTaskAlerts } = require('../src/notifications');

function fakeDatabase({ initialized = true, task = null, sent = [] } = {}) {
  return {
    getState: (key) => key === 'initialized' && initialized ? '1' : null,
    getTask: () => task,
    hasNotification: (key) => sent.includes(key),
  };
}

function task(overrides = {}) {
  return {
    key: '1:2',
    title: 'Proyecto final',
    course: 'Curso de prueba',
    dueAt: '2026-09-16T10:00:00.000Z',
    lockAt: '2026-09-16T10:00:00.000Z',
    points: 10,
    status: 'upcoming',
    url: 'https://example.com/task',
    ...overrides,
  };
}

test('selecciona el recordatorio más cercano que corresponde', () => {
  const now = new Date('2026-09-16T07:00:00.000Z');
  const alerts = buildTaskAlerts([task()], fakeDatabase(), now);
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].kind, 'new');
  assert.equal(alerts[1].kind, 'deadline_6h');
});

test('no repite un recordatorio ya enviado', () => {
  const now = new Date('2026-09-16T07:00:00.000Z');
  const sent = ['deadline:1:2:2026-09-16T10:00:00.000Z:6'];
  const alerts = buildTaskAlerts([task()], fakeDatabase({ initialized: false, sent }), now);
  assert.equal(alerts.length, 0);
});

test('detecta una fecha de entrega modificada', () => {
  const now = new Date('2026-09-14T10:00:00.000Z');
  const previous = { due_at: '2026-09-15T10:00:00.000Z' };
  const alerts = buildTaskAlerts([task()], fakeDatabase({ task: previous }), now);
  assert.ok(alerts.some((alert) => alert.kind === 'due_changed'));
});
