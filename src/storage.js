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

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temporary, file);
}

module.exports = { decodeAuthState, ensureDataDirectories, exists, seedAuthState, writeJsonAtomic };

