# Auditoría de Seguridad del Código — Agentic Platform

**Fecha:** 2026-02-21
**Alcance:** Backend (TypeScript/Bun), Core (Rust/Tokio), Frontend (Astro), Despliegue (Systemd/Nginx/CI)
**Total de hallazgos:** 101 problemas (29 CRITICAL, 20 HIGH, 25 MEDIUM, 27 LOW)

---

## Resumen Ejecutivo

Se realizó una auditoría exhaustiva del código fuente de la plataforma Agentic, una plataforma de orquestación de bots para WhatsApp y Telegram. Se analizaron más de 60 archivos fuente en tres lenguajes (TypeScript, Rust, Astro/HTML). Los hallazgos se clasifican en cuatro categorías: **Seguridad**, **Errores no manejados**, **Fugas de memoria** y **Optimización**.

### Distribución por severidad

| Severidad | Backend | Core (Rust) | Frontend/Deploy | Total |
|-----------|---------|-------------|-----------------|-------|
| CRITICAL  | 12      | 3           | 5               | **20** |
| HIGH      | 10      | 4           | 7               | **21** |
| MEDIUM    | 10      | 8           | 10              | **28** |
| LOW       | 14      | 8           | 8               | **30** |
| **Total** | **46**  | **23**      | **30**          | **99** |

---

## TOP 10 — Problemas Más Críticos (Acción Inmediata)

### 1. Secret JWT Hardcodeado como Fallback
- **Archivo:** `backend/src/middleware/auth.middleware.ts:10`
- **Severidad:** CRITICAL | **Categoría:** Seguridad
- **Descripción:** El secret JWT tiene fallback a `"DEV_SECRET_DO_NOT_USE_IN_PROOD"`. Si `JWT_SECRET` no está configurado en producción, cualquier atacante puede forjar tokens válidos.
- **Corrección:**
```ts
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET environment variable is required");
```

### 2. Rutas Críticas Sin Autenticación
- **Archivos:**
  - `backend/src/api/client.routes.ts` — CRUD de clientes (emails, teléfonos, CURP)
  - `backend/src/api/flow.controller.ts` — CRUD de flujos de automatización
  - `backend/src/api/trigger.controller.ts` — CRUD de triggers
  - `backend/src/api/execution.controller.ts` — Logs de ejecución
  - `backend/src/api/upload.controller.ts` — Subida/descarga de archivos
  - `backend/src/api/webhook.controller.ts` — Inyección de mensajes
- **Severidad:** CRITICAL | **Categoría:** Seguridad
- **Descripción:** Estas rutas no usan `authMiddleware` ni `.guard({ isSignIn: true })`. Cualquier persona con acceso a la red puede leer, crear, modificar y eliminar datos sensibles sin autenticación.
- **Corrección:** Agregar autenticación a todas las rutas:
```ts
export const clientRoutes = new Elysia({ prefix: "/clients" })
    .use(authMiddleware)
    .guard({ isSignIn: true })
    .get("/", ClientController.getAll)
    // ...
```

### 3. Path Traversal en Endpoint de Archivos
- **Archivo:** `backend/src/api/upload.controller.ts:82`
- **Severidad:** CRITICAL | **Categoría:** Seguridad
- **Descripción:** El parámetro `:name` en `/upload/files/:name` se usa directamente en `path.join()` sin sanitizar. Un atacante puede solicitar `/upload/files/../../etc/passwd` o `../../../.env` para leer archivos arbitrarios del servidor.
- **Corrección:**
```ts
const resolved = path.resolve(UPLOAD_DIR, name);
if (!resolved.startsWith(path.resolve(UPLOAD_DIR))) {
    set.status = 403;
    return "Access denied";
}
```

### 4. SSRF en Webhook Tool Executor y Media Services
- **Archivos:**
  - `backend/src/core/ai/ToolExecutor.ts:129-133`
  - `backend/src/services/media/pdf.service.ts:15`
  - `backend/src/services/media/transcription.service.ts:18-22`
  - `backend/src/services/media/vision.service.ts:27, 73-74`
