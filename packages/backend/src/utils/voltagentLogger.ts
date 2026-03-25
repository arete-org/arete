/**
 * @description: Routes VoltAgent logs into a dedicated rotating file so they do not flood the main backend console.
 * @footnote-scope: utility
 * @footnote-module: VoltAgentLogger
 * @footnote-risk: medium - Bad logger wiring can hide generation failures or leak noisy prompt dumps into the wrong sink.
 * @footnote-ethics: medium - VoltAgent debug logs can include prompt content, so isolation reduces accidental operator exposure.
 */

import fs from 'node:fs';
import type { VoltAgentLogger as VoltAgentLoggerContract } from '@footnote/agent-runtime';
import type { SupportedLogLevel } from '@footnote/contracts/providers';
import { createLogger, format, type Logger as WinstonLogger } from 'winston';

import { logger, sanitizeLogData } from './logger.js';

type DailyRotateFileConstructor =
    typeof import('winston-daily-rotate-file');
type DailyRotateFileModule = DailyRotateFileConstructor & {
    default?: DailyRotateFileConstructor;
};

const buildVoltAgentLoggerBindings = (
    bindings: Record<string, unknown>
): Record<string, unknown> => ({
    component: 'voltagent',
    ...bindings,
});

const createVoltAgentLoggerAdapter = (
    target: Pick<WinstonLogger, 'log'>,
    bindings: Record<string, unknown> = {}
): VoltAgentLoggerContract => {
    const mergedBindings = buildVoltAgentLoggerBindings(bindings);

    const write =
        (level: SupportedLogLevel) =>
        (message: string, context?: object) => {
            target.log(level, sanitizeLogData(message), {
                ...mergedBindings,
                ...(context ? sanitizeLogData(context) : {}),
            });
        };

    return {
        trace: write('trace'),
        debug: write('debug'),
        info: write('info'),
        warn: write('warn'),
        error: write('error'),
        fatal: write('fatal'),
        child(childBindings: Record<string, unknown>) {
            return createVoltAgentLoggerAdapter(target, {
                ...bindings,
                ...childBindings,
            });
        },
    };
};

/**
 * Creates a VoltAgent-compatible logger that writes only to dedicated log files.
 *
 * If the file transport cannot be created, VoltAgent falls back to a scoped
 * backend logger so errors stay visible instead of disappearing silently.
 */
export const createVoltAgentLogger = ({
    directory,
    level,
}: {
    directory: string;
    level: SupportedLogLevel;
}): VoltAgentLoggerContract => {
    try {
        fs.mkdirSync(directory, { recursive: true });
    } catch (error) {
        logger.warn(
            `VoltAgent logger could not create "${directory}". Falling back to the shared backend logger. Error: ${error instanceof Error ? error.message : String(error)}`
        );
        return createVoltAgentLoggerAdapter(
            typeof logger.child === 'function'
                ? logger.child({ module: 'voltagent' })
                : logger
        );
    }

    try {
        const dailyRotateFileModule = (await import(
            'winston-daily-rotate-file'
        )) as DailyRotateFileModule;
        const DailyRotateFile =
            dailyRotateFileModule.default ?? dailyRotateFileModule;

        const voltAgentFileLogger = createLogger({
            level,
            format: format.combine(
                format.timestamp(),
                format.json()
            ),
            transports: [
                new DailyRotateFile({
                    dirname: directory,
                    filename: 'voltagent-%DATE%.log',
                    datePattern: 'YYYY-MM-DD',
                    maxFiles: '30d',
                }),
            ],
            exitOnError: false,
        });

        return createVoltAgentLoggerAdapter(voltAgentFileLogger);
    } catch (error) {
        logger.warn(
            `VoltAgent logger could not load a dedicated rotating file transport. Falling back to the shared backend logger. Error: ${error instanceof Error ? error.message : String(error)}`
        );
        return createVoltAgentLoggerAdapter(
            typeof logger.child === 'function'
                ? logger.child({ module: 'voltagent' })
                : logger
        );
    }
};
