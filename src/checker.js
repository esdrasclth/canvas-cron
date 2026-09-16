const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');
const { AuthenticationRequiredError, getPendingTasks } = require('./canvas');
const { openDatabase } = require('./database');
const { buildDigest, buildTaskAlerts, localDateKey, shouldSendDigest } = require('./notifications');
const { refreshSession } = require('./session');
const { ensureDataDirectories, seedAuthState, writeJsonAtomic } = require('./storage');
const { sendTelegramMessage } = require('./telegram');

async function acquireLock() {
  try {
    return await fs.open(config.lockFile, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stats = await fs.stat(config.lockFile).catch(() => null);
    if (stats && Date.now() - stats.mtimeMs > 20 * 60_000) {
      await fs.unlink(config.lockFile).catch(() => {});
      return fs.open(config.lockFile, 'wx');
    }
    return null;
  }
}

async function loadTasksWithRefresh() {
  try {
    return await getPendingTasks();
  } catch (error) {
    if (!(error instanceof AuthenticationRequiredError) || !config.autoRefreshSession) throw error;
    console.log('La sesión caducó; intentando renovarla con Chromium headless.');
    await refreshSession();
    return getPendingTasks();
  }
}

// Ejecuta una revisión completa: consulta Canvas, envía lo que corresponda y
// deja el estado en SQLite. Devuelve null si otra revisión ya está en curso.
async function runCheck() {
  await ensureDataDirectories();
  await seedAuthState();
  const lock = await acquireLock();
  if (!lock) return null;

  const database = openDatabase();
  try {
    const now = new Date();
    const result = await loadTasksWithRefresh();
    const alerts = buildTaskAlerts(result.tasks, database, now);
    let alertsDelivered = 0;

    for (const alert of alerts) {
      const delivery = await sendTelegramMessage(alert.text);
      if (!delivery.dryRun) {
        database.addNotification(alert.key, alert.taskKey, alert.kind, now.toISOString());
        alertsDelivered += 1;
      }
    }

    database.syncTasks(result.tasks, now.toISOString());
    const initialized = database.getState('initialized') === '1';
    database.setState('initialized', '1');

    // El resumen sale a la hora configurada haya novedades o no.
    let digestSent = false;
    if (shouldSendDigest(database, now) || (!initialized && config.sendStartupDigest)) {
      const delivery = await sendTelegramMessage(buildDigest(result.tasks, now));
      if (!delivery.dryRun) {
        database.setState('last_digest_date', localDateKey(now));
        digestSent = true;
      }
    }

    await writeJsonAtomic(path.join(config.outputDir, 'pending-tasks.json'), result.tasks);
    database.setState('last_success_at', now.toISOString());
    database.setState('last_error', '');

    return {
      checkedAt: now.toISOString(),
      plannerItems: result.plannerItems,
      pendingTasks: result.tasks.length,
      alertsPrepared: alerts.length,
      alertsDelivered,
      digestSent,
      dryRun: config.telegramDryRun,
    };
  } catch (error) {
    const previousError = database.getState('last_error');
    const errorKey = `${config.telegramDryRun ? 'dry:' : ''}${error.code || error.name}:${error.message}`;
    if (previousError !== errorKey) {
      await sendTelegramMessage([
        '⚠️ <b>El monitor de Canvas necesita atención</b>',
        error.code === 'INTERACTION_REQUIRED'
          ? 'Microsoft solicitó una intervención manual para renovar la sesión.'
          : `Error: ${String(error.message).slice(0, 500)}`,
      ].join('\n')).catch((telegramError) => console.error(telegramError.message));
      database.setState('last_error', errorKey);
    }
    throw error;
  } finally {
    database.close();
    await lock.close();
    await fs.unlink(config.lockFile).catch(() => {});
  }
}

module.exports = { runCheck };
