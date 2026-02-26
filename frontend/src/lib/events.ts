const API_URL = import.meta.env.PUBLIC_API_URL ||
    (import.meta.env.DEV ? 'http://localhost:8080' : 'https://api-agentic.angelviajero.com.mx');

type BotEventType =
    | 'connected' | 'bot:qr' | 'bot:connected' | 'bot:disconnected'
    | 'message:received' | 'message:sent' | 'session:created';

type EventHandler = (data: any) => void;

export class BotEventSource {
    private es: EventSource | null = null;
    private handlers = new Map<string, Set<EventHandler>>();
    private botId: string;

    constructor(botId: string) { this.botId = botId; }

    connect(): boolean {
        const token = localStorage.getItem('token');
        if (!token) return false;
        const url = `${API_URL}/events/stream?token=${encodeURIComponent(token)}&botId=${encodeURIComponent(this.botId)}`;
        this.es = new EventSource(url);
        this.es.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handlers.get(data.type)?.forEach(fn => { try { fn(data); } catch {} });
            } catch {}
        };
        this.es.onerror = () => console.warn('[SSE] Connection error, browser will retry...');
        return true;
    }

    on(type: BotEventType, handler: EventHandler): this {
        if (!this.handlers.has(type)) this.handlers.set(type, new Set());
        this.handlers.get(type)!.add(handler);
        return this;
    }

    close(): void {
        this.es?.close();
        this.es = null;
        this.handlers.clear();
    }
}

export class SystemLogSource {
    private es: EventSource | null = null;
    private handler: ((log: any) => void) | null = null;

    connect(onLog: (log: any) => void): boolean {
        const token = localStorage.getItem('token');
        if (!token) return false;
        this.handler = onLog;
        const url = `${API_URL}/events/system-logs?token=${encodeURIComponent(token)}`;
        this.es = new EventSource(url);
        this.es.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'system:log' && this.handler) {
                    this.handler(data.log);
                }
            } catch {}
        };
        return true;
    }

    close(): void {
        this.es?.close();
        this.es = null;
        this.handler = null;
    }
}
