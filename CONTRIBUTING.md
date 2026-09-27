# Contribuir a Canvas Cron

Canvas Cron es software libre bajo [MIT](LICENSE). Los reportes de fallos y las
propuestas son bienvenidos.

---

## Entorno

Requisitos: **Node 20+**.

```bash
npm install
npx playwright install chromium
cp .env.example .env
npm test
```

Para una revisión real hace falta una sesión de Canvas (`npm run portal`).
Sin `TELEGRAM_BOT_TOKEN` ni `TELEGRAM_CHAT_ID`, o con `TELEGRAM_DRY_RUN=true`,
los mensajes se imprimen en la terminal en vez de enviarse: así se prueba el
formato sin molestar a nadie.

---

## Pruebas

```bash
npm test
```

Las pruebas usan `node:test` y no salen a internet: Canvas y Telegram se
sustituyen por clientes falsos inyectados.
`test/formatting.test.js` fija la hora (`2026-09-16T18:00Z`, mediodía en
Tegucigalpa) para que «en 5 h» o «hace 2 días» no dependan de cuándo corren.
Si añades un mensaje, prueba su texto con una hora fija igual.

El enrutador de comandos (`src/bot.js`) carga SQLite de forma diferida, para
que las pruebas de formato no necesiten el binario nativo de better-sqlite3.

---

## Qué no romper

- **Un aviso se marca como enviado sólo después de que Telegram lo acepta.**
  Pasa por `alert_outbox`; si lo marcas antes, una caída a la mitad lo pierde,
  y si no lo marcas, se repite en cada revisión.
- **La primera sincronización no avisa.** Notas y anuncios sólo se registran la
  primera vez (`grades_initialized`, `announcements_initialized`). Quitar eso
  manda un semestre de avisos viejos.
- **El HTML que viene de Canvas se escapa siempre.** Telegram rechaza el mensaje
  entero ante una etiqueta que no admite; usa `escapeHtml` para todo texto
  de Canvas.
- **Los mensajes largos se dividen sin romper etiquetas.** `splitMessage` en
  `src/telegram.js` cierra y reabre las etiquetas abiertas en cada corte.
- **La revisión no abre un navegador.** Chromium es sólo para renovar la
  sesión; lo demás va por la API REST.
- **Nunca se evaden MFA ni CAPTCHA.** Si Microsoft pide intervención, el
  monitor avisa y se detiene.

---

## Estilo

- **Español** en los mensajes al usuario, en los comentarios y en los commits.
- Mensajes de commit en imperativo y con el porqué: «Reforzar entrega, sesión y
  resiliencia del monitor».
- Sin dependencias nuevas si Node ya lo resuelve (`fetch`, `node:test`,
  `process.loadEnvFile`).
- Toda variable nueva va en `.env.example`, en `docker-compose.yml` y en la
  tabla del README.

---

## Antes del pull request

```bash
npm test
docker compose build     # si tocaste dependencias o el Dockerfile
```

---

## Pull requests

1. Rama descriptiva: `feat/recordatorio-configurable`, `fix/anuncios-sin-texto`.
2. Un pull request, un tema.
3. En la descripción: qué problema resuelve y cómo lo probaste.
4. **Nunca subas `data/`, `artifacts/`, `playwright/.auth/` ni `.env`.** Tienen
   la sesión de Canvas, que da acceso a la cuenta, y el token del bot. Si un
   token se filtra, revócalo en BotFather con `/revoke`.

---

## Seguridad

Una vulnerabilidad no se reporta en un issue público. Escribe a
<Esdras.Clother@outlook.com> con los pasos para reproducirla.
