import { Queue } from "bullmq";
import { redis } from "./redis.service";

export const QUEUE_NAME = "agentic-message-queue";

class QueueService {
    private queue: Queue;

    constructor() {
        // Reuse the internal IORedis connection if possible, or let BullMQ handle it
        this.queue = new Queue(QUEUE_NAME, {
            connection: {
                url: process.env['REDIS_URL'] || "redis://localhost:6379"
            }
        });
    }

    async addIncomingMessage(messageId: string) {
        return this.queue.add("incoming", { messageId });
    }

    async scheduleStepExecution(executionId: string, stepId: string, delayMs: number) {
        return this.queue.add("execute_step", { executionId, stepId }, { delay: delayMs });
    }

    async scheduleAutomationCheck(intervalMs = Number(process.env['AUTOMATION_CHECK_INTERVAL_MS']) || 30 * 60 * 1000) {
        return this.queue.add("check_automations", {}, {
            repeat: { every: intervalMs },
            removeOnComplete: true,
        });
    }

    async close() {
        await this.queue.close();
    }
}

export const queueService = new QueueService();
