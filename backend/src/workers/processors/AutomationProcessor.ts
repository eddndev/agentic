import { prisma } from "../../services/postgres.service";
import { redis } from "../../services/redis.service";
import { aiEngine } from "../../core/ai";
import type { Message } from "@prisma/client";

export class AutomationProcessor {
    static async processAll(): Promise<void> {
        const automations = await prisma.automation.findMany({
            where: { enabled: true },
            include: { bot: true },
        });

        console.log(`[Automation] Processing ${automations.length} active automation(s)`);

        for (const automation of automations) {
            if (!automation.bot.aiEnabled) continue;

            try {
                if (automation.labelName) {
                    await this.processWithLabel(automation);
                } else {
                    await this.processWithoutLabel(automation);
                }
            } catch (err) {
                console.error(`[Automation] Error processing automation "${automation.name}":`, err);
            }
        }
    }

    /** Sessions that HAVE the specified label and are inactive */
    private static async processWithLabel(automation: any): Promise<void> {
        const ignoredLabels: string[] = automation.bot.ignoredLabels || [];

        const sessionLabels = await prisma.sessionLabel.findMany({
            where: {
                label: {
                    botId: automation.botId,
                    name: automation.labelName,
                    deleted: false,
                },
                ...(ignoredLabels.length > 0 && {
                    session: {
                        labels: {
                            none: { labelId: { in: ignoredLabels } },
                        },
                    },
                }),
            },
            include: {
                session: {
                    include: {
                        messages: {
                            where: { fromMe: false },
                            orderBy: { createdAt: "desc" },
                            take: 1,
                            select: { createdAt: true },
                        },
                    },
                },
            },
        });

        const cutoff = Date.now() - automation.timeoutMs;

        for (const sl of sessionLabels) {
            await this.triggerIfInactive(automation, sl.session, cutoff);
        }
    }

    /** Sessions that have NO labels at all and are inactive */
    private static async processWithoutLabel(automation: any): Promise<void> {
        const sessions = await prisma.session.findMany({
            where: {
                botId: automation.botId,
                labels: { none: {} },
            },
            include: {
                messages: {
                    where: { fromMe: false },
                    orderBy: { createdAt: "desc" },
                    take: 1,
                    select: { createdAt: true },
                },
            },
        });

        const cutoff = Date.now() - automation.timeoutMs;

        for (const session of sessions) {
            await this.triggerIfInactive(automation, session, cutoff);
        }
    }

    private static async triggerIfInactive(automation: any, session: any, cutoff: number): Promise<void> {
        // Skip the bot's own session
        if (session.identifier === automation.bot.identifier) return;

        const lastUserMsg = session.messages[0]?.createdAt;
        if (!lastUserMsg || lastUserMsg.getTime() > cutoff) return;

        const redisKey = `automation:done:${automation.id}:${session.id}`;
        const already = await redis.get(redisKey);
        if (already) return;

        await redis.set(redisKey, "1", "PX", automation.timeoutMs);

        const syntheticMessage = {
            id: `auto_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            content: `[Automatización: ${automation.name}] ${automation.prompt}`,
            type: "TEXT",
            fromMe: false,
            externalId: null,
            metadata: null,
        } as unknown as Message;

        try {
            console.log(`[Automation] Triggering "${automation.name}" for session ${session.id}`);
            await aiEngine.processMessages(session.id, [syntheticMessage]);
        } catch (err) {
            console.error(`[Automation] Error processing session ${session.id}:`, err);
        }
    }
}
