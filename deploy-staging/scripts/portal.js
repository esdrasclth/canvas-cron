const { chromium } = require('playwright');
const readline = require('node:readline');
const fs = require('node:fs/promises');
const path = require('node:path');

const PORTAL_URL = 'https://portal.unitec.edu/';
const artifactsDir = path.resolve('artifacts');
const authDir = path.resolve('playwright/.auth');
const authFile = path.join(authDir, 'unitec.json');

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(authDir, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const savedAccess = await fs.access(authFile).then(() => true).catch(() => false);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ...(savedAccess ? { storageState: authFile } : {}),
  });

  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded' });

  console.log('READY');
  console.log('Inicia sesión en la ventana del navegador.');
  console.log('Comandos disponibles: status, inspect, login, signin, save, canvas, tasks, screenshot, exit');

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  rl.on('line', async (rawCommand) => {
    const input = rawCommand.trim();
    const command = input.split(' ', 1)[0].toLowerCase();
    const activePage = context.pages().at(-1);

    try {
      if (command === 'status') {
        console.log(JSON.stringify({
          pages: context.pages().length,
          title: await activePage.title(),
          url: activePage.url(),
        }, null, 2));
      } else if (command === 'inspect') {
        const snapshot = await activePage.locator('body').innerText();
        await fs.writeFile(path.join(artifactsDir, 'portal-text.txt'), snapshot, 'utf8');
        console.log(snapshot.slice(0, 20000));
        console.log('\nSAVED artifacts/portal-text.txt');
      } else if (command === 'login') {
        const loginButton = activePage.getByText(/cuenta de correo/i).first();
        await loginButton.waitFor({ state: 'visible' });
        await loginButton.click();
        await activePage.waitForTimeout(1000);
        console.log(JSON.stringify({ title: await activePage.title(), url: activePage.url() }, null, 2));
      } else if (command === 'signin') {
        const encodedCredentials = input.slice('signin '.length);
        const credentials = JSON.parse(Buffer.from(encodedCredentials, 'base64url').toString('utf8'));

        const emailInput = activePage.locator('input[type="email"]');
        await emailInput.waitFor({ state: 'visible' });
        await emailInput.fill(credentials.email);
        await activePage.locator('input[type="submit"]').click();

        const passwordInput = activePage.locator('input[type="password"]');
        await passwordInput.waitFor({ state: 'visible' });
        await passwordInput.fill(credentials.password);
        await activePage.locator('input[type="submit"]').click();
        await activePage.waitForTimeout(2000);

        console.log(JSON.stringify({ title: await activePage.title(), url: activePage.url() }, null, 2));
      } else if (command === 'save') {
        await context.storageState({ path: authFile });
        console.log(`SAVED ${authFile}`);
      } else if (command === 'canvas') {
        await context.storageState({ path: authFile });
        const canvasAccess = activePage.getByText('Canvas', { exact: true }).first();
        await canvasAccess.waitFor({ state: 'visible' });

        const previousPages = context.pages();
        await canvasAccess.click();
        await activePage.waitForTimeout(1500);

        const destination = context.pages().find((candidate) => !previousPages.includes(candidate))
          ?? context.pages().at(-1);
        await destination.waitForLoadState('domcontentloaded');
        console.log(JSON.stringify({
          title: await destination.title(),
          url: destination.url(),
        }, null, 2));
      } else if (command === 'tasks') {
        const canvasOrigin = 'https://unitechonduras.instructure.com';
        const startDate = new Date();
        startDate.setMonth(startDate.getMonth() - 6);
        const endDate = new Date();
        endDate.setMonth(endDate.getMonth() + 6);
        const url = new URL('/api/v1/planner/items', canvasOrigin);
        url.searchParams.set('start_date', startDate.toISOString());
        url.searchParams.set('end_date', endDate.toISOString());
        url.searchParams.set('per_page', '100');

        async function fetchAll(firstUrl) {
          const allItems = [];
          let nextUrl = firstUrl;
          let pageNumber = 0;
          while (nextUrl && pageNumber < 20) {
            const response = await context.request.get(nextUrl);
            if (!response.ok()) {
              throw new Error(`Canvas API ${response.status()}: ${await response.text()}`);
            }
            allItems.push(...await response.json());
            const nextMatch = response.headers().link?.match(/<([^>]+)>;\s*rel="next"/);
            nextUrl = nextMatch?.[1] ?? null;
            pageNumber += 1;
          }
          return allItems;
        }

        const items = await fetchAll(url.toString());
        const todoUrl = new URL('/api/v1/users/self/todo', canvasOrigin);
        todoUrl.searchParams.set('per_page', '100');
        const todoItems = await fetchAll(todoUrl.toString());

        await fs.writeFile(
          path.join(artifactsDir, 'canvas-planner-items.json'),
          JSON.stringify(items, null, 2),
          'utf8',
        );
        await fs.writeFile(
          path.join(artifactsDir, 'canvas-todo-items.json'),
          JSON.stringify(todoItems, null, 2),
          'utf8',
        );

        const actionableTypes = new Set(['assignment', 'quiz', 'discussion_topic']);
        const pending = items
          .filter((item) => actionableTypes.has(item.plannable_type))
          .filter((item) => item.submissions && !item.submissions.submitted)
          .filter((item) => !item.submissions.excused && !item.submissions.graded)
          .filter((item) => !item.planner_override?.marked_complete)
          .map((item) => ({
            course: item.context_name,
            title: item.plannable?.title ?? '(Sin título)',
            type: item.plannable_type,
            dueAt: item.plannable?.due_at ?? item.plannable_date,
            lockAt: item.plannable?.lock_at ?? null,
            points: item.plannable?.points_possible ?? null,
            missing: Boolean(item.submissions?.missing),
            url: new URL(item.html_url, canvasOrigin).toString(),
          }))
          .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));

        await fs.writeFile(
          path.join(artifactsDir, 'pending-tasks.json'),
          JSON.stringify(pending, null, 2),
          'utf8',
        );

        const formatter = new Intl.DateTimeFormat('es-HN', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: 'America/Tegucigalpa',
        });
        const markdown = [
          '# Tareas pendientes de Canvas',
          '',
          `Generado: ${formatter.format(new Date())}`,
          '',
          ...pending.flatMap((task) => [
            `- **${task.title}** — ${task.course}`,
            `  - Entrega: ${formatter.format(new Date(task.dueAt))}${task.missing ? ' · vencida/no entregada' : ''}`,
            `  - Tipo: ${task.type}${task.points == null ? '' : ` · ${task.points} puntos`}`,
            `  - [Abrir en Canvas](${task.url})`,
          ]),
          '',
        ].join('\n');
        await fs.writeFile(path.join(artifactsDir, 'pending-tasks.md'), markdown, 'utf8');

        console.log(JSON.stringify({
          plannerItems: items.length,
          todoItems: todoItems.length,
          pendingItems: pending.length,
          pending,
        }, null, 2));
      } else if (command === 'screenshot') {
        const output = path.join(artifactsDir, 'portal.png');
        await activePage.screenshot({ path: output, fullPage: true });
        console.log(`SAVED ${output}`);
      } else if (command === 'exit') {
        rl.close();
        await context.close();
        await browser.close();
        process.exit(0);
      } else if (command) {
        console.log(`Comando desconocido: ${command}`);
      }
    } catch (error) {
      console.error(error.stack || error.message);
    }
  });

  context.on('close', () => process.exit(0));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
