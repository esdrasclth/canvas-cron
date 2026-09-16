const config = require('./config');
const { escapeHtml } = require('./telegram');

function formatDate(value) {
  return new Intl.DateTimeFormat('es-HN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: config.timezone,
  }).format(new Date(value));
}

function localDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: config.timezone,
  }).format(date);
}

function localHour(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', {
    hour: '2-digit', hour12: false, timeZone: config.timezone,
  }).format(date));
}

function taskLines(task) {
  return [
    `<b>${escapeHtml(task.title)}</b>`,
    escapeHtml(task.course),
    `Entrega: ${escapeHtml(formatDate(task.dueAt))}`,
    task.points == null ? null : `Valor: ${escapeHtml(task.points)} puntos`,
    `<a href="${escapeHtml(task.url)}">Abrir en Canvas</a>`,
  ].filter(Boolean);
}

function buildTaskAlerts(tasks, database, now = new Date()) {
  const alerts = [];
  const hasPriorTasks = database.getState('initialized') === '1';

  for (const task of tasks) {
    const previous = database.getTask(task.key);
    const dueAt = new Date(task.dueAt);
    const hoursRemaining = (dueAt - now) / 3_600_000;

    if (!previous && (hasPriorTasks || config.sendInitialNewTasks)) {
      const key = `new:${task.key}:${task.dueAt}`;
      if (!database.hasNotification(key)) {
        alerts.push({
          key, taskKey: task.key, kind: 'new',
          text: ['🆕 <b>Nueva actividad en Canvas</b>', '', ...taskLines(task)].join('\n'),
        });
      }
    }

    if (previous && previous.due_at !== task.dueAt) {
      const key = `changed:${task.key}:${task.dueAt}`;
      if (!database.hasNotification(key)) {
        alerts.push({
          key, taskKey: task.key, kind: 'due_changed',
          text: [
            '🔄 <b>Cambió la fecha de entrega</b>', '',
            `<b>${escapeHtml(task.title)}</b>`, escapeHtml(task.course),
            `Antes: ${escapeHtml(formatDate(previous.due_at))}`,
            `Ahora: ${escapeHtml(formatDate(task.dueAt))}`,
            `<a href="${escapeHtml(task.url)}">Abrir en Canvas</a>`,
          ].join('\n'),
        });
      }
    }

    if (hoursRemaining > 0) {
      const threshold = config.reminderHours.find((hours) => hoursRemaining <= hours);
      if (threshold != null) {
        const key = `deadline:${task.key}:${task.dueAt}:${threshold}`;
        if (!database.hasNotification(key)) {
          alerts.push({
            key, taskKey: task.key, kind: `deadline_${threshold}h`,
            text: [`⏰ <b>Vence en menos de ${threshold} hora${threshold === 1 ? '' : 's'}</b>`, '', ...taskLines(task)].join('\n'),
          });
        }
      }
    } else {
      const key = `overdue:${task.key}:${task.dueAt}`;
      if (!database.hasNotification(key)) {
        const closed = task.status === 'overdue_closed';
        alerts.push({
          key, taskKey: task.key, kind: 'overdue',
          text: [
            closed ? '🚨 <b>Actividad vencida y cerrada</b>' : '⚠️ <b>Actividad vencida pendiente</b>',
            '', ...taskLines(task),
          ].join('\n'),
        });
      }
    }
  }

  return alerts;
}

function buildDigest(tasks, now = new Date()) {
  if (!tasks.length) return '✅ <b>Canvas al día</b>\nNo hay actividades pendientes.';
  const upcoming = tasks.filter((task) => task.status === 'upcoming');
  const overdue = tasks.filter((task) => task.status !== 'upcoming');
  const lines = ['📚 <b>Resumen de Canvas</b>', ''];
  if (upcoming.length) {
    lines.push(`<b>Próximas (${upcoming.length})</b>`);
    for (const task of upcoming) {
      lines.push(`• ${escapeHtml(task.title)} — ${escapeHtml(formatDate(task.dueAt))}`);
    }
  }
  if (overdue.length) {
    lines.push('', `<b>Vencidas (${overdue.length})</b>`);
    for (const task of overdue) lines.push(`• ${escapeHtml(task.title)} — ${escapeHtml(task.course)}`);
  }
  return lines.join('\n');
}

function shouldSendDigest(database, now = new Date()) {
  if (localHour(now) < config.digestHour) return false;
  const today = localDateKey(now);
  return database.getState('last_digest_date') !== today;
}

module.exports = {
  buildDigest,
  buildTaskAlerts,
  formatDate,
  localDateKey,
  shouldSendDigest,
};

