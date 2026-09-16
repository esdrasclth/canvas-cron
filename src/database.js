const Database = require('better-sqlite3');
const config = require('./config');

function openDatabase() {
  const db = new Database(config.databaseFile);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_key TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      course TEXT NOT NULL,
      due_at TEXT NOT NULL,
      lock_at TEXT,
      status TEXT NOT NULL,
      url TEXT NOT NULL,
      points REAL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS notifications (
      notification_key TEXT PRIMARY KEY,
      task_key TEXT,
      kind TEXT NOT NULL,
      sent_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const statements = {
    getTask: db.prepare('SELECT * FROM tasks WHERE task_key = ?'),
    upsertTask: db.prepare(`
      INSERT INTO tasks (
        task_key, title, course, due_at, lock_at, status, url, points,
        first_seen_at, last_seen_at, active
      ) VALUES (
        @key, @title, @course, @dueAt, @lockAt, @status, @url, @points,
        @now, @now, 1
      )
      ON CONFLICT(task_key) DO UPDATE SET
        title = excluded.title,
        course = excluded.course,
        due_at = excluded.due_at,
        lock_at = excluded.lock_at,
        status = excluded.status,
        url = excluded.url,
        points = excluded.points,
        last_seen_at = excluded.last_seen_at,
        active = 1
    `),
    deactivateAll: db.prepare('UPDATE tasks SET active = 0'),
    hasNotification: db.prepare('SELECT 1 FROM notifications WHERE notification_key = ?'),
    addNotification: db.prepare(`
      INSERT OR IGNORE INTO notifications (notification_key, task_key, kind, sent_at)
      VALUES (?, ?, ?, ?)
    `),
    getState: db.prepare('SELECT value FROM system_state WHERE key = ?'),
    setState: db.prepare(`
      INSERT INTO system_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
  };

  return {
    db,
    getTask: (key) => statements.getTask.get(key),
    syncTasks(tasks, now) {
      const sync = db.transaction(() => {
        statements.deactivateAll.run();
        for (const task of tasks) statements.upsertTask.run({ ...task, now });
      });
      sync();
    },
    hasNotification: (key) => Boolean(statements.hasNotification.get(key)),
    addNotification: (key, taskKey, kind, sentAt) => statements.addNotification.run(key, taskKey, kind, sentAt),
    getState: (key) => statements.getState.get(key)?.value ?? null,
    setState: (key, value) => statements.setState.run(key, value),
    close: () => db.close(),
  };
}

module.exports = { openDatabase };

