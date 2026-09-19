const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');
const {
  AuthenticationRequiredError, getAnnouncements, getGradedSubmissions, getPendingTasks,
} = require('./canvas');
const { openDatabase } = require('./database');
const {
  buildAnnouncementAlerts, buildDigest, buildGradeAlerts, buildTaskAlerts, buildWeeklyDigest,
  htmlToText, inQuietHours, localDateKey, relativeTime, shouldHoldAlert, shouldSendDigest, shouldSendWeekly,
} = require('./notifications');
const { refreshSession } = require('./session');
const {
  ensureDataDirectories, readAuthState, seedAuthState, summarizeAuthState, writeJsonAtomic,
} = require('./storage');
const { escapeHtml, sendTelegramMessage } = require('./telegram');

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

// Envía los avisos respetando la ventana de silencio. Lo que se retiene no se
// registra, así que vuelve a evaluarse en la siguiente revisión; por eso se
// devuelve aparte, para no darlo por visto al sincronizar.
async function deliverAlerts(alerts, database, now) {
  let delivered = 0;
  let held = 0;
  const pending = [];

  for (const alert of alerts) {
    if (shouldHoldAlert(alert, now)) {
      held += 1;
      pending.push(alert);
      continue;
    }

    const result = await sendTelegramMessage(alert.text, { keyboard: alert.keyboard || null });
    if (result.dryRun) {
      pending.push(alert);
      continue;
    }

    database.addNotification(alert.key, alert.taskKey, alert.kind, now.toISOString());
    if (alert.clearSnooze) database.clearSnooze(alert.taskKey, now.toISOString());
    delivered += 1;
  }

  return { delivered, held, pending };
}

// Claves de origen de los avisos de un tipo que no llegaron a salir.
function pendingKeys(pending, kind) {
  return new Set(pending.filter((alert) => alert.kind === kind).map((alert) => alert.taskKey));
}

// Las calificaciones y los anuncios son informacion secundaria: si Canvas
// falla ahi, la revision de pendientes no debe caerse por eso. Solo se leen y
// se preparan los avisos; se guardan despues de enviarlos (ver commitUpdates).
async function loadGrades(database, now) {
  if (!config.trackGrades) return { items: [], alerts: [] };

  try {
    const result = await getGradedSubmissions();
    return {
      items: result.submissions,
      skipped: result.skipped,
      alerts: buildGradeAlerts(result.submissions, database, now),
    };
  } catch (error) {
    console.error(`No se pudieron leer las calificaciones: ${error.message}`);
    return { items: [], alerts: [], error: error.message };
  }
}

// La primera carga trae el historial del periodo para que /anuncios tenga algo
// que mostrar aunque en los ultimos dias no se haya publicado nada. Esa pasada
// no avisa: todo lo que trae ya estaba publicado.
const ANNOUNCEMENT_HISTORY_DAYS = 180;

async function loadAnnouncements(database, now) {
  if (!config.trackAnnouncements) return { items: [], alerts: [] };

  const backfill = database.getState('announcements_history') !== '1';
  try {
    const result = await getAnnouncements({
      days: backfill ? Math.max(ANNOUNCEMENT_HISTORY_DAYS, config.announcementLookbackDays) : config.announcementLookbackDays,
    });
    const items = result.announcements.map((item) => ({ ...item, text: htmlToText(item.message) }));
    return {
      items,
      backfill,
      skipped: result.skipped,
      alerts: backfill ? [] : buildAnnouncementAlerts(items, database, now),
    };
  } catch (error) {
    console.error(`No se pudieron leer los anuncios: ${error.message}`);
    return { items: [], alerts: [], error: error.message };
  }
}

// Lo que quedó retenido (horas de silencio o simulación) no se guarda: si se
// guardara, la siguiente revisión ya no lo vería como nuevo y el aviso se
// perdería.
// El error y los cursos saltados quedan en system_state para que /revisar y
// /estado los muestren: antes solo iban al log del contenedor.
function commitUpdates(database, grades, announcements, pending, now) {
  const iso = now.toISOString();

  if (config.trackGrades) {
    database.setState('grades_error', grades.error || '');
    if (!grades.error) {
      const heldGrades = pendingKeys(pending, 'graded');
      database.syncSubmissions(grades.items.filter((item) => !heldGrades.has(item.key)), iso);
      database.setState('grades_initialized', '1');
      database.setState('grades_skipped', (grades.skipped || []).join(', '));
    }
  }

  if (config.trackAnnouncements) {
    database.setState('announcements_error', announcements.error || '');
    if (!announcements.error) {
      const heldAnnouncements = pendingKeys(pending, 'announcement');
      database.saveAnnouncements(announcements.items.filter((item) => !heldAnnouncements.has(item.key)), iso);
      database.setState('announcements_initialized', '1');
      database.setState('announcements_history', '1');
      database.setState('announcements_skipped', (announcements.skipped || []).join(', '));
    }
  }
}

