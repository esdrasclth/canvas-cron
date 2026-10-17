const { request } = require('playwright');
const config = require('./config');
const { exists } = require('./storage');

class AuthenticationRequiredError extends Error {
  constructor(message = 'La sesión de Canvas necesita renovarse') {
    super(message);
    this.name = 'AuthenticationRequiredError';
    this.code = 'AUTH_REQUIRED';
  }
}

async function fetchAll(api, firstUrl) {
  const items = [];
  let nextUrl = firstUrl;

  for (let page = 0; nextUrl && page < 30; page += 1) {
    const response = await api.get(nextUrl);
    const contentType = response.headers()['content-type'] || '';
    if ([401, 403].includes(response.status()) || !contentType.includes('application/json')) {
      throw new AuthenticationRequiredError();
    }
    if (!response.ok()) {
      throw new Error(`Canvas respondió HTTP ${response.status()}`);
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

function taskKey(item, assignmentId) {
  return `${item.course_id}:${assignmentId}`;
}

function taskStatus(task, now = new Date()) {
  const due = new Date(task.dueAt);
  const lock = task.lockAt ? new Date(task.lockAt) : null;
  if (due >= now) return 'upcoming';
  if (lock && lock <= now) return 'overdue_closed';
  return 'overdue_open';
}

async function getPendingTasks() {
  if (!await exists(config.authFile)) throw new AuthenticationRequiredError('No existe una sesión guardada');

  const api = await request.newContext({ storageState: config.authFile });
  try {
    const now = new Date();
    const startDate = new Date(now);
    startDate.setMonth(startDate.getMonth() - 6);
    const endDate = new Date(now);
    endDate.setMonth(endDate.getMonth() + 6);

    const plannerUrl = new URL('/api/v1/planner/items', config.canvasOrigin);
    plannerUrl.searchParams.set('start_date', startDate.toISOString());
    plannerUrl.searchParams.set('end_date', endDate.toISOString());
    plannerUrl.searchParams.set('per_page', '100');
    const plannerItems = await fetchAll(api, plannerUrl.toString());

    const actionableTypes = new Set(['assignment', 'quiz', 'discussion_topic']);
    const candidates = plannerItems
      .filter((item) => actionableTypes.has(item.plannable_type))
      .filter((item) => item.submissions && !item.submissions.excused)
      .filter((item) => !item.submissions.submitted && !item.submissions.graded)
      .filter((item) => !item.planner_override?.marked_complete)
      .map((item) => ({ item, assignmentId: assignmentIdFor(item) }))
      .filter(({ assignmentId }) => assignmentId != null);

    const checked = await Promise.all(candidates.map(async ({ item, assignmentId }) => {
      const response = await api.get(
        `${config.canvasOrigin}/api/v1/courses/${item.course_id}/assignments/${assignmentId}/submissions/self`,
      );
      const contentType = response.headers()['content-type'] || '';
      if ([401, 403].includes(response.status()) || !contentType.includes('application/json')) {
        throw new AuthenticationRequiredError();
      }
      const submission = response.ok() ? await response.json() : item.submissions;
      return { item, assignmentId, submission };
    }));

    const tasks = checked
      .filter(({ submission }) => submission.workflow_state === 'unsubmitted' || (
        submission.workflow_state == null && !submission.submitted && !submission.graded
      ))
      .map(({ item, assignmentId, submission }) => ({
        key: taskKey(item, assignmentId),
        courseId: item.course_id,
        assignmentId,
        course: item.context_name,
        title: item.plannable?.title ?? '(Sin título)',
        type: item.plannable_type,
        dueAt: item.plannable?.due_at ?? item.plannable_date,
        lockAt: item.plannable?.lock_at ?? null,
        points: item.plannable?.points_possible ?? null,
        missing: Boolean(submission.missing ?? item.submissions?.missing),
        url: new URL(item.html_url, config.canvasOrigin).toString(),
      }))
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
      .map((task) => ({ ...task, status: taskStatus(task, now) }));

    return { plannerItems: plannerItems.length, tasks };
  } finally {
    await api.dispose();
  }
}

module.exports = { AuthenticationRequiredError, getPendingTasks, taskStatus };
