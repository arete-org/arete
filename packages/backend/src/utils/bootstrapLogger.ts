/**
 * @description: Lightweight logger for backend bootstrap code that runs before runtime config is available.
 * @footnote-scope: utility
 * @footnote-module: BackendBootstrapLogger
 * @footnote-risk: low - Bootstrap logging failures reduce startup visibility but should not block startup.
 * @footnote-ethics: low - Emits startup diagnostics without changing user-facing behavior.
 */

import { createLogger, format, transports } from 'winston';

/**
 * Dedicated bootstrap logger that avoids importing runtime-config-dependent logger wiring.
 */
export const logger: ReturnType<typeof createLogger> = createLogger({
    level: 'warn',
    format: format.combine(
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.json()
    ),
    transports: [new transports.Console()],
    exitOnError: false,
});
