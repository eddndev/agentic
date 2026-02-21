# Real-Time Events: SSE (Server-Sent Events)

## Context

El frontend no tiene comunicación push del backend. Todo se obtiene por polling (`setInterval`):
- Monitor (chat): sesiones + mensajes cada 3s → 40 req/min
- Bot detail (QR): status + QR cada 3s → 40 req/min
- BotConnection: status + QR cada 2s → 60 req/min

Con 3 usuarios en el panel = ~240 req/min innecesarios. El QR tarda en aparecer, los mensajes llegan con hasta 3s de retraso, y la experiencia se siente lenta.

**Solución**: SSE con EventSource nativo del browser + EventEmitter en el backend (monolito single-process, no necesita Redis Pub/Sub).

---

## Arquitectura

```
BaileysService ──emit──┐
                        │
AIEngine ───────emit──┐ │
                      ▼ ▼
              EventBus (EventEmitter)
                      │
                      ▼
         GET /events/stream?token=xxx&botId=xxx
              (Elysia async ReadableStream)
                      │
                      ▼
            EventSource (browser)
                      │
            ┌─────────┴──────────┐
            ▼                    ▼
    monitor.astro         detail.astro
    (mensajes live)       (QR + status live)
```

---

## Eventos

| Evento | Emisor | Payload |
|--------|--------|---------|
| `bot:qr` | BaileysService | `{ botId, qr }` |
| `bot:connected` | BaileysService | `{ botId, user }` |
| `bot:disconnected` | BaileysService | `{ botId, statusCode }` |
| `message:received` | BaileysService | `{ botId, sessionId, message }` |
| `message:sent` | AIEngine | `{ botId, sessionId, content }` |
| `session:created` | BaileysService | `{ botId, session }` |

---

## Archivos nuevos (3)

### 1. `backend/src/services/event-bus.ts`

EventEmitter tipado con `subscribe(botId, callback) → unsubscribe()`. `setMaxListeners(0)` para múltiples tabs. Todos los eventos pasan por un solo canal interno `'bot-event'`, filtrado por `botId` en el subscriber.

```typescript
import { EventEmitter } from 'node:events';

export type BotEvent =
    | { type: 'bot:qr';          botId: string; qr: string }
    | { type: 'bot:connected';   botId: string; user: any }
    | { type: 'bot:disconnected';botId: string; statusCode: number | undefined }
    | { type: 'message:received';botId: string; sessionId: string; message: any }
    | { type: 'message:sent';    botId: string; sessionId: string; content: string }
    | { type: 'session:created'; botId: string; session: any };

class EventBus extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(0);
    }

    emitBotEvent(payload: BotEvent): boolean {
        return super.emit('bot-event', payload);
    }

    subscribe(botId: string, callback: (event: BotEvent) => void): () => void {
        const handler = (event: BotEvent) => {
            if (event.botId === botId) callback(event);
        };
        this.on('bot-event', handler);
        return () => this.off('bot-event', handler);
    }
}

export const eventBus = new EventBus();
```

### 2. `backend/src/api/events.controller.ts`

Endpoint SSE: `GET /events/stream?token=xxx&botId=xxx`

- Auth: verifica JWT desde query param (EventSource no soporta headers custom)
- Retorna `ReadableStream` con `content-type: text/event-stream`
- Suscribe al EventBus, cada evento se envía como `data: ${JSON.stringify(event)}\n\n`
- Heartbeat cada 30s (`: ping\n\n`) para mantener conexión viva
- Cleanup en `request.signal` abort + `ReadableStream.cancel()`
- Header `x-accel-buffering: no` para evitar buffering de nginx

```typescript
import { Elysia, t } from 'elysia';
import { jwt } from '@elysiajs/jwt';
import { eventBus } from '../services/event-bus';

export const eventsController = new Elysia({ prefix: '/events' })
    .use(jwt({
        name: 'jwt',
        secret: process.env.JWT_SECRET || 'DEV_SECRET_DO_NOT_USE_IN_PROOD'
    }))
    .get('/stream', async ({ query, jwt: jwtPlugin, set, request }) => {
        const { token, botId } = query;

        if (!token) { set.status = 401; return { error: 'Missing token' }; }
        const profile = await jwtPlugin.verify(token);
        if (!profile) { set.status = 401; return { error: 'Invalid token' }; }
        if (!botId) { set.status = 400; return { error: 'Missing botId' }; }

        set.headers['content-type'] = 'text/event-stream; charset=utf-8';
        set.headers['cache-control'] = 'no-cache';
        set.headers['connection'] = 'keep-alive';
        set.headers['x-accel-buffering'] = 'no';

        let unsubscribe: (() => void) | null = null;
        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

        const stream = new ReadableStream({
            start(controller) {
                const encoder = new TextEncoder();
                const enqueue = (data: object | string) => {
                    try {
                        const payload = typeof data === 'string' ? data : JSON.stringify(data);
                        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
                    } catch {}
                };

                enqueue({ type: 'connected', botId });

                unsubscribe = eventBus.subscribe(botId, (event) => enqueue(event));

                heartbeatTimer = setInterval(() => {
                    try { controller.enqueue(encoder.encode(': ping\n\n')); }
                    catch { if (heartbeatTimer) clearInterval(heartbeatTimer); }
                }, 30_000);

                request.signal.addEventListener('abort', () => {
                    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
                    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
                    try { controller.close(); } catch {}
                }, { once: true });
            },
            cancel() {
                if (unsubscribe) { unsubscribe(); unsubscribe = null; }
                if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
            }
        });

        return stream;
    }, {
        query: t.Object({ token: t.String(), botId: t.String() })
    });
```

### 3. `frontend/src/lib/events.ts`

