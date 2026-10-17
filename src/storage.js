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

async function seedAuthState() {
  await ensureDataDirectories();
  if (await exists(config.authFile)) return false;

  if (process.env.AUTH_STATE_B64) {
    const decoded = Buffer.from(process.env.AUTH_STATE_B64, 'base64').toString('utf8');
    JSON.parse(decoded);
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

module.exports = { ensureDataDirectories, exists, seedAuthState, writeJsonAtomic };

