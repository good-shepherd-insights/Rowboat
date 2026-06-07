import { LEVEL_ORDER, type LogLevelValue, resolveMinLevel } from "./log-level.js";

export interface LogEntry {
    level: LogLevelValue;
    prefix: string;
    args: unknown[];
    ts: string;
}

export interface Transport {
    write(entry: LogEntry): void;
}

export class ConsoleTransport implements Transport {
    write(entry: LogEntry): void {
        const tag = entry.prefix ? `[${entry.prefix}]` : "";
        const parts = tag ? [entry.ts, tag, ...entry.args] : [entry.ts, ...entry.args];
        if (entry.level === "error") {
            console.error(...parts);
        } else if (entry.level === "warn") {
            console.warn(...parts);
        } else {
            console.log(...parts);
        }
    }
}

export class Logger {
    private prefix: string;
    private parent: Logger | null;
    private minLevel: LogLevelValue;
    private ownTransports: Transport[];

    constructor(prefix: string, opts?: { parent?: Logger; transports?: Transport[] }) {
        this.prefix = prefix;
        this.parent = opts?.parent ?? null;
        this.minLevel = this.parent ? this.parent.minLevel : resolveMinLevel();
        this.ownTransports = opts?.transports ?? [];
    }

    private getFullPrefix(): string {
        if (!this.prefix) return "";
        if (this.parent) {
            const parentPrefix = this.parent.getFullPrefix();
            return parentPrefix ? `${parentPrefix} ${this.prefix}` : this.prefix;
        }
        return this.prefix;
    }

    private getTransports(): Transport[] {
        return this.parent ? this.parent.getTransports() : this.ownTransports;
    }

    private emit(level: LogLevelValue, ...args: unknown[]) {
        if (LEVEL_ORDER[level] > LEVEL_ORDER[this.minLevel]) return;
        const entry: LogEntry = {
            level,
            prefix: this.getFullPrefix(),
            args,
            ts: new Date().toISOString(),
        };
        for (const transport of this.getTransports()) {
            transport.write(entry);
        }
    }

    log(...args: unknown[]) { this.emit("info", ...args); }
    info(...args: unknown[]) { this.emit("info", ...args); }
    warn(...args: unknown[]) { this.emit("warn", ...args); }
    error(...args: unknown[]) { this.emit("error", ...args); }
    debug(...args: unknown[]) { this.emit("debug", ...args); }

    child(childPrefix: string): Logger {
        return new Logger(childPrefix, { parent: this });
    }

    getMinLevel(): LogLevelValue {
        return this.minLevel;
    }
}

export const rootLogger = new Logger("", { transports: [new ConsoleTransport()] });