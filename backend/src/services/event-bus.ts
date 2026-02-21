import { EventEmitter } from 'node:events';

export type BotEvent =
    | { type: 'bot:qr';           botId: string; qr: string }
    | { type: 'bot:connected';    botId: string; user: any }
    | { type: 'bot:disconnected'; botId: string; statusCode: number | undefined }
    | { type: 'message:received'; botId: string; sessionId: string; message: any }
    | { type: 'message:sent';     botId: string; sessionId: string; content: string }
    | { type: 'session:created';  botId: string; session: any };

class EventBus extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(0);
    }

    emitBotEvent(payload: BotEvent): boolean {
        return super.emit('bot-event', payload);
    }

    subscribe(botId: string, callback: (event: BotEvent) => void): () => void {
        const handler = (event: BotEvent) => {
            if (event.botId === botId) callback(event);
        };
        this.on('bot-event', handler);
        return () => this.off('bot-event', handler);
    }
}

export const eventBus = new EventBus();
