/**
 * @description: Runs outbound message filters before content is sent to Discord.
 * @arete-scope: interface
 * @arete-module: OutboundFilters
 * @arete-risk: moderate - Filter failures could distort messages or degrade formatting.
 * @arete-ethics: moderate - Outbound normalization influences transparency and user trust.
 */

import { logger } from '../../utils/logger.js';
import { normalizeOutboundLinks } from './normalizeLinks.js';
import type { OutboundFilter, OutboundFilterResult } from './types.js';

/**
 * @arete-logger: outboundFilters
 *
 * @logs
 * Outbound filter execution, changes applied, and filter error conditions.
 *
 * @impact
 * Risk: Missing or noisy logs can obscure formatting decisions.
 * Ethics: Logs touch message metadata and should avoid raw content leakage.
 */
const outboundFilterLogger = logger.child({ module: 'outboundFilters' });

// Ordered pipeline so each filter sees the edits from the prior one.
const outboundFilters: Array<{ name: string; apply: OutboundFilter }> = [
    { name: 'normalize_links', apply: normalizeOutboundLinks },
];

export const runOutboundFilters = (content: string): OutboundFilterResult => {
    let filteredContent = content; // Track intermediate state for each filter.
    const changeLog: string[] = []; // Final list of changes for logging.

    // Execute each filter in sequence so formatting changes are deterministic.
    for (const filter of outboundFilters) {
        try {
            const result = filter.apply(filteredContent);
            filteredContent = result.content;
            if (result.changes.length > 0) {
                for (const change of result.changes) {
                    changeLog.push(`${filter.name}:${change}`);
                }
            }
        } catch (error) {
            // Fail open: log the failure and proceed to the next filter.
            outboundFilterLogger.error('Outbound filter failed; continuing', {
                filter: filter.name,
                error: (error as Error)?.message ?? String(error),
            });
        }
    }

    // Log only the change summary; avoid raw message bodies or identifiers.
    outboundFilterLogger.debug('Outbound filters evaluated', {
        // TODO: Pseudonymize change summaries if they later include identifiers.
        changes: changeLog,
    });

    return { content: filteredContent, changes: changeLog };
};

export type { OutboundFilter, OutboundFilterResult } from './types.js';