- **Severidad:** CRITICAL | **Categoría:** Seguridad
- **Descripción:** Se realizan `fetch()` a URLs arbitrarias sin validación. Un atacante puede hacer que el servidor acceda a endpoints internos como `http://169.254.169.254/latest/meta-data/` (metadata de cloud) o `http://localhost:6379/` (Redis).
- **Corrección:** Validar URLs contra rangos de IP privados/reservados antes de hacer fetch. Bloquear `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`.

### 5. API Key de Gemini Expuesta en URL
- **Archivo:** `backend/src/services/ai/gemini.provider.ts:30, 86, 144`
- **Severidad:** CRITICAL | **Categoría:** Seguridad
- **Descripción:** La API key de Gemini se pasa como query parameter (`?key=${this.apiKey}`). Aparece en logs del servidor, logs de proxy, CDN, historial del navegador.
- **Corrección:** Usar header en su lugar:
```ts
headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey }
```

### 6. Spawning de Tareas Sin Límite (Core Rust) — DoS
- **Archivo:** `core/src/main.rs:125, 156, 185`
- **Severidad:** CRITICAL | **Categoría:** Seguridad/Memoria
- **Descripción:** Cada mensaje entrante genera un `tokio::spawn` sin límite de concurrencia. Una ráfaga de mensajes puede crear miles de tareas simultáneas, agotando conexiones de BD y memoria.
- **Corrección:**
```rust
let semaphore = Arc::new(tokio::sync::Semaphore::new(100));
let permit = semaphore.clone().acquire_owned().await.unwrap();
tokio::spawn(async move {
    let _permit = permit;
    // procesar mensaje...
});
```

### 7. Spawning Recursivo Sin Límite en Flow Engine
- **Archivo:** `core/src/flow_engine.rs:315-318, 358`
- **Severidad:** CRITICAL | **Categoría:** Memoria
- **Descripción:** `schedule_step` crea un `tokio::spawn` que llama a `execute_and_advance`, que a su vez llama a `schedule_step` de nuevo. Un flujo con muchos pasos (o delay_ms=0) crea cadenas profundas de spawns sin backpressure.
- **Corrección:** Convertir el patrón recursivo en un loop iterativo dentro de una sola tarea.

### 8. Token JWT Sin Expiración
- **Archivo:** `backend/src/api/auth.controller.ts:18-22`
- **Severidad:** HIGH | **Categoría:** Seguridad
- **Descripción:** Los JWT se firman sin claim de expiración. Un token comprometido es válido para siempre.
- **Corrección:**
```ts
await jwt.sign({ ...payload, exp: Math.floor(Date.now()/1000) + 86400 }) // 24h
```

### 9. Credenciales Admin Hardcodeadas en Seed
- **Archivo:** `backend/prisma/seed.ts:7-8, 38`
- **Severidad:** CRITICAL | **Categoría:** Seguridad
- **Descripción:** Credenciales por defecto `admin@agentic.com / password123` en código fuente. La línea 38 además imprime la contraseña en texto plano en los logs.
- **Corrección:** No ejecutar seed en producción sin credenciales vía variables de entorno. Eliminar log de contraseña.

### 10. Token en localStorage (Vulnerable a XSS)
- **Archivo:** `frontend/src/pages/login.astro:103-104`, `frontend/src/lib/api.ts:7-8`
- **Severidad:** CRITICAL | **Categoría:** Seguridad
- **Descripción:** El JWT se almacena en `localStorage`, accesible por cualquier JavaScript en la página. Cualquier vulnerabilidad XSS permite robar el token.
- **Corrección:** Usar cookies `httpOnly`, `Secure`, `SameSite=Strict` configuradas desde el servidor.

---

## BACKEND — Hallazgos Completos (TypeScript/Bun)

### Seguridad

