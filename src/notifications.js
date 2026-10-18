const config = require('./config');
const { escapeHtml } = require('./telegram');

const TYPE_ICONS = {
  assignment: '📝',
  quiz: '🧪',
  discussion_topic: '💬',
};

const WEEKDAY_INDEX = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
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

function localWeekday(date = new Date()) {
  const short = new Intl.DateTimeFormat('en-US', {
    weekday: 'short', timeZone: config.timezone,
  }).format(date);
  return WEEKDAY_INDEX[short];
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

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function formatPoints(points) {
  const formatted = points == null ? null : formatNumber(points);
  return formatted == null ? null : `${formatted} pts`;
}

function formatScore({ score, points_possible: possible, grade }) {
  const scoreText = formatNumber(score);
  const possibleText = formatNumber(possible);

  if (scoreText == null) return grade ? String(grade) : 'sin nota numérica';
  if (possibleText == null || Number(possible) <= 0) return scoreText;

  const percent = Math.round((Number(score) / Number(possible)) * 100);
  return `${scoreText} / ${possibleText} (${percent}%)`;
}

function dueBucket(task, now = new Date()) {
  const due = new Date(task.dueAt);
  if (due < now) return 'overdue';

  if (localDateKey(due) === localDateKey(now)) return 'today';

  const tomorrow = new Date(now.getTime() + 86_400_000);
  if (localDateKey(due) === localDateKey(tomorrow)) return 'tomorrow';

  return due <= new Date(now.getTime() + 7 * 86_400_000) ? 'week' : 'later';
}

// Ventana de silencio: dentro de ella solo pasan los avisos urgentes, porque
// enterarse a las 3 de la mañana de algo que vence en 5 días no sirve de nada.
function inQuietHours(now = new Date(), quiet = config.quietHours) {
  if (!quiet) return false;
  const hour = localHour(now);
  return quiet.start <= quiet.end
    ? hour >= quiet.start && hour < quiet.end
    : hour >= quiet.start || hour < quiet.end;
}

function isUrgentKind(kind) {
  if (kind === 'overdue') return true;
  const match = /^deadline_(\d+)h$/.exec(String(kind));
  return Boolean(match) && Number(match[1]) <= 6;
}

function shouldHoldAlert(alert, now = new Date()) {
  return inQuietHours(now) && !isUrgentKind(alert.kind);
}

function taskKeyboard(task) {
  return {
    inline_keyboard: [[
      { text: '✅ Ya la entregué', callback_data: `done:${task.key}` },
      { text: '⏰ Recordar en 2 h', callback_data: `snooze:${task.key}:120` },
    ]],
  };
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
  const muted = new Set(database.listMutedCourses());

  for (const task of tasks) {
    if (muted.has(task.course)) continue;

    const action = database.getTaskAction(task.key);
    // Marcada como entregada a mano: no se vuelve a insistir.
    if (action?.done_at) continue;

    if (action?.snooze_until) {
      if (new Date(action.snooze_until) > now) continue;
      // Venció el aplazamiento: un único recordatorio y se libera la tarea.
      const key = `snooze:${task.key}:${action.snooze_until}`;
      if (!database.hasNotification(key)) {
        alerts.push({
          key,
          taskKey: task.key,
          kind: 'snoozed',
          clearSnooze: true,
          text: ['⏰ <b>Recordatorio aplazado</b>', '', ...taskLines(task, now)].join('\n'),
          keyboard: taskKeyboard(task),
        });
      }
      continue;
    }

    const previous = database.getTask(task.key);
    const dueAt = new Date(task.dueAt);
    const hoursRemaining = (dueAt - now) / 3_600_000;

    if (!previous && (hasPriorTasks || config.sendInitialNewTasks)) {
      const key = `new:${task.key}:${task.dueAt}`;
      if (!database.hasNotification(key)) {
        alerts.push({
          key, taskKey: task.key, kind: 'new',
          text: ['🆕 <b>Nueva actividad en Canvas</b>', '', ...taskLines(task, now)].join('\n'),
          keyboard: taskKeyboard(task),
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
          keyboard: taskKeyboard(task),
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
            keyboard: taskKeyboard(task),
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
          keyboard: closed ? null : taskKeyboard(task),
        });
      }
    }
  }

  return alerts;
}

function sameScore(a, b) {
  const left = a == null ? null : Number(a);
  const right = b == null ? null : Number(b);
  return left === right;
}

function buildGradeAlerts(submissions, database, now = new Date()) {
  // La primera sincronización solo guarda el historial: avisar de un semestre
  // entero de calificaciones viejas no le sirve a nadie.
  const initialized = database.getState('grades_initialized') === '1';
  const muted = new Set(database.listMutedCourses());
  const alerts = [];

  for (const submission of submissions) {
    const previous = database.getSubmission(submission.key);
    const changed = !previous
      || previous.graded_at !== submission.gradedAt
      || !sameScore(previous.score, submission.score);
    if (!changed || !initialized || muted.has(submission.course)) continue;

    const key = `graded:${submission.key}:${submission.gradedAt}:${submission.score}`;
    if (database.hasNotification(key)) continue;

    const scoreText = formatScore({
      score: submission.score,
      points_possible: submission.pointsPossible,
      grade: submission.grade,
    });

    alerts.push({
      key,
      taskKey: submission.key,
      kind: 'graded',
      text: [
        previous ? '🔄 <b>Cambió una calificación</b>' : '🎓 <b>Nueva calificación</b>',
        '',
        `<b>${escapeHtml(submission.title)}</b>`,
        `<i>${escapeHtml(submission.course)}</i>`,
        '',
        `📊 Nota: <b>${escapeHtml(scoreText)}</b>`,
        `🗓️ Calificado ${escapeHtml(relativeTime(submission.gradedAt, now))}`,
        `<a href="${escapeHtml(submission.url)}">Abrir en Canvas</a>`,
      ].join('\n'),
    });
  }

  return alerts;
}

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü',
  iquest: '¿', iexcl: '¡', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

// Canvas entrega los anuncios en HTML del editor; Telegram solo acepta unas
// pocas etiquetas y rechaza el mensaje entero si una no cuadra. Se pasa a texto
// plano conservando párrafos, viñetas y el destino de los enlaces.
function htmlToText(html) {
  const text = String(html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (match, href, inner) => {
      const label = inner.replace(/<[^>]+>/g, '').trim();
      const target = decodeEntities(href);
      if (!/^https?:/i.test(target)) return label;
      const plainLabel = decodeEntities(label);
      return !plainLabel || plainLabel === target ? target : `${label} (${target})`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|h[1-6]|ul|ol|tr|table|blockquote|pre)>/gi, '\n\n')
    .replace(/<\/(td|th)>/gi, '  ')
    .replace(/<[^>]+>/g, '');

  return decodeEntities(text)
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Corta por una frontera de palabra para que el mensaje quepa en uno solo.
function truncateText(text, limit) {
  if (text.length <= limit) return { text, truncated: false };
  const cut = text.slice(0, limit);
  const boundary = cut.lastIndexOf(' ');
  return { text: `${(boundary > limit * 0.8 ? cut.slice(0, boundary) : cut).trimEnd()}…`, truncated: true };
}

// Deja margen para encabezado, adjuntos y enlace dentro de los 4096 de Telegram.
const ANNOUNCEMENT_BODY_LIMIT = 3300;

function buildAnnouncementAlerts(announcements, database, now = new Date()) {
  // Igual que con las notas: la primera pasada solo registra lo que ya existía.
  const initialized = database.getState('announcements_initialized') === '1';
  if (!initialized) return [];

  const muted = new Set(database.listMutedCourses());
  const alerts = [];

  for (const announcement of announcements) {
    if (muted.has(announcement.course) || database.hasAnnouncement(announcement.key)) continue;

    const key = `announcement:${announcement.key}`;
    if (database.hasNotification(key)) continue;

    const plain = announcement.text ?? htmlToText(announcement.message);
    const body = truncateText(plain, ANNOUNCEMENT_BODY_LIMIT);
    const meta = [
      announcement.author,
      announcement.postedAt ? relativeTime(announcement.postedAt, now) : null,
    ].filter(Boolean).join(' · ');
    const attachments = announcement.attachments || [];

    alerts.push({
      key,
      taskKey: announcement.key,
      kind: 'announcement',
      text: [
        '📢 <b>Nuevo anuncio</b>',
        '',
        `<b>${escapeHtml(announcement.title)}</b>`,
        `<i>${escapeHtml(announcement.course)}${meta ? ` · ${escapeHtml(meta)}` : ''}</i>`,
        '',
        body.text ? escapeHtml(body.text) : '<i>(Anuncio sin texto)</i>',
        attachments.length ? `\n📎 Adjuntos: ${escapeHtml(attachments.join(', '))}` : null,
        '',
        `<a href="${escapeHtml(announcement.url)}">${body.truncated ? 'Leer completo en Canvas' : 'Abrir en Canvas'}</a>`,
      ].filter((line) => line !== null).join('\n'),
    });
  }

  return alerts;
}

function buildAnnouncementsList(rows, now = new Date()) {
  if (!rows.length) {
    return '📢 <b>Anuncios</b>\n\nTodavía no hay anuncios registrados.';
  }

  const lines = ['📢 <b>Anuncios recientes</b>', ''];
  for (const row of rows) {
    const snippet = truncateText(String(row.message || '').replace(/\s+/g, ' '), 180).text;
    lines.push(
      `<b>${escapeHtml(row.title)}</b>`,
      `   <i>${escapeHtml(row.course)}${row.posted_at ? ` · ${escapeHtml(relativeTime(row.posted_at, now))}` : ''}</i>`,
      snippet ? `   ${escapeHtml(snippet)}` : null,
      `   <a href="${escapeHtml(row.url)}">abrir</a>`,
      '',
    );
  }

  return lines.filter((line) => line !== null).join('\n').trimEnd();
}

function recentGradeLine(row, now = new Date()) {
  return `• <b>${escapeHtml(row.title)}</b> — ${escapeHtml(formatScore(row))}\n   <i>${escapeHtml(row.course)} · ${escapeHtml(relativeTime(row.graded_at, now))}</i>`;
}

function recentAnnouncementLine(row, now = new Date()) {
  const when = row.posted_at ? ` · ${escapeHtml(relativeTime(row.posted_at, now))}` : '';
  return `• <a href="${escapeHtml(row.url)}"><b>${escapeHtml(row.title)}</b></a>\n   <i>${escapeHtml(row.course)}${when}</i>`;
}

// Bloque de /revisar: dice si hubo novedades y, haya o no, muestra lo último
// registrado para que una revisión sin cambios no parezca vacía o rota.
function buildRecentSection({
  heading, fresh = 0, held = 0, error = null, skipped = [], rows = [], formatRow, now = new Date(), labels,
}) {
  const lines = [heading];

  if (error) {
    lines.push(`⚠️ No pude consultarlas en Canvas: <i>${escapeHtml(String(error).slice(0, 200))}</i>`);
  } else if (held) {
    lines.push(`${fresh} ${fresh === 1 ? labels.one : labels.many}; te ${fresh === 1 ? 'llegará' : 'llegarán'} al terminar las horas de silencio.`);
  } else if (fresh) {
    lines.push(`${fresh} ${fresh === 1 ? labels.one : labels.many}: ${fresh === 1 ? labels.sentOne : labels.sentMany} arriba.`);
  } else {
    lines.push(labels.none);
  }

  if (skipped.length) lines.push(`<i>Sin acceso en: ${escapeHtml(skipped.join(', '))}</i>`);

  if (rows.length) {
    lines.push('', `<i>${labels.recent}</i>`);
    for (const row of rows) lines.push(formatRow(row, now));
  } else if (!error) {
    lines.push(`<i>${labels.empty}</i>`);
  }

  return lines.join('\n');
}

function buildGradesSection(options) {
  return buildRecentSection({
    heading: '🎓 <b>Calificaciones</b>',
    formatRow: recentGradeLine,
    labels: {
      one: 'calificación nueva',
      many: 'calificaciones nuevas',
      sentOne: 'te la envié',
      sentMany: 'te las envié',
      none: 'No hay calificaciones nuevas.',
      recent: options.rows?.length === 1 ? 'Última registrada:' : 'Últimas registradas:',
      empty: 'Todavía no hay calificaciones registradas.',
    },
    ...options,
  });
}

function buildAnnouncementsSection(options) {
  return buildRecentSection({
    heading: '📢 <b>Anuncios</b>',
    formatRow: recentAnnouncementLine,
    labels: {
      one: 'anuncio nuevo',
      many: 'anuncios nuevos',
      sentOne: 'te lo envié',
      sentMany: 'te los envié',
      none: 'No hay anuncios nuevos.',
      recent: options.rows?.length === 1 ? 'Último registrado:' : 'Últimos registrados:',
      empty: 'Todavía no hay anuncios registrados.',
    },
    ...options,
  });
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

// Repaso del domingo: solo los proximos 7 dias y lo vencido, con los puntos en
// juego para saber donde conviene poner el esfuerzo.
function buildWeeklyDigest(tasks, now = new Date()) {
  const week = tasks.filter((task) => ['overdue', 'today', 'tomorrow', 'week'].includes(dueBucket(task, now)));
  const points = week.reduce((total, task) => total + (Number(task.points) || 0), 0);
  const summary = [
    `${week.length} entrega${week.length === 1 ? '' : 's'} en 7 días`,
    points > 0 ? `${formatNumber(points)} pts en juego` : null,
  ].filter(Boolean).join(' · ');

  return buildGroupedList(week, now, {
    header: `🗓️ <b>La semana que viene</b>\n<i>${escapeHtml(summary)}</i>`,
    empty: `🎉 <b>Semana despejada</b>\n\nNo hay entregas en los próximos 7 días.`,
  });
}

function buildGradesList(rows, now = new Date(), { limit = 15 } = {}) {
  if (!rows.length) {
    return '🎓 <b>Calificaciones</b>\n\nTodavía no hay notas registradas.';
  }

  const byCourse = new Map();
  for (const row of rows.slice(0, limit)) {
    if (!byCourse.has(row.course)) byCourse.set(row.course, []);
    byCourse.get(row.course).push(row);
  }

  const lines = ['🎓 <b>Calificaciones recientes</b>', ''];
  for (const [course, items] of byCourse) {
    const percents = items
      .filter((item) => item.score != null && Number(item.points_possible) > 0)
      .map((item) => (Number(item.score) / Number(item.points_possible)) * 100);
    const average = percents.length
      ? ` · promedio ${Math.round(percents.reduce((a, b) => a + b, 0) / percents.length)}%`
      : '';

    lines.push(`📘 <b>${escapeHtml(course)}</b><i>${escapeHtml(average)}</i>`);
    for (const item of items) {
      lines.push(`   • ${escapeHtml(item.title)} — <b>${escapeHtml(formatScore(item))}</b> · ${escapeHtml(relativeTime(item.graded_at, now))}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function shouldSendDigest(database, now = new Date()) {
  if (localHour(now) < config.digestHour) return false;
  const today = localDateKey(now);
  return database.getState('last_digest_date') !== today;
}

function shouldSendWeekly(database, now = new Date()) {
  if (localWeekday(now) !== config.weeklyDigestDay) return false;
  if (localHour(now) < config.weeklyDigestHour) return false;
  return database.getState('last_weekly_date') !== localDateKey(now);
}

module.exports = {
  buildAnnouncementAlerts,
  buildAnnouncementsList,
  buildAnnouncementsSection,
  buildGradesSection,
  buildDigest,
  buildGradeAlerts,
  buildGradesList,
  buildGroupedList,
  buildTaskAlerts,
  buildWeeklyDigest,
  dueBucket,
  formatDate,
  formatDayName,
  formatPoints,
  formatScore,
  formatTime,
  htmlToText,
  inQuietHours,
  isUrgentKind,
  localDateKey,
  localWeekday,
  relativeTime,
  shouldHoldAlert,
  shouldSendDigest,
  shouldSendWeekly,
  taskCard,
  taskKeyboard,
  truncateText,
};
