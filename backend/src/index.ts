import { Elysia } from "elysia";
import { node } from "@elysiajs/node";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { initSystemLogger } from "./services/system-logger";

// --- System Logger (intercept console before anything else) ---
initSystemLogger();

// --- Configuration ---
const REDIS_URL = process.env['REDIS_URL'] || "redis://localhost:6379";
const PORT = process.env.PORT || 8080;

// --- Services ---
// Redis Connection
const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null // Required for BullMQ
});

redis.on("error", (err) => console.error("Redis Client Error", err));
redis.on("connect", () => console.log("Redis Connected"));

// --- Workers ---
import { startAgenticWorker } from "./workers/message.worker";
const worker = startAgenticWorker();

// --- Global Error Handlers (Prevent Crash) ---
process.on('uncaughtException', (err) => {
    console.error('!!!! Uncaught Exception !!!!', err);
    // Do NOT exit the process, just log it.
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('!!!! Unhandled Rejection !!!!', reason);
    // Do NOT exit.
});

// --- Graceful Shutdown ---
import { MessageAccumulator } from "./services/accumulator.service";
import { aiEngine } from "./core/ai";
import { queueService } from "./services/queue.service";

let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Shutdown] Received ${signal}, starting graceful shutdown...`);

    // 1. Stop accepting new WhatsApp messages + cancel reconnect timers
    try {
        console.log("[Shutdown] Shutting down Baileys sessions...");
        await BaileysService.shutdownAll();
        console.log("[Shutdown] Baileys sessions closed.");
    } catch (e) {
        console.error("[Shutdown] Error shutting down Baileys:", e);
    }

    // 2. Flush pending message accumulator buffers
    if (MessageAccumulator.pendingCount > 0) {
        console.log(`[Shutdown] Flushing ${MessageAccumulator.pendingCount} pending accumulator buffer(s)...`);
        MessageAccumulator.flushAll((sid, msgs) => {
            aiEngine.processMessages(sid, msgs).catch(err => {
                console.error(`[Shutdown] Failed to process flushed messages for ${sid}:`, err);
            });
        });
    }

    // 3. Close BullMQ worker + queue (stop accepting new jobs, finish current)
    try {
        console.log("[Shutdown] Closing BullMQ worker...");
        await worker.close();
        await queueService.close();
        console.log("[Shutdown] BullMQ worker + queue closed.");
    } catch (e) {
        console.error("[Shutdown] Error closing BullMQ:", e);
    }

    // 4. Disconnect Redis
    try {
        console.log("[Shutdown] Disconnecting Redis...");
        await redis.quit();
        console.log("[Shutdown] Redis disconnected.");
    } catch (e) {
        console.error("[Shutdown] Error disconnecting Redis:", e);
    }

    // 5. Disconnect Prisma
    try {
        console.log("[Shutdown] Disconnecting Prisma...");
        await prisma.$disconnect();
        console.log("[Shutdown] Prisma disconnected.");
    } catch (e) {
        console.error("[Shutdown] Error disconnecting Prisma:", e);
    }

    console.log("[Shutdown] Graceful shutdown complete.");
    process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// --- Baileys Init ---
import { prisma } from "./services/postgres.service";
import { BaileysService } from "./services/baileys.service";
import { Platform } from "@prisma/client";

// Reconnect WhatsApp Sessions
prisma.bot.findMany({ where: { platform: Platform.WHATSAPP } }).then(bots => {
    console.log(`[Init] Found ${bots.length} WhatsApp bots to reconnect...`);
    for (const bot of bots) {
        BaileysService.startSession(bot.id).catch(err => {
            console.error(`[Init] Failed to start session for ${bot.name}:`, err);
        });
    }
});

// Schedule automation check every 30 minutes
queueService.scheduleAutomationCheck().then(() => {
    console.log("[Init] Automation check scheduled (every 30 min)");
}).catch(err => {
    console.error("[Init] Failed to schedule automation check:", err);
});

// --- API ---
import { webhookController } from "./api/webhook.controller";
import { uploadController } from "./api/upload.controller";
import { flowController } from "./api/flow.controller";
import { botController } from "./api/bot.controller";
import { triggerController } from "./api/trigger.controller";
import { executionController } from "./api/execution.controller";
import { authController } from "./api/auth.controller";
import { clientRoutes } from "./api/client.routes";
import { toolController } from "./api/tool.controller";
import { sessionController } from "./api/session.controller";
import { eventsController } from "./api/events.controller";
import { automationController } from "./api/automation.controller";
import { logsController } from "./api/logs.controller";
const ALLOWED_ORIGINS = new Set([
    'https://agentic.w-gateway.cc',
    'http://localhost:4321',
    'http://localhost:5173',
]);

const app = new Elysia({ adapter: node() })
    .onRequest(({ request, set }) => {
        const headers = request.headers;
        let origin = '';
        if (typeof headers.get === 'function') {
            origin = headers.get('origin') || '';
        }
        if (!origin && typeof headers === 'object') {
            origin = (headers as any).origin || '';
        }
        set.headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGINS.has(origin) ? origin : '*';
        set.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
        set.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
        set.headers['Access-Control-Allow-Credentials'] = 'true';
        set.headers['Vary'] = 'Origin';

        if (request.method === 'OPTIONS') {
            set.status = 204;
            return '';
        }
    })
    .use(webhookController)
    .use(uploadController)
    .use(flowController)
    .use(botController)
    .use(triggerController)
    .use(executionController)
    .use(authController)
    .use(clientRoutes)
    .use(toolController)
    .use(sessionController)
    .use(eventsController)
    .use(automationController)
    .use(logsController)
    .get("/", () => "Agentic Orchestrator Active")
    .get("/health", () => ({ status: "ok", timestamp: new Date().toISOString() }))
    .get("/info", () => ({
        service: "Agentic",
        version: "1.0.0",
        redis: redis.status
    }))
    .listen({
        port: Number(PORT),
        hostname: '0.0.0.0'
    });

console.log(
    `Agentic is running at 0.0.0.0:${PORT}`
);
