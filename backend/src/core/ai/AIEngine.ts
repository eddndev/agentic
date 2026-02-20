import { prisma } from "../../services/postgres.service";
import { redis } from "../../services/redis.service";
import { getAIProvider } from "../../services/ai";
import { ConversationService } from "../../services/conversation.service";
import { BaileysService } from "../../services/baileys.service";
import { ToolExecutor } from "./ToolExecutor";
import { TranscriptionService, VisionService, PDFService } from "../../services/media";
import type { AIMessage, AIToolDefinition, AIProvider, AICompletionRequest, AICompletionResponse } from "../../services/ai";
import type { Message } from "@prisma/client";

const MAX_TOOL_ITERATIONS = 10;
const LOCK_TTL = 60; // seconds

/** Maps primary provider to its fallback */
const FALLBACK_MAP: Record<string, { provider: "OPENAI" | "GEMINI"; model: string }> = {
    GEMINI: { provider: "OPENAI", model: "gpt-4o-mini" },
    OPENAI: { provider: "GEMINI", model: "gemini-3-flash-preview" },
};

export class AIEngine {

    /**
     * Process a single message. Convenience wrapper around processMessages.
     */
    async processMessage(sessionId: string, message: Message): Promise<void> {
        return this.processMessages(sessionId, [message]);
    }

