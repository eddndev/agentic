import { Elysia, t } from 'elysia';
import { authMiddleware } from '../middleware/auth.middleware';
import { getRecentLogs } from '../services/system-logger';

export const logsController = new Elysia({ prefix: '/logs' })
    .use(authMiddleware)
    .guard({ isSignIn: true })
    .get('/system', ({ query }) => {
        const limit = Math.min(Number(query.limit) || 100, 500);
        const offset = Number(query.offset) || 0;
        const level = (['info', 'warn', 'error'] as const).includes(query.level as any)
            ? (query.level as 'info' | 'warn' | 'error')
            : undefined;
        const search = query.search || undefined;

        return getRecentLogs(limit, offset, level, search);
    }, {
        query: t.Object({
            limit: t.Optional(t.String()),
            offset: t.Optional(t.String()),
            level: t.Optional(t.String()),
            search: t.Optional(t.String()),
        })
    });
