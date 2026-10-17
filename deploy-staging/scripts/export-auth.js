const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const source = path.resolve('playwright/.auth/unitec.json');
  const outputDir = path.resolve('artifacts');
  const output = path.join(outputDir, 'unitec-auth.b64');
  const contents = await fs.readFile(source);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(output, contents.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  console.log(`Estado de sesión exportado a ${output}`);
  console.log('Trátalo como una contraseña y elimínalo después de configurar Dokploy.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

