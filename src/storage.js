const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
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

async function replaceFile(temporary, target) {
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    // POSIX reemplaza el destino atomicamente. Windows puede rechazarlo si ya
    // existe: se aparta el actual y se restaura si el segundo rename falla.
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
    const displaced = `${target}.${randomUUID()}.replaced`;
    let hasDisplaced = false;
    try {
      await fs.rename(target, displaced);
      hasDisplaced = true;
    } catch (moveError) {
      if (moveError.code !== 'ENOENT') throw moveError;
    }
    try {
      await fs.rename(temporary, target);
    } catch (replaceError) {
      if (hasDisplaced) await fs.rename(displaced, target).catch(() => {});
      throw replaceError;
    }
    if (hasDisplaced) await fs.unlink(displaced).catch(() => {});
  }
}

async function writeFileAtomic(file, contents, options = 'utf8') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, options);
    await replaceFile(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
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
    const state = parseAuthState(decoded);
    await writeFileAtomic(config.authFile, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    return true;
  }

  const localAuth = path.resolve('playwright/.auth/unitec.json');
  if (localAuth !== config.authFile && await exists(localAuth)) {
    const state = parseAuthState(await fs.readFile(localAuth, 'utf8'));
    await writeFileAtomic(config.authFile, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
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

// La sesion nueva se escribe como candidata y se verifica antes de tocar la
// activa. Solo una candidata valida reemplaza el archivo actual.
async function installAuthState(text, { verify } = {}) {
  const state = parseAuthState(text);
  await ensureDataDirectories();
  const candidate = `${config.authFile}.${randomUUID()}.candidate`;
  let verification = null;

  try {
    await fs.writeFile(candidate, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (verify) verification = await verify(candidate);

    if (await exists(config.authFile)) {
      const previous = await fs.readFile(config.authFile);
      await writeFileAtomic(`${config.authFile}.previous`, previous, { mode: 0o600 });
    }
    await replaceFile(candidate, config.authFile);
  } catch (error) {
    // Si el fallback de Windows retiro el destino antes de fallar, se recupera
    // la copia anterior. En el camino normal la sesion activa nunca se toco.
    if (!await exists(config.authFile) && await exists(`${config.authFile}.previous`)) {
      await fs.copyFile(`${config.authFile}.previous`, config.authFile).catch(() => {});
    }
    throw error;
  } finally {
    await fs.unlink(candidate).catch(() => {});
  }

  return { ...summarizeAuthState(state), verification };
}

async function writeJsonAtomic(file, value) {
  await writeFileAtomic(file, JSON.stringify(value, null, 2), 'utf8');
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
  writeFileAtomic,
  writeJsonAtomic,
};

