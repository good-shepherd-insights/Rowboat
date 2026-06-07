import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { WorkDir } from "../config/config.js";
import { LOG_LEVEL } from "../config/env.js";
import { IdGen } from "../application/lib/id-gen.js";
import type { ServiceEventType } from "@x/shared/dist/service-events.js";
import { serviceBus } from "./service_bus.js";

type ServiceNameType = ServiceEventType["service"];
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ServiceEventInput = DistributiveOmit<ServiceEventType, "ts">;

type LogLevelValue = "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevelValue, number> = {
    error: 0,
    warn: 1,
    info: 2,
};

const LOG_DIR = path.join(WorkDir, "logs");
const LOG_FILE = path.join(LOG_DIR, "services.jsonl");
const MAX_LOG_BYTES = 10 * 1024 * 1024;

export type ServiceRunContext = {
    runId: string;
    service: ServiceNameType;
    startedAt: number;
};

function safeTimestampForFile(ts: string): string {
    return ts.replace(/[:.]/g, "-");
}

function resolveMinLevel(): LogLevelValue {
    if (LOG_LEVEL in LEVEL_ORDER) return LOG_LEVEL as LogLevelValue;
    return "info";
}

export class ServiceLogger {
    private idGen = new IdGen();
    private stream: fs.WriteStream | null = null;
    private currentSize = 0;
    private initialized = false;
    private minLevel: LogLevelValue;
    private writeQueue: Promise<void> = Promise.resolve();

    constructor() {
        this.minLevel = resolveMinLevel();
    }

    getLogLevel(): LogLevelValue {
        return this.minLevel;
    }

    private shouldEmit(event: ServiceEventInput): boolean {
        if (this.minLevel === "info") return true;
        if (event.type === "run_start" || event.type === "run_complete") return true;
        return LEVEL_ORDER[event.level as LogLevelValue] <= LEVEL_ORDER[this.minLevel];
    }

    private async ensureReady(): Promise<void> {
        if (this.initialized) return;
        await fsp.mkdir(LOG_DIR, { recursive: true });
        try {
            const stats = await fsp.stat(LOG_FILE);
            this.currentSize = stats.size;
        } catch {
            this.currentSize = 0;
        }
        this.stream = fs.createWriteStream(LOG_FILE, { flags: "a", encoding: "utf8" });
        this.initialized = true;
    }

    private async rotateIfNeeded(nextBytes: number): Promise<void> {
        if (this.currentSize + nextBytes <= MAX_LOG_BYTES) return;
        if (this.stream) {
            const stream = this.stream;
            this.stream = null;
            await new Promise<void>((resolve) => {
                let settled = false;
                const done = () => {
                    if (settled) return;
                    settled = true;
                    resolve();
                };
                stream.once("error", done);
                stream.end(done);
            });
        }
        const ts = safeTimestampForFile(new Date().toISOString());
        const rotatedPath = path.join(LOG_DIR, `services.${ts}.jsonl`);
        try {
            await fsp.rename(LOG_FILE, rotatedPath);
        } catch {
            // Ignore if file doesn't exist or rename fails
        }
        this.currentSize = 0;
        this.stream = fs.createWriteStream(LOG_FILE, { flags: "a", encoding: "utf8" });
    }

    async log(event: ServiceEventInput): Promise<void> {
        if (!this.shouldEmit(event)) return;

        const payload = {
            ...event,
            ts: new Date().toISOString(),
        } as ServiceEventType;
        const line = JSON.stringify(payload) + "\n";
        const bytes = Buffer.byteLength(line, "utf8");

        this.writeQueue = this.writeQueue.then(async () => {
            await this.ensureReady();
            await this.rotateIfNeeded(bytes);
            this.stream?.write(line);
            this.currentSize += bytes;
            try {
                await serviceBus.publish(payload);
            } catch {
                // Ignore publish errors to avoid blocking log writes
            }
        });

        return this.writeQueue;
    }

    async startRun(opts: {
        service: ServiceNameType;
        message: string;
        trigger?: "timer" | "manual" | "startup";
        config?: Record<string, unknown>;
    }): Promise<ServiceRunContext> {
        const runId = `${opts.service}_${await this.idGen.next()}`;
        const startedAt = Date.now();
        await this.log({
            type: "run_start",
            service: opts.service,
            runId,
            level: "info",
            message: opts.message,
            trigger: opts.trigger,
            config: opts.config,
        });
        return { runId, service: opts.service, startedAt };
    }
}

export const serviceLogger = new ServiceLogger();
