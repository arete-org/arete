/**
 * @description: Shared helpers and factory for persistence of response provenance metadata.
 * @footnote-scope: utility
 * @footnote-module: TraceStore
 * @footnote-risk: medium - Storage failures can break audit trails and transparency features.
 * @footnote-ethics: high - Controls trace storage ensuring AI responses are traceable and auditable.
 */

import { runtimeConfig } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { SqliteTraceStore } from './sqliteTraceStore.js';
import {
    assertValidResponseMetadata,
    traceStoreJsonReplacer,
} from './traceStoreUtils.js';

/**
 * Public trace store contract. It currently aliases the SQLite implementation
 * so callers stay decoupled from the factory details.
 */
export type TraceStore = SqliteTraceStore;

const traceStoreLogger =
    typeof logger.child === 'function'
        ? logger.child({ module: 'traceStore' })
        : logger;

export { assertValidResponseMetadata, traceStoreJsonReplacer };

/**
 * Creates the trace store from runtime config and falls back to a local SQLite
 * file when container-style paths are unavailable.
 */
export function createTraceStoreFromConfig(): TraceStore {
    const configuredPath = runtimeConfig.storage.provenanceSqlitePath;
    const flyDefaultPath = runtimeConfig.runtime.flyAppName
        ? '/data/provenance.db'
        : undefined;
    const defaultPath =
        configuredPath || flyDefaultPath || './data/provenance.db';

    try {
        return new SqliteTraceStore({ dbPath: defaultPath });
    } catch (error) {
        const code = (error as { code?: string }).code;
        const isPermission = code === 'EACCES' || code === 'EPERM';
        const isMissing = code === 'ENOENT';
        const isDockerPath = defaultPath.startsWith('/data/');

        if (
            !configuredPath &&
            defaultPath !== './data/provenance.db' &&
            (isPermission || (isDockerPath && isMissing))
        ) {
            // Fallback to a local relative path when default path is not writable and no env override is set.
            const availabilityMessage = isMissing
                ? 'is not present'
                : 'was not writable';
            traceStoreLogger.warn(
                `Falling back to local SQLite path "./data/provenance.db" because default path "${defaultPath}" ${availabilityMessage}: ${String(error)}`
            );
            return new SqliteTraceStore({ dbPath: './data/provenance.db' });
        }

        if (configuredPath && isDockerPath && (isPermission || isMissing)) {
            // Allow the same /data path in local (non-container) runs by falling back to ./data.
            traceStoreLogger.warn(
                `Falling back to local SQLite path "./data/provenance.db" because "${configuredPath}" is unavailable: ${String(error)}`
            );
            return new SqliteTraceStore({ dbPath: './data/provenance.db' });
        }

        throw error;
    }
}

/**
 * Eager default trace store used by the backend HTTP handlers.
 */
export const defaultTraceStore = createTraceStoreFromConfig();

