import { redis } from "./redis.service";

/**
 * Publishes a new message to the Redis Stream for the Rust core to process.
 * XADD to agentic:queue:incoming with MAXLEN ~ 10000 for backpressure control.
 */
export async function publishNewMessage(params: {
    botId: string;
    sessionId: string;
    identifier: string;
    platform: string;
    fromMe: boolean;
    sender: string;
    content: string | null;
    mediaUrl?: string | null;
    timestamp?: number;
}) {
    const payload = JSON.stringify({
        type: "NEW_MESSAGE",
        bot_id: params.botId,
        session_id: params.sessionId,
        identifier: params.identifier,
        platform: params.platform,
        from_me: params.fromMe,
        sender: params.sender,
        message: {
            text: params.content || null,
            mediaUrl: params.mediaUrl || null,
            timestamp: params.timestamp || Math.floor(Date.now() / 1000),
        },
    });

    await redis.xadd(
        "agentic:queue:incoming",
        "MAXLEN",
        "~",
        "10000",
        "*",
        "payload",
        payload
    );
}
