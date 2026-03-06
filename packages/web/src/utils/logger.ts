/**
 * @description: Provides a minimal scoped logger for web pages/components with consistent structured payloads.
 * @footnote-scope: utility
 * @footnote-module: WebScopedLogger
 * @footnote-risk: low - Logging helpers only affect observability, not runtime behavior.
 * @footnote-ethics: low - Structured logs help debugging but should avoid sensitive payload dumps.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogFields = Record<string, unknown>;

const writeLog = (
    level: LogLevel,
    scope: string,
    message: string,
    fields: LogFields
): void => {
    const scopedMessage = `[${scope}] ${message}`;

    if (level === 'error') {
        console.error(scopedMessage, fields);
        return;
    }

    if (level === 'warn') {
        console.warn(scopedMessage, fields);
        return;
    }

    if (level === 'debug') {
        console.debug(scopedMessage, fields);
        return;
    }

    console.info(scopedMessage, fields);
};

export const createScopedLogger = (scope: string) => ({
    debug(message: string, fields: LogFields = {}) {
        writeLog('debug', scope, message, fields);
    },
    info(message: string, fields: LogFields = {}) {
        writeLog('info', scope, message, fields);
    },
    warn(message: string, fields: LogFields = {}) {
        writeLog('warn', scope, message, fields);
    },
    error(message: string, fields: LogFields = {}) {
        writeLog('error', scope, message, fields);
    },
});
