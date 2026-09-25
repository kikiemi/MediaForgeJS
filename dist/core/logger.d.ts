export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
/** Leveled console logger; level is settable at runtime via `logger.level`. */
export declare class Logger {
    /** Minimum level emitted; default 'warn'. */
    level: LogLevel;
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}
/** The library-wide logger instance. */
export declare const logger: Logger;