| # | Severidad | Archivo | Descripción |
|---|-----------|---------|-------------|
| B1 | CRITICAL | `middleware/auth.middleware.ts:10` | JWT secret con fallback hardcodeado `"DEV_SECRET_DO_NOT_USE_IN_PROOD"` |
| B2 | CRITICAL | `prisma/seed.ts:7-8` | Credenciales admin por defecto en código fuente; contraseña logueada en línea 38 |
| B3 | CRITICAL | `api/upload.controller.ts:82` | Path traversal — `:name` param no sanitizado en `path.join()` |
| B4 | CRITICAL | `services/ai/gemini.provider.ts:30,86,144` | API key en URL query string expuesta en logs |
| B5 | CRITICAL | `core/ai/ToolExecutor.ts:129-133` | SSRF — webhook fetch a URL arbitraria sin validación |
| B6 | CRITICAL | `services/media/pdf.service.ts:15` | SSRF — fetch a URL de media sin validación |
| B7 | CRITICAL | `services/media/transcription.service.ts:18-22` | SSRF — fetch a URL de transcripción sin validación |
| B8 | CRITICAL | `services/media/vision.service.ts:27,73-74` | SSRF — fetch a URL de imagen sin validación |
| B9 | CRITICAL | `api/client.routes.ts:1-9` | Rutas de clientes sin autenticación (emails, CURP, teléfonos) |
| B10 | CRITICAL | `api/flow.controller.ts` | Rutas de flujos sin autenticación |
| B11 | CRITICAL | `api/trigger.controller.ts` | Rutas de triggers sin autenticación |
| B12 | CRITICAL | `api/execution.controller.ts` | Rutas de ejecuciones sin autenticación |
| B13 | HIGH | `api/auth.controller.ts:22` | Rol `"ADMIN"` hardcodeado en cada JWT |
| B14 | HIGH | `api/client.controller.ts:89-106` | Mass assignment — spread de `updateData` sin whitelist |
| B15 | HIGH | `api/bot.controller.ts:205`, `webhook.controller.ts:89` | Detalles de error interno expuestos al cliente |
| B16 | HIGH | `api/auth.controller.ts:7-36` | Sin rate limiting en endpoint de login |
| B17 | HIGH | `api/bot.controller.ts:127-176` | Sin validación de input en update de bot (enum cast sin validar) |
| B18 | HIGH | `services/encryption.service.ts:1-64` | AES-256-CBC sin HMAC (ciphertext maleable, padding oracle) |
| B19 | HIGH | `api/auth.controller.ts:18-22` | JWT sin claim de expiración |
| B20 | HIGH | `api-main.ts:39-43` | CORS permite orígenes localhost en producción |
| B21 | MEDIUM | `api/bot.controller.ts:30,128`, `flow.controller.ts:35,75` | Body cast a `any` — bypass de type safety y validación |
| B22 | MEDIUM | `api/execution.controller.ts:53-54` | `parseInt` sin radix ni verificación de NaN |
| B23 | MEDIUM | `api/client.controller.ts:111-116` | Delete sin try/catch — error P2025 no manejado |
| B24 | MEDIUM | `api/upload.controller.ts:13-52` | Sin validación de tamaño ni tipo de archivo en upload |
| B25 | MEDIUM | `api/bot.controller.ts` (todos), `session.controller.ts`, `tool.controller.ts` | Sin verificación de autorización horizontal (ownership) |
| B26 | MEDIUM | `api/webhook.controller.ts:30-31` | Enumeración de bot identifiers en mensajes de error |
| B27 | MEDIUM | `api/webhook.controller.ts:61` | `Math.random()` para IDs externos — riesgo de colisión |
| B28 | MEDIUM | `api-main.ts` (sin shutdown handler) | Sin graceful shutdown de Prisma |
| B29 | MEDIUM | `index.ts:12-15`, `api-main.ts:18-20`, `gateway-main.ts:22-24` | `uncaughtException` capturada sin `process.exit()` — estado indefinido |
| B30 | LOW | `api/bot.controller.ts:25-26,118-126` | Credenciales de bot retornadas sin filtrar en respuestas |
| B31 | LOW | `api/bot.controller.ts:94` | JSON.parse silencioso con catch vacío |
| B32 | LOW | `api/session.controller.ts:192-193` | Sin validación de offset/limit negativos |
| B33 | LOW | `api/tool.controller.ts:8-14` | Sin límite de longitud en nombre de herramienta (ReDoS) |
| B34 | LOW | `core/ai/ToolExecutor.ts:428` | `externalId: null` en unique column — comportamiento DB-specific |
| B35 | LOW | `services/ai/openai.provider.ts:46` | `JSON.parse` de tool arguments sin try/catch |
| B36 | LOW | `services/ai/openai.provider.ts:23-30`, `gemini.provider.ts:56-59` | Sin timeout en fetch a APIs externas de AI |
| B37 | LOW | `gateway-main.ts:73-86` | Health endpoint muestra conteo de bots stale |

