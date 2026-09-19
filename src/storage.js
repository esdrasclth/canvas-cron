const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');

async function exists(file) {
  return fs.access(file).then(() => true).catch(() => false);
}

async function ensureDataDirectories() {
  await Promise.all([
    fs.mkdir(path.dirname(config.authFile), { recursive: true }),
    fs.mkdir(config.profileDir, { recursive: true }),
    fs.mkdir(config.outputDir, { recursive: true }),
  ]);
}

function decodeAuthState(raw) {
  // Dokploy y otros editores de variables pueden introducir saltos de linea o
  // espacios al pegar el base64; se limpian antes de decodificar.
  const sanitized = raw.replace(/\s+/g, '');
  const decoded = Buffer.from(sanitized, 'base64').toString('utf8');
  try {
    JSON.parse(decoded);
  } catch (error) {
    throw new Error(
      `AUTH_STATE_B64 no contiene un JSON valido tras decodificar (${error.message}). ` +
        'Vuelve a generarlo con "npm run auth:export" y pegalo completo en una sola linea.',
    );
  }
  return decoded;
}

async function seedAuthState() {
  await ensureDataDirectories();
  if (await exists(config.authFile)) return false;

  if (process.env.AUTH_STATE_B64) {
    const decoded = decodeAuthState(process.env.AUTH_STATE_B64);
    await fs.writeFile(config.authFile, decoded, { encoding: 'utf8', mode: 0o600 });
    return true;
  }

  const localAuth = path.resolve('playwright/.auth/unitec.json');
  if (localAuth !== config.authFile && await exists(localAuth)) {
    await fs.copyFile(localAuth, config.authFile);
    return true;
  }

  return false;
}

// Valida que el contenido sea un storageState de Playwright utilizable, sin
// aceptar un JSON cualquiera que luego rompa la revision.
function parseAuthState(text) {
  let state;
  try {
    state = JSON.parse(text);
  } catch (error) {
    throw new Error(`El archivo no es JSON válido (${error.message}).`);
  }
  if (!state || typeof state !== 'object' || !Array.isArray(state.cookies)) {
    throw new Error('El archivo no parece una sesión de Playwright: falta el arreglo "cookies".');
  }
  if (!state.cookies.length) throw new Error('La sesión no contiene ninguna cookie.');
  return state;
}

function summarizeAuthState(state, now = new Date()) {
  const seconds = now.getTime() / 1000;
  const withExpiry = state.cookies.filter((cookie) => Number(cookie.expires) > 0);
  const future = withExpiry
    .filter((cookie) => Number(cookie.expires) > seconds)
    .sort((a, b) => a.expires - b.expires);

  return {
    cookies: state.cookies.length,
    sessionOnly: state.cookies.length - withExpiry.length,
    expired: withExpiry.length - future.length,
    // La primera en caducar marca cuanto le queda de vida util a la sesion.
    earliestExpiry: future.length ? new Date(future[0].expires * 1000) : null,
    earliestExpiryName: future.length ? future[0].name : null,
  };
}

async function readAuthState() {
  if (!await exists(config.authFile)) return null;
  return parseAuthState(await fs.readFile(config.authFile, 'utf8'));
}

// Reemplaza la sesion guardando antes una copia, para poder volver atras si el
// archivo nuevo resulta inservible.
async function installAuthState(text) {
  const state = parseAuthState(text);
  await ensureDataDirectories();
  if (await exists(config.authFile)) {
    await fs.copyFile(config.authFile, `${config.authFile}.previous`).catch(() => {});
  }
  await fs.writeFile(config.authFile, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  return summarizeAuthState(state);
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temporary, file);
}

module.exports = {
  decodeAuthState,
  ensureDataDirectories,
  exists,
  installAuthState,
  parseAuthState,
  readAuthState,
  seedAuthState,
  summarizeAuthState,
  writeJsonAtomic,
};

