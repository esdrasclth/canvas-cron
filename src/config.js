const path = require('node:path');

function booleanValue(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function numberValue(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

// "23-6" significa desde las 23:00 hasta las 06:00. Vacio desactiva la ventana.
function parseQuietHours(raw) {
  const match = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(String(raw || '').trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (![start, end].every((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)) return null;
  return start === end ? null : { start, end };
}

const dataDir = path.resolve(process.env.DATA_DIR || 'data');

module.exports = {
  portalUrl: 'https://portal.unitec.edu/',
  canvasOrigin: 'https://unitechonduras.instructure.com',
  dataDir,
  authFile: path.join(dataDir, 'auth', 'unitec.json'),
  profileDir: path.join(dataDir, 'chrome-profile'),
  databaseFile: path.join(dataDir, 'notifications.db'),
  outputDir: path.join(dataDir, 'output'),
  lockFile: path.join(dataDir, 'check.lock'),
  timezone: process.env.TIMEZONE || 'America/Tegucigalpa',
  digestHour: numberValue('DAILY_DIGEST_HOUR', 18),
  reminderHours: (process.env.REMINDER_HOURS || '72,24,6,3,1')
    .split(',')
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b),
  // 0 = domingo. El resumen semanal repasa la carga de los siguientes 7 dias.
  weeklyDigestDay: numberValue('WEEKLY_DIGEST_DAY', 0),
  weeklyDigestHour: numberValue('WEEKLY_DIGEST_HOUR', 19),
  quietHours: parseQuietHours(process.env.QUIET_HOURS ?? '23-6'),
  // Minutos sin una revision correcta antes de avisar que algo dejo de correr.
  heartbeatMinutes: numberValue('HEARTBEAT_MINUTES', 90),
  sessionWarnDays: numberValue('SESSION_WARN_DAYS', 5),
  trackGrades: booleanValue('TRACK_GRADES', true),
  trackAnnouncements: booleanValue('TRACK_ANNOUNCEMENTS', true),
  // Cuantos dias hacia atras se piden los anuncios en cada revision.
  announcementLookbackDays: numberValue('ANNOUNCEMENT_LOOKBACK_DAYS', 14),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  telegramDryRun: booleanValue(
    'TELEGRAM_DRY_RUN',
    !(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
  ),
  unitEmail: process.env.UNITEC_EMAIL || '',
  unitPassword: process.env.UNITEC_PASSWORD || '',
  headless: booleanValue('HEADLESS', true),
  autoRefreshSession: booleanValue('AUTO_REFRESH_SESSION', true),
  sendInitialNewTasks: booleanValue('SEND_INITIAL_NEW_TASKS', false),
  sendStartupDigest: booleanValue('SEND_STARTUP_DIGEST', true),
  healthPort: numberValue('PORT', 3000),
  telegramCommands: booleanValue('TELEGRAM_COMMANDS', true),
  pollTimeoutSeconds: numberValue('TELEGRAM_POLL_TIMEOUT', 50),
  parseQuietHours,
};
