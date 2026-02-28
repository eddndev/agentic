import { Elysia, t } from "elysia";
import { prisma } from "../services/postgres.service";
import { aiEngine } from "../core/ai";
import { MessageAccumulator } from "../services/accumulator.service";
import { Platform, SessionStatus } from "@prisma/client";

export const webhookController = new Elysia({ prefix: "/webhook" })
    .post("/:platform", async ({ params, body, headers, set }) => {
        const { platform } = params;
        const { from, content, type = "text", fromMe = false } = body as any;

        if (!['whatsapp', 'telegram'].includes(platform.toLowerCase())) {
            set.status = 400;
            return "Invalid platform";
        }

        const platformEnum = platform.toUpperCase() as Platform;

        console.log(`[Webhook] Received ${type} from ${from} on ${platformEnum}`);

        try {
            // 1. Resolve Bot (Target System)
            const botIdentifier = (body as any).botId || "AGENTIC_DEMO_BOT";

            const bot = await prisma.bot.findUnique({
                where: { identifier: botIdentifier }
            });

            if (!bot) {
                set.status = 404;
                return `Bot '${botIdentifier}' not found`;
            }

            // Verify webhook secret (required — configure one in bot credentials)
            const webhookSecret = (bot.credentials as any)?.webhookSecret;
            if (!webhookSecret) {
                console.warn(`[Webhook] Bot '${botIdentifier}' has no webhookSecret configured — rejecting request`);
                set.status = 403;
                return "Webhook secret not configured for this bot";
            }
            const providedSecret = headers['x-webhook-secret'];
            if (providedSecret !== webhookSecret) {
                set.status = 401;
                return "Invalid webhook secret";
            }

            // 2. Resolve Session (User Connection)
            // Session is now the USER's session with the specific BOT
            let session = await prisma.session.findUnique({
                where: {
                    botId_identifier: {
                        botId: bot.id,
                        identifier: from // User's ID (Phone)
                    }
                }
            });

            if (!session) {
                console.log(`[Webhook] New Session for user ${from} on bot ${bot.name}`);
                session = await prisma.session.create({
                    data: {
                        botId: bot.id,
                        platform: platformEnum,
                        identifier: from,
                        name: `User ${from}`, // We don't know name yet
                        status: SessionStatus.CONNECTED
                    }
                });
            }

            // 3. Persist Message
            const message = await prisma.message.create({
                data: {
                    externalId: `msg_${Date.now()}_${Math.random()}`,
                    sessionId: session.id,
                    sender: from,
                    fromMe,
                    content,
                    type: type.toUpperCase(),
                    isProcessed: false
                }
            });

            // 4. Skip bot's own messages
            if (fromMe) {
                return { status: "received", messageId: message.id, bot: bot.name };
            }

            // 5. Process with AI Engine (with optional message accumulation)
            if (bot.messageDelay > 0) {
                MessageAccumulator.accumulate(
                    session.id,
                    message,
                    bot.messageDelay,
                    (sid, msgs) => {
                        aiEngine.processMessages(sid, msgs).catch(err => {
                            console.error("[Webhook] AI Engine Error:", err);
                        });
                    }
                );
            } else {
                aiEngine.processMessage(session.id, message).catch(err => {
                    console.error("[Webhook] AI Engine Error:", err);
                });
            }

            return { status: "received", messageId: message.id, bot: bot.name };

        } catch (err: any) {
            console.error("[Webhook] Error:", err);
            set.status = 500;
            return err.message;
        }
    }, {
        body: t.Object({
            from: t.String(),
            content: t.String(),
            type: t.Optional(t.String()),
            botId: t.Optional(t.String()),
            fromMe: t.Optional(t.Boolean())
        })
    });
