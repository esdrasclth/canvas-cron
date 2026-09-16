const config = require('./config');
const { escapeHtml } = require('./telegram');

const TYPE_ICONS = {
  assignment: '📝',
  quiz: '🧪',
  discussion_topic: '💬',
};

function formatDate(value) {
  return new Intl.DateTimeFormat('es-HN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: config.timezone,
  }).format(new Date(value));
}

function formatTime(value) {
  return new Intl.DateTimeFormat('es-HN', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.timezone,
  }).format(new Date(value));
}

function formatDayName(value) {
  const label = new Intl.DateTimeFormat('es-HN', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: config.timezone,
  }).format(new Date(value));
  return label.charAt(0).toUpperCase() + label.slice(1);
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

// "en 3 h", "en 2 días", "hace 5 h": da contexto inmediato sin obligar a
// calcular mentalmente a partir de la fecha.
function relativeTime(value, now = new Date()) {
  const diffMinutes = Math.round((new Date(value) - now) / 60_000);
  const past = diffMinutes < 0;
  const minutes = Math.abs(diffMinutes);
  const prefix = past ? 'hace' : 'en';

  if (minutes < 60) return `${prefix} ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${prefix} ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${prefix} ${days} día${days === 1 ? '' : 's'}`;
  const months = Math.round(days / 30);
  return `${prefix} ${months} mes${months === 1 ? '' : 'es'}`;
}

function formatPoints(points) {
  if (points == null) return null;
  const value = Number(points);
  if (!Number.isFinite(value)) return null;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} pts`;
}

function dueBucket(task, now = new Date()) {
  const due = new Date(task.dueAt);
  if (due < now) return 'overdue';

  if (localDateKey(due) === localDateKey(now)) return 'today';

  const tomorrow = new Date(now.getTime() + 86_400_000);
  if (localDateKey(due) === localDateKey(tomorrow)) return 'tomorrow';

  return due <= new Date(now.getTime() + 7 * 86_400_000) ? 'week' : 'later';
}

// Ficha de tres lineas: identidad, curso y datos accionables.
function taskCard(task, now = new Date(), { showDay = true } = {}) {
  const icon = TYPE_ICONS[task.type] || '📌';
  const details = [
    showDay ? `${formatDayName(task.dueAt)}, ${formatTime(task.dueAt)}` : formatTime(task.dueAt),
    relativeTime(task.dueAt, now),
    formatPoints(task.points),
  ].filter(Boolean);

  return [
    `${icon} <b>${escapeHtml(task.title)}</b>`,
    `   <i>${escapeHtml(task.course)}</i>`,
    `   ${escapeHtml(details.join(' · '))} · <a href="${escapeHtml(task.url)}">abrir</a>`,
  ].join('\n');
}

function taskLines(task, now = new Date()) {
  return [
    `<b>${escapeHtml(task.title)}</b>`,
    `<i>${escapeHtml(task.course)}</i>`,
    '',
    `📅 Entrega: ${escapeHtml(formatDate(task.dueAt))} (${escapeHtml(relativeTime(task.dueAt, now))})`,
    formatPoints(task.points) ? `🎯 Valor: ${escapeHtml(formatPoints(task.points))}` : null,
    `<a href="${escapeHtml(task.url)}">Abrir en Canvas</a>`,
  ].filter((line) => line !== null);
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
          text: ['🆕 <b>Nueva actividad en Canvas</b>', '', ...taskLines(task, now)].join('\n'),
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
            `<b>${escapeHtml(task.title)}</b>`,
            `<i>${escapeHtml(task.course)}</i>`,
            '',
            `❌ Antes: ${escapeHtml(formatDate(previous.due_at))}`,
            `✅ Ahora: ${escapeHtml(formatDate(task.dueAt))} (${escapeHtml(relativeTime(task.dueAt, now))})`,
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
          const urgent = threshold <= 6;
          alerts.push({
            key, taskKey: task.key, kind: `deadline_${threshold}h`,
            text: [
              `${urgent ? '🔴' : '⏰'} <b>Vence en menos de ${threshold} hora${threshold === 1 ? '' : 's'}</b>`,
              '', ...taskLines(task, now),
            ].join('\n'),
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
            '', ...taskLines(task, now),
          ].join('\n'),
        });
      }
    }
  }

  return alerts;
}

const SECTIONS = [
  { bucket: 'overdue', title: '🚨 VENCIDAS', showDay: true },
  { bucket: 'today', title: '🔴 HOY', showDay: false },
  { bucket: 'tomorrow', title: '🟠 MAÑANA', showDay: false },
  { bucket: 'week', title: '🟡 ESTA SEMANA', showDay: true },
  { bucket: 'later', title: '🔵 MÁS ADELANTE', showDay: true },
];

// Agrupa por urgencia en vez de volcar una lista plana: lo que vence primero
// aparece primero y con su propio encabezado.
function buildGroupedList(tasks, now = new Date(), { header, empty }) {
  if (!tasks.length) return empty;

  const sorted = [...tasks].sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  const lines = [header, ''];

  for (const section of SECTIONS) {
    const group = sorted.filter((task) => dueBucket(task, now) === section.bucket);
    if (!group.length) continue;
    lines.push(`${section.title} · ${group.length}`);
    for (const task of group) lines.push(taskCard(task, now, { showDay: section.showDay }));
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function buildDigest(tasks, now = new Date()) {
  const pending = tasks.length;
  const overdue = tasks.filter((task) => dueBucket(task, now) === 'overdue').length;
  const summary = [
    `${pending} pendiente${pending === 1 ? '' : 's'}`,
    overdue ? `${overdue} vencida${overdue === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');

  return buildGroupedList(tasks, now, {
    header: `📚 <b>Resumen de Canvas</b>\n<i>${escapeHtml(formatDayName(now))} · ${escapeHtml(summary)}</i>`,
    empty: `✅ <b>Canvas al día</b>\n<i>${escapeHtml(formatDayName(now))}</i>\n\nNo hay actividades pendientes.`,
  });
}

function shouldSendDigest(database, now = new Date()) {
  if (localHour(now) < config.digestHour) return false;
  const today = localDateKey(now);
  return database.getState('last_digest_date') !== today;
}

module.exports = {
  buildDigest,
  buildGroupedList,
  buildTaskAlerts,
  dueBucket,
  formatDate,
  formatDayName,
  formatPoints,
  formatTime,
  localDateKey,
  relativeTime,
  shouldSendDigest,
  taskCard,
};
