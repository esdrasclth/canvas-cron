const path = require('node:path');
const fs = require('node:fs');

// Node 20+ puede cargar .env sin una dependencia adicional. Las variables ya
// presentes en el proceso conservan prioridad sobre el archivo local.
const localEnvFile = path.resolve('.env');
if (fs.existsSync(localEnvFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(localEnvFile);
}

function booleanValue(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  const normalized = value.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} debe ser true o false; se recibio "${value}".`);
}

function numberValue(name, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    const range = Number.isFinite(min) || Number.isFinite(max) ? ` entre ${min} y ${max}` : '';
    throw new Error(`${name} debe ser un numero${integer ? ' entero' : ''}${range}; se recibio "${raw}".`);
  }
  return value;
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
const timezone = process.env.TIMEZONE || 'America/Tegucigalpa';
try {
  new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
} catch {
  throw new Error(`TIMEZONE no es una zona horaria valida: "${timezone}".`);
}

const reminderRaw = process.env.REMINDER_HOURS || '72,24,6,3,1';
const reminderValues = reminderRaw
  .split(',')
  .map((value) => Number(value.trim()));
if (reminderValues.some((value) => !Number.isFinite(value) || value <= 0)) {
  throw new Error(`REMINDER_HOURS solo acepta numeros positivos separados por coma; se recibio "${reminderRaw}".`);
}
const reminderHours = [...new Set(reminderValues)].sort((a, b) => a - b);
const quietHoursRaw = process.env.QUIET_HOURS ?? '23-6';
const quietHours = parseQuietHours(quietHoursRaw);
if (String(quietHoursRaw).trim() && !quietHours) {
  throw new Error(`QUIET_HOURS debe tener el formato 23-6 con horas distintas entre 0 y 23; se recibio "${quietHoursRaw}".`);
}
if (!reminderHours.length) throw new Error('REMINDER_HOURS debe contener al menos un numero positivo.');

module.exports = {
  portalUrl: 'https://portal.unitec.edu/',
  canvasOrigin: 'https://unitechonduras.instructure.com',
  dataDir,
  authFile: path.join(dataDir, 'auth', 'unitec.json'),
  profileDir: path.join(dataDir, 'chrome-profile'),
  databaseFile: path.join(dataDir, 'notifications.db'),
  outputDir: path.join(dataDir, 'output'),
  lockFile: path.join(dataDir, 'check.lock'),
  timezone,
  digestHour: numberValue('DAILY_DIGEST_HOUR', 18, { min: 0, max: 23, integer: true }),
  reminderHours,
  // 0 = domingo. El resumen semanal repasa la carga de los siguientes 7 dias.
  weeklyDigestDay: numberValue('WEEKLY_DIGEST_DAY', 0, { min: 0, max: 6, integer: true }),
  weeklyDigestHour: numberValue('WEEKLY_DIGEST_HOUR', 19, { min: 0, max: 23, integer: true }),
  quietHours,
  // Minutos sin una revision correcta antes de avisar que algo dejo de correr.
  heartbeatMinutes: numberValue('HEARTBEAT_MINUTES', 90, { min: 1 }),
  sessionWarnDays: numberValue('SESSION_WARN_DAYS', 5, { min: 0 }),
  trackGrades: booleanValue('TRACK_GRADES', true),
  trackAnnouncements: booleanValue('TRACK_ANNOUNCEMENTS', true),
  // Cuantos dias hacia atras se piden los anuncios en cada revision.
  announcementLookbackDays: numberValue('ANNOUNCEMENT_LOOKBACK_DAYS', 14, { min: 1, integer: true }),
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
  healthPort: numberValue('PORT', 3000, { min: 1, max: 65535, integer: true }),
  telegramCommands: booleanValue('TELEGRAM_COMMANDS', true),
  pollTimeoutSeconds: numberValue('TELEGRAM_POLL_TIMEOUT', 50, { min: 1, max: 600, integer: true }),
  telegramMaxRetries: numberValue('TELEGRAM_MAX_RETRIES', 3, { min: 0, max: 10, integer: true }),
  telegramRetryBaseMs: numberValue('TELEGRAM_RETRY_BASE_MS', 1000, { min: 10, max: 60_000, integer: true }),
  sqliteBusyTimeoutMs: numberValue('SQLITE_BUSY_TIMEOUT_MS', 5000, { min: 0, max: 60_000, integer: true }),
  lockStaleMinutes: numberValue('CHECK_LOCK_STALE_MINUTES', 20, { min: 1, max: 1440 }),
  canvasRequestTimeoutMs: numberValue('CANVAS_REQUEST_TIMEOUT_MS', 30_000, { min: 1000, max: 300_000, integer: true }),
  canvasMaxRetries: numberValue('CANVAS_MAX_RETRIES', 2, { min: 0, max: 10, integer: true }),
  canvasRetryBaseMs: numberValue('CANVAS_RETRY_BASE_MS', 500, { min: 10, max: 60_000, integer: true }),
  canvasMaxPages: numberValue('CANVAS_MAX_PAGES', 30, { min: 1, max: 1000, integer: true }),
  canvasConcurrency: numberValue('CANVAS_CONCURRENCY', 5, { min: 1, max: 50, integer: true }),
  parseQuietHours,
};
