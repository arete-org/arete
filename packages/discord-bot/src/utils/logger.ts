/**
 * @description: Winston-based logging utility with console and file transports. Provides structured logging for all bot operations.
 * @arete-scope: utility
 * @arete-module: Logger
 * @arete-risk: low - Logging failures hinder debugging and observability but should not halt bot execution.
 * @arete-ethics: moderate - Logs may include sensitive user-derived content, so redaction and retention discipline are required.
 */

import fs from 'fs';
import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

const { combine, timestamp, printf, colorize } = format;
const splatSymbol = Symbol.for('splat');

// --- Redaction rules ---
// Discord snowflakes are 17-19 digit numeric strings. We redact them to avoid
// accidental leakage in logs if upstream code forgets to pseudonymize.
const DISCORD_ID_REGEX = /\b\d{17,19}\b/g;

/**
 * Recursively redacts Discord-style numeric IDs found in strings within the provided value.
 *
 * Processes nested arrays and objects while preserving overall structure; non-string primitives are returned unchanged.
 *
 * @param value - The value to sanitize (string, array, object, or primitive)
 * @param visited - Tracks visited objects/arrays to avoid infinite recursion on circular references
 * @returns The same value shape with 17–19 digit Discord IDs in strings replaced by `[REDACTED_ID]`
 */
export function sanitizeLogData<T>(
    value: T,
    visited: WeakSet<object> = new WeakSet<object>()
): T {
    if (typeof value === 'string') {
        // Swap raw snowflakes for a clear placeholder.
        return value.replace(DISCORD_ID_REGEX, '[REDACTED_ID]') as T;
    }

    if (Array.isArray(value)) {
        if (visited.has(value)) {
            return '[Circular]' as T;
        }
        visited.add(value);

        // Walk arrays and sanitize each entry.
        return value.map((entry) => sanitizeLogData(entry, visited)) as T;
    }

    if (value && typeof value === 'object') {
        if (visited.has(value as object)) {
            return '[Circular]' as T;
        }
        visited.add(value as object);

        // Walk objects so nested IDs get scrubbed too.
        const sanitized: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
            sanitized[key] = sanitizeLogData(val, visited);
        }
        return sanitized as T;
    }

    return value;
}

// --- Winston formatters ---
const sanitizeFormat = format((info) => {
    // Clean the main message field (string or structured).
    info.message = sanitizeLogData(info.message);

    // Clean any extra args passed to logger.info/debug/etc.
    const splat = info[splatSymbol] as unknown[] | undefined;
    if (Array.isArray(splat)) {
        info[splatSymbol] = splat.map((item) => sanitizeLogData(item));
    }

    return info;
});

/**
 * Custom log format function
 * @private
 * @param {Object} log - Log entry object
 * @returns {string} Formatted log string
 */
const logFormat = printf(({ level, message, timestamp }) => {
    return `${timestamp} [${level}]: ${message}`;
});

// --- Logger output configuration ---
const logDirectory = process.env.LOG_DIR || 'logs';
let canWriteLogDirectory = true;
try {
    fs.mkdirSync(logDirectory, { recursive: true });
} catch (error) {
    canWriteLogDirectory = false;
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'EACCES' || err?.code === 'EPERM') {
        console.warn(
            `Logger cannot create log directory "${logDirectory}" due to permissions (${err.code}). Continuing with console logging only.`
        );
    } else {
        console.warn(
            `Logger failed to create log directory "${logDirectory}". Continuing with console logging only. Error: ${err?.message ?? String(error)}`
        );
    }
}

/**
 * Winston logger instance with console and file transports
 * @type {import('winston').Logger}
 */
export const logger = createLogger({
    level: (process.env.LOG_LEVEL || 'debug').toLowerCase(),
    format: combine(
        sanitizeFormat(),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        colorize({ all: true }),
        logFormat
    ),
    transports: [
        new transports.Console(),
        ...(canWriteLogDirectory
            ? [
                  new DailyRotateFile({
                      dirname: logDirectory,
                      filename: '%DATE%.log',
                      datePattern: 'YYYY-MM-DD',
                      format: format.combine(
                          format.uncolorize(),
                          format.timestamp(),
                          format.json()
                      ),
                  }),
              ]
            : []),
    ],
    exitOnError: false,
});

// --- LLM cost tracking utilities ---

/**
 * Format USD currency for display
 * @param {number} amount - Amount in USD
 * @returns {string} Formatted currency string
 */
export const formatUsd = (amount: number): string => {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 4,
        maximumFractionDigits: 4,
    }).format(amount);
};

/**
 * Log LLM cost summary for current session
 * @description: Provides cost awareness for AI-assisted development
 */
export interface LLMCostTotals {
    totalCostUsd: number;
    totalCalls: number;
    totalTokensIn: number;
    totalTokensOut: number;
}

export type LLMCostSummaryProvider = () => LLMCostTotals | null | undefined;

export const logLLMCostSummary = (getTotals?: LLMCostSummaryProvider) => {
    try {
        const totals = getTotals?.();
        if (!totals) {
            logger.info('[LLM Cost] No cost data available yet.');
            return;
        }

        logger.info(
            `[LLM Cost] ${formatUsd(totals.totalCostUsd)} total across ${totals.totalCalls} calls ` +
                `(tokens in: ${totals.totalTokensIn}, out: ${totals.totalTokensOut})`
        );
    } catch (error) {
        logger.error(
            `Failed to retrieve LLM cost summary: ${error instanceof Error ? error.message : String(error)}`
        );
    }
};
