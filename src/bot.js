const fs = require('node:fs');
const config = require('./config');
const {
  buildAnnouncementsList, buildAnnouncementsSection, buildDigest, buildGradesList, buildGradesSection, buildGroupedList, buildWeeklyDigest, dueBucket,
  formatDate, inQuietHours, relativeTime,
} = require('./notifications');
const { installAuthState, readAuthState, summarizeAuthState } = require('./storage');
const {
  answerCallbackQuery, clearKeyboard, downloadFile, escapeHtml, getUpdates,
  sendTelegramMessage, setMyCommands,
} = require('./telegram');

const COMMANDS = [
  { command: 'tareas', description: 'Todas las actividades pendientes' },
  { command: 'hoy', description: 'Lo que vence hoy' },
  { command: 'semana', description: 'Los próximos 7 días' },
  { command: 'vencidas', description: 'Actividades ya vencidas' },
  { command: 'notas', description: 'Calificaciones recientes' },
  { command: 'anuncios', description: 'Anuncios recientes de los cursos' },
  { command: 'resumen', description: 'El resumen diario, ahora mismo' },
  { command: 'repaso', description: 'El repaso semanal con los puntos en juego' },
  { command: 'revisar', description: 'Consultar Canvas en este momento' },
  { command: 'sesion', description: 'Estado de la sesión y cómo renovarla' },
  { command: 'silenciar', description: 'Silenciar o reactivar un curso' },
  { command: 'estado', description: 'Estado del monitor' },
  { command: 'ayuda', description: 'Ver los comandos disponibles' },
];

function helpText() {
  const lines = [
    '🤖 <b>Monitor de Canvas CEUTEC</b>',
    '',
    'Reviso Canvas cada 30 minutos y aviso cuando hay novedades.',
    `Resumen diario a las ${String(config.digestHour).padStart(2, '0')}:00 y repaso semanal los domingos.`,
    '',
    '<b>Comandos</b>',
  ];
  for (const { command, description } of COMMANDS) lines.push(`/${command} — ${description}`);
  lines.push(
    '',
    '<b>Botones de cada aviso</b>',
    '✅ <i>Ya la entregué</i> deja de insistir con esa actividad.',
    '⏰ <i>Recordar en 2 h</i> la aplaza y vuelve a avisarte luego.',
    '',
    'Para renovar la sesión, envíame el archivo <code>unitec.json</code> como documento.',
  );
  return lines.join('\n');
}

function withDatabase(handler) {
  // Carga diferida: asi el enrutador de comandos se puede importar (y probar)
  // sin el binario nativo de SQLite.
  const { openDatabase } = require('./database');
  // Se abre y cierra por comando para ver siempre lo que escribió el cron.
  const database = openDatabase();
  try {
    return handler(database);
  } finally {
    database.close();
  }
}

function lastUpdateLabel(database, now) {
  const last = database.getState('last_success_at');
  if (!last) return 'sin revisiones todavía';
  return `actualizado ${relativeTime(last, now)}`;
}

function listCommand({ header, empty, filter }) {
  return async () => {
    const now = new Date();
    return withDatabase((database) => {
      const tasks = database.listActiveTasks().filter((task) => (filter ? filter(task, now) : true));
      const footer = `\n\n<i>${escapeHtml(lastUpdateLabel(database, now))}</i>`;
      return buildGroupedList(tasks, now, { header, empty }) + footer;
    });
  };
}

// Si la ultima lectura fallo, la lista puede estar vacia o vieja: se dice.
function withSourceError(text, error) {
  if (!error) return text;
  return `${text}\n\n⚠️ <i>La última consulta a Canvas falló: ${escapeHtml(error.slice(0, 200))}</i>`;
}

function knownCourses(database) {
  return [...new Set([
    ...database.listActiveTasks().map((task) => task.course),
    ...database.listGradedSubmissions(200).map((row) => row.course),
    ...database.listRecentAnnouncements(200).map((row) => row.course),
  ])].sort();
}

