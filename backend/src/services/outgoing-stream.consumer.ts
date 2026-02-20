import { redis } from "./redis.service";
import { BaileysService } from "./baileys.service";

const STREAM_KEY = "agentic:queue:outgoing";
const GROUP_NAME = "node_gateway_group";
const CONSUMER_NAME = `node_consumer_${process.pid}`;

interface OutgoingPayload {
    bot_id: string;
    target: string;
    execution_id: string;
    step_order: number;
    payload: {
        text?: string;
        image?: { url: string };
        audio?: { url: string };
        caption?: string;
        ptt?: boolean;
    };
}

/**
 * Starts the outgoing stream consumer that reads messages from the Rust core
 * and sends them via BaileysService.
 */
export async function startOutgoingConsumer() {
    // Create consumer group (ignore if already exists)
    try {
        await redis.xgroup("CREATE", STREAM_KEY, GROUP_NAME, "$", "MKSTREAM");
        console.log(`[OutgoingConsumer] Created consumer group ${GROUP_NAME}`);
    } catch (e: any) {
        if (!e.message?.includes("BUSYGROUP")) {
            console.error("[OutgoingConsumer] Error creating consumer group:", e);
        }
    }

    console.log(`[OutgoingConsumer] Listening on ${STREAM_KEY} as ${CONSUMER_NAME}`);

    // Continuous read loop
    const loop_ = async () => {
        while (true) {
            try {
                const results = await redis.xreadgroup(
                    "GROUP",
                    GROUP_NAME,
                    CONSUMER_NAME,
                    "COUNT",
                    "10",
                    "BLOCK",
                    "5000",
                    "STREAMS",
                    STREAM_KEY,
                    ">"
                );

                if (!results) continue;

                for (const [_streamKey, messages] of results) {
                    for (const [messageId, fields] of messages) {
                        await processOutgoingMessage(messageId, fields);
                    }
                }
            } catch (e) {
                console.error("[OutgoingConsumer] Error reading from stream:", e);
                await new Promise((r) => setTimeout(r, 1000));
            }
        }
    };

    // Run in background (don't await)
    loop_().catch((e) => {
        console.error("[OutgoingConsumer] Fatal error:", e);
    });
}

async function processOutgoingMessage(messageId: string, fields: string[]) {
    // fields is [key, value, key, value, ...]
    let payloadStr: string | undefined;
    for (let i = 0; i < fields.length; i += 2) {
        if (fields[i] === "payload") {
            payloadStr = fields[i + 1];
            break;
        }
    }

    if (!payloadStr) {
        console.warn(`[OutgoingConsumer] Message ${messageId} has no payload field`);
        await redis.xack(STREAM_KEY, GROUP_NAME, messageId);
        return;
    }

    let msg: OutgoingPayload;
    try {
        msg = JSON.parse(payloadStr);
    } catch (e) {
        console.error(`[OutgoingConsumer] Failed to parse payload for ${messageId}:`, e);
        await redis.xack(STREAM_KEY, GROUP_NAME, messageId);
        return;
    }

    try {
        const { bot_id, target, execution_id, step_order, payload } = msg;

        // Build Baileys-compatible content object
        let content: any;

        if (payload.image) {
            content = {
                image: { url: payload.image.url },
                caption: payload.caption || undefined,
            };
        } else if (payload.audio) {
            content = {
                audio: { url: payload.audio.url },
                ptt: payload.ptt ?? false,
            };
        } else if (payload.text) {
            content = { text: payload.text };
        } else {
            console.warn(
                `[OutgoingConsumer] Empty payload for execution ${execution_id} step ${step_order}`
            );
            await redis.xack(STREAM_KEY, GROUP_NAME, messageId);
            return;
        }

        await BaileysService.sendMessage(bot_id, target, content);
    } catch (e) {
        console.error(
            `[OutgoingConsumer] Failed to send message for execution ${msg.execution_id} step ${msg.step_order}:`,
            e
        );
    }

    // Always ACK to avoid poison pill loop
    await redis.xack(STREAM_KEY, GROUP_NAME, messageId);
}
