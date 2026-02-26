
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
    type WASocket,
    type WAMessage,
    jidNormalizedUser
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'node:https';
import QRCode from 'qrcode';
import { prisma } from './postgres.service';
import { aiEngine } from '../core/ai';
import { flowEngine } from '../core/flow';
import { MessageAccumulator } from './accumulator.service';
import { eventBus } from './event-bus';
import { SessionStatus, Platform } from '@prisma/client';
import pino from 'pino';

const logger = pino({ level: 'silent' });

// Map to store active sockets: botId -> socket
const sessions = new Map<string, WASocket>();
// Map to store current QR codes: botId -> qrDataURL
const qrCodes = new Map<string, string>();
// Track reconnect attempts for exponential backoff
const reconnectAttempts = new Map<string, number>();
// Track reconnect timers so they can be cancelled on shutdown
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

let shuttingDown = false;

const AUTH_DIR = 'auth_info_baileys';

export class BaileysService {

    static async startSession(botId: string) {
        if (sessions.has(botId)) {
            return sessions.get(botId);
        }

        console.log(`[${new Date().toISOString()}] [Baileys] Starting session for Bot ${botId}`);

        const sessionDir = path.join(AUTH_DIR, botId);
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version, isLatest } = await fetchLatestBaileysVersion();

        // Fetch bot config to check for IPv6 assignment
        const botConfig = await prisma.bot.findUnique({ where: { id: botId } });
        let socketAgent;

        if (botConfig?.ipv6Address) {
            // Check if the IPv6 address is actually available on this machine
            const isAvailable = await this.isAddressAvailable(botConfig.ipv6Address);
            if (isAvailable) {
                console.log(`[Baileys] Bot ${botConfig.name} will bind to IPv6: ${botConfig.ipv6Address}`);
                socketAgent = new https.Agent({
                    localAddress: botConfig.ipv6Address,
                    family: 6,
                    keepAlive: true
                });
            } else {
                console.log(`[Baileys] IPv6 ${botConfig.ipv6Address} not available locally, using default network interface`);
            }
        }

        console.log(`[${new Date().toISOString()}] [Baileys] Using WA v${version.join('.')}, isLatest: ${isLatest}`);