Clase `BotEventSource` wrapper sobre `EventSource`:

```typescript
const API_URL = import.meta.env.PUBLIC_API_URL ||
    (import.meta.env.DEV ? 'http://localhost:8080' : 'https://api-agentic.angelviajero.com.mx');

type BotEventType =
    | 'connected' | 'bot:qr' | 'bot:connected' | 'bot:disconnected'
    | 'message:received' | 'message:sent' | 'session:created';

type EventHandler = (data: any) => void;

export class BotEventSource {
    private es: EventSource | null = null;
    private handlers = new Map<string, Set<EventHandler>>();
    private botId: string;

    constructor(botId: string) { this.botId = botId; }

    connect(): boolean {
        const token = localStorage.getItem('token');
        if (!token) return false;
        const url = `${API_URL}/events/stream?token=${encodeURIComponent(token)}&botId=${encodeURIComponent(this.botId)}`;
        this.es = new EventSource(url);
        this.es.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handlers.get(data.type)?.forEach(fn => { try { fn(data); } catch {} });
            } catch {}
        };
        this.es.onerror = () => console.warn('[SSE] Connection error, browser will retry...');
        return true;
    }

    on(type: BotEventType, handler: EventHandler): this {
        if (!this.handlers.has(type)) this.handlers.set(type, new Set());
        this.handlers.get(type)!.add(handler);
        return this;
    }

    close(): void {
        this.es?.close();
        this.es = null;
        this.handlers.clear();
    }
}
```

---

## Archivos modificados (6)

### 4. `backend/src/services/baileys.service.ts`

Agregar `import { eventBus } from './event-bus'` y emitir en 5 puntos:

| Ubicación | Evento |
|-----------|--------|
| Después de `qrCodes.set(botId, url)` | `bot:qr` |
| En `connection === 'open'`, después de `reconnectAttempts.delete` | `bot:connected` |
| En `connection === 'close'`, después de `sessions.delete` | `bot:disconnected` |
| En `handleIncomingMessage`, después de crear session nueva | `session:created` |
| En `handleIncomingMessage`, después del guard `if (!created)`, antes de `if (message.fromMe)` | `message:received` |

### 5. `backend/src/core/ai/AIEngine.ts`

Agregar `import { eventBus } from '../../services/event-bus'`. Emitir `message:sent` después de `BaileysService.sendMessage` exitoso (dentro del `if (response.content)` block).

### 6. `backend/src/index.ts`

Agregar `import { eventsController }` y `.use(eventsController)` en la cadena de Elysia.

### 7. `frontend/src/pages/bots/monitor.astro`

Reemplazar `setInterval(() => this.poll(), 3000)` con:
- `BotEventSource(botId)` que escucha:
  - `message:received` → push a `messages[]` si el sessionId coincide, actualizar `sessions[]` con lastMessage
  - `message:sent` → push a `messages[]` como `fromMe: true`
  - `session:created` → prepend a `sessions[]`
- Mantener un poll lento (60s) de `loadSessions()` como fallback
- `destroy()`: `sseClient.close()` + `clearInterval`

### 8. `frontend/src/pages/bots/detail.astro`

Reemplazar `setInterval(() => this.checkStatus(), 3000)` en el componente `botConnection_${safeId}` con:
- `BotEventSource(botId)` que escucha:
  - `bot:qr` → `this.qr = data.qr; this.connected = false`
  - `bot:connected` → `this.connected = true; this.qr = null`
  - `bot:disconnected` → `this.connected = false; this.qr = null`
- Mantener `checkStatus()` como fetch inicial one-shot
- `destroy()`: `sseClient.close()`

### 9. `frontend/src/components/BotConnection.astro`

Mismo patrón que detail.astro: reemplazar polling de 2s con SSE.

---

## Decisiones de diseño

- **`/bots` index page**: NO agregar SSE — es un one-shot check que apenas se usa. No vale N conexiones SSE por N bots.
- **No eliminar endpoints de polling** — siguen funcionando como fallback para clientes que no soporten SSE.
- **Dedup de `message:sent`**: El evento `message:received` con `fromMe: true` no se emite porque el guard `if (message.fromMe) { flowEngine...; return; }` lo atrapa antes. Solo `message:sent` de AIEngine llega al frontend para respuestas del bot.
- **JWT secret**: copiar la misma cadena exacta de `auth.middleware.ts` en `events.controller.ts` para evitar fallos de verificación.

---

## Orden de implementación

1. `event-bus.ts` (sin dependencias)
2. `baileys.service.ts` (agregar emits)
3. `AIEngine.ts` (agregar emit)
4. `events.controller.ts` (endpoint SSE)
5. `index.ts` (registrar controller)
6. `frontend/src/lib/events.ts` (wrapper EventSource)
7. `monitor.astro` (reemplazar polling)
8. `detail.astro` (reemplazar polling)
9. `BotConnection.astro` (reemplazar polling)

---

## Verificación

1. **Build**: `cd backend && npm run build` (esbuild bundle exitoso)
2. **Test SSE manual**: `curl -N "http://localhost:8080/events/stream?token=<jwt>&botId=<id>"` → ver `data: {"type":"connected",...}\n\n` y heartbeat cada 30s
3. **Test QR**: Abrir bot detail en browser → conectar bot → QR aparece instantáneamente sin refresh
4. **Test mensajes**: Abrir monitor → enviar mensaje por WhatsApp → aparece en el chat sin delay
5. **Test desconexión**: Cerrar tab → verificar que el EventBus limpia el subscriber (no memory leak)
6. **Test fallback**: Deshabilitar SSE (bloquear endpoint) → verificar que el poll de 60s sigue funcionando en monitor
