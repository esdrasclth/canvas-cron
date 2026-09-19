const { request } = require('playwright');
const config = require('./config');
const { exists } = require('./storage');

class AuthenticationRequiredError extends Error {
  constructor(message = 'La sesión de Canvas necesita renovarse', status = null) {
    super(message);
    this.name = 'AuthenticationRequiredError';
    this.code = 'AUTH_REQUIRED';
    this.status = status;
  }
}

class CanvasHttpError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'CanvasHttpError';
    this.code = 'CANVAS_HTTP_ERROR';
    this.status = status;
  }
}

// Con la sesion ya validada (la lista de cursos respondio), un 401/403/404 en
// un curso concreto significa que ese curso restringe la seccion, no que la
// sesion caduco: se salta ese curso en vez de perder todos los demas.
function isCourseRestriction(error) {
  return [401, 403, 404].includes(error?.status);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function canvasRetryDelay(response, attempt) {
  const raw = response?.headers?.()['retry-after'];
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return Math.min(config.canvasRetryBaseMs * (2 ** attempt), 30_000);
}

async function canvasGet(api, url, {
  maxRetries = config.canvasMaxRetries,
  sleep = wait,
} = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response;
    try {
      response = await api.get(url, { timeout: config.canvasRequestTimeoutMs });
    } catch (error) {
      if (attempt >= maxRetries) throw new CanvasHttpError(`No se pudo consultar Canvas: ${error.message}`);
      await sleep(Math.min(config.canvasRetryBaseMs * (2 ** attempt), 30_000));
      continue;
    }

    const retryable = response.status() === 429 || response.status() >= 500;
    if (!retryable || attempt >= maxRetries) return response;
    await sleep(canvasRetryDelay(response, attempt));
  }
  throw new CanvasHttpError('No se pudo consultar Canvas despues de varios intentos.');
}

function readJsonResponse(response, { courseScoped = false } = {}) {
  const status = response.status();
  const contentType = response.headers()['content-type'] || '';
  if ([401, 403].includes(status)) {
    if (courseScoped) throw new CanvasHttpError(`Canvas restringio el recurso (HTTP ${status})`, status);
    throw new AuthenticationRequiredError(undefined, status);
  }
  if (!response.ok()) throw new CanvasHttpError(`Canvas respondió HTTP ${status}`, status);
  if (!contentType.includes('application/json')) {
    // Una API que responde 200 con HTML suele ser la redireccion al login. Los
    // errores HTTP con HTML ya se clasificaron arriba como fallos de Canvas.
    throw new AuthenticationRequiredError('Canvas devolvio la pagina de inicio de sesion', status);
  }
  return response.json();
}

