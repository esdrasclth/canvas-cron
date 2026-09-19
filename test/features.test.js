const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAnnouncementAlerts, buildAnnouncementsList, buildGradeAlerts, buildGradesList, buildTaskAlerts, buildWeeklyDigest,
  htmlToText, inQuietHours, isUrgentKind, localWeekday, shouldHoldAlert,
} = require('../src/notifications');
const { parseArgs, parseCallbackData } = require('../src/bot');
const { parseAuthState, summarizeAuthState } = require('../src/storage');
const { parseQuietHours } = require('../src/config');

// 2026-09-16T18:00Z son las 12:00 en America/Tegucigalpa (UTC-6).
const now = new Date('2026-09-16T18:00:00.000Z');

function fakeDatabase(overrides = {}) {
  const {
    initialized = true, gradesInitialized = true, task = null, sent = [],
    muted = [], action = null, submission = null,
    announcementsInitialized = true, savedAnnouncements = [],
  } = overrides;
  return {
    getState: (key) => {
      if (key === 'initialized') return initialized ? '1' : null;
      if (key === 'grades_initialized') return gradesInitialized ? '1' : null;
      if (key === 'announcements_initialized') return announcementsInitialized ? '1' : null;
      return null;
    },
    getTask: () => task,
    hasNotification: (key) => sent.includes(key),
    listMutedCourses: () => muted,
    getTaskAction: () => action,
    getSubmission: () => submission,
    hasAnnouncement: (key) => savedAnnouncements.includes(key),
  };
}

function task(overrides = {}) {
  return {
    key: '1:2',
    title: 'Proyecto final',
    course: 'Programación II',
    dueAt: '2026-09-16T23:00:00.000Z',
    status: 'upcoming',
    url: 'https://example.com/task',
    points: 20,
    type: 'assignment',
    ...overrides,
  };
}

test('un curso silenciado no genera ningún aviso', () => {
  const alerts = buildTaskAlerts([task()], fakeDatabase({ muted: ['Programación II'] }), now);
  assert.deepEqual(alerts, []);
});

test('una tarea marcada como entregada deja de avisar', () => {
  const action = { done_at: '2026-09-16T10:00:00.000Z', snooze_until: null };
  const alerts = buildTaskAlerts([task()], fakeDatabase({ action }), now);
  assert.deepEqual(alerts, []);
});

test('una tarea aplazada calla hasta que vence el aplazamiento', () => {
  const futuro = { done_at: null, snooze_until: '2026-09-16T20:00:00.000Z' };
  assert.deepEqual(buildTaskAlerts([task()], fakeDatabase({ action: futuro }), now), []);

  const vencido = { done_at: null, snooze_until: '2026-09-16T17:00:00.000Z' };
  const alerts = buildTaskAlerts([task()], fakeDatabase({ action: vencido }), now);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'snoozed');
  assert.equal(alerts[0].clearSnooze, true);
});

test('los avisos de tarea llevan botones de listo y aplazar', () => {
  const alerts = buildTaskAlerts([task()], fakeDatabase(), now);
  const buttons = alerts[0].keyboard.inline_keyboard[0];
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].callback_data, 'done:1:2');
  assert.equal(buttons[1].callback_data, 'snooze:1:2:120');
});

test('la clave de tarea con dos puntos se lee bien desde el boton', () => {
  assert.deepEqual(parseCallbackData('done:1234:5678'), { action: 'done', taskKey: '1234:5678' });
  assert.deepEqual(parseCallbackData('snooze:1234:5678:120'), {
    action: 'snooze', taskKey: '1234:5678', minutes: 120,
  });
  assert.equal(parseCallbackData('otra-cosa'), null);
  assert.equal(parseCallbackData('snooze:1234:5678:abc'), null);
});

test('la ventana de silencio cruza la medianoche', () => {
  const quiet = { start: 23, end: 6 };
  // 05:00Z = 23:00 local del dia anterior.
  assert.equal(inQuietHours(new Date('2026-09-17T05:00:00.000Z'), quiet), true);
  assert.equal(inQuietHours(new Date('2026-09-17T09:00:00.000Z'), quiet), true);
  assert.equal(inQuietHours(new Date('2026-09-16T18:00:00.000Z'), quiet), false);
});

test('en silencio solo pasan los avisos urgentes', () => {
  const madrugada = new Date('2026-09-17T08:00:00.000Z'); // 02:00 local
  assert.equal(shouldHoldAlert({ kind: 'new' }, madrugada), true);
  assert.equal(shouldHoldAlert({ kind: 'deadline_24h' }, madrugada), true);
  assert.equal(shouldHoldAlert({ kind: 'graded' }, madrugada), true);
  assert.equal(shouldHoldAlert({ kind: 'deadline_3h' }, madrugada), false);
  assert.equal(shouldHoldAlert({ kind: 'overdue' }, madrugada), false);
});

