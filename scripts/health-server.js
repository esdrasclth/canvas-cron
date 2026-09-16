const http = require('node:http');
const fs = require('node:fs');
const config = require('../src/config');
const { ensureDataDirectories, seedAuthState } = require('../src/storage');
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

function buildStatus() {
  const authenticated = fs.existsSync(config.authFile);
  if (authenticated) return { code: 200, body: { status: 'ready', bot: botState } };
  return {
    code: 503,
    body: { status: 'authentication_required', bot: botState, error: seedError || undefined },
  };
}

function respondJson(response, code, body) {
  response.writeHead(code, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function main() {
  await prepareState();

  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;

    // Raiz siempre 200: los chequeos de Dokploy/Traefik apuntan a / por defecto
    // y un 404 marcaria el servicio como caido.
    if (pathname === '/' || pathname === '/alive') {
      respondJson(response, 200, { status: 'alive' });
      return;
    }

    if (pathname === '/health') {
      const { code, body } = buildStatus();
      respondJson(response, code, body);
      return;
    }

    respondJson(response, 404, { status: 'not_found' });
  });

  server.listen(config.healthPort, '0.0.0.0', () => {
    console.log(`Health server listening on port ${config.healthPort}`);
  });

  launchBot();
}

process.on('unhandledRejection', (error) => {
  console.error('unhandledRejection', error);
});

main().catch((error) => {
  console.error(error);
  // Sin reintentos posibles aqui, pero se mantiene el proceso vivo para que el
  // contenedor siga disponible y los logs puedan consultarse desde Dokploy.
  setInterval(() => {}, 60_000);
});
