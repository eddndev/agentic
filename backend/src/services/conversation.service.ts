import { redis } from "./redis.service";
import type { AIMessage } from "./ai";

const KEY_PREFIX = "conv:";
const TTL_SECONDS = 24 * 60 * 60; // 24 hours
const MAX_MESSAGES = 50;

export class ConversationService {

    static key(sessionId: string): string {
        return `${KEY_PREFIX}${sessionId}`;
    }

    static async addMessage(sessionId: string, message: AIMessage): Promise<void> {
        const k = this.key(sessionId);
        await redis.rpush(k, JSON.stringify(message));
        await redis.ltrim(k, -MAX_MESSAGES, -1);
        await redis.expire(k, TTL_SECONDS);
    }

    static async addMessages(sessionId: string, messages: AIMessage[]): Promise<void> {
        if (messages.length === 0) return;
        const k = this.key(sessionId);
        const pipeline = redis.pipeline();
        for (const msg of messages) {
            pipeline.rpush(k, JSON.stringify(msg));
        }
        pipeline.ltrim(k, -MAX_MESSAGES, -1);
        pipeline.expire(k, TTL_SECONDS);
        await pipeline.exec();
    }

    static async getHistory(sessionId: string): Promise<AIMessage[]> {
        const k = this.key(sessionId);
        const items = await redis.lrange(k, 0, -1);
        return items.map((item) => JSON.parse(item));
    }

    static async clear(sessionId: string): Promise<void> {
        await redis.del(this.key(sessionId));
    }

    static async hasHistory(sessionId: string): Promise<boolean> {
        const len = await redis.llen(this.key(sessionId));
        return len > 0;
    }
}
