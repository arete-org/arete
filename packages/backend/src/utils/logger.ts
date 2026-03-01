/**
 * @description: Winston-based logging utility with console and rotating file transports for backend operations.
 * @arete-scope: utility
 * @arete-module: Logger
 * @arete-risk: low - Logging failures can make debugging difficult but should not break request handling.
 * @arete-ethics: moderate - Logs may contain user data affecting privacy and auditability.
 */

import fs from 'fs';
import { createLogger, format, transports } from 'winston';

const { combine, timestamp, printf, colorize } = format;
const splatSymbol = Symbol.for('splat');

// --- Redaction rules ---
// Discord snowflakes are 17-19 digit numeric strings. We redact them to avoid
// accidental leakage in logs if upstream code forgets to pseudonymize.
const DISCORD_ID_REGEX = /\b\d{17,19}\b/g;

/**
 * Recursively sanitize log data to strip raw Discord identifiers. This is a
 * defense-in-depth layer; primary protection should still pseudonymize IDs
 * before logging or storing.
 */
export function sanitizeLogData<T>(value: T): T {
    if (typeof value === 'string') {
        // Swap raw snowflakes for a clear placeholder.
        return value.replace(DISCORD_ID_REGEX, '[REDACTED_ID]') as T;
    }

    if (Array.isArray(value)) {
        // Walk arrays and sanitize each entry.
        return value.map((entry) => sanitizeLogData(entry)) as T;
    }

    if (value && typeof value === 'object') {
        // Walk objects so nested IDs get scrubbed too.
        const sanitized: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
            sanitized[key] = sanitizeLogData(val);
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

type DailyRotateFileConstructor =
    typeof import('winston-daily-rotate-file');
type DailyRotateFileModule = DailyRotateFileConstructor & {
    default?: DailyRotateFileConstructor;
};

let DailyRotateFile: DailyRotateFileConstructor | null = null;
try {
    // Load the rotating file transport lazily so a missing optional package
    // does not take the backend down during startup.
    const dailyRotateFileModule = (await import(
        'winston-daily-rotate-file'
    )) as DailyRotateFileModule;
    DailyRotateFile =
        dailyRotateFileModule.default ?? dailyRotateFileModule;
} catch (error) {
    console.warn(
        `Logger could not load winston-daily-rotate-file. Continuing with console logging only. Error: ${error instanceof Error ? error.message : String(error)}`
    );
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
        ...(canWriteLogDirectory && DailyRotateFile
            ? [
                  new DailyRotateFile({
                      dirname: logDirectory,
                      filename: '%DATE%.log',
                      datePattern: 'YYYY-MM-DD',
                      maxFiles: '30d',
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