### Fugas de Memoria

| # | Severidad | Archivo | Descripción |
|---|-----------|---------|-------------|
| B38 | HIGH | `services/ai/gemini.provider.ts:13,160` | `cacheRegistry` Map crece sin límite — nunca se evictan entradas |
| B39 | HIGH | `services/gateway-command.client.ts:85-118` | Fire-and-forget crea reply keys huérfanas en Redis |
| B40 | MEDIUM | `services/redis.service.ts:1-14` | Conexión Redis nunca cerrada en shutdown |
| B41 | LOW | `services/accumulator.service.ts:1-61` | Buffer en memoria crece indefinidamente con debounce alto |

### Optimización

| # | Severidad | Archivo | Descripción |
|---|-----------|---------|-------------|
| B42 | MEDIUM | `api/session.controller.ts:25-39` | Query de sesiones sin paginación — retorna todo el dataset |
| B43 | MEDIUM | `api/bot.controller.ts:161-168,180-187` | N+1 query — clear conversations itera sesiones secuencialmente |
| B44 | LOW | `prisma/schema.prisma:136,147` | Index duplicado en `Message.externalId` |
| B45 | LOW | `prisma/schema.prisma:44-62` | Index faltante en `Session.botId` |
| B46 | LOW | `services/baileys.service.ts:47-48,326-328,499-500` | Operaciones de archivo síncronas bloquean event loop |

---

## CORE (Rust) — Hallazgos Completos

### Seguridad

| # | Severidad | Archivo | Descripción |
|---|-----------|---------|-------------|
| R1 | CRITICAL | `matcher.rs:9-35`, `models/db.rs:39` | `MatchType::REGEX` definido pero no implementado — vector ReDoS si se implementa ingenuamente |
| R2 | CRITICAL | `main.rs:125,156,185` | Task spawning sin límite de concurrencia — DoS |
| R3 | CRITICAL | `flow_engine.rs:315-318,358` | Spawning recursivo sin backpressure en Flow Engine |
| R4 | HIGH | `main.rs:203-208` | Payload crudo con PII logueado en parse failure |
| R5 | HIGH | `processors.rs:129` | Timezone `America/Mexico_City` hardcodeada |
| R6 | MEDIUM | `flow_engine.rs:298-305` | Sin validación de `delay_ms`/`jitter_pct` — overflow potencial |
| R7 | MEDIUM | `flow_engine.rs:183` | Sin protección de idempotencia en procesamiento de mensajes |
| R8 | LOW | `flow_engine.rs:30` | Sin validación de longitud máxima de contenido de mensaje |

### Errores No Manejados

| # | Severidad | Archivo | Descripción |
|---|-----------|---------|-------------|
| R9 | HIGH | `processors.rs:262-293` | Serialización fallida de mensaje saliente silenciada con `if let Ok` |
| R10 | HIGH | `flow_engine.rs:79-220` | Lock distribuido no liberado en panic — 30s de mensajes perdidos |
| R11 | MEDIUM | `flow_engine.rs:87` | `unwrap_or(false)` enmascara errores de conectividad Redis |
| R12 | MEDIUM | `processors.rs:236-241` | `unwrap_or(None)` en gateway lookup enmascara errores Redis |
| R13 | MEDIUM | `processors.rs:126-127` | Parse failure de `ConditionalTimeMetadata` silenciado |
| R14 | MEDIUM | `main.rs:197-201` | ACK failure silenciado — causa duplicación de mensajes |
| R15 | MEDIUM | `flow_engine.rs:393-425` | Recovery sin filtro de antigüedad ni límite de batch |
| R16 | MEDIUM | `models/db.rs:117` | `Execution.status` es String en lugar de enum tipado |
| R17 | LOW | `flow_engine.rs:287-292,328-334,348-354` | `let _ =` descarta errores de UPDATE a BD |
| R18 | LOW | `processors.rs:137-147` | `to_minutes` parser sin validación de rango (99:99 aceptado) |
| R19 | LOW | `main.rs:28` | `DATABASE_URL` potencialmente expuesta en panic message |
| R20 | LOW | `flow_engine.rs:358` | `step.order + 1` overflow en debug mode |