async function fetchAll(api, firstUrl, {
  courseScoped = false,
  maxPages = config.canvasMaxPages,
  requestOptions,
} = {}) {
  const items = [];
  let nextUrl = firstUrl;

  for (let page = 0; nextUrl; page += 1) {
    if (page >= maxPages) {
      throw new CanvasHttpError(`Canvas excedio el limite de ${maxPages} paginas; se cancelo para no guardar datos parciales.`);
    }
    const response = await canvasGet(api, nextUrl, requestOptions);
    const pageItems = await readJsonResponse(response, { courseScoped });
    if (!Array.isArray(pageItems)) throw new CanvasHttpError('Canvas devolvio una pagina JSON con formato inesperado.');
    items.push(...pageItems);
    nextUrl = response.headers().link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }

  return items;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
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

async function getPendingTasks({ authFile = config.authFile } = {}) {
  if (!await exists(authFile)) throw new AuthenticationRequiredError('No existe una sesión guardada');

  const api = await request.newContext({ storageState: authFile, timeout: config.canvasRequestTimeoutMs });
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

    const checked = await mapWithConcurrency(candidates, config.canvasConcurrency, async ({ item, assignmentId }) => {
      const response = await canvasGet(api,
        `${config.canvasOrigin}/api/v1/courses/${item.course_id}/assignments/${assignmentId}/submissions/self`,
      );
      const submission = response.status() === 404
        ? item.submissions
        : await readJsonResponse(response);
      return { item, assignmentId, submission };
    });

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

  const api = await request.newContext({ storageState: config.authFile, timeout: config.canvasRequestTimeoutMs });
  try {
    const courses = await listActiveCourses(api);
    const graded = [];
    const skipped = [];

    const courseResults = await mapWithConcurrency(courses, config.canvasConcurrency, async (course) => {
      const url = new URL(`/api/v1/courses/${course.id}/assignments`, config.canvasOrigin);
      url.searchParams.append('include[]', 'submission');
      url.searchParams.set('per_page', '100');

      let assignments;
      try {
        assignments = await fetchAll(api, url.toString(), { courseScoped: true });
      } catch (error) {
        if (!isCourseRestriction(error)) throw error;
        return { skipped: course.name || `Curso ${course.id}`, rows: [] };
      }
      const rows = [];
      for (const assignment of assignments) {
        const submission = assignment.submission;
        if (!submission || !submission.graded_at) continue;
        if (submission.workflow_state === 'unsubmitted' && submission.score == null) continue;

        rows.push({
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
      return { skipped: null, rows };
    });

    for (const result of courseResults) {
      if (result.skipped) skipped.push(result.skipped);
      graded.push(...result.rows);
    }

    graded.sort((a, b) => new Date(b.gradedAt) - new Date(a.gradedAt));
    return { courses: courses.length, submissions: graded, skipped };
  } finally {
    await api.dispose();
  }
}

// Los anuncios de todos los cursos salen de un solo endpoint filtrado por
// context_codes; se parten en grupos para no armar URLs enormes.
function announcementsUrl(codes, startDate, endDate) {
  const url = new URL('/api/v1/announcements', config.canvasOrigin);
  for (const code of codes) url.searchParams.append('context_codes[]', code);
  url.searchParams.set('start_date', startDate.toISOString());
  url.searchParams.set('end_date', endDate.toISOString());
  url.searchParams.set('per_page', '50');
  return url.toString();
}

async function getAnnouncements({ days = config.announcementLookbackDays } = {}) {
  if (!await exists(config.authFile)) throw new AuthenticationRequiredError('No existe una sesión guardada');

  const api = await request.newContext({ storageState: config.authFile, timeout: config.canvasRequestTimeoutMs });
  try {
    const courses = await listActiveCourses(api);
    const courseNames = new Map(courses.map((course) => [`course_${course.id}`, course.name || `Curso ${course.id}`]));
    const now = new Date();
    const startDate = new Date(now.getTime() - days * 86_400_000);
    const announcements = [];
    const skipped = [];
    const items = [];

    const codes = [...courseNames.keys()];
    for (let index = 0; index < codes.length; index += 10) {
      const group = codes.slice(index, index + 10);
      try {
        items.push(...await fetchAll(api, announcementsUrl(group, startDate, now), { courseScoped: true }));
      } catch (error) {
        if (!isCourseRestriction(error)) throw error;
        // Canvas rechaza el lote entero si un solo curso no deja ver anuncios;
        // se reintenta curso por curso para aislar al que falla.
        for (const code of group) {
          try {
            items.push(...await fetchAll(api, announcementsUrl([code], startDate, now), { courseScoped: true }));
          } catch (courseError) {
            if (!isCourseRestriction(courseError)) throw courseError;
            skipped.push(courseNames.get(code));
          }
        }
      }
    }

    for (const item of items) {
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

    // Del mas viejo al mas nuevo, para que lleguen a Telegram en orden.
    announcements.sort((a, b) => new Date(a.postedAt) - new Date(b.postedAt));
    return { courses: courses.length, announcements, skipped };
  } finally {
    await api.dispose();
  }
}

module.exports = {
  AuthenticationRequiredError,
  CanvasHttpError,
  canvasGet,
  fetchAll,
  getAnnouncements,
  getGradedSubmissions,
  getPendingTasks,
  mapWithConcurrency,
  readJsonResponse,
  taskStatus,
};
