import { redis } from "./redis.service";
import { prisma } from "./postgres.service";
import type { AIMessage } from "./ai";

const KEY_PREFIX = "conv:";
const TTL_SECONDS = Number(process.env.CONV_TTL_SECONDS) || 7 * 24 * 60 * 60; // 7 days
const MAX_MESSAGES = Number(process.env.CONV_MAX_MESSAGES) || 100;
const PG_HISTORY_DAYS = Number(process.env.CONV_PG_HISTORY_DAYS) || 30;

export class ConversationService {

    static key(sessionId: string): string {
        return `${KEY_PREFIX}${sessionId}`;
    }

    static async addMessage(sessionId: string, message: AIMessage): Promise<void> {
        const k = this.key(sessionId);
        await redis.rpush(k, JSON.stringify(message));
        await redis.ltrim(k, -MAX_MESSAGES, -1);
        await redis.expire(k, TTL_SECONDS);

        // Dual-write to Postgres (non-fatal)
        try {
            await prisma.conversationLog.create({
                data: {
                    sessionId,
                    role: message.role,
                    content: message.content ?? null,
                    toolName: message.name ?? null,
                    toolArgs: message.toolCalls ? message.toolCalls as any : null,
                    toolResult: message.toolCallId ? { toolCallId: message.toolCallId } : null,
                },
            });
        } catch (e) {
            console.error("[ConversationService] Postgres write failed:", e);
        }
    }

    static async addMessages(sessionId: string, messages: AIMessage[]): Promise<void> {
        if (messages.length === 0) return;
        const k = this.key(sessionId);

        // Redis pipeline
        const pipeline = redis.pipeline();
        for (const msg of messages) {
            pipeline.rpush(k, JSON.stringify(msg));
        }
        pipeline.ltrim(k, -MAX_MESSAGES, -1);
        pipeline.expire(k, TTL_SECONDS);
        await pipeline.exec();

        // Dual-write batch to Postgres (non-fatal)
        try {
            await prisma.conversationLog.createMany({
                data: messages.map((msg) => ({
                    sessionId,
                    role: msg.role,
                    content: msg.content ?? null,
                    toolName: msg.name ?? null,
                    toolArgs: msg.toolCalls ? msg.toolCalls as any : null,
                    toolResult: msg.toolCallId ? { toolCallId: msg.toolCallId } : null,
                })),
            });
        } catch (e) {
            console.error("[ConversationService] Postgres batch write failed:", e);
        }
    }

    static async getHistory(sessionId: string): Promise<AIMessage[]> {
        const k = this.key(sessionId);
        const items = await redis.lrange(k, 0, -1);

        if (items.length > 0) {
            return items.map((item) => JSON.parse(item));
        }

        // Fallback: reconstruct from Postgres
        return this.reconstructFromPostgres(sessionId);
    }

    static async reconstructFromPostgres(sessionId: string): Promise<AIMessage[]> {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - PG_HISTORY_DAYS);

        const logs = await prisma.conversationLog.findMany({
            where: {
                sessionId,
                createdAt: { gte: cutoff },
            },
            orderBy: { createdAt: "asc" },
            take: MAX_MESSAGES,
        });

        if (logs.length === 0) return [];

        const messages: AIMessage[] = [];
        for (const log of logs) {
            if (log.role === "user" || log.role === "assistant") {
                messages.push({ role: log.role, content: log.content ?? "" });
            } else if (log.role === "tool") {
                // Flatten tool messages to assistant text to avoid toolCallId reconstruction issues
                const resultStr = log.toolResult
                    ? (typeof log.toolResult === "string" ? log.toolResult : JSON.stringify(log.toolResult))
                    : "no result";
                messages.push({
                    role: "assistant",
                    content: `[Previous tool: ${log.toolName} → ${resultStr}]`,
                });
            }
        }

        // Cache back to Redis for subsequent calls
        if (messages.length > 0) {
            const k = this.key(sessionId);
            const pipeline = redis.pipeline();
            for (const msg of messages) {
                pipeline.rpush(k, JSON.stringify(msg));
            }
            pipeline.ltrim(k, -MAX_MESSAGES, -1);
            pipeline.expire(k, TTL_SECONDS);
            await pipeline.exec();
        }

        return messages;
    }

    static async clear(sessionId: string): Promise<void> {
        await redis.del(this.key(sessionId));
        // Also clear Postgres records
        try {
            await prisma.conversationLog.deleteMany({ where: { sessionId } });
        } catch (e) {
            console.error("[ConversationService] Postgres clear failed:", e);
        }
    }

    static async hasHistory(sessionId: string): Promise<boolean> {
        const len = await redis.llen(this.key(sessionId));
        return len > 0;
    }
}
