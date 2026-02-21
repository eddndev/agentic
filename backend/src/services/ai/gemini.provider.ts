import type { AIProvider, AICompletionRequest, AICompletionResponse, AIMessage, AIToolDefinition } from "./types";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const CACHE_TTL = "3600s"; // 1 hour
const MIN_CACHE_TOKENS = 4096; // Minimum for Gemini explicit caching

interface CacheEntry {
    name: string;       // "cachedContents/{id}"
    promptHash: string; // Hash of the system prompt to detect changes
    expiresAt: number;  // Unix ms
}

// In-memory cache of botId -> CacheEntry (process-level, not Redis — lightweight)
const cacheRegistry = new Map<string, CacheEntry>();

export class GeminiProvider implements AIProvider {
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    async chat(request: AICompletionRequest): Promise<AICompletionResponse> {
        const systemMsg = request.messages.find((m) => m.role === "system");
        const systemPrompt = systemMsg?.content ?? "";

        // Try to use context cache for the system prompt
        const cachedContentName = await this.getOrCreateCache(request.model, systemPrompt, request.tools);

        const url = `${BASE_URL}/models/${request.model}:generateContent?key=${this.apiKey}`;

        const body: any = {
            contents: this.formatContents(request.messages),
            generationConfig: {
                temperature: request.temperature ?? 0.7,
            },
        };

        if (cachedContentName) {
            // Use cached content — system instruction and tools are baked into the cache
            body.cachedContent = cachedContentName;
        } else {
            // No cache — send system instruction and tools inline
            if (systemPrompt) {
                body.systemInstruction = {
                    parts: [{ text: systemPrompt }],
                };
            }
            if (request.tools && request.tools.length > 0) {
                body.tools = [{
                    functionDeclarations: this.formatTools(request.tools),
                }];
            }
        }

        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120_000),
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Gemini API error (${res.status}): ${err}`);
        }

        const data = await res.json() as any;
        const candidate = data.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];

        let content: string | null = null;
        const toolCalls: AICompletionResponse["toolCalls"] = [];

        for (const part of parts) {
            if (part.text) {
                content = (content ?? "") + part.text;
            }
            if (part.functionCall) {
                toolCalls.push({
                    id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    name: part.functionCall.name,
                    arguments: part.functionCall.args ?? {},
                    ...(part.functionCall.thought_signature ? { thoughtSignature: part.functionCall.thought_signature } : {}),
                });
            }
        }

        const usage = data.usageMetadata;
        return {
            content,
            toolCalls,
            usage: usage ? {
                promptTokens: usage.promptTokenCount ?? 0,
                completionTokens: usage.candidatesTokenCount ?? 0,
                totalTokens: usage.totalTokenCount ?? 0,
            } : undefined,
        };
    }

    /**
     * Get or create a cached content for the system prompt + tools.
     * Returns the cachedContent name if available, null otherwise.
     */
    private async getOrCreateCache(
        model: string,
        systemPrompt: string,
        tools?: AIToolDefinition[]
    ): Promise<string | null> {
        if (!systemPrompt) return null;

        // Simple hash to detect prompt changes
        const promptHash = this.hash(systemPrompt + JSON.stringify(tools ?? []));
        const cacheKey = `${model}:${promptHash}`;

        // Check in-memory registry
        const existing = cacheRegistry.get(cacheKey);
        if (existing && existing.expiresAt > Date.now() + 60_000) {
            // Still valid with at least 1 min buffer
            return existing.name;
        }

        // Rough token estimate: ~4 chars per token for English/Spanish
        const estimatedTokens = Math.ceil(systemPrompt.length / 4);
        if (estimatedTokens < MIN_CACHE_TOKENS) {
            // Too small for explicit caching — Gemini implicit caching handles this automatically
            return null;
        }

        try {
            const cacheBody: any = {
                model: `models/${model}`,
                systemInstruction: {
                    parts: [{ text: systemPrompt }],
                },
                ttl: CACHE_TTL,
            };

            if (tools && tools.length > 0) {
                cacheBody.tools = [{
                    functionDeclarations: this.formatTools(tools),
                }];
            }

            const res = await fetch(`${BASE_URL}/cachedContents?key=${this.apiKey}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(cacheBody),
                signal: AbortSignal.timeout(15_000),
            });

            if (!res.ok) {
                const err = await res.text();
                console.warn(`[Gemini] Cache creation failed (${res.status}), using inline: ${err}`);
                return null;
            }

            const data = await res.json() as any;
            const name = data.name; // "cachedContents/{id}"
            const ttlSeconds = parseInt(CACHE_TTL);

            cacheRegistry.set(cacheKey, {
                name,
                promptHash,
                expiresAt: Date.now() + ttlSeconds * 1000,
            });

            console.log(`[Gemini] Created context cache: ${name} (${data.usageMetadata?.totalTokenCount} tokens, TTL ${CACHE_TTL})`);
            return name;
        } catch (error: any) {
            console.warn(`[Gemini] Cache creation error, using inline:`, error.message);
            return null;
        }
    }

    private hash(str: string): string {
        // Simple djb2 hash — just for change detection, not crypto
        let hash = 5381;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) + hash) + str.charCodeAt(i);
        }
        return (hash >>> 0).toString(36);
    }

    private formatContents(messages: AIMessage[]): any[] {
        // Pre-scan: identify tool calls that lack thoughtSignature.
        // Gemini requires thought_signature on all functionCall parts.
        // When history contains calls from OpenAI fallback (no signature),
        // we convert them to plain text summaries to avoid 400 errors.
        const unsignedCallIds = new Set<string>();
        for (const msg of messages) {
            if (msg.role === "assistant" && msg.toolCalls?.length) {
                for (const tc of msg.toolCalls) {
                    if (!tc.thoughtSignature) {
                        unsignedCallIds.add(tc.id);
                    }
                }
            }
        }

        const contents: any[] = [];

        for (const msg of messages) {
            if (msg.role === "system") continue;

            if (msg.role === "user") {
                contents.push({
                    role: "user",
                    parts: [{ text: msg.content ?? "" }],
                });
            } else if (msg.role === "assistant") {
                const parts: any[] = [];
                if (msg.content) {
                    parts.push({ text: msg.content });
                }
                if (msg.toolCalls?.length) {
                    const signedCalls = msg.toolCalls.filter(tc => tc.thoughtSignature);
                    const unsignedCalls = msg.toolCalls.filter(tc => !tc.thoughtSignature);

                    // Convert unsigned calls to text summary
                    if (unsignedCalls.length > 0) {
                        const summary = unsignedCalls
                            .map(tc => `[Called ${tc.name}(${JSON.stringify(tc.arguments)})]`)
                            .join("\n");
                        parts.push({ text: summary });
                    }

                    // Keep signed calls as proper functionCall parts
                    for (const tc of signedCalls) {
                        parts.push({
                            functionCall: {
                                name: tc.name,
                                args: tc.arguments,
                                thought_signature: tc.thoughtSignature,
                            },
                        });
                    }
                }
                if (parts.length > 0) {
                    contents.push({ role: "model", parts });
                }
            } else if (msg.role === "tool") {
                // Skip tool responses for unsigned calls (they're now text summaries)
                if (msg.toolCallId && unsignedCallIds.has(msg.toolCallId)) {
                    // Convert to a model message with the result as text
                    contents.push({
                        role: "model",
                        parts: [{ text: `[Result of ${msg.name ?? "tool"}]: ${msg.content ?? ""}` }],
                    });
                } else {
                    contents.push({
                        role: "function",
                        parts: [{
                            functionResponse: {
                                name: msg.name ?? "unknown",
                                response: { result: msg.content ?? "" },
                            },
                        }],
                    });
                }
            }
        }

        return contents;
    }

    private formatTools(tools: AIToolDefinition[]): any[] {
        return tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters || { type: "object", properties: {} },
        }));
    }
}
