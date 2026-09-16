const fs = require('node:fs');
const config = require('./config');
const {
  buildDigest, buildGroupedList, dueBucket, formatDate, relativeTime,
} = require('./notifications');
const { escapeHtml, getUpdates, sendTelegramMessage, setMyCommands } = require('./telegram');

const COMMANDS = [
  { command: 'tareas', description: 'Todas las actividades pendientes' },
  { command: 'hoy', description: 'Lo que vence hoy' },
  { command: 'semana', description: 'Los próximos 7 días' },
  { command: 'vencidas', description: 'Actividades ya vencidas' },
  { command: 'resumen', description: 'El resumen diario, ahora mismo' },
  { command: 'revisar', description: 'Consultar Canvas en este momento' },
  { command: 'estado', description: 'Estado del monitor y la sesión' },
  { command: 'ayuda', description: 'Ver los comandos disponibles' },
];

function helpText() {
  const lines = [
    '🤖 <b>Monitor de Canvas CEUTEC</b>',
    '',
    'Reviso Canvas cada 30 minutos y aviso cuando hay novedades.',
    `El resumen diario sale a las ${String(config.digestHour).padStart(2, '0')}:00.`,
    '',
    '<b>Comandos</b>',
  ];
  for (const { command, description } of COMMANDS) lines.push(`/${command} — ${description}`);
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

async function statusCommand() {
  const now = new Date();
  return withDatabase((database) => {
    const tasks = database.listActiveTasks();
    const lastSuccess = database.getState('last_success_at');
    const lastError = database.getState('last_error');
    const sessionReady = fs.existsSync(config.authFile);
    const counts = tasks.reduce((acc, task) => {
      const bucket = dueBucket(task, now);
      acc[bucket] = (acc[bucket] || 0) + 1;
      return acc;
    }, {});

    return [
      '⚙️ <b>Estado del monitor</b>',
      '',
      `Sesión de UNITEC: ${sessionReady ? '✅ activa' : '❌ falta renovarla'}`,
      `Avisos por Telegram: ${config.telegramDryRun ? '🔇 simulación' : '🔔 activos'}`,
      `Última revisión: ${lastSuccess ? `${escapeHtml(formatDate(lastSuccess))} (${escapeHtml(relativeTime(lastSuccess, now))})` : 'ninguna'}`,
      lastError ? `Último error: ${escapeHtml(lastError.slice(0, 200))}` : 'Sin errores registrados',
      '',
      `Pendientes: <b>${tasks.length}</b>`,
      `Vencidas ${counts.overdue || 0} · hoy ${counts.today || 0} · mañana ${counts.tomorrow || 0} · esta semana ${counts.week || 0} · después ${counts.later || 0}`,
      '',
      `Resumen diario: ${String(config.digestHour).padStart(2, '0')}:00 (${escapeHtml(config.timezone)})`,
      `Recordatorios: ${config.reminderHours.join(', ')} h antes de vencer`,
    ].join('\n');
  });
}

async function checkCommand() {
  // Se carga aqui para que un fallo de better-sqlite3 o Playwright no impida
  // que el resto de los comandos respondan.
  const { runCheck } = require('./checker');
  const summary = await runCheck();
  if (!summary) return '⏳ Ya hay una revisión en curso. Intenta de nuevo en un momento.';

  return [
    '✅ <b>Revisión completada</b>',
    '',
    `Pendientes: <b>${summary.pendingTasks}</b>`,
    `Avisos enviados: ${summary.alertsDelivered}`,
    summary.digestSent ? 'Resumen diario enviado.' : null,
    '',
    '<i>Usa /tareas para ver el detalle.</i>',
  ].filter(Boolean).join('\n');
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
  resumen: async () => {
    const now = new Date();
    return withDatabase((database) => buildDigest(database.listActiveTasks(), now));
  },
  revisar: checkCommand,
  estado: statusCommand,
};

function parseCommand(text) {
  const match = String(text || '').trim().match(/^\/([a-zA-Z_]+)(?:@\w+)?/);
  return match ? match[1].toLowerCase() : null;
}

async function handleMessage(message) {
  // Solo responde al chat configurado: el bot es personal y su enlace es publico.
  if (String(message.chat?.id) !== String(config.telegramChatId)) {
    console.log(`Mensaje ignorado de un chat no autorizado: ${message.chat?.id}`);
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
    await sendTelegramMessage(await handler());
  } catch (error) {
    console.error(`Falló /${command}:`, error.message);
    await sendTelegramMessage(
      `⚠️ No pude completar /${escapeHtml(command)}.\n<i>${escapeHtml(String(error.message).slice(0, 300))}</i>`,
    ).catch(() => {});
  }
}

async function pollOnce() {
  const offset = withDatabase((database) => Number(database.getState('telegram_offset') || 0));
  const updates = await getUpdates(offset, config.pollTimeoutSeconds);

  for (const update of updates) {
    // El offset se guarda antes de atender el mensaje para que un comando que
    // falle no se reintente en bucle en cada vuelta.
    withDatabase((database) => database.setState('telegram_offset', String(update.update_id + 1)));
    if (update.message) await handleMessage(update.message);
  }
  return updates.length;
}

async function startBot() {
  await setMyCommands(COMMANDS).catch((error) => {
    console.error(`No se pudo registrar el menú de comandos: ${error.message}`);
  });
  console.log('Bot de Telegram escuchando comandos.');

  let backoffMs = 1_000;
  for (;;) {
    try {
      await pollOnce();
      backoffMs = 1_000;
    } catch (error) {
      console.error(`Error al consultar Telegram: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }
}

module.exports = { COMMANDS, handleMessage, helpText, parseCommand, pollOnce, startBot };
