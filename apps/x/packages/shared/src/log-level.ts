export type LogLevelValue = "silent" | "error" | "warn" | "info" | "debug";

export const LEVEL_ORDER: Record<LogLevelValue, number> = {
    silent: -1,
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
};

export const LIFECYCLE_EVENT_TYPES = new Set(["run_start", "run_complete"]);

export const LOG_LEVEL = (typeof process !== "undefined" && process.env?.ROWBOAT_LOG_LEVEL) || "info";

export function resolveMinLevel(): LogLevelValue {
    if (LOG_LEVEL in LEVEL_ORDER) return LOG_LEVEL as LogLevelValue;
    return "info";
}