async function statusCommand() {
  const now = new Date();
  const session = await readAuthState().then((state) => (state ? summarizeAuthState(state, now) : null));

  return withDatabase((database) => {
    const tasks = database.listActiveTasks();
    const lastSuccess = database.getState('last_success_at');
    const lastError = database.getState('last_error');
    const muted = database.listMutedCourses();
    const snoozed = database.listSnoozedTasks().length;
    const counts = tasks.reduce((acc, task) => {
      const bucket = dueBucket(task, now);
      acc[bucket] = (acc[bucket] || 0) + 1;
      return acc;
    }, {});

    const quiet = config.quietHours
      ? `${String(config.quietHours.start).padStart(2, '0')}:00–${String(config.quietHours.end).padStart(2, '0')}:00${inQuietHours(now) ? ' (activo ahora)' : ''}`
      : 'desactivadas';

    return [
      '⚙️ <b>Estado del monitor</b>',
      '',
      `Sesión de UNITEC: ${fs.existsSync(config.authFile) ? '✅ activa' : '❌ falta renovarla'}`,
      session?.earliestExpiry
        ? `Caduca: ${escapeHtml(formatDate(session.earliestExpiry))} (${escapeHtml(relativeTime(session.earliestExpiry, now))})`
        : null,
      `Avisos: ${config.telegramDryRun ? '🔇 simulación' : '🔔 activos'}`,
      `Última revisión: ${lastSuccess ? `${escapeHtml(formatDate(lastSuccess))} (${escapeHtml(relativeTime(lastSuccess, now))})` : 'ninguna'}`,
      lastError ? `Último error: ${escapeHtml(lastError.slice(0, 200))}` : 'Sin errores registrados',
      '',
      `Pendientes: <b>${tasks.length}</b>`,
      `Vencidas ${counts.overdue || 0} · hoy ${counts.today || 0} · mañana ${counts.tomorrow || 0} · esta semana ${counts.week || 0} · después ${counts.later || 0}`,
      `Calificaciones guardadas: ${database.listGradedSubmissions(500).length}`,
      `Anuncios guardados: ${database.listRecentAnnouncements(500).length}`,
      database.getState('grades_error') ? `⚠️ Calificaciones: ${escapeHtml(database.getState('grades_error').slice(0, 200))}` : null,
      database.getState('announcements_error') ? `⚠️ Anuncios: ${escapeHtml(database.getState('announcements_error').slice(0, 200))}` : null,
      database.getState('grades_skipped') ? `Sin acceso a notas en: ${escapeHtml(database.getState('grades_skipped'))}` : null,
      database.getState('announcements_skipped') ? `Sin acceso a anuncios en: ${escapeHtml(database.getState('announcements_skipped'))}` : null,
      snoozed ? `Aplazadas: ${snoozed}` : null,
      muted.length ? `Cursos silenciados: ${escapeHtml(muted.join(', '))}` : 'Ningún curso silenciado',
      '',
      `Resumen diario: ${String(config.digestHour).padStart(2, '0')}:00 (${escapeHtml(config.timezone)})`,
      `Repaso semanal: domingo ${String(config.weeklyDigestHour).padStart(2, '0')}:00`,
      `Recordatorios: ${config.reminderHours.join(', ')} h antes de vencer`,
      `Horas de silencio: ${escapeHtml(quiet)}`,
    ].filter((line) => line !== null).join('\n');
  });
}

