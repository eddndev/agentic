import { prisma } from "../../services/postgres.service";
import { BaileysService } from "../../services/baileys.service";
import { isBuiltinTool } from "./builtin-tools";
import type { Session } from "@prisma/client";

export interface ToolResult {
    success: boolean;
    data: any;
}

export class ToolExecutor {

    /**
     * Execute a tool call by looking up the tool definition and dispatching by actionType.
     * Built-in tools skip the DB lookup entirely (fast-path).
     */
    static async execute(
        botId: string,
        session: Session,
        toolCall: { name: string; arguments: Record<string, any> },
        originalMessage?: { content?: string | null }
    ): Promise<ToolResult> {
        try {
            // Fast-path: built-in tools don't need a DB record
            if (isBuiltinTool(toolCall.name)) {
                return await this.executeBuiltin(botId, session, { name: toolCall.name }, toolCall.arguments);
            }

            const tool = await prisma.tool.findFirst({
                where: { botId, name: toolCall.name, status: "ACTIVE" },
            });

            if (!tool) {
                return { success: false, data: `Tool '${toolCall.name}' not found or disabled.` };
            }

            return await this.dispatchByActionType(botId, session, tool, toolCall.arguments);
        } catch (error: any) {
            console.error(`[ToolExecutor] Error executing tool '${toolCall.name}':`, error);
            return { success: false, data: error.message || "Tool execution failed" };
        }
    }

    /**
     * Dispatch execution based on the tool's actionType.
     */
    private static async dispatchByActionType(
        botId: string,
        session: Session,
        tool: any,
        args: Record<string, any>
    ): Promise<ToolResult> {
        switch (tool.actionType) {
            case "FLOW":
                return await this.executeFlow(botId, session, tool, args);
            case "WEBHOOK":
                return await this.executeWebhook(tool, args, session);
            case "BUILTIN":
                return await this.executeBuiltin(botId, session, tool, args);
            default:
                return { success: false, data: `Unknown actionType: ${tool.actionType}` };
        }
    }

    /**
     * FLOW action: Execute a sequence of steps, interpolating {{param}} placeholders.
     */
    private static async executeFlow(
        botId: string,
        session: Session,
        tool: any,
        args: Record<string, any>
    ): Promise<ToolResult> {
        const flowId = tool.flowId || (tool.actionConfig as any)?.flowId;
        if (!flowId) {
            return { success: false, data: "No flowId configured for this tool." };
        }

        const flow = await prisma.flow.findUnique({
            where: { id: flowId },
            include: { steps: { orderBy: { order: "asc" } } },
        });

        if (!flow) {
            return { success: false, data: `Flow '${flowId}' not found.` };
        }

        for (const step of flow.steps) {
            let content = step.content || "";

            // Interpolate {{param}} placeholders
            for (const [key, value] of Object.entries(args)) {
                content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(value));
            }

            try {
                if (step.type === "TEXT" && content) {
                    await BaileysService.sendMessage(botId, session.identifier, { text: content });
                } else if (step.type === "IMAGE" && step.mediaUrl) {
                    await BaileysService.sendMessage(botId, session.identifier, {
                        image: { url: step.mediaUrl },
                        caption: content || undefined,
                    });
                } else if ((step.type === "AUDIO" || step.type === "PTT") && step.mediaUrl) {
                    await BaileysService.sendMessage(botId, session.identifier, {
                        audio: { url: step.mediaUrl },
                        ptt: step.type === "PTT",
                    });
                }
            } catch (e: any) {
                console.error(`[ToolExecutor] Flow '${flow.name}' step ${step.order} failed:`, e.message);
            }

            // Respect step delay
            if (step.delayMs > 0) {
                await new Promise((r) => setTimeout(r, step.delayMs));
            }
        }

