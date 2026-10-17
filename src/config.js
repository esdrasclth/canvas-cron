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
  digestHour: numberValue('DAILY_DIGEST_HOUR', 7),
  reminderHours: (process.env.REMINDER_HOURS || '72,24,6,1')
    .split(',')
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b),
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
};

