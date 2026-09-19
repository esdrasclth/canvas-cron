const http = require('node:http');
const config = require('../src/config');
const { openDatabase } = require('../src/database');
const {
  ensureDataDirectories, readAuthState, seedAuthState, summarizeAuthState,
} = require('../src/storage');
const { startBot } = require('../src/bot');

// Motivo por el que la sesion no se pudo preparar al arrancar. Se expone en
// /health en lugar de terminar el proceso: si el contenedor muere, las tareas
// programadas de Dokploy no encuentran donde ejecutarse.
let seedError = null;
let botState = 'detenido';

async function prepareState() {
  try {
    await ensureDataDirectories();
    await seedAuthState();
  } catch (error) {
    seedError = error.message;
    console.error(`No se pudo preparar el estado de sesion: ${error.message}`);
  }
}

// El contenedor ya vive siempre, asi que aqui mismo se atienden los comandos
// de Telegram sin necesidad de un segundo servicio.
function launchBot() {
  if (!config.telegramCommands) {
    botState = 'desactivado';
    console.log('Comandos de Telegram desactivados (TELEGRAM_COMMANDS=false).');
    return;
  }
  if (!config.telegramBotToken || !config.telegramChatId) {
    botState = 'sin credenciales';
    console.log('Comandos de Telegram inactivos: falta TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID.');
    return;
  }
  if (config.telegramDryRun) {
    botState = 'simulacion';
    console.log('Comandos de Telegram inactivos: TELEGRAM_DRY_RUN está activo.');
    return;
  }

  botState = 'escuchando';
  startBot().catch((error) => {
    botState = `detenido: ${error.message}`;
    console.error(`El bot de Telegram se detuvo: ${error.message}`);
  });
}

async function buildStatus(now = new Date()) {
  let session;
  try {
    const state = await readAuthState();
    if (!state) {
      return {
        code: 503,
        body: { status: 'authentication_required', bot: botState, error: seedError || undefined },
      };
    }
    session = summarizeAuthState(state, now);
    if (!session.earliestExpiry && session.sessionOnly === 0 && session.expired > 0) {
      return {
        code: 503,
        body: { status: 'authentication_required', bot: botState, error: 'Todas las cookies con caducidad estan vencidas.' },
      };
    }
  } catch (error) {
    return { code: 503, body: { status: 'invalid_session', bot: botState, error: error.message } };
  }

  let monitor;
  try {
    const database = openDatabase();
    try {
      const quickCheck = database.db.pragma('quick_check', { simple: true });
      if (quickCheck !== 'ok') throw new Error(`SQLite quick_check: ${quickCheck}`);
      monitor = {
        lastSuccessAt: database.getState('last_success_at'),
        lastError: database.getState('last_error') || null,
        telegramLastPollAt: database.getState('telegram_last_poll_at'),
        telegramPollError: database.getState('telegram_last_poll_error') || null,
      };
    } finally {
      database.close();
    }
  } catch (error) {
    return { code: 503, body: { status: 'database_unavailable', bot: botState, error: error.message } };
  }

  const stale = monitor.lastSuccessAt
    ? now - new Date(monitor.lastSuccessAt) >= config.heartbeatMinutes * 60_000
    : false;
  const botExpected = config.telegramCommands && !config.telegramDryRun
    && Boolean(config.telegramBotToken && config.telegramChatId);
  const botPollLimitMs = Math.max(180_000, (config.pollTimeoutSeconds + 30) * 2000);
  const botPollStale = botExpected && monitor.telegramLastPollAt
    ? now - new Date(monitor.telegramLastPollAt) >= botPollLimitMs
    : false;
  const botStopped = botExpected && botState.startsWith('detenido');
  const unhealthy = stale || Boolean(monitor.lastError) || botPollStale || botStopped
    || (botExpected && Boolean(monitor.telegramPollError));
  return {
    code: unhealthy ? 503 : 200,
    body: {
      status: unhealthy ? 'degraded' : 'ready',
      bot: botState,
      session: {
        cookies: session.cookies,
        expired: session.expired,
        expiresAt: session.earliestExpiry?.toISOString() || null,
      },
      monitor: { ...monitor, stale, botPollStale },
    },
  };
}

function respondJson(response, code, body) {
  response.writeHead(code, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function main() {
  await prepareState();

  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;

    // Raiz siempre 200: los chequeos de Dokploy/Traefik apuntan a / por defecto
    // y un 404 marcaria el servicio como caido.
    if (pathname === '/' || pathname === '/alive') {
      respondJson(response, 200, { status: 'alive' });
      return;
    }

    if (pathname === '/health') {
      try {
        const { code, body } = await buildStatus();
        respondJson(response, code, body);
      } catch (error) {
        respondJson(response, 503, { status: 'health_error', error: error.message });
      }
      return;
    }

    respondJson(response, 404, { status: 'not_found' });
  });

  server.listen(config.healthPort, '0.0.0.0', () => {
    console.log(`Health server listening on port ${config.healthPort}`);
  });

  launchBot();
}

if (require.main === module) {
  process.on('unhandledRejection', (error) => {
    console.error('unhandledRejection', error);
  });

  main().catch((error) => {
    console.error(error);
    // Sin reintentos posibles aqui, pero se mantiene el proceso vivo para que el
    // contenedor siga disponible y los logs puedan consultarse desde Dokploy.
    setInterval(() => {}, 60_000);
  });
}

module.exports = { buildStatus, main };