test('clasifica la urgencia por el umbral del recordatorio', () => {
  assert.equal(isUrgentKind('deadline_1h'), true);
  assert.equal(isUrgentKind('deadline_6h'), true);
  assert.equal(isUrgentKind('deadline_24h'), false);
  assert.equal(isUrgentKind('overdue'), true);
  assert.equal(isUrgentKind('new'), false);
});

test('lee la ventana de silencio desde la variable de entorno', () => {
  assert.deepEqual(parseQuietHours('23-6'), { start: 23, end: 6 });
  assert.deepEqual(parseQuietHours(' 22 - 7 '), { start: 22, end: 7 });
  assert.equal(parseQuietHours(''), null);
  assert.equal(parseQuietHours('25-3'), null);
  assert.equal(parseQuietHours('6-6'), null);
});

function submission(overrides = {}) {
  return {
    key: '1:2',
    title: 'Quiz de arreglos',
    course: 'Programación II',
    url: 'https://example.com/a',
    score: 18,
    pointsPossible: 20,
    grade: '18',
    gradedAt: '2026-09-16T12:00:00.000Z',
    ...overrides,
  };
}

test('avisa de una calificación nueva con nota y porcentaje', () => {
  const alerts = buildGradeAlerts([submission()], fakeDatabase(), now);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'graded');
  assert.match(alerts[0].text, /18 \/ 20 \(90%\)/);
  assert.match(alerts[0].text, /Nueva calificación/);
});

test('la primera sincronización no inunda con el historial', () => {
  const alerts = buildGradeAlerts([submission()], fakeDatabase({ gradesInitialized: false }), now);
  assert.deepEqual(alerts, []);
});

test('no repite una calificación sin cambios, pero sí avisa si cambia', () => {
  const guardada = { graded_at: '2026-09-16T12:00:00.000Z', score: 18 };
  assert.deepEqual(buildGradeAlerts([submission()], fakeDatabase({ submission: guardada }), now), []);

  const alerts = buildGradeAlerts([submission({ score: 20 })], fakeDatabase({ submission: guardada }), now);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /Cambió una calificación/);
});

test('una nota sin puntos posibles no inventa porcentaje', () => {
  const alerts = buildGradeAlerts([submission({ pointsPossible: null, grade: 'A' })], fakeDatabase(), now);
  assert.doesNotMatch(alerts[0].text, /%/);
});

test('no avisa de calificaciones de un curso silenciado', () => {
  const alerts = buildGradeAlerts([submission()], fakeDatabase({ muted: ['Programación II'] }), now);
  assert.deepEqual(alerts, []);
});

test('la lista de notas agrupa por curso y promedia', () => {
  const rows = [
    { title: 'Quiz 1', course: 'Programación II', score: 18, points_possible: 20, grade: '18', graded_at: '2026-09-15T12:00:00.000Z' },
    { title: 'Lab 2', course: 'Programación II', score: 10, points_possible: 20, grade: '10', graded_at: '2026-09-14T12:00:00.000Z' },
  ];
  const text = buildGradesList(rows, now);
  assert.match(text, /Programación II/);
  assert.match(text, /promedio 70%/);
  assert.match(text, /Quiz 1/);
});

test('el repaso semanal solo cuenta los próximos 7 días y suma puntos', () => {
  const text = buildWeeklyDigest([
    task({ key: 'a', title: 'De la semana', dueAt: '2026-09-18T15:00:00.000Z', points: 10 }),
    task({ key: 'b', title: 'Muy lejana', dueAt: '2026-11-01T15:00:00.000Z', points: 50 }),
  ], now);

  assert.match(text, /1 entrega en 7 días/);
  assert.match(text, /10 pts en juego/);
  assert.match(text, /De la semana/);
  assert.doesNotMatch(text, /Muy lejana/);
});

test('el domingo se identifica en la zona horaria local', () => {
  // 2026-09-20T18:00Z es domingo 12:00 en Tegucigalpa.
  assert.equal(localWeekday(new Date('2026-09-20T18:00:00.000Z')), 0);
  // 2026-09-21T02:00Z sigue siendo domingo 20:00 local.
  assert.equal(localWeekday(new Date('2026-09-21T02:00:00.000Z')), 0);
});

test('rechaza un archivo de sesión que no sirve', () => {
  assert.throws(() => parseAuthState('{}'), /falta el arreglo "cookies"/);
  assert.throws(() => parseAuthState('{"cookies":[]}'), /ninguna cookie/);
  assert.throws(() => parseAuthState('no json'), /no es JSON válido/);
});

test('resume la sesión distinguiendo cookies caducadas y de sesión', () => {
  const seconds = Math.floor(now.getTime() / 1000);
  const state = parseAuthState(JSON.stringify({
    cookies: [
      { name: 'futura', expires: seconds + 86_400 },
      { name: 'lejana', expires: seconds + 864_000 },
      { name: 'vieja', expires: seconds - 100 },
      { name: 'de-sesion', expires: -1 },
    ],
  }));

  const summary = summarizeAuthState(state, now);
  assert.equal(summary.cookies, 4);
  assert.equal(summary.sessionOnly, 1);
  assert.equal(summary.expired, 1);
  assert.equal(summary.earliestExpiryName, 'futura');
});

