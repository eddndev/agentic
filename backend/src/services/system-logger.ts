import { eventBus } from './event-bus';

export interface LogEntry {
    id: number;
    timestamp: string;
    level: 'info' | 'warn' | 'error';
    message: string;
}

const MAX_BUFFER_SIZE = 2000;
let nextId = 1;

const buffer: LogEntry[] = [];

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

function formatArgs(args: any[]): string {
    return args.map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); }
        catch { return String(a); }
    }).join(' ');
}

function pushEntry(level: LogEntry['level'], args: any[]): void {
    const entry: LogEntry = {
        id: nextId++,
        timestamp: new Date().toISOString(),
        level,
        message: formatArgs(args),
    };

    buffer.push(entry);
    if (buffer.length > MAX_BUFFER_SIZE) {
        buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
    }

    eventBus.emitSystemEvent({ type: 'system:log', log: entry });
}

export function initSystemLogger(): void {
    console.log = (...args: any[]) => { originalLog(...args); pushEntry('info', args); };
    console.warn = (...args: any[]) => { originalWarn(...args); pushEntry('warn', args); };
    console.error = (...args: any[]) => { originalError(...args); pushEntry('error', args); };
}

export function getRecentLogs(
    limit = 100,
    offset = 0,
    level?: LogEntry['level'],
    search?: string,
): { data: LogEntry[]; total: number } {
    let filtered = buffer;

    if (level) {
        filtered = filtered.filter(e => e.level === level);
    }
    if (search) {
        const q = search.toLowerCase();
        filtered = filtered.filter(e => e.message.toLowerCase().includes(q));
    }

    const total = filtered.length;
    // Return newest first
    const data = filtered.slice().reverse().slice(offset, offset + limit);
    return { data, total };
}