        try {
            // @ts-ignore
            const sock = makeWASocket({
                version,
                logger,
                printQRInTerminal: false,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger),
                },
                generateHighQualityLinkPreview: true,
                qrTimeout: 60000,
                // Custom Agent for IPv6 Binding
                ...(socketAgent && {
                    agent: socketAgent,
                    fetchAgent: socketAgent
                })
            });

            sessions.set(botId, sock);

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    console.log(`[${new Date().toISOString()}] [Baileys] QR Received for Bot ${botId}`);
                    try {
                        const url = await QRCode.toDataURL(qr);
                        qrCodes.set(botId, url);
                        eventBus.emitBotEvent({ type: 'bot:qr', botId, qr: url });
                    } catch (err) {
                        console.error(`[${new Date().toISOString()}] QR Generation Error`, err);
                    }
                }

                if (connection === 'close') {
                    const error = lastDisconnect?.error as Boom;
                    const statusCode = error?.output?.statusCode;

                    // Terminal states: don't reconnect
                    const terminalCodes = [
                        DisconnectReason.loggedOut,  // 401 — user logged out
                        408,                         // QR timeout
                    ];
                    const shouldReconnect = !terminalCodes.includes(statusCode!);

                    console.log(`[Baileys] Connection closed for Bot ${botId}. Code: ${statusCode}, Reconnecting: ${shouldReconnect}`);

                    sessions.delete(botId);
                    qrCodes.delete(botId);
                    eventBus.emitBotEvent({ type: 'bot:disconnected', botId, statusCode });

                    if (shouldReconnect && !shuttingDown) {
                        const attempt = reconnectAttempts.get(botId) || 0;
                        // Conflict (440) gets a longer base delay to avoid fight with other instance
                        const baseDelay = statusCode === 440 ? 15000 : 5000;
                        const delay = Math.min(baseDelay * Math.pow(2, attempt), 120000);
                        reconnectAttempts.set(botId, attempt + 1);
                        console.log(`[Baileys] Reconnecting Bot ${botId} in ${delay / 1000}s (attempt ${attempt + 1})`);
                        const timer = setTimeout(() => {
                            reconnectTimers.delete(botId);
                            if (!shuttingDown) this.startSession(botId);
                        }, delay);
                        reconnectTimers.set(botId, timer);
                    } else {
                        reconnectAttempts.delete(botId);
                        console.log(`[Baileys] Bot ${botId} stopped (code ${statusCode}). No reconnect.`);
                    }
                } else if (connection === 'open') {
                    console.log(`[Baileys] Connection opened for Bot ${botId}`);
                    qrCodes.delete(botId);
                    reconnectAttempts.delete(botId); // Reset backoff on successful connection
                    eventBus.emitBotEvent({ type: 'bot:connected', botId, user: sock.user });

                    // Force full label sync — reuse syncLabels() which clears cache + version file
                    setTimeout(async () => {
                        try {
                            await BaileysService.syncLabels(botId);
                            console.log(`[Baileys] Full label sync completed for Bot ${botId}`);
                        } catch (e: any) {
                            console.warn(`[Baileys] Label sync failed for Bot ${botId}:`, e.message);
                        }
                    }, 5000);
                }
            });

            sock.ev.on('messages.upsert', async ({ messages, type }) => {
                if (type !== 'notify') return;

                for (const msg of messages) {
                    if (!msg.message) continue;
                    // Avoid processing status updates or broadcast messages if needed
                    if (msg.key.remoteJid === 'status@broadcast') continue;

                    // @ts-ignore
                    await this.handleIncomingMessage(botId, msg);
                }
            });

            sock.ev.on('labels.edit', async (label: any) => {
                try {
                    await prisma.label.upsert({
                        where: { botId_waLabelId: { botId, waLabelId: String(label.id) } },
                        update: {
                            name: label.name,
                            color: label.color ?? 0,
                            deleted: label.deleted ?? false,
                            predefinedId: label.predefinedId ?? null,
                        },
                        create: {
                            botId,
                            waLabelId: String(label.id),
                            name: label.name,
                            color: label.color ?? 0,
                            deleted: label.deleted ?? false,
                            predefinedId: label.predefinedId ?? null,
                        },
                    });
                    console.log(`[Baileys] Label synced: "${label.name}" (${label.id}) for Bot ${botId}`);
                } catch (e) {
                    console.error(`[Baileys] labels.edit error:`, e);
                }
            });

            sock.ev.on('labels.association', async (event: any) => {
                try {
                    const association = event.association;
                    console.log(`[Baileys] labels.association event:`, JSON.stringify(event));

                    if (event.type !== 'add' && event.type !== 'remove') return;
                    if (association.type !== 'label_jid') return;

                    const rawChatId = association.chatId;
                    const waLabelId = String(association.labelId);

                    // Resolve chatId: if LID, convert to phone JID via Baileys mapping
                    let resolvedJid = jidNormalizedUser(rawChatId);
                    if (resolvedJid.endsWith('@lid')) {
                        try {
                            const pn = await (sock as any).signalRepository.lidMapping.getPNForLID(resolvedJid);
                            if (pn) {
                                resolvedJid = jidNormalizedUser(pn);
                                console.log(`[Baileys] LID ${rawChatId} resolved to ${resolvedJid}`);
                            }
                        } catch (e: any) {
                            console.warn(`[Baileys] LID resolution failed for ${rawChatId}:`, e.message);
                        }
                    }

                    // Find session by resolved JID, fallback to raw chatId
                    let session = await prisma.session.findUnique({
                        where: { botId_identifier: { botId, identifier: resolvedJid } },
                    });
                    if (!session && resolvedJid !== rawChatId) {
                        session = await prisma.session.findUnique({
                            where: { botId_identifier: { botId, identifier: rawChatId } },
                        });
                    }
                    // Auto-create session if it doesn't exist yet
                    if (!session) {
                        const identifier = resolvedJid.endsWith('@lid') ? rawChatId : resolvedJid;
                        session = await prisma.session.create({
                            data: {
                                botId,
                                platform: Platform.WHATSAPP,
                                identifier,
                                name: identifier.split('@')[0],
                                status: SessionStatus.CONNECTED,
                            },
                        });
                        console.log(`[Baileys] Auto-created session for ${identifier} (label association)`);
                    }

                    const label = await prisma.label.findUnique({
                        where: { botId_waLabelId: { botId, waLabelId } },
                    });
                    if (!label) {
                        console.warn(`[Baileys] labels.association: No label for waLabelId=${waLabelId}, skipping`);
                        return;
                    }

                    if (event.type === 'add') {
                        await prisma.sessionLabel.upsert({
                            where: { sessionId_labelId: { sessionId: session.id, labelId: label.id } },
                            update: {},
                            create: { sessionId: session.id, labelId: label.id },
                        });
                        console.log(`[Baileys] Label "${label.name}" added to session ${resolvedJid}`);
                    } else {
                        await prisma.sessionLabel.deleteMany({
                            where: { sessionId: session.id, labelId: label.id },
                        });
                        console.log(`[Baileys] Label "${label.name}" removed from session ${resolvedJid}`);
                    }
                } catch (e) {
                    console.error(`[Baileys] labels.association error:`, e);
                }
            });

            return sock;

        } catch (error: any) {
            console.error(`[${new Date().toISOString()}] [Baileys] Failed to start session for bot ${botId}:`, error);
            if (error.message?.includes('QR refs attempts ended')) {
                console.log(`[${new Date().toISOString()}] [Baileys] QR timeout for bot ${botId}. Removing session to allow fresh retry.`);
                this.stopSession(botId);
            }
            return null;
        }
    }

    private static async handleIncomingMessage(botId: string, msg: WAMessage & { message: any }) { // Type intersection specific to local context
        const rawFrom = msg.key.remoteJid;
        if (!rawFrom) return;

        // CRITICAL: Normalize JID (convert @lid to @s.whatsapp.net) to identify user consistently
        let from = jidNormalizedUser(rawFrom);

        // Fix: If it's an LID, try to find the phone number in the undocumented 'remoteJidAlt' field
        if (from.includes('@lid') && (msg.key as any).remoteJidAlt) {
            from = jidNormalizedUser((msg.key as any).remoteJidAlt);
        }

        // Extract content
        const content = msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            "";

        const msgType = msg.message.imageMessage ? 'IMAGE' :
            msg.message.audioMessage ? 'AUDIO' :
            msg.message.documentMessage ? 'DOCUMENT' : 'TEXT';

        // Download media if present
        let mediaUrl: string | undefined;
        if (['IMAGE', 'AUDIO', 'DOCUMENT'].includes(msgType)) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                if (buffer) {
                    const ext = msgType === 'IMAGE' ? '.jpg' :
                        msgType === 'AUDIO' ? '.ogg' :
                        (msg.message.documentMessage?.fileName?.split('.').pop() || 'pdf');
                    const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext.replace('.', '')}`;
                    const uploadDir = path.resolve('uploads');
                    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
                    const filePath = path.join(uploadDir, filename);
                    fs.writeFileSync(filePath, buffer as Buffer);
                    mediaUrl = filePath;
                    console.log(`[Baileys] Media saved: ${filePath}`);
                }
            } catch (mediaErr) {
                console.error(`[Baileys] Failed to download media:`, mediaErr);
            }
        }

        console.log(`[${new Date().toISOString()}] [Baileys] Received ${msgType} from ${from} (${msg.pushName}) [MsgID: ${msg.key.id}] on Bot ${botId}: ${content.substring(0, 50)}...`);

        try {
            // 1. Resolve Bot
            const bot = await prisma.bot.findUnique({ where: { id: botId } });
            if (!bot) return;

            // Filter: exclude group messages
            if (bot.excludeGroups && from.endsWith("@g.us")) {
                return;
            }

            // 2. Resolve Session (User Connection)
            let session = await prisma.session.findUnique({
                where: {
                    botId_identifier: {
                        botId: bot.id,
                        identifier: from
                    }
                }
            });

            if (!session) {
                console.log(`[Baileys] New Session for user ${from} on bot ${bot.name}`);
                try {
                    session = await prisma.session.create({
                        data: {
                            botId: bot.id,
                            platform: Platform.WHATSAPP,
                            identifier: from,
                            name: msg.pushName || `User ${from.slice(0, 6)}`,
                            status: SessionStatus.CONNECTED
                        }
                    });
                    eventBus.emitBotEvent({ type: 'session:created', botId, session });
                } catch (e: any) {
                    // Handle Race Condition: Another request created the session ms ago
                    if (e.code === 'P2002') {
                        console.log(`[Baileys] Session race condition detected for ${from}, fetching existing...`);
                        const existing = await prisma.session.findUnique({
                            where: {
                                botId_identifier: { botId: bot.id, identifier: from }
                            }
                        });
                        if (!existing) throw e; // Should not happen if P2002 occurred
                        session = existing;
                    } else {
                        throw e;
                    }
                }
            }

            // 3. Persist Message (atomic upsert — no TOCTOU race)
            const messageExternalId = msg.key.id || `msg_${Date.now()}`;
            const messageData = {
                sessionId: session.id,
                sender: from,
                fromMe: msg.key.fromMe || false,
                content,
                type: msgType,
                metadata: mediaUrl ? { mediaUrl } : undefined,
                isProcessed: false,
            };

            const { message, created } = await (async () => {
                const beforeUpsert = Date.now();
                try {
                    const msg = await prisma.message.upsert({
                        where: { externalId: messageExternalId },
                        update: {},  // no-op on conflict — keeps existing record
                        create: { externalId: messageExternalId, ...messageData },
                    });
                    // A message is "new" if its createdAt is very recent (within our upsert window)
                    const isNew = msg.createdAt.getTime() >= beforeUpsert - 1000;
                    return { message: msg, created: isNew };
                } catch (e: any) {
                    // Fallback for edge cases
                    console.error(`[Baileys] Message upsert error for ${messageExternalId}:`, e);
                    const existing = await prisma.message.findUnique({ where: { externalId: messageExternalId } });
                    return { message: existing, created: false };
                }
            })();

            if (!message) return;

            // Skip duplicate messages — already processed by a previous event
            if (!created) {
                console.log(`[Baileys] Duplicate message ${messageExternalId}, skipping processing.`);
                return;
            }

            eventBus.emitBotEvent({ type: 'message:received', botId, sessionId: session.id, message });

            // Filter: skip AI for sessions with ignored labels
            if (bot.ignoredLabels.length > 0) {
                const sessionLabels = await prisma.sessionLabel.findMany({
                    where: { sessionId: session.id },
                    include: { label: { select: { name: true } } },
                });
                const labelNames = sessionLabels.map(sl => sl.label.name);
                if (labelNames.some(name => bot.ignoredLabels.includes(name))) {
                    return;
                }
            }

            // 4. Outgoing messages: skip AI but evaluate flow triggers (OUTGOING/BOTH)
            if (message.fromMe) {
                flowEngine.processIncomingMessage(session.id, message).catch(err => {
                    console.error(`[Baileys] FlowEngine error (outgoing):`, err);
                });
                return;
            }

            // 5. Process with AI Engine (with optional message accumulation)
            const handleAIError = async (err: any, sid: string) => {
                console.error(`[${new Date().toISOString()}] [Baileys] AI Engine Error for session ${sid}:`, err);
                try {
                    await BaileysService.sendMessage(botId, from, {
                        text: "Lo siento, ocurrió un error procesando tu mensaje. Intenta de nuevo en unos momentos."
                    });
                } catch {}
            };

            if (bot.messageDelay > 0) {
                MessageAccumulator.accumulate(
                    session.id,
                    message,
                    bot.messageDelay,
                    (sid, msgs) => {
                        aiEngine.processMessages(sid, msgs).catch(err => handleAIError(err, sid));
                    }
                );
            } else {
                aiEngine.processMessage(session.id, message).catch(err => handleAIError(err, session.id));
            }

        } catch (e) {
            console.error(`[${new Date().toISOString()}] [Baileys] Error processing message:`, e);
        }
    }

    static getQR(botId: string) {
        return qrCodes.get(botId);
    }

    static getSession(botId: string) {
        return sessions.get(botId);
    }

    static async stopSession(botId: string) {
        const sock = sessions.get(botId);
        if (sock) {
            try {
                await sock.logout();
            } catch (e) {
                console.log(`[${new Date().toISOString()}] [Baileys] Error during logout for bot ${botId}:`, e);
            }
            sessions.delete(botId);
        }
        qrCodes.delete(botId);

        // Optionally clear auth data to require new QR scan
        const sessionDir = path.join(AUTH_DIR, botId);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            console.log(`[${new Date().toISOString()}] [Baileys] Cleared auth data for bot ${botId}`);
        }

        console.log(`[${new Date().toISOString()}] [Baileys] Session stopped for bot ${botId}`);
    }

    static async sendMessage(botId: string, to: string, content: any): Promise<boolean> {
        const sock = sessions.get(botId);
        if (!sock) {
            console.warn(`[${new Date().toISOString()}] [Baileys] sendMessage failed: Bot ${botId} not connected`);
            return false;
        }

        try {
            await sock.sendMessage(to, content);
            return true;
        } catch (error: any) {
            // Log the error with details but don't crash
            const errorCode = error?.code || 'UNKNOWN';
            const errorMsg = error?.message || String(error);
            console.error(`[${new Date().toISOString()}] [Baileys] sendMessage failed for Bot ${botId} to ${to}:`, {
                code: errorCode,
                message: errorMsg,
                contentType: content?.text ? 'TEXT' : content?.image ? 'IMAGE' : content?.audio ? 'AUDIO' : 'OTHER'
            });

            // Rethrow so caller can handle/log, but with more context
            throw new Error(`Baileys send failed (${errorCode}): ${errorMsg}`);
        }
    }

    /**
     * Mark messages as read (blue ticks) for a chat.
     */
    static async markRead(botId: string, chatJid: string, messageIds: string[]): Promise<void> {
        const sock = sessions.get(botId);
        if (!sock || messageIds.length === 0) return;
        try {
            const keys = messageIds.map(id => ({
                remoteJid: chatJid,
                id,
                fromMe: false,
                participant: undefined,
            }));
            await sock.readMessages(keys);
        } catch (e: any) {
            console.warn(`[Baileys] markRead failed:`, e.message);
        }
    }

    /**
     * Send presence update (typing / paused) for a chat.
     */
    static async sendPresence(botId: string, chatJid: string, presence: "composing" | "paused"): Promise<void> {
        const sock = sessions.get(botId);
        if (!sock) return;
        try {
            await sock.sendPresenceUpdate(presence, chatJid);
        } catch (e: any) {
            console.warn(`[Baileys] sendPresence(${presence}) failed:`, e.message);
        }
    }

    static async syncLabels(botId: string): Promise<void> {
        const sock = sessions.get(botId);
        if (!sock) throw new Error(`Bot ${botId} not connected`);

        // Delete the local app state version file to force a full snapshot re-download.
        // resyncAppState only fetches patches newer than the cached version,
        // so if labels were already synced before the DB table existed, no events fire.
        const versionFile = path.join(AUTH_DIR, botId, 'app-state-sync-version-regular_high.json');
        try { fs.unlinkSync(versionFile); } catch {}

        // Also clear the in-memory cache
        await (sock as any).authState.keys.set({
            'app-state-sync-version': { 'regular_high': null }
        });

        await (sock as any).resyncAppState(['regular_high'], true);
    }

    /**
     * Resolve a phone JID to the LID that WhatsApp uses internally for app state patches.
     * Falls back to the original JID if no mapping exists.
     */
    private static async resolveJidForAppState(sock: WASocket, phoneJid: string): Promise<string> {
        try {
            const lid = await (sock as any).signalRepository.lidMapping.getLIDForPN(phoneJid);
            if (lid) {
                console.log(`[Baileys] Resolved ${phoneJid} -> ${lid} for app state`);
                return lid;
            }
        } catch {}
        return phoneJid;
    }

    static async addChatLabel(botId: string, chatJid: string, waLabelId: string): Promise<void> {
        const sock = sessions.get(botId);
        if (!sock) throw new Error(`Bot ${botId} not connected`);
        const jid = await this.resolveJidForAppState(sock, chatJid);
        console.log(`[Baileys] addChatLabel: jid=${jid}, waLabelId=${waLabelId}`);
        await (sock as any).addChatLabel(jid, waLabelId);
    }

    static async removeChatLabel(botId: string, chatJid: string, waLabelId: string): Promise<void> {
        const sock = sessions.get(botId);
        if (!sock) throw new Error(`Bot ${botId} not connected`);
        const jid = await this.resolveJidForAppState(sock, chatJid);
        console.log(`[Baileys] removeChatLabel: jid=${jid}, waLabelId=${waLabelId}`);
        await (sock as any).removeChatLabel(jid, waLabelId);
    }

    /**
     * Graceful shutdown: cancel all reconnect timers and close all sockets.
     */
    static async shutdownAll(): Promise<void> {
        shuttingDown = true;

        // Cancel all pending reconnect timers
        for (const [botId, timer] of reconnectTimers) {
            clearTimeout(timer);
            console.log(`[Baileys] Cancelled reconnect timer for Bot ${botId}`);
        }
        reconnectTimers.clear();
        reconnectAttempts.clear();

        // Close all active sockets (without deleting auth — not a logout)
        for (const [botId, sock] of sessions) {
            try {
                sock.ws.close();
                console.log(`[Baileys] Closed socket for Bot ${botId}`);
            } catch (e: any) {
                console.warn(`[Baileys] Error closing socket for Bot ${botId}:`, e.message);
            }
        }
        sessions.clear();
        qrCodes.clear();
    }

    /**
     * Check if a local address is available for binding.
     * Compares against OS network interfaces.
     */
    private static async isAddressAvailable(address: string): Promise<boolean> {
        const { networkInterfaces } = await import('os');
        const nets = networkInterfaces();
        for (const ifaces of Object.values(nets)) {
            if (!ifaces) continue;
            for (const iface of ifaces) {
                if (iface.address === address) return true;
            }
        }
        return false;
    }
}