### Memoria y Performance

| # | Severidad | Archivo | Descripción |
|---|-----------|---------|-------------|
| R21 | LOW | `main.rs` (todo) | Sin graceful shutdown — tareas abortadas dejan executions en RUNNING |
| R22 | LOW | `main.rs:59,79,199,212` + otros | Clones innecesarios de Redis connection (bajo impacto) |
| R23 | LOW | `tests/e2e_roundtrip.rs:105` | Test E2E hardcodea stream sin gateway ID — siempre falla |

---

## FRONTEND / DEPLOY — Hallazgos Completos

### Seguridad Frontend

| # | Severidad | Archivo | Descripción |
|---|-----------|---------|-------------|
| F1 | CRITICAL | `pages/login.astro:103-104`, `lib/api.ts:7-8` | Token JWT almacenado en localStorage (vulnerable a XSS) |
| F2 | CRITICAL | `components/MediaPicker.astro:226-234` | Upload sin header de autorización — bypass de auth |
| F3 | CRITICAL | `lib/api.ts:1` | URL de producción hardcodeada como fallback en código cliente |
| F4 | CRITICAL | `components/clients/ClientList.astro:240` | `ApiClient` expuesto en `window` — XSS tiene acceso a API autenticada |
| F5 | HIGH | `pages/bots/detail.astro:384,1092-1113` | XSS via `x-html` con `botId` de URL sin sanitizar |
| F6 | HIGH | `lib/api.ts` (todos los métodos) | Sin protección CSRF |
| F7 | MEDIUM | `layouts/Layout.astro:29-44` | Token no limpiado en localStorage al fallar sesión |
| F8 | MEDIUM | `layouts/Layout.astro:31-34` | Logs de debug con datos de usuario en producción |
| F9 | MEDIUM | `pages/login.astro:104` | Objeto user completo en localStorage (datos sensibles expuestos) |
| F10 | MEDIUM | `lib/api.ts` | Sin manejo de 401 — no redirecciona ni limpia token |
| F11 | MEDIUM | `pages/bots/index.astro:328-329` | Sin validación de input antes de enviar a API |
| F12 | LOW | `layouts/Layout.astro:65-72` | Sin meta tag Content-Security-Policy como fallback |
| F13 | LOW | Múltiples páginas | Uso de `alert()` para mensajes — bloquea thread y UX pobre |

### Seguridad de Despliegue

| # | Severidad | Archivo | Descripción |
|---|-----------|---------|-------------|
| D1 | CRITICAL | `.github/workflows/deploy.yml:32` | `git reset --hard` en producción destruye cambios locales |
| D2 | HIGH | `vps-setup.sh:69` | Nginx solo escucha en puerto 80 — sin HTTPS/TLS |
| D3 | HIGH | `vps-setup.sh:68-93` | Sin security headers en Nginx (CSP, HSTS, X-Frame-Options, etc.) |
| D4 | HIGH | `deploy/agentic-*.service:23-24` | `ReadWritePaths` demasiado amplio — servicio puede modificar su propio código |
| D5 | HIGH | `.github/workflows/deploy.yml:54-68` | Usuario deploy con sudo sin restricciones |
| D6 | HIGH | `.github/workflows/deploy.yml:39` | Seed de BD ejecutado en cada deploy de producción |
| D7 | MEDIUM | `deploy/agentic-*.service` | Faltan directivas de hardening: `ProtectHome`, `PrivateTmp`, `PrivateDevices` |
| D8 | MEDIUM | `deploy/agentic-backend.service` | Servicio legacy sin hardening (puede reactivarse accidentalmente) |
| D9 | MEDIUM | `vps-setup.sh:48-55,105` | Password de BD echado a terminal y visible en output |
| D10 | MEDIUM | `vps-setup.sh:62` | `chmod 755` en directorio de app — legible por todos los usuarios |
| D11 | MEDIUM | `.github/workflows/deploy.yml` | Sin pasos de auditoría de seguridad en CI/CD |
| D12 | LOW | `deploy/.env.gateway-1:2` | Puerto de health check (9001) sin firewall |
| D13 | LOW | `vps-setup.sh:41`, `ecosystem.config.cjs` | PM2 instalado pero no usado — software innecesario |
| D14 | LOW | `frontend/package.json` | Sin lockfile para builds reproducibles |
| D15 | LOW | `.github/workflows/deploy.yml:36` | `bun install` sin `--frozen-lockfile` en CI |