async function warnAboutSession(database, now) {
  const state = await readAuthState();
  if (!state) return null;

  const summary = summarizeAuthState(state, now);
  if (!summary.earliestExpiry) return summary;

  const days = (summary.earliestExpiry - now) / 86_400_000;
  if (days > config.sessionWarnDays) return summary;

  // Una sola advertencia por día para no repetirla en cada revisión.
  const key = `session_warn:${localDateKey(now)}`;
  if (database.hasNotification(key)) return summary;

  const result = await sendTelegramMessage([
    '🔐 <b>La sesión de Canvas está por caducar</b>',
    '',
    `Caduca ${escapeHtml(relativeTime(summary.earliestExpiry, now))}.`,
    '',
    'Para renovarla: ejecuta <code>npm run portal</code> en tu computadora, inicia sesión',
    'y envíame el archivo <code>playwright/.auth/unitec.json</code> como documento en este chat.',
    'Yo la instalo sin necesidad de tocar Dokploy.',
  ].join('\n'));

  if (!result.dryRun) database.addNotification(key, null, 'session_expiring', now.toISOString());
  return summary;
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
    const taskAlerts = buildTaskAlerts(result.tasks, database, now);
    const grades = await loadGrades(database, now);
    const announcements = await loadAnnouncements(database, now);

    const { delivered, held, pending } = await deliverAlerts(
      [...taskAlerts, ...grades.alerts, ...announcements.alerts], database, now,
    );
    commitUpdates(database, grades, announcements, pending, now);

    database.syncTasks(result.tasks, now.toISOString());
    const initialized = database.getState('initialized') === '1';
    database.setState('initialized', '1');

    // Los resúmenes salen a su hora haya novedades o no, pero nunca en silencio.
    const quiet = inQuietHours(now);
    let digestSent = false;
    if (!quiet && (shouldSendDigest(database, now) || (!initialized && config.sendStartupDigest))) {
      const delivery = await sendTelegramMessage(buildDigest(result.tasks, now));
      if (!delivery.dryRun) {
        database.setState('last_digest_date', localDateKey(now));
        digestSent = true;
      }
    }

    let weeklySent = false;
    if (!quiet && shouldSendWeekly(database, now)) {
      const delivery = await sendTelegramMessage(buildWeeklyDigest(result.tasks, now));
      if (!delivery.dryRun) {
        database.setState('last_weekly_date', localDateKey(now));
        weeklySent = true;
      }
    }

    const session = await warnAboutSession(database, now);

    await writeJsonAtomic(path.join(config.outputDir, 'pending-tasks.json'), result.tasks);
    database.setState('last_success_at', now.toISOString());
    database.setState('last_error', '');

    return {
      checkedAt: now.toISOString(),
      plannerItems: result.plannerItems,
      pendingTasks: result.tasks.length,
      gradedTracked: grades.items.length,
      gradeAlerts: grades.alerts.length,
      announcementsTracked: announcements.items.length,
      announcementAlerts: announcements.alerts.length,
      gradesHeld: pending.filter((alert) => alert.kind === 'graded').length,
      announcementsHeld: pending.filter((alert) => alert.kind === 'announcement').length,
      gradesError: grades.error || null,
      announcementsError: announcements.error || null,
      gradesSkipped: grades.skipped || [],
      announcementsSkipped: announcements.skipped || [],
      alertsPrepared: taskAlerts.length + grades.alerts.length + announcements.alerts.length,
      alertsDelivered: delivered,
      alertsHeldForQuietHours: held,
      digestSent,
      weeklySent,
      sessionExpiresAt: session?.earliestExpiry ? session.earliestExpiry.toISOString() : null,
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
          : `Error: ${escapeHtml(String(error.message).slice(0, 500))}`,
        '',
        'Si es la sesión, envíame el archivo <code>unitec.json</code> como documento y la instalo.',
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