        return {
            success: true,
            data: `[Flujo ejecutado: ${flow.name}]${flow.description ? ` ${flow.description}` : ""}`,
        };
    }

    /**
     * WEBHOOK action: POST to a URL with the tool arguments as body.
     */
    private static async executeWebhook(
        tool: any,
        args: Record<string, any>,
        session: Session
    ): Promise<ToolResult> {
        const config = tool.actionConfig as any;
        if (!config?.url) {
            return { success: false, data: "No webhook URL configured." };
        }

        const method = (config.method || "POST").toUpperCase();
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            ...(config.headers || {}),
        };

        const res = await fetch(config.url, {
            method,
            headers,
            body: method !== "GET" ? JSON.stringify({ ...args, sessionId: session.id, identifier: session.identifier }) : undefined,
            signal: AbortSignal.timeout(15_000),
        });

        const text = await res.text();
        let data: any;
        try { data = JSON.parse(text); } catch { data = text; }

        return { success: res.ok, data };
    }

    /**
     * BUILTIN action: Execute internal functions.
     */
    private static async executeBuiltin(
        botId: string,
        session: Session,
        tool: any,
        args: Record<string, any>
    ): Promise<ToolResult> {
        const builtinName = tool.name || (tool.actionConfig as any)?.builtinName;

        switch (builtinName) {
            case "get_current_time": {
                const tz = args.timezone || "America/Mexico_City";
                const now = new Date().toLocaleString("es-MX", { timeZone: tz });
                return { success: true, data: { time: now, timezone: tz } };
            }

            case "clear_conversation": {
                const { ConversationService } = await import("../../services/conversation.service");
                await ConversationService.clear(session.id);
                return { success: true, data: "Conversation history cleared." };
            }

            case "get_labels": {
                const labels = await prisma.label.findMany({
                    where: { botId, deleted: false },
                    include: { _count: { select: { sessions: true } } },
                });
                return {
                    success: true,
                    data: labels.map(l => ({
                        name: l.name,
                        color: l.color,
                        waLabelId: l.waLabelId,
                        sessionCount: l._count.sessions,
                    })),
                };
            }

            case "assign_label": {
                const labelName = args.label_name;
                if (!labelName) {
                    return { success: false, data: "Falta el parámetro label_name." };
                }

                const label = await prisma.label.findFirst({
                    where: { botId, deleted: false, name: { equals: labelName, mode: "insensitive" } },
                });
                if (!label) {
                    return { success: false, data: `Etiqueta '${labelName}' no encontrada.` };
                }

                // Sync with WhatsApp
                await BaileysService.addChatLabel(botId, session.identifier, label.waLabelId);

                // Upsert in DB
                await prisma.sessionLabel.upsert({
                    where: { sessionId_labelId: { sessionId: session.id, labelId: label.id } },
                    update: {},
                    create: { sessionId: session.id, labelId: label.id },
                });

                return { success: true, data: `Etiqueta '${label.name}' asignada al chat.` };
            }

            case "remove_label": {
                const removeLabelName = args.label_name;
                if (!removeLabelName) {
                    return { success: false, data: "Falta el parámetro label_name." };
                }

                const labelToRemove = await prisma.label.findFirst({
                    where: { botId, deleted: false, name: { equals: removeLabelName, mode: "insensitive" } },
                });
                if (!labelToRemove) {
                    return { success: false, data: `Etiqueta '${removeLabelName}' no encontrada.` };
                }

                const existingAssoc = await prisma.sessionLabel.findUnique({
                    where: { sessionId_labelId: { sessionId: session.id, labelId: labelToRemove.id } },
                });
                if (!existingAssoc) {
                    return { success: false, data: `El chat no tiene la etiqueta '${labelToRemove.name}'.` };
                }

                // Sync with WhatsApp
                await BaileysService.removeChatLabel(botId, session.identifier, labelToRemove.waLabelId);

                // Remove from DB
                await prisma.sessionLabel.delete({ where: { id: existingAssoc.id } });

                return { success: true, data: `Etiqueta '${labelToRemove.name}' removida del chat.` };
            }

            case "get_sessions_by_label": {
                const searchLabelName = args.label_name;
                if (!searchLabelName) {
                    return { success: false, data: "Falta el parámetro label_name." };
                }
                const includeMessages = args.include_messages ?? 5;

                const targetLabel = await prisma.label.findFirst({
                    where: { botId, deleted: false, name: { equals: searchLabelName, mode: "insensitive" } },
                });
                if (!targetLabel) {
                    return { success: false, data: `Etiqueta '${searchLabelName}' no encontrada.` };
                }

                const sessionLabels = await prisma.sessionLabel.findMany({
                    where: { labelId: targetLabel.id },
                    include: {
                        session: {
                            include: {
                                messages: {
                                    orderBy: { createdAt: "desc" },
                                    take: includeMessages,
                                    select: {
                                        content: true,
                                        fromMe: true,
                                        createdAt: true,
                                        type: true,
                                    },
                                },
                            },
                        },
                    },
                });

                const result = sessionLabels.map(sl => ({
                    sessionId: sl.session.id,
                    name: sl.session.name,
                    identifier: sl.session.identifier,
                    lastMessageAt: sl.session.messages[0]?.createdAt ?? null,
                    lastMessages: sl.session.messages.reverse().map(m => ({
                        content: m.content,
                        fromMe: m.fromMe,
                        createdAt: m.createdAt,
                        type: m.type,
                    })),
                }));

                return { success: true, data: result };
            }

            case "reply_to_message": {
                const messageId = args.message_id;
                const replyText = args.text;
                if (!messageId || !replyText) {
                    return { success: false, data: "Faltan parámetros: message_id y text son obligatorios." };
                }

                const originalMsg = await prisma.message.findUnique({
                    where: { externalId: messageId },
                    include: { session: true },
                });
                if (!originalMsg) {
                    return { success: false, data: `Mensaje '${messageId}' no encontrado.` };
                }
                if (originalMsg.session.botId !== botId) {
                    return { success: false, data: "El mensaje no pertenece a este bot." };
                }

                await BaileysService.sendMessage(botId, session.identifier, {
                    text: replyText,
                    contextInfo: {
                        stanzaId: messageId,
                        participant: originalMsg.sender,
                        quotedMessage: { conversation: originalMsg.content || "" },
                    },
                });

                return { success: true, data: `Mensaje enviado. No respondas de nuevo a este mensaje, ya fue contestado.` };
            }

            case "send_followup_message": {
                const targetSessionId = args.session_id;
                const messageText = args.message;
                if (!targetSessionId || !messageText) {
                    return { success: false, data: "Faltan parámetros: session_id y message son obligatorios." };
                }

                // Validate session belongs to the same bot
                const targetSession = await prisma.session.findFirst({
                    where: { id: targetSessionId, botId },
                    include: { bot: true },
                });
                if (!targetSession) {
                    return { success: false, data: `Sesión '${targetSessionId}' no encontrada o no pertenece a este bot.` };
                }

                // Send message via WhatsApp
                await BaileysService.sendMessage(botId, targetSession.identifier, { text: messageText });

                // Persist message in DB
                await prisma.message.create({
                    data: {
                        sessionId: targetSession.id,
                        content: messageText,
                        fromMe: true,
                        type: "TEXT",
                        externalId: `followup_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                        sender: targetSession.bot.identifier || "bot",
                    },
                });

                return { success: true, data: `Mensaje de seguimiento enviado a ${targetSession.name || targetSession.identifier}.` };
            }

            default:
                return { success: false, data: `Unknown builtin: ${builtinName}` };
        }
    }
}