    /**
     * Process a batch of accumulated messages as a single AI call.
     * Each message is preprocessed (audio→transcription, image→vision, PDF→text)
     * and the results are combined into a single user message.
     */
    async processMessages(sessionId: string, messages: Message[]): Promise<void> {
        // 1. Load session + bot
        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            include: { bot: true },
        });

        if (!session || !session.bot) {
            console.error(`[AIEngine] Session ${sessionId} or bot not found`);
            return;
        }

        // 2. If AI not enabled, skip — trigger evaluation is handled by the
        //    Rust core via Redis Streams (published in baileys.service.ts)
        if (!session.bot.aiEnabled) {
            return;
        }

        const bot = session.bot;
        const lockKey = `ai:lock:${sessionId}`;

        // 3. Acquire distributed lock
        const lockAcquired = await redis.set(lockKey, "1", "EX", LOCK_TTL, "NX");
        if (!lockAcquired) {
            console.log(`[AIEngine] Lock held for session ${sessionId}, skipping`);
            return;
        }

        try {
            // 4. Mark all messages as read + show typing indicator
            const msgIds = messages.map(m => m.externalId).filter(Boolean);
            if (msgIds.length > 0) {
                await BaileysService.markRead(bot.id, session.identifier, msgIds);
            }
            await BaileysService.sendPresence(bot.id, session.identifier, "composing");

            // 5. Preprocess multimodal content for each message in the batch
            const contentParts: string[] = [];

            for (const msg of messages) {
                let partContent = msg.content || "";
                const metadata = (msg.metadata as any) || {};
                const mediaUrl = metadata.mediaUrl;

                if (mediaUrl) {
                    try {
                        if (msg.type === "AUDIO") {
                            const transcription = await TranscriptionService.transcribe(mediaUrl);
                            partContent = `[Audio transcription]: ${transcription}`;
                        } else if (msg.type === "IMAGE") {
                            const description = await VisionService.analyze(mediaUrl, "Describe this image.", bot.aiProvider);
                            partContent = partContent
                                ? `${partContent}\n[Image description]: ${description}`
                                : `[Image description]: ${description}`;
                        } else if (msg.type === "DOCUMENT" && mediaUrl.toLowerCase().endsWith(".pdf")) {
                            const pdfText = await PDFService.extractText(mediaUrl);
                            partContent = `[PDF content]: ${pdfText.substring(0, 3000)}`;
                        }
                    } catch (mediaError: any) {
                        console.error(`[AIEngine] Media preprocessing error:`, mediaError);
                        partContent = partContent || "[Media file received but could not be processed]";
                    }
                }

                if (partContent) {
                    contentParts.push(partContent);
                }
            }

            const userContent = contentParts.length > 0
                ? contentParts.join("\n\n")
                : "[empty message]";

            const userMessage: AIMessage = { role: "user", content: userContent };
            await ConversationService.addMessage(sessionId, userMessage);

            // 5. Load tools from DB
            const tools = await prisma.tool.findMany({
                where: { botId: bot.id, status: "ACTIVE" },
            });

            const toolDefinitions: AIToolDefinition[] = tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: (t.parameters as Record<string, any>) || { type: "object", properties: {} },
            }));

            // 6. Build messages array
            const history = await ConversationService.getHistory(sessionId);
            const aiMessages: AIMessage[] = [];

            if (bot.systemPrompt) {
                aiMessages.push({ role: "system", content: bot.systemPrompt });
            }

            aiMessages.push(...history);

            // 7. Get AI provider and call (with automatic fallback)
            let activeProvider = getAIProvider(bot.aiProvider);
            let activeModel = bot.aiModel;
            let usedFallback = false;

            const chatRequest: AICompletionRequest = {
                model: activeModel,
                messages: aiMessages,
                tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
                temperature: bot.temperature,
            };

            let response = await this.chatWithFallback(
                activeProvider, chatRequest, bot.aiProvider
            );

            // If fallback was used, switch provider for the rest of the conversation
            if (response._fallback) {
                const fb = FALLBACK_MAP[bot.aiProvider];
                activeProvider = getAIProvider(fb.provider);
                activeModel = fb.model;
                usedFallback = true;
            }

            // 8. Tool call loop
            let iterations = 0;
            while (response.toolCalls.length > 0 && iterations < MAX_TOOL_ITERATIONS) {
                iterations++;

                // Add assistant message with tool calls to history
                const assistantMsg: AIMessage = {
                    role: "assistant",
                    content: response.content,
                    toolCalls: response.toolCalls,
                };
                await ConversationService.addMessage(sessionId, assistantMsg);

                // Execute each tool call
                const toolMessages: AIMessage[] = [];
                for (const toolCall of response.toolCalls) {
                    console.log(`[AIEngine] Executing tool: ${toolCall.name}(${JSON.stringify(toolCall.arguments)})`);

                    const result = await ToolExecutor.execute(
                        bot.id,
                        session,
                        toolCall,
                        messages[messages.length - 1]
                    );

                    const resultStr = typeof result.data === "string"
                        ? result.data
                        : JSON.stringify(result.data);

                    toolMessages.push({
                        role: "tool",
                        content: resultStr,
                        toolCallId: toolCall.id,
                        name: toolCall.name,
                    });

                    // Tool logging now handled by ConversationService.addMessages (dual-write)
                }

                await ConversationService.addMessages(sessionId, toolMessages);

                // Re-call AI with updated history (use active provider, which may be fallback)
                const updatedHistory = await ConversationService.getHistory(sessionId);
                const updatedMessages: AIMessage[] = [];
                if (bot.systemPrompt) {
                    updatedMessages.push({ role: "system", content: bot.systemPrompt });
                }
                updatedMessages.push(...updatedHistory);

                const loopRequest: AICompletionRequest = {
                    model: activeModel,
                    messages: updatedMessages,
                    tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
                    temperature: bot.temperature,
                };

                response = await this.chatWithFallback(
                    activeProvider, loopRequest, usedFallback ? FALLBACK_MAP[bot.aiProvider].provider : bot.aiProvider
                );

                if (response._fallback && !usedFallback) {
                    const fb = FALLBACK_MAP[bot.aiProvider];
                    activeProvider = getAIProvider(fb.provider);
                    activeModel = fb.model;
                    usedFallback = true;
                }
            }

            // 9. Stop typing + send final response
            await BaileysService.sendPresence(bot.id, session.identifier, "paused");

            if (response.content) {
                await BaileysService.sendMessage(bot.id, session.identifier, { text: response.content });

                // Add assistant response to history
                const assistantMsg: AIMessage = { role: "assistant", content: response.content };
                await ConversationService.addMessage(sessionId, assistantMsg);
            }

            // 10. Update metadata on recent ConversationLog entries (async, fire-and-forget)
            this.logMetadata(sessionId, activeModel, response.usage?.totalTokens).catch(() => {});

        } catch (error: any) {
            console.error(`[AIEngine] Error processing message for session ${sessionId}:`, error);

            // Try to send error message to user
            try {
                await BaileysService.sendMessage(
                    session.bot.id,
                    session.identifier,
                    { text: "Lo siento, ocurrió un error procesando tu mensaje. Intenta de nuevo." }
                );
            } catch {}
        } finally {
            // 11. Release lock
            await redis.del(lockKey);
        }
    }

    /**
     * Call provider.chat() with automatic fallback to the alternate provider on failure.
     * Returns the response with a `_fallback` flag if the fallback was used.
     */
    private async chatWithFallback(
        primary: AIProvider,
        request: AICompletionRequest,
        primaryName: string
    ): Promise<AICompletionResponse & { _fallback?: boolean }> {
        try {
            return await primary.chat(request);
        } catch (primaryError: any) {
            const fb = FALLBACK_MAP[primaryName];
            if (!fb) throw primaryError; // No fallback configured

            console.warn(
                `[AIEngine] ${primaryName} failed (${primaryError.message}), falling back to ${fb.provider}/${fb.model}`
            );

            try {
                const fallbackProvider = getAIProvider(fb.provider);
                const fallbackResponse = await fallbackProvider.chat({
                    ...request,
                    model: fb.model,
                });
                return { ...fallbackResponse, _fallback: true };
            } catch (fallbackError: any) {
                console.error(
                    `[AIEngine] Fallback ${fb.provider} also failed:`, fallbackError.message
                );
                // Throw the original error — both providers are down
                throw primaryError;
            }
        }
    }

    private async logMetadata(
        sessionId: string, model: string, tokenCount?: number
    ): Promise<void> {
        await prisma.conversationLog.updateMany({
            where: { sessionId, model: null },
            data: { model, ...(tokenCount != null ? { tokenCount } : {}) },
        });
    }
}