---

## Aspectos Positivos

La auditoría también identificó buenas prácticas:

1. **Sin SQL injection en Rust** — Todas las queries usan bindings parametrizados (`$1`, `$2`) via sqlx
2. **Sin código `unsafe` en Rust** — Cero bloques `unsafe` en todo el codebase
3. **Hashing de contraseñas con Argon2** — Algoritmo robusto para almacenamiento de passwords
4. **Poison pill handling** — Mensajes con JSON inválido se ACKean correctamente
5. **Connection pooling** — PostgreSQL usa `PgPoolOptions` con pool de 20 conexiones
6. **Stream trimming** — `XADD` usa `MAXLEN ~ 10000` para prevenir crecimiento infinito
7. **Distributed locking** — Lock Redis con TTL previene ejecuciones duplicadas concurrentes
8. **Systemd sandboxing parcial** — `NoNewPrivileges=true`, `ProtectSystem=strict` presentes
9. **Internacionalización** — Soporte i18n con español e inglés

---

## Plan de Remediación Recomendado

### Fase 1 — Inmediato (Semana 1-2)
| Prioridad | Acción | Issues |
|-----------|--------|--------|
| P0 | Eliminar fallback de JWT secret — fallar en startup si no está configurado | B1 |
| P0 | Agregar autenticación a TODAS las rutas desprotegidas | B9-B12 |
| P0 | Corregir path traversal en upload file serving | B3 |
| P0 | Mover API key de Gemini de URL a header | B4 |
| P0 | Agregar expiración a JWT | B19 |
| P0 | Eliminar credenciales por defecto del seed en producción | B2 |

### Fase 2 — Corto plazo (Semana 3-4)
| Prioridad | Acción | Issues |
|-----------|--------|--------|
| P1 | Validar URLs contra IPs privadas en fetch (SSRF) | B5-B8 |
| P1 | Agregar límite de concurrencia en Rust core | R2, R3 |
| P1 | Migrar token de localStorage a httpOnly cookies | F1 |
| P1 | Corregir upload sin auth en MediaPicker | F2 |
| P1 | Cambiar AES-256-CBC por AES-256-GCM | B18 |
| P1 | Configurar HTTPS en Nginx | D2 |
| P1 | Agregar security headers en Nginx | D3 |
| P1 | Eliminar seed de pipeline de producción | D6 |

### Fase 3 — Medio plazo (Semana 5-8)
| Prioridad | Acción | Issues |
|-----------|--------|--------|
| P2 | Agregar rate limiting en login y webhook | B16, B11 |
| P2 | Implementar autorización horizontal (ownership checks) | B25 |
| P2 | Agregar logging a todas las supresiones silenciosas de errores en Rust | R9-R14 |
| P2 | Implementar protección de idempotencia | R7 |
| P2 | Agregar graceful shutdown en todos los servicios | B28, B40, R21 |
| P2 | Validar y sanitizar inputs con esquemas Elysia `t.Object()` | B21, B17 |
| P2 | Agregar timeouts a llamadas de API externas | B36 |
| P2 | Restringir permisos sudo del usuario deploy | D5 |
| P2 | Hardening completo de systemd services | D7 |
| P2 | Agregar auditoría de seguridad a CI/CD | D11 |

### Fase 4 — Largo plazo (Mes 2-3)
| Prioridad | Acción | Issues |
|-----------|--------|--------|
| P3 | Implementar CSRF tokens | F6 |
| P3 | Hacer timezone configurable por bot | R5 |
| P3 | Implementar LRU cache para Gemini | B38 |
| P3 | Optimizar N+1 queries y paginación | B42, B43 |
| P3 | Agregar filtro de antigüedad en recovery | R15 |
| P3 | Tipar `Execution.status` como enum | R16 |
| P3 | Agregar validación de archivos (tamaño/tipo) en upload | B24 |
| P3 | Remover software innecesario (PM2) | D13 |
| P3 | Convertir operaciones de archivo a async | B46 |
