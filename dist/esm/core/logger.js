const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
export class Logger {
    level = 'warn';
    debug(...args) {
        if (LEVELS[this.level] <= LEVELS.debug)
            console.debug('[MediaForgeJS]', ...args);
    }
    info(...args) {
        if (LEVELS[this.level] <= LEVELS.info)
            console.info('[MediaForgeJS]', ...args);
    }
    warn(...args) {
        if (LEVELS[this.level] <= LEVELS.warn)
            console.warn('[MediaForgeJS]', ...args);
    }
    error(...args) {
        if (LEVELS[this.level] <= LEVELS.error)
            console.error('[MediaForgeJS]', ...args);
    }
}
export const logger = new Logger();
