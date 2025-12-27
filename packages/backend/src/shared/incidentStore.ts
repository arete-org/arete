/**
 * @description: Factory for creating the incident store with env-driven configuration and pseudonymization checks.
 * @arete-scope: utility
 * @arete-module: IncidentStoreFactory
 * @arete-risk: high - Misconfiguration can block incident storage or create inconsistent data paths.
 * @arete-ethics: high - Protects against storing raw Discord identifiers without hashing.
 */
import { logger } from './logger';
import { SqliteIncidentStore } from './sqliteIncidentStore';

const incidentStoreLogger = typeof logger.child === 'function' ? logger.child({ module: 'incidentStore' }) : logger;

export type IncidentStore = SqliteIncidentStore;

let cachedIncidentStore: IncidentStore | null = null;

export function getDefaultIncidentStore(): IncidentStore {
  if (!cachedIncidentStore) {
    cachedIncidentStore = createIncidentStoreFromEnv();
  }
  return cachedIncidentStore;
}

export function createIncidentStoreFromEnv(): IncidentStore {
  const backend = process.env.INCIDENT_BACKEND?.trim().toLowerCase();
  if (backend && backend !== 'sqlite') {
    throw new Error(`Unsupported INCIDENT_BACKEND "${backend}". Only "sqlite" is supported.`);
  }

  const pseudonymizationSecret = process.env.INCIDENT_PSEUDONYMIZATION_SECRET?.trim();
  if (!pseudonymizationSecret) {
    throw new Error('Missing required environment variable: INCIDENT_PSEUDONYMIZATION_SECRET');
  }

  const envPath = process.env.INCIDENT_SQLITE_PATH?.trim();
  const flyDefaultPath = process.env.FLY_APP_NAME ? '/data/incidents.db' : undefined;
  const defaultPath = envPath || flyDefaultPath || './data/incidents.db';

  try {
    return new SqliteIncidentStore({ dbPath: defaultPath, pseudonymizationSecret });
  } catch (error) {
    const code = (error as { code?: string }).code;
    const isPermission = code === 'EACCES' || code === 'EPERM';
    if (isPermission && !envPath) {
      incidentStoreLogger.warn(
        `Falling back to local SQLite path "./data/incidents.db" because default path "${defaultPath}" was not writable: ${String(error)}`
      );
      return new SqliteIncidentStore({ dbPath: './data/incidents.db', pseudonymizationSecret });
    }
    throw error;
  }
}

// Expose a stable export without building the store until someone calls into it.
export const defaultIncidentStore: IncidentStore = new Proxy({} as IncidentStore, {
  get: (_target, prop) => {
    const store = getDefaultIncidentStore();
    const value = store[prop as keyof IncidentStore];
    return typeof value === 'function' ? value.bind(store) : value;
  }
});
export type { IncidentAuditEvent, IncidentPointers, IncidentRecord, IncidentStatus } from './sqliteIncidentStore';