test('separa los argumentos de un comando', () => {
  assert.equal(parseArgs('/silenciar Programación II'), 'Programación II');
  assert.equal(parseArgs('/silenciar'), '');
});

function announcement(overrides = {}) {
  return {
    key: '10:77',
    title: 'Cambio de aula para el examen',
    course: 'Programación II',
    author: 'Ing. Pérez',
    message: '<p>Buenas tardes,</p><p>El examen será en el aula <strong>B-204</strong>.</p>',
    attachments: [],
    postedAt: '2026-09-16T16:00:00.000Z',
    url: 'https://example.com/anuncio',
    ...overrides,
  };
}

test('convierte el HTML del anuncio a texto conservando párrafos, viñetas y enlaces', () => {
  const text = htmlToText([
    '<h2>Recordatorio</h2>',
    '<p>Traer calculadora&nbsp;y &quot;hoja&quot; de f&oacute;rmulas.<br>Sin excepciones.</p>',
    '<ul><li>Tema 1</li><li>Tema 2</li></ul>',
    '<p>Guía: <a href="https://example.com/guia.pdf">descargar</a></p>',
    '<script>alert(1)</script><p>&#161;&#xE9;xito!</p>',
  ].join(''));

  assert.equal(text, [
    'Recordatorio',
    '',
    'Traer calculadora y "hoja" de fórmulas.',
    'Sin excepciones.',
    '',
    '• Tema 1',
    '• Tema 2',
    '',
    'Guía: descargar (https://example.com/guia.pdf)',
    '',
    '¡éxito!',
  ].join('\n'));
});

test('avisa de un anuncio nuevo con título y contenido', () => {
  const alerts = buildAnnouncementAlerts([announcement()], fakeDatabase(), now);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'announcement');
  assert.equal(alerts[0].key, 'announcement:10:77');
  assert.match(alerts[0].text, /Nuevo anuncio/);
  assert.match(alerts[0].text, /Cambio de aula para el examen/);
  assert.match(alerts[0].text, /El examen será en el aula B-204./);
  assert.match(alerts[0].text, /Ing. Pérez · hace 2 h/);
  // El HTML de Canvas no debe llegar crudo a Telegram.
  assert.doesNotMatch(alerts[0].text, /<p>|<strong>/);
});

test('escapa el contenido del anuncio para el HTML de Telegram', () => {
  const alerts = buildAnnouncementAlerts([
    announcement({ title: 'Notas <parcial>', message: '<p>Si x &lt; 5 &amp; y &gt; 2</p>' }),
  ], fakeDatabase(), now);
  assert.match(alerts[0].text, /Notas &lt;parcial&gt;/);
  assert.match(alerts[0].text, /Si x &lt; 5 &amp; y &gt; 2/);
});

test('la primera sincronización de anuncios no reenvía los viejos', () => {
  const alerts = buildAnnouncementAlerts([announcement()], fakeDatabase({ announcementsInitialized: false }), now);
  assert.deepEqual(alerts, []);
});

test('no repite anuncios ya vistos ni avisa de cursos silenciados', () => {
  assert.deepEqual(buildAnnouncementAlerts([announcement()], fakeDatabase({ savedAnnouncements: ['10:77'] }), now), []);
  assert.deepEqual(buildAnnouncementAlerts([announcement()], fakeDatabase({ muted: ['Programación II'] }), now), []);
});

test('un anuncio largo se recorta y enlaza al texto completo', () => {
  const alerts = buildAnnouncementAlerts([
    announcement({ message: `<p>${'palabra '.repeat(1000)}</p>`, attachments: ['rubrica.pdf'] }),
  ], fakeDatabase(), now);
  assert.ok(alerts[0].text.length < 4096);
  assert.match(alerts[0].text, /…/);
  assert.match(alerts[0].text, /Leer completo en Canvas/);
  assert.match(alerts[0].text, /Adjuntos: rubrica.pdf/);
});

test('en silencio los anuncios se retienen', () => {
  const madrugada = new Date('2026-09-17T08:00:00.000Z'); // 02:00 local
  assert.equal(shouldHoldAlert({ kind: 'announcement' }, madrugada), true);
});

test('la lista de anuncios muestra título, curso y un extracto', () => {
  const text = buildAnnouncementsList([{
    title: 'Cambio de aula', course: 'Programación II', message: 'El examen será en el aula B-204.',
    url: 'https://example.com/a', posted_at: '2026-09-16T16:00:00.000Z',
  }], now);
  assert.match(text, /Anuncios recientes/);
  assert.match(text, /Cambio de aula/);
  assert.match(text, /aula B-204/);
  assert.match(text, /hace 2 h/);
});
