const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/config');
const { deliverAlerts } = require('../src/checker');
const { openDatabase } = require('../src/database');

test('los avisos nuevos y de fecha cambiada sobreviven a la sincronizacion', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-outbox-test-'));
  const originalDatabaseFile = config.databaseFile;
  config.databaseFile = path.join(directory, 'notifications.db');

  const database = openDatabase();
  t.after(async () => {
    database.close();
    config.databaseFile = originalDatabaseFile;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const alerts = [{
    key: 'new:1:2:2026-09-17T20:00:00.000Z',
    taskKey: '1:2',
    kind: 'new',
    text: '<b>Nueva actividad</b>',
  }, {
    key: 'changed:3:4:2026-09-18T20:00:00.000Z',
    taskKey: '3:4',
    kind: 'due_changed',
    text: '<b>Cambio de fecha</b>',
  }];

  let sends = 0;
  const send = async () => {
    sends += 1;
    return { dryRun: false };
  };

  const quietNow = new Date('2026-09-17T08:00:00.000Z'); // 02:00 local
  const held = await deliverAlerts(alerts, database, quietNow, { send });
  assert.equal(held.held, 2);
  assert.equal(sends, 0);
  assert.equal(database.listQueuedAlerts().length, 2);

  database.syncTasks([{
    key: '1:2', title: 'Nueva actividad', course: 'Curso',
    dueAt: '2026-09-17T20:00:00.000Z', lockAt: null, status: 'upcoming',
    url: 'https://example.com/task', points: 10, type: 'assignment',
  }], quietNow.toISOString());

  const daytime = new Date('2026-09-17T18:00:00.000Z'); // 12:00 local
  const delivered = await deliverAlerts([], database, daytime, { send });
  assert.equal(delivered.delivered, 2);
  assert.equal(sends, 2);
  assert.equal(database.listQueuedAlerts().length, 0);
  assert.ok(alerts.every((alert) => database.hasNotification(alert.key)));
});

test('la outbox reanuda desde el ultimo fragmento confirmado', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-outbox-progress-'));
  const originalDatabaseFile = config.databaseFile;
  config.databaseFile = path.join(directory, 'notifications.db');
  const database = openDatabase();
  t.after(async () => {
    database.close();
    config.databaseFile = originalDatabaseFile;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const alert = { key: 'announcement:1:9', taskKey: '1:9', kind: 'announcement', text: 'mensaje largo' };
  const now = new Date('2026-09-17T18:00:00.000Z');
  await assert.rejects(deliverAlerts([alert], database, now, {
    send: async (text, options) => {
      assert.equal(options.startChunk, 0);
      await options.onChunkSent(1);
      throw new Error('fallo en el segundo fragmento');
    },
  }), /segundo fragmento/);

  assert.equal(database.listQueuedAlerts()[0].outboxNextChunk, 1);
  let resumedAt;
  await deliverAlerts([], database, now, {
    send: async (text, options) => {
      resumedAt = options.startChunk;
      await options.onChunkSent(2);
      return { dryRun: false };
    },
  });
  assert.equal(resumedAt, 1);
  assert.equal(database.listQueuedAlerts().length, 0);
  assert.equal(database.hasNotification(alert.key), true);
});
