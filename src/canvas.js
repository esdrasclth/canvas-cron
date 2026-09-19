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

async function listActiveCourses(api) {
  const url = new URL('/api/v1/courses', config.canvasOrigin);
  url.searchParams.set('enrollment_state', 'active');
  url.searchParams.set('per_page', '100');
  return fetchAll(api, url.toString());
}

// Las calificaciones vienen de los "assignments" de cada curso con la entrega
// del propio usuario incrustada: una peticion por curso en vez de una por
// actividad, y ya trae nota, puntos posibles y fecha de calificacion.
async function getGradedSubmissions() {
  if (!await exists(config.authFile)) throw new AuthenticationRequiredError('No existe una sesión guardada');

  const api = await request.newContext({ storageState: config.authFile });
  try {
    const courses = await listActiveCourses(api);
    const graded = [];

    for (const course of courses) {
      const url = new URL(`/api/v1/courses/${course.id}/assignments`, config.canvasOrigin);
      url.searchParams.append('include[]', 'submission');
      url.searchParams.set('per_page', '100');

      const assignments = await fetchAll(api, url.toString());
      for (const assignment of assignments) {
        const submission = assignment.submission;
        if (!submission || !submission.graded_at) continue;
        if (submission.workflow_state === 'unsubmitted' && submission.score == null) continue;

        graded.push({
          key: `${course.id}:${assignment.id}`,
          title: assignment.name || '(Sin título)',
          course: course.name || `Curso ${course.id}`,
          url: assignment.html_url
            ? new URL(assignment.html_url, config.canvasOrigin).toString()
            : `${config.canvasOrigin}/courses/${course.id}/assignments/${assignment.id}`,
          score: submission.score ?? null,
          pointsPossible: assignment.points_possible ?? null,
          grade: submission.grade == null ? null : String(submission.grade),
          gradedAt: submission.graded_at,
        });
      }
    }

    graded.sort((a, b) => new Date(b.gradedAt) - new Date(a.gradedAt));
    return { courses: courses.length, submissions: graded };
  } finally {
    await api.dispose();
  }
}

// Los anuncios de todos los cursos salen de un solo endpoint filtrado por
// context_codes; se parten en grupos para no armar URLs enormes.
async function getAnnouncements({ days = config.announcementLookbackDays } = {}) {
  if (!await exists(config.authFile)) throw new AuthenticationRequiredError('No existe una sesión guardada');

  const api = await request.newContext({ storageState: config.authFile });
  try {
    const courses = await listActiveCourses(api);
    const courseNames = new Map(courses.map((course) => [`course_${course.id}`, course.name || `Curso ${course.id}`]));
    const now = new Date();
    const startDate = new Date(now.getTime() - days * 86_400_000);
    const announcements = [];

    const codes = [...courseNames.keys()];
    for (let index = 0; index < codes.length; index += 10) {
      const url = new URL('/api/v1/announcements', config.canvasOrigin);
      for (const code of codes.slice(index, index + 10)) url.searchParams.append('context_codes[]', code);
      url.searchParams.set('start_date', startDate.toISOString());
      url.searchParams.set('end_date', now.toISOString());
      url.searchParams.set('per_page', '50');

      for (const item of await fetchAll(api, url.toString())) {
        const courseId = String(item.context_code || '').replace(/^course_/, '');
        announcements.push({
          key: `${courseId}:${item.id}`,
          title: item.title || '(Sin título)',
          course: courseNames.get(item.context_code) || `Curso ${courseId}`,
          author: item.author?.display_name || item.user_name || null,
          message: item.message || '',
          attachments: (item.attachments || []).map((file) => file.display_name || file.filename).filter(Boolean),
          postedAt: item.posted_at || item.delayed_post_at || item.created_at,
          url: item.html_url
            ? new URL(item.html_url, config.canvasOrigin).toString()
            : `${config.canvasOrigin}/courses/${courseId}/discussion_topics/${item.id}`,
        });
      }
    }

    // Del mas viejo al mas nuevo, para que lleguen a Telegram en orden.
    announcements.sort((a, b) => new Date(a.postedAt) - new Date(b.postedAt));
    return { courses: courses.length, announcements };
  } finally {
    await api.dispose();
  }
}

module.exports = {
  AuthenticationRequiredError,
  getAnnouncements,
  getGradedSubmissions,
  getPendingTasks,
  taskStatus,
};