async function sessionCommand() {
  const now = new Date();
  const state = await readAuthState();
  if (!state) {
    return [
      '🔐 <b>Sin sesión guardada</b>',
      '',
      'Ejecuta <code>npm run portal</code> en tu computadora, inicia sesión y envíame',
      'el archivo <code>playwright/.auth/unitec.json</code> como documento en este chat.',
    ].join('\n');
  }

  const summary = summarizeAuthState(state, now);
  return [
    '🔐 <b>Sesión de Canvas</b>',
    '',
    `${summary.cookies} cookies · ${summary.sessionOnly} de sesión · ${summary.expired} caducadas`,
    summary.earliestExpiry
      ? `Primera en caducar: <b>${escapeHtml(formatDate(summary.earliestExpiry))}</b> (${escapeHtml(relativeTime(summary.earliestExpiry, now))})`
      : 'Ninguna cookie con fecha futura: la sesión depende de cookies de sesión.',
    '',
    '<b>Para renovarla</b>',
    '1. <code>npm run portal</code> en tu computadora e inicia sesión.',
    '2. Envíame <code>playwright/.auth/unitec.json</code> como documento aquí.',
    '',
    'La instalo, guardo una copia de la anterior y la pruebo contra Canvas.',
  ].filter(Boolean).join('\n');
}

// Cuantas notas y anuncios recientes se muestran tras /revisar.
const RECENT_LIMIT = 5;

async function checkCommand() {
  // Se carga aqui para que un fallo de better-sqlite3 o Playwright no impida
  // que el resto de los comandos respondan.
  const { runCheck } = require('./checker');
  const summary = await runCheck();
  if (!summary) return '⏳ Ya hay una revisión en curso. Intenta de nuevo en un momento.';

  const now = new Date();
  const recent = withDatabase((database) => ({
    grades: database.listGradedSubmissions(RECENT_LIMIT),
    announcements: database.listRecentAnnouncements(RECENT_LIMIT),
  }));

  const sections = [[
    '✅ <b>Revisión completada</b>',
    '',
    `Pendientes: <b>${summary.pendingTasks}</b>`,
    `Avisos enviados: ${summary.alertsDelivered}`,
    summary.alertsHeldForQuietHours ? `Retenidos por horas de silencio: ${summary.alertsHeldForQuietHours}` : null,
  ].filter((line) => line !== null).join('\n')];

  if (config.trackGrades) {
    sections.push(buildGradesSection({
      fresh: summary.gradeAlerts,
      held: summary.gradesHeld,
      error: summary.gradesError,
      skipped: summary.gradesSkipped,
      rows: recent.grades,
      now,
    }));
  }
  if (config.trackAnnouncements) {
    sections.push(buildAnnouncementsSection({
      fresh: summary.announcementAlerts,
      held: summary.announcementsHeld,
      error: summary.announcementsError,
      skipped: summary.announcementsSkipped,
      rows: recent.announcements,
      now,
    }));
  }

  sections.push('<i>Usa /tareas, /notas o /anuncios para ver más.</i>');
  return sections.join('\n\n');
}

function muteCommand(args) {
  const now = new Date().toISOString();
  return withDatabase((database) => {
    const muted = database.listMutedCourses();
    const courses = knownCourses(database);

    if (!args) {
      const lines = ['🔕 <b>Silenciar un curso</b>', '', 'Uso: <code>/silenciar Programación</code>', ''];
      if (muted.length) {
        lines.push('<b>Silenciados ahora</b>');
        for (const course of muted) lines.push(`• ${escapeHtml(course)} — <code>/activar ${escapeHtml(course)}</code>`);
        lines.push('');
      }
      lines.push('<b>Cursos conocidos</b>');
      for (const course of courses) lines.push(`• ${escapeHtml(course)}`);
      return lines.join('\n');
    }

    const matches = courses.filter((course) => course.toLowerCase().includes(args.toLowerCase()));
    if (!matches.length) {
      return `No encontré un curso que contenga «${escapeHtml(args)}».\n\nUsa /silenciar sin texto para ver la lista.`;
    }
    if (matches.length > 1) {
      return [`«${escapeHtml(args)}» coincide con varios cursos:`, '', ...matches.map((c) => `• ${escapeHtml(c)}`), '', 'Sé más específico.'].join('\n');
    }

    database.muteCourse(matches[0], now);
    return `🔕 Silenciado <b>${escapeHtml(matches[0])}</b>.\n\nNo te avisaré de sus actividades, calificaciones ni anuncios. Para revertirlo: <code>/activar ${escapeHtml(matches[0])}</code>`;
  });
}

