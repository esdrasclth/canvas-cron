const { request } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');

const CANVAS_ORIGIN = 'https://unitechonduras.instructure.com';
const AUTH_FILE = path.resolve('playwright/.auth/unitec.json');
const OUTPUT_DIR = path.resolve('artifacts');

async function fetchAll(api, firstUrl) {
  const items = [];
  let nextUrl = firstUrl;

  for (let page = 0; nextUrl && page < 20; page += 1) {
    const response = await api.get(nextUrl);
    if (!response.ok()) {
      throw new Error(`Canvas API ${response.status()}: ${await response.text()}`);
    }

    items.push(...await response.json());
    nextUrl = response.headers().link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }

  return items;
}

function assignmentIdFor(item) {
  if (item.plannable_type === 'assignment') return item.plannable_id;
  return item.plannable?.assignment_id ?? null;
}

function taskStatus(task, now) {
  const due = new Date(task.dueAt);
  const lock = task.lockAt ? new Date(task.lockAt) : null;
  if (due >= now) return 'próxima';
  if (lock && lock <= now) return 'vencida y cerrada';
  return 'vencida pero abierta';
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.access(AUTH_FILE);

  const api = await request.newContext({ storageState: AUTH_FILE });
  const now = new Date();
  const startDate = new Date(now);
  startDate.setMonth(startDate.getMonth() - 6);
  const endDate = new Date(now);
  endDate.setMonth(endDate.getMonth() + 6);

  const plannerUrl = new URL('/api/v1/planner/items', CANVAS_ORIGIN);
  plannerUrl.searchParams.set('start_date', startDate.toISOString());
  plannerUrl.searchParams.set('end_date', endDate.toISOString());
  plannerUrl.searchParams.set('per_page', '100');

  const plannerItems = await fetchAll(api, plannerUrl.toString());
  const actionableTypes = new Set(['assignment', 'quiz', 'discussion_topic']);
  const candidates = plannerItems
    .filter((item) => actionableTypes.has(item.plannable_type))
    .filter((item) => item.submissions && !item.submissions.excused)
    .filter((item) => !item.planner_override?.marked_complete)
    .map((item) => ({ item, assignmentId: assignmentIdFor(item) }))
    .filter(({ assignmentId }) => assignmentId != null);

  const checked = await Promise.all(candidates.map(async ({ item, assignmentId }) => {
    const response = await api.get(
      `${CANVAS_ORIGIN}/api/v1/courses/${item.course_id}/assignments/${assignmentId}/submissions/self`,
    );
    const submission = response.ok() ? await response.json() : item.submissions;
    return { item, submission };
  }));

  const pending = checked
    .filter(({ submission }) => submission.workflow_state === 'unsubmitted' || (
      submission.workflow_state == null
      && !submission.submitted
      && !submission.graded
    ))
    .map(({ item, submission }) => ({
      course: item.context_name,
      title: item.plannable?.title ?? '(Sin título)',
      type: item.plannable_type,
      dueAt: item.plannable?.due_at ?? item.plannable_date,
      lockAt: item.plannable?.lock_at ?? null,
      points: item.plannable?.points_possible ?? null,
      missing: Boolean(submission.missing ?? item.submissions?.missing),
      url: new URL(item.html_url, CANVAS_ORIGIN).toString(),
    }))
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
    .map((task) => ({ ...task, status: taskStatus(task, now) }));

  await fs.writeFile(
    path.join(OUTPUT_DIR, 'pending-tasks.json'),
    JSON.stringify(pending, null, 2),
    'utf8',
  );

  const formatter = new Intl.DateTimeFormat('es-HN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Tegucigalpa',
  });
  const headings = [
    ['Próximas entregas', 'próxima'],
    ['Vencidas pero abiertas', 'vencida pero abierta'],
    ['Vencidas y cerradas', 'vencida y cerrada'],
  ];
  const markdown = [
    '# Tareas pendientes de Canvas',
    '',
    `Generado: ${formatter.format(now)}`,
    '',
  ];

  for (const [heading, status] of headings) {
    const tasks = pending.filter((task) => task.status === status);
    if (!tasks.length) continue;
    markdown.push(`## ${heading}`, '');
    for (const task of tasks) {
      markdown.push(
        `- **${task.title}** — ${task.course}`,
        `  - Entrega: ${formatter.format(new Date(task.dueAt))}`,
        `  - Tipo: ${task.type}${task.points == null ? '' : ` · ${task.points} puntos`}`,
        `  - [Abrir en Canvas](${task.url})`,
      );
    }
    markdown.push('');
  }

  await fs.writeFile(path.join(OUTPUT_DIR, 'pending-tasks.md'), markdown.join('\n'), 'utf8');
  console.log(JSON.stringify({ plannerItems: plannerItems.length, pendingItems: pending.length, pending }, null, 2));
  await api.dispose();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

