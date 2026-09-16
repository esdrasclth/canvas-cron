# Monitor de tareas de UNITEC y Canvas

Servicio de Node.js que consulta Canvas con una sesión guardada, identifica tareas
pendientes y envía alertas por Telegram. Está preparado para ejecutarse en un
contenedor administrado por Dokploy sin abrir un navegador durante las revisiones
normales.

Chromium solo se inicia en modo headless cuando la sesión necesita renovarse.

## Comandos locales

```powershell
npm install
npm run portal
npm run tasks
npm run check
npm test
```

- `npm run portal`: abre el portal para iniciar sesión manualmente.
- `npm run tasks`: genera la lista local anterior de tareas.
- `npm run check`: ejecuta el monitor y las reglas de notificación.
- `npm run service`: inicia el endpoint interno `/health` para mantener activo el contenedor.
- `npm run auth:export`: exporta la sesión en Base64 para cargarla inicialmente en Dokploy.
- `npm run telegram:setup`: valida el token del bot y encuentra el `chat_id` después de enviarle `/start`.

`npm run check` usa Telegram en modo de prueba mientras falten el token o el chat ID.
Los mensajes aparecen en la terminal y no se envían.

## Datos persistentes

En desarrollo se usa `./data`. En Docker se monta `/app/data`, que contiene:

```text
auth/unitec.json       Sesión de Canvas
chrome-profile/        Perfil utilizado para renovar la sesión
notifications.db       Tareas y alertas ya enviadas
output/                Último resultado de la extracción
```

La carpeta está excluida de Git. Su contenido debe tratarse como una credencial.

## Variables

Copia `.env.example` como `.env` para desarrollo. En Dokploy configura las
variables desde la sección Environment del servicio.

| Variable | Uso |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Token entregado por BotFather. |
| `TELEGRAM_CHAT_ID` | Chat privado que recibirá las alertas. |
| `TELEGRAM_DRY_RUN` | `false` habilita el envío real. |
| `UNITEC_EMAIL` | Correo usado para renovar una sesión vencida. |
| `UNITEC_PASSWORD` | Contraseña usada únicamente durante la renovación headless. |
| `AUTH_STATE_B64` | Sesión inicial exportada; puede eliminarse después del primer arranque. |
| `REMINDER_HOURS` | Umbrales de recordatorio, por defecto `72,24,6,3,1`. |
| `DAILY_DIGEST_HOUR` | Hora local del resumen diario, por defecto `18`. |
| `TELEGRAM_COMMANDS` | `false` desactiva la atención de comandos. |
| `TELEGRAM_POLL_TIMEOUT` | Segundos de long polling, por defecto `50`. |
| `TIMEZONE` | Zona horaria, por defecto `America/Tegucigalpa`. |

## Configurar Telegram de forma segura

El token de BotFather es una credencial con control total del bot. Si se comparte
por accidente, revócalo en BotFather con `/revoke` y genera uno nuevo con `/token`.
Configura el token nuevo directamente en Dokploy y no lo pegues en el repositorio
ni en el chat. El `TELEGRAM_CHAT_ID` de este usuario es `679645775`.

## Despliegue en Dokploy

El código vive en `https://github.com/esdrasclth/canvas-cron`. Usa ese repositorio
como fuente en Dokploy: la subida directa de un ZIP devuelve `500 Internal Server
Error` y no es una vía fiable.

1. En Dokploy crea un servicio **Docker Compose** y elige el proveedor **GitHub**.
2. Selecciona el repositorio `esdrasclth/canvas-cron`, rama `main`, y deja
   `docker-compose.yml` como ruta del Compose.
3. Copia las variables de `.env.example` en la sección Environment.
4. Genera la sesión inicial localmente:

   ```powershell
   npm run auth:export
   ```

5. Copia el contenido de `artifacts/unitec-auth.b64` a `AUTH_STATE_B64` en Dokploy.
6. Despliega el Compose. El volumen `unitec-bot-data` conservará la sesión y SQLite.
7. En **Schedules**, crea un trabajo de tipo **Compose**:
   - Servicio: `unitec-bot`
   - Comando: `npm run check`
   - Cron: `*/30 * * * *`
   - Zona horaria: `America/Tegucigalpa`
