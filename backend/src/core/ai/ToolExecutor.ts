import { prisma } from "../../services/postgres.service";
import { BaileysService } from "../../services/baileys.service";
import { EncryptionService } from "../../services/encryption.service";
import type { Session } from "@prisma/client";

export interface ToolResult {
    success: boolean;
    data: any;
}

export class ToolExecutor {

    /**
     * Execute a tool call by looking up the tool definition and dispatching by actionType.
     */
    static async execute(
        botId: string,
        session: Session,
        toolCall: { name: string; arguments: Record<string, any> },
        originalMessage?: { content?: string | null }
    ): Promise<ToolResult> {
        const tool = await prisma.tool.findFirst({
            where: { botId, name: toolCall.name, status: "ACTIVE" },
        });

        if (!tool) {
            return { success: false, data: `Tool '${toolCall.name}' not found or disabled.` };
        }

        try {
            switch (tool.actionType) {
                case "FLOW":
                    return await this.executeFlow(botId, session, tool, toolCall.arguments);
                case "WEBHOOK":
                    return await this.executeWebhook(tool, toolCall.arguments, session);
                case "BUILTIN":
                    return await this.executeBuiltin(botId, session, tool, toolCall.arguments);
                default:
                    return { success: false, data: `Unknown actionType: ${tool.actionType}` };
            }
        } catch (error: any) {
            console.error(`[ToolExecutor] Error executing tool '${toolCall.name}':`, error);
            return { success: false, data: error.message || "Tool execution failed" };
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

        const results: string[] = [];

        for (const step of flow.steps) {
            let content = step.content || "";

            // Interpolate {{param}} placeholders
            for (const [key, value] of Object.entries(args)) {
                content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(value));
            }

            try {
                if (step.type === "TEXT" && content) {
                    await BaileysService.sendMessage(botId, session.identifier, { text: content });
                    results.push(`Sent text: ${content.substring(0, 50)}`);
                } else if (step.type === "IMAGE" && step.mediaUrl) {
                    await BaileysService.sendMessage(botId, session.identifier, {
                        image: { url: step.mediaUrl },
                        caption: content || undefined,
                    });
                    results.push("Sent image");
                } else if ((step.type === "AUDIO" || step.type === "PTT") && step.mediaUrl) {
                    await BaileysService.sendMessage(botId, session.identifier, {
                        audio: { url: step.mediaUrl },
                        ptt: step.type === "PTT",
                    });
                    results.push(`Sent ${step.type.toLowerCase()}`);
                }
            } catch (e: any) {
                results.push(`Failed step ${step.order}: ${e.message}`);
            }

            // Respect step delay
            if (step.delayMs > 0) {
                await new Promise((r) => setTimeout(r, step.delayMs));
            }
        }

        return { success: true, data: `Executed flow '${flow.name}' with ${flow.steps.length} steps. ${results.join("; ")}` };
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
        const config = tool.actionConfig as any;
        const builtinName = config?.builtinName || tool.name;

        switch (builtinName) {
            case "lookup_client": {
                const client = await prisma.client.findFirst({
                    where: {
                        botId,
                        OR: [
                            { curp: args.curp || undefined },
                            { phoneNumber: args.phoneNumber || session.identifier },
                            { email: args.email || undefined },
                        ].filter(c => Object.values(c).some(v => v !== undefined)),
                    },
                    select: {
                        id: true, name: true, email: true, phoneNumber: true,
                        curp: true, status: true, createdAt: true,
                    },
                });
                return { success: !!client, data: client ?? "Cliente no encontrado." };
            }

            case "register_client": {
                if (!args.curp || !args.email || !args.phoneNumber) {
                    return { success: false, data: "Faltan campos obligatorios: curp, email, phoneNumber. NO inventes datos, pídelos al usuario." };
                }

                // Validate email format
                if (!args.email.includes("@") || args.email.length < 5) {
                    return { success: false, data: "El email proporcionado no es válido. Pide un email real al usuario." };
                }

                // Validate phone format (only digits, 10-15 chars)
                const cleanPhone = String(args.phoneNumber).replace(/\D/g, "");
                if (cleanPhone.length < 10 || cleanPhone.length > 15) {
                    return { success: false, data: "El número de teléfono no es válido (debe tener 10-15 dígitos). Pide un número real al usuario." };
                }

                // Validate CURP format (18 alphanumeric chars)
                if (!/^[A-Z0-9]{18}$/i.test(args.curp)) {
                    return { success: false, data: "La CURP no es válida (debe tener 18 caracteres alfanuméricos)." };
                }

                // Upsert: if a client with this CURP already exists, update their data
                const client = await prisma.client.upsert({
                    where: {
                        curp: args.curp.toUpperCase(),
                    },
                    update: {
                        name: args.name || undefined,
                        email: args.email,
                        phoneNumber: cleanPhone,
                    },
                    create: {
                        botId,
                        name: args.name || "Pendiente",
                        curp: args.curp.toUpperCase(),
                        email: args.email,
                        phoneNumber: cleanPhone,
                    },
                    select: { id: true, name: true, email: true, curp: true, phoneNumber: true, status: true },
                });
                return { success: true, data: client };
            }

            case "save_credentials": {
                if (!args.email || !args.password) {
                    return { success: false, data: "Faltan campos obligatorios: email y password de Llave CDMX. Pídelos al usuario." };
                }

                if (!args.email.includes("@") || args.email.length < 5) {
                    return { success: false, data: "El email no es válido. Pide el correo real de Llave CDMX al usuario." };
                }

                // Find existing client by email, phone, or CURP
                const existing = await prisma.client.findFirst({
                    where: {
                        botId,
                        OR: [
                            { email: args.email },
                            { phoneNumber: session.identifier.replace("@s.whatsapp.net", "") },
                            ...(args.curp ? [{ curp: args.curp.toUpperCase() }] : []),
                        ],
                    },
                });

                const encrypted = EncryptionService.encrypt(args.password);

                if (existing) {
                    // Update existing client with credentials
                    const updated = await prisma.client.update({
                        where: { id: existing.id },
                        data: {
                            encryptedPassword: encrypted,
                            email: args.email,
                            ...(args.curp ? { curp: args.curp.toUpperCase() } : {}),
                        },
                        select: { id: true, name: true, email: true, curp: true, status: true },
                    });
                    return { success: true, data: { ...updated, message: "Credenciales guardadas correctamente." } };
                } else {
                    // Create new client with credentials
                    const phoneFromSession = session.identifier.replace("@s.whatsapp.net", "");
                    const created = await prisma.client.create({
                        data: {
                            botId,
                            name: args.name || "Pendiente",
                            email: args.email,
                            phoneNumber: phoneFromSession,
                            encryptedPassword: encrypted,
                            curp: args.curp?.toUpperCase() || null,
                        },
                        select: { id: true, name: true, email: true, curp: true, status: true },
                    });
                    return { success: true, data: { ...created, message: "Cliente registrado con credenciales." } };
                }
            }

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

            default:
                return { success: false, data: `Unknown builtin: ${builtinName}` };
        }
    }
}
