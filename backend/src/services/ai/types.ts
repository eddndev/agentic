export interface AIMessage {
    role: "system" | "user" | "assistant" | "tool";
    content?: string | null;
    toolCalls?: AIToolCall[];
    toolCallId?: string;
    name?: string;
}

export interface AIToolCall {
    id: string;
    name: string;
    arguments: Record<string, any>;
    thoughtSignature?: string;
}

export interface AIToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, any>; // JSON Schema
}

export interface AICompletionRequest {
    model: string;
    messages: AIMessage[];
    tools?: AIToolDefinition[];
    temperature?: number;
    thinkingLevel?: "LOW" | "MEDIUM" | "HIGH";
}

export interface AICompletionResponse {
    content: string | null;
    toolCalls: AIToolCall[];
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}

export interface AIProvider {
    chat(request: AICompletionRequest): Promise<AICompletionResponse>;
}
