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
    })
    .get('/system-logs', async ({ query, jwt: jwtPlugin, set, request }) => {
        const { token } = query;

        if (!token) { set.status = 401; return { error: 'Missing token' }; }
        const profile = await jwtPlugin.verify(token);
        if (!profile) { set.status = 401; return { error: 'Invalid token' }; }

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

                enqueue({ type: 'connected' });

                unsubscribe = eventBus.subscribeSystem((event) => enqueue(event));

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
        query: t.Object({ token: t.String() })
    });