function unmuteCommand(args) {
  return withDatabase((database) => {
    const muted = database.listMutedCourses();
    if (!muted.length) return 'No hay ningún curso silenciado.';
    if (!args) {
      return ['🔔 <b>Reactivar un curso</b>', '', ...muted.map((c) => `• <code>/activar ${escapeHtml(c)}</code>`)].join('\n');
    }

    const matches = muted.filter((course) => course.toLowerCase().includes(args.toLowerCase()));
    if (!matches.length) return `Ningún curso silenciado contiene «${escapeHtml(args)}».`;
    if (matches.length > 1) {
      return [`«${escapeHtml(args)}» coincide con varios:`, '', ...matches.map((c) => `• ${escapeHtml(c)}`)].join('\n');
    }

    database.unmuteCourse(matches[0]);
    return `🔔 Reactivado <b>${escapeHtml(matches[0])}</b>.`;
  });
}

const HANDLERS = {
  ayuda: async () => helpText(),
  start: async () => helpText(),
  help: async () => helpText(),
  tareas: listCommand({
    header: '📋 <b>Actividades pendientes</b>',
    empty: '✅ <b>Sin pendientes</b>\n\nNo hay actividades por entregar.',
  }),
  hoy: listCommand({
    header: '🔴 <b>Vence hoy</b>',
    empty: '👍 <b>Nada vence hoy</b>',
    filter: (task, now) => dueBucket(task, now) === 'today',
  }),
  semana: listCommand({
    header: '🗓️ <b>Próximos 7 días</b>',
    empty: '👍 <b>Nada vence esta semana</b>',
    filter: (task, now) => ['today', 'tomorrow', 'week'].includes(dueBucket(task, now)),
  }),
  vencidas: listCommand({
    header: '🚨 <b>Actividades vencidas</b>',
    empty: '✅ <b>Ninguna vencida</b>',
    filter: (task, now) => dueBucket(task, now) === 'overdue',
  }),
  notas: async () => {
    const now = new Date();
    return withDatabase((database) => withSourceError(
      buildGradesList(database.listGradedSubmissions(15), now),
      database.getState('grades_error'),
    ));
  },
  anuncios: async () => {
    const now = new Date();
    return withDatabase((database) => withSourceError(
      buildAnnouncementsList(database.listRecentAnnouncements(8), now),
      database.getState('announcements_error'),
    ));
  },
  resumen: async () => {
    const now = new Date();
    return withDatabase((database) => buildDigest(database.listActiveTasks(), now));
  },
  repaso: async () => {
    const now = new Date();
    return withDatabase((database) => buildWeeklyDigest(database.listActiveTasks(), now));
  },
  revisar: checkCommand,
  sesion: sessionCommand,
  silenciar: async (args) => muteCommand(args),
  activar: async (args) => unmuteCommand(args),
  estado: statusCommand,
};

function parseCommand(text) {
  const match = String(text || '').trim().match(/^\/([a-zA-Z_]+)(?:@\w+)?/);
  return match ? match[1].toLowerCase() : null;
}

function parseArgs(text) {
  const trimmed = String(text || '').trim();
  const space = trimmed.indexOf(' ');
  return space === -1 ? '' : trimmed.slice(space + 1).trim();
}

// Las claves de tarea llevan dos puntos (curso:actividad), asi que los minutos
// se leen desde el final en vez de partir por el primer separador.
function parseCallbackData(data) {
  const text = String(data || '');
  if (text.startsWith('done:')) {
    const taskKey = text.slice('done:'.length);
    return taskKey ? { action: 'done', taskKey } : null;
  }
  if (text.startsWith('snooze:')) {
    const rest = text.slice('snooze:'.length);
    const separator = rest.lastIndexOf(':');
    if (separator <= 0) return null;
    const minutes = Number(rest.slice(separator + 1));
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    return { action: 'snooze', taskKey: rest.slice(0, separator), minutes };
  }
  return null;
}

