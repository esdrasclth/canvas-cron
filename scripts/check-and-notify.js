const { runCheck } = require('../src/checker');

async function main() {
  const summary = await runCheck();
  if (!summary) {
    console.log('Ya hay una comprobación en curso; esta ejecución se omite.');
    return;
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
