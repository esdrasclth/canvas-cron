const http = require('node:http');
const fs = require('node:fs');
const config = require('../src/config');
const { ensureDataDirectories, seedAuthState } = require('../src/storage');

async function main() {
  await ensureDataDirectories();
  await seedAuthState();
  const server = http.createServer((request, response) => {
    if (request.url !== '/health') {
      response.writeHead(404).end('Not found');
      return;
    }
    const healthy = fs.existsSync(config.authFile);
    response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: healthy ? 'ready' : 'authentication_required' }));
  });
  server.listen(config.healthPort, '0.0.0.0', () => {
    console.log(`Health server listening on port ${config.healthPort}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