function isAuthorized(chatId) {
  return String(chatId) === String(config.telegramChatId);
}

async function handleDocument(message) {
  const document = message.document;
  const name = document.file_name || '';
  if (!/\.json$/i.test(name) && document.mime_type !== 'application/json') {
    await sendTelegramMessage('Solo entiendo el archivo <code>unitec.json</code> de la sesión de Canvas.');
    return;
  }

  try {
    const buffer = await downloadFile(document.file_id);
    const { getPendingTasks } = require('./canvas');
    const summary = await installAuthState(buffer.toString('utf8'), {
      verify: (candidate) => getPendingTasks({ authFile: candidate }),
    });
    const verification = `✅ Probada contra Canvas: ${summary.verification.tasks.length} pendientes.`;

    await sendTelegramMessage([
      '🔐 <b>Sesión actualizada</b>',
      '',
      `${summary.cookies} cookies instaladas.`,
      summary.earliestExpiry
        ? `Primera en caducar ${escapeHtml(relativeTime(summary.earliestExpiry, new Date()))}.`
        : 'Sin cookies con fecha de caducidad.',
      '',
      verification,
    ].join('\n'));
  } catch (error) {
    await sendTelegramMessage([
      '⚠️ <b>No pude usar ese archivo</b>',
      '',
      escapeHtml(error.message),
      '',
      'La sesión activa no fue reemplazada. Debe ser el <code>unitec.json</code> que genera <code>npm run portal</code>.',
    ].join('\n'));
  }
}

async function handleCallback(query) {
  if (!isAuthorized(query.message?.chat?.id)) return;

  const parsed = parseCallbackData(query.data);
  if (!parsed) {
    await answerCallbackQuery(query.id, 'No entendí ese botón.').catch(() => {});
    return;
  }

  const now = new Date();
  const iso = now.toISOString();
  let notice;

  if (parsed.action === 'done') {
    withDatabase((database) => database.markTaskDone(parsed.taskKey, iso));
    notice = 'Listo: no te vuelvo a avisar de esta actividad.';
  } else {
    const until = new Date(now.getTime() + parsed.minutes * 60_000);
    withDatabase((database) => database.snoozeTask(parsed.taskKey, until.toISOString(), iso));
    notice = `Aplazada: te recuerdo ${relativeTime(until, now)}.`;
  }

  await answerCallbackQuery(query.id, notice).catch(() => {});
  // Sin botones el aviso queda visualmente resuelto.
  await clearKeyboard(query.message.chat.id, query.message.message_id).catch(() => {});
  await sendTelegramMessage(`${parsed.action === 'done' ? '✅' : '⏰'} ${escapeHtml(notice)}`);
}

async function handleMessage(message) {
  // Solo responde al chat configurado: el bot es personal y su enlace es publico.
  if (!isAuthorized(message.chat?.id)) {
    console.log(`Mensaje ignorado de un chat no autorizado: ${message.chat?.id}`);
    return;
  }

  if (message.document) {
    await handleDocument(message);
    return;
  }

  const command = parseCommand(message.text);
  if (!command) return;

  const handler = HANDLERS[command];
  if (!handler) {
    await sendTelegramMessage(`No conozco /${escapeHtml(command)}.\n\n${helpText()}`);
    return;
  }

  try {
    await sendTelegramMessage(await handler(parseArgs(message.text)));
  } catch (error) {
    console.error(`Falló /${command}:`, error.message);
    await sendTelegramMessage(
      `⚠️ No pude completar /${escapeHtml(command)}.\n<i>${escapeHtml(String(error.message).slice(0, 300))}</i>`,
    ).catch(() => {});
  }
}