8. Ejecuta el trabajo manualmente con `TELEGRAM_DRY_RUN=true` y revisa los logs.
9. Configura el bot y cambia `TELEGRAM_DRY_RUN=false`.
10. Elimina `AUTH_STATE_B64` después de confirmar que `/app/data/auth/unitec.json` existe.

No es necesario publicar un dominio. El servicio de salud escucha en el puerto
3000 dentro del contenedor y el trabajo programado se ejecuta con `docker exec`.

## Diagnóstico en Dokploy

**El schedule responde `Container not found`.** Significa que no hay contenedor en
ejecución al que entrar, casi siempre porque el proceso principal murió y
`restart: unless-stopped` lo dejó en bucle de reinicio. Revisa los logs del
Compose y comprueba el estado del contenedor. El servidor de salud ya no termina
el proceso cuando falla la preparación de la sesión: se mantiene en pie y reporta
el motivo, de modo que el `docker exec` del schedule siempre encuentre destino.

**Comprobar el estado desde dentro del contenedor:**

```sh
node -e "require('node:http').get('http://127.0.0.1:3000/health',r=>{r.pipe(process.stdout)})"
```

- `{"status":"ready"}` — la sesión está cargada y `npm run check` puede ejecutarse.
- `{"status":"authentication_required","error":"..."}` — falta la sesión; el campo
  `error` indica si `AUTH_STATE_B64` es inválido.

**`AUTH_STATE_B64` inválido.** El editor de variables puede partir el base64 en
varias líneas o recortarlo. Los saltos de línea y espacios ya se limpian
automáticamente, pero un valor truncado se rechaza con un mensaje explícito.
Vuelve a generarlo con `npm run auth:export` y pega el contenido completo.

## Comandos en Telegram

El servicio que mantiene vivo al contenedor también atiende comandos, así que se
pueden consultar las tareas en cualquier momento sin esperar la revisión de los
30 minutos. El menú se registra en Telegram al arrancar.

| Comando | Qué devuelve |
| --- | --- |
| `/tareas` | Todas las pendientes, agrupadas por urgencia. |
| `/hoy` | Solo lo que vence hoy. |
| `/semana` | Los próximos 7 días. |
| `/vencidas` | Lo que ya pasó de fecha. |
| `/resumen` | El resumen diario, en el momento. |
| `/revisar` | Consulta Canvas en vivo y luego responde. |
| `/estado` | Sesión, última revisión, conteos y configuración. |
| `/ayuda` | La lista de comandos. |

Las consultas se responden con lo último guardado en SQLite, por lo que son
inmediatas e incluyen cuándo se actualizó. `/revisar` es el único que sale a
Canvas, y comparte el mismo archivo de bloqueo que la tarea programada: si una
revisión ya está en curso, lo dice en lugar de duplicarla.

Solo se atiende el chat indicado en `TELEGRAM_CHAT_ID`; los mensajes de cualquier
otro se registran y se descartan. Los comandos quedan inactivos mientras
`TELEGRAM_DRY_RUN` sea `true`, porque sin envío real no habría respuesta.

## Alertas

El monitor envía mensajes cuando:

- aparece una actividad nueva;
- cambia una fecha de entrega;
- faltan 72, 24, 6, 3 o 1 hora;
- una actividad vence;
- llega la hora del resumen diario (18:00 local, haya novedades o no);
- Microsoft exige intervención para renovar la sesión.

SQLite registra cada alerta después de que Telegram la acepta. Si el trabajo vuelve
a ejecutarse, el mismo aviso no se repite.

## Sesión vencida

El monitor primero intenta renovar la sesión con Chromium headless y las variables
`UNITEC_EMAIL` y `UNITEC_PASSWORD`. Si Microsoft solicita MFA, CAPTCHA o una
confirmación adicional, se envía una alerta técnica y será necesario generar y
cargar una sesión nueva. El proceso no intenta evadir esos controles.
