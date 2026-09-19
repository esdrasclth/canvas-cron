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
      type TEXT,
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

    CREATE TABLE IF NOT EXISTS submissions (
      task_key TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      course TEXT NOT NULL,
      url TEXT NOT NULL,
      score REAL,
      points_possible REAL,
      grade TEXT,
      graded_at TEXT,
      seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS course_mutes (
      course TEXT PRIMARY KEY,
      muted_at TEXT NOT NULL
    );

    -- Anuncios ya vistos; el mensaje se guarda en texto plano para /anuncios.
    CREATE TABLE IF NOT EXISTS announcements (
      announcement_key TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      course TEXT NOT NULL,
      author TEXT,
      message TEXT NOT NULL,
      url TEXT NOT NULL,
      posted_at TEXT,
      seen_at TEXT NOT NULL
    );

    -- Lo que el usuario decidió desde los botones de cada aviso.
    CREATE TABLE IF NOT EXISTS task_actions (
      task_key TEXT PRIMARY KEY,
      done_at TEXT,
      snooze_until TEXT,
      updated_at TEXT NOT NULL
    );
  `);

  // Las bases creadas antes de guardar el tipo de actividad se migran aqui.
  const columns = db.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name);
  if (!columns.includes('type')) db.exec('ALTER TABLE tasks ADD COLUMN type TEXT');

  const statements = {
    getTask: db.prepare('SELECT * FROM tasks WHERE task_key = ?'),
    upsertTask: db.prepare(`
      INSERT INTO tasks (
        task_key, title, course, due_at, lock_at, status, url, points, type,
        first_seen_at, last_seen_at, active
      ) VALUES (
        @key, @title, @course, @dueAt, @lockAt, @status, @url, @points, @type,
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
        type = excluded.type,
        last_seen_at = excluded.last_seen_at,
        active = 1
    `),
    deactivateAll: db.prepare('UPDATE tasks SET active = 0'),
    listActive: db.prepare('SELECT * FROM tasks WHERE active = 1 ORDER BY due_at'),
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
    getSubmission: db.prepare('SELECT * FROM submissions WHERE task_key = ?'),
    upsertSubmission: db.prepare(`
      INSERT INTO submissions (
        task_key, title, course, url, score, points_possible, grade, graded_at, seen_at
      ) VALUES (
        @key, @title, @course, @url, @score, @pointsPossible, @grade, @gradedAt, @now
      )
      ON CONFLICT(task_key) DO UPDATE SET
        title = excluded.title,
        course = excluded.course,
        url = excluded.url,
        score = excluded.score,
        points_possible = excluded.points_possible,
        grade = excluded.grade,
        graded_at = excluded.graded_at,
        seen_at = excluded.seen_at
    `),
    listGraded: db.prepare(`
      SELECT * FROM submissions WHERE graded_at IS NOT NULL
      ORDER BY graded_at DESC LIMIT ?
    `),
    hasAnnouncement: db.prepare('SELECT 1 FROM announcements WHERE announcement_key = ?'),
    upsertAnnouncement: db.prepare(`
      INSERT INTO announcements (
        announcement_key, title, course, author, message, url, posted_at, seen_at
      ) VALUES (
        @key, @title, @course, @author, @text, @url, @postedAt, @now
      )
      ON CONFLICT(announcement_key) DO UPDATE SET
        title = excluded.title,
        course = excluded.course,
        author = excluded.author,
        message = excluded.message,
        url = excluded.url,
        posted_at = excluded.posted_at
    `),
    listAnnouncements: db.prepare('SELECT * FROM announcements ORDER BY posted_at DESC LIMIT ?'),
    listMutes: db.prepare('SELECT course FROM course_mutes ORDER BY course'),
    addMute: db.prepare('INSERT OR REPLACE INTO course_mutes (course, muted_at) VALUES (?, ?)'),
    removeMute: db.prepare('DELETE FROM course_mutes WHERE course = ?'),
    getAction: db.prepare('SELECT * FROM task_actions WHERE task_key = ?'),
    setDone: db.prepare(`
      INSERT INTO task_actions (task_key, done_at, snooze_until, updated_at)
      VALUES (?, ?, NULL, ?)
      ON CONFLICT(task_key) DO UPDATE SET done_at = excluded.done_at,
        snooze_until = NULL, updated_at = excluded.updated_at
    `),
    setSnooze: db.prepare(`
      INSERT INTO task_actions (task_key, done_at, snooze_until, updated_at)
      VALUES (?, NULL, ?, ?)
      ON CONFLICT(task_key) DO UPDATE SET snooze_until = excluded.snooze_until,
        updated_at = excluded.updated_at
    `),
    clearSnooze: db.prepare(`
      UPDATE task_actions SET snooze_until = NULL, updated_at = ? WHERE task_key = ?
    `),
    clearAction: db.prepare('DELETE FROM task_actions WHERE task_key = ?'),
    listSnoozed: db.prepare('SELECT * FROM task_actions WHERE snooze_until IS NOT NULL'),
  };

  function rowToTask(row) {
    return {
      key: row.task_key,
      title: row.title,
      course: row.course,
      dueAt: row.due_at,
      lockAt: row.lock_at,
      status: row.status,
      url: row.url,
      points: row.points,
      type: row.type,
    };
  }

  return {
    db,
    getTask: (key) => statements.getTask.get(key),
    // Devuelve las tareas con la misma forma que entrega Canvas, para que los
    // formateadores sirvan igual con datos frescos o guardados.
    listActiveTasks: () => statements.listActive.all().map(rowToTask),
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

    getSubmission: (key) => statements.getSubmission.get(key),
    syncSubmissions(submissions, now) {
      const sync = db.transaction(() => {
        for (const submission of submissions) {
          statements.upsertSubmission.run({ ...submission, now });
        }
      });
      sync();
    },
    listGradedSubmissions: (limit = 20) => statements.listGraded.all(limit),

    hasAnnouncement: (key) => Boolean(statements.hasAnnouncement.get(key)),
    // Espera los anuncios ya convertidos a texto plano (campo text).
    saveAnnouncements(announcements, now) {
      const save = db.transaction(() => {
        for (const announcement of announcements) {
          statements.upsertAnnouncement.run({ ...announcement, now });
        }
      });
      save();
    },
    listRecentAnnouncements: (limit = 10) => statements.listAnnouncements.all(limit),

    listMutedCourses: () => statements.listMutes.all().map((row) => row.course),
    muteCourse: (course, now) => statements.addMute.run(course, now),
    unmuteCourse: (course) => statements.removeMute.run(course).changes > 0,
    isCourseMuted(course) {
      return statements.listMutes.all().some((row) => row.course === course);
    },

    getTaskAction: (key) => statements.getAction.get(key),
    markTaskDone: (key, now) => statements.setDone.run(key, now, now),
    snoozeTask: (key, until, now) => statements.setSnooze.run(key, until, now),
    clearSnooze: (key, now) => statements.clearSnooze.run(now, key),
    clearTaskAction: (key) => statements.clearAction.run(key),
    listSnoozedTasks: () => statements.listSnoozed.all(),

    close: () => db.close(),
  };
}

module.exports = { openDatabase };