async function pollOnce({
  fetchUpdates = getUpdates,
  onMessage = handleMessage,
  onCallback = handleCallback,
} = {}) {
  const offset = withDatabase((database) => Number(database.getState('telegram_offset') || 0));
  const updates = await fetchUpdates(offset, config.pollTimeoutSeconds);

  for (const update of updates) {
    // El offset avanza solo despues de completar el handler. Si el proceso cae
    // a mitad, Telegram vuelve a entregar el update en vez de perderlo.
    if (update.message) await onMessage(update.message);
    else if (update.callback_query) await onCallback(update.callback_query);
    withDatabase((database) => {
      database.setState('telegram_offset', String(update.update_id + 1));
      database.setState('telegram_last_poll_at', new Date().toISOString());
      database.setState('telegram_last_poll_error', '');
    });
  }
  if (!updates.length) {
    withDatabase((database) => {
      database.setState('telegram_last_poll_at', new Date().toISOString());
      database.setState('telegram_last_poll_error', '');
    });
  }
  return updates.length;
}

// Vigila que las revisiones sigan ocurriendo: el contenedor puede estar en pie
// mientras la tarea programada dejó de correr, y eso antes pasaba inadvertido.
async function checkHeartbeat(now = new Date()) {
  const state = withDatabase((database) => ({
    lastSuccess: database.getState('last_success_at'),
    alertedAt: database.getState('heartbeat_alert_at'),
  }));
  if (!state.lastSuccess) return 'sin-datos';

  const staleMinutes = (now - new Date(state.lastSuccess)) / 60_000;

  if (staleMinutes < config.heartbeatMinutes) {
    if (!state.alertedAt) return 'ok';
    withDatabase((database) => database.setState('heartbeat_alert_at', ''));
    await sendTelegramMessage([
      '✅ <b>El monitor volvió a funcionar</b>',
      '',
      `Última revisión ${escapeHtml(relativeTime(state.lastSuccess, now))}.`,
    ].join('\n'));
    return 'recuperado';
  }

  if (inQuietHours(now)) return 'silencio';
  // Una advertencia cada 6 horas mientras siga caído.
  if (state.alertedAt && (now - new Date(state.alertedAt)) < 6 * 3_600_000) return 'ya-avisado';

  await sendTelegramMessage([
    '⚠️ <b>El monitor dejó de revisar</b>',
    '',
    `La última revisión correcta fue ${escapeHtml(relativeTime(state.lastSuccess, now))}.`,
    `Lo esperado es una cada 30 minutos.`,
    '',
    'Revisa la tarea programada en Dokploy, o usa /revisar para forzar una ahora.',
  ].join('\n'));
  withDatabase((database) => database.setState('heartbeat_alert_at', now.toISOString()));
  return 'avisado';
}

function startHeartbeat(intervalMs = 10 * 60_000) {
  const timer = setInterval(() => {
    checkHeartbeat().catch((error) => console.error(`Latido falló: ${error.message}`));
  }, intervalMs);
  timer.unref?.();
  return timer;
}

async function startBot() {
  await setMyCommands(COMMANDS).catch((error) => {
    console.error(`No se pudo registrar el menú de comandos: ${error.message}`);
  });
  startHeartbeat();
  console.log('Bot de Telegram escuchando comandos.');

  let backoffMs = 1_000;
  for (;;) {
    try {
      await pollOnce();
      backoffMs = 1_000;
    } catch (error) {
      console.error(`Error al consultar Telegram: ${error.message}`);
      withDatabase((database) => database.setState(
        'telegram_last_poll_error', `${new Date().toISOString()} ${error.message}`.slice(0, 500),
      ));
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }
}

module.exports = {
  COMMANDS,
  checkHeartbeat,
  handleCallback,
  handleMessage,
  helpText,
  parseArgs,
  parseCallbackData,
  parseCommand,
  pollOnce,
  startBot,
  startHeartbeat,
};
