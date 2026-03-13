/**
 * @description: Persists incidents and audit events to SQLite with retry/backoff handling. Discord-facing identifiers are pseudonymized via HMAC to avoid storing or logging raw IDs. Full digests are stored for uniqueness; only short prefixes should be surfaced in operator logs.
 * @footnote-scope: utility
 * @footnote-module: SqliteIncidentStore
 * @footnote-risk: high - Storage errors or hashing mistakes can break audit trails.
 * @footnote-ethics: high - Ensures incident records avoid raw Discord identifiers.
 */
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import type {
    IncidentAuditAction,
    IncidentPointers,
    IncidentRemediationState,
    IncidentStatus,
} from '@footnote/contracts/web';
import { logger } from '../../utils/logger.js';
import {
    pseudonymizeActorId,
    pseudonymizeIncidentPointers,
    shortHash,
} from '../../utils/pseudonymization.js';

const BUSY_MAX_ATTEMPTS = 5;
const BUSY_RETRY_DELAY_MS = 50;
const incidentLogger =
    typeof logger.child === 'function'
        ? logger.child({ module: 'sqliteIncidentStore' })
        : logger;

/**
 * Small async sleep used only when SQLite reports a temporary busy/locked
 * state. The retry loop backs off a little more on each attempt.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Durable incident row returned to the rest of the backend after
 * pseudonymization has already happened.
 */
export interface IncidentRecord {
    id: number;
    shortId: string;
    reporterHash?: string | null;
    status: IncidentStatus;
    tags: string[];
    description?: string | null;
    contact?: string | null;
    consentedAt: string;
    pointers: IncidentPointers;
    remediationState: IncidentRemediationState;
    remediationApplied: boolean;
    remediationNotes?: string | null;
    remediationUpdatedAt?: string | null;
    createdAt: string;
    updatedAt: string;
}

/**
 * Append-only audit event stored alongside each incident.
 */
export interface IncidentAuditEvent {
    id: number;
    incidentId: number;
    actorHash?: string | null;
    action: IncidentAuditAction;
    notes?: string | null;
    createdAt: string;
}

/**
 * Input accepted when creating a brand-new incident record.
 */
export interface CreateIncidentInput {
    reporterId?: string | null;
    status?: IncidentStatus;
    tags?: string[];
    description?: string | null;
    contact?: string | null;
    consentedAt: string;
    pointers?: IncidentPointers;
}

/**
 * Input used when appending one audit event to an existing incident.
 */
export interface AppendAuditEventInput {
    actorHash?: string | null;
    action: IncidentAuditAction;
    notes?: string | null;
}

/**
 * Input used when the Discord bot reports whether the automatic under-review
 * edit succeeded, was skipped, or failed.
 */
export interface UpdateRemediationInput {
    state: Exclude<IncidentRemediationState, 'pending'>;
    notes?: string | null;
}

/**
 * Operator-facing list filters supported in Wave 1.
 */
export interface ListIncidentsInput {
    status?: IncidentStatus;
    tag?: string;
    createdFrom?: string;
    createdTo?: string;
}

/**
 * Minimal config required to open the SQLite-backed incident store.
 */
export interface SqliteIncidentStoreConfig {
    dbPath: string;
    pseudonymizationSecret: string;
}

type CreateIncidentAuditInput = {
    incident: CreateIncidentInput;
    auditEvent: AppendAuditEventInput;
};

type UpdateStatusWithAuditInput = {
    incidentId: number;
    status: IncidentStatus;
    auditEvent: AppendAuditEventInput;
};

type UpdateRemediationWithAuditInput = {
    incidentId: number;
    remediation: UpdateRemediationInput;
    auditEvent?: AppendAuditEventInput;
};

type IncidentRow = {
    id: number;
    short_id: string;
    reporter_hash: string | null;
    status: IncidentStatus;
    tags_json: string | null;
    description: string | null;
    contact: string | null;
    consented_at: string;
    pointers_json: string | null;
    remediation_state: IncidentRemediationState;
    remediation_applied: number;
    remediation_notes: string | null;
    remediation_updated_at: string | null;
    created_at: string;
    updated_at: string;
};

type AuditRow = {
    id: number;
    incident_id: number;
    actor_hash: string | null;
    action: IncidentAuditAction;
    notes: string | null;
    created_at: string;
};

export class SqliteIncidentStore {
    private readonly db: Database.Database;
    private readonly insertIncident: Database.Statement;
    private readonly updateStatusStatement: Database.Statement;
    private readonly updateRemediationStatement: Database.Statement;
    private readonly getIncidentByIdStatement: Database.Statement;
    private readonly getIncidentByShortIdStatement: Database.Statement;
    private readonly insertAuditEvent: Database.Statement;
    private readonly getAuditEventsByIncidentIdStatement: Database.Statement;
    private readonly pseudonymizationSecret: string;

    /**
     * Opens or creates the SQLite database, ensures the incident schema exists,
     * and prepares the statements reused by each store method.
     */
    constructor(config: SqliteIncidentStoreConfig) {
        const resolvedPath = path.resolve(config.dbPath);
        fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
        if (
            !config.pseudonymizationSecret ||
            config.pseudonymizationSecret.trim().length === 0
        ) {
            throw new Error(
                'pseudonymizationSecret is required to initialize SqliteIncidentStore.'
            );
        }

        this.pseudonymizationSecret = config.pseudonymizationSecret.trim();
        this.db = new Database(resolvedPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');

        this.db.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        short_id TEXT NOT NULL UNIQUE,
        reporter_hash TEXT,
        status TEXT NOT NULL,
        tags_json TEXT,
        description TEXT,
        contact TEXT,
        consented_at TEXT NOT NULL,
        pointers_json TEXT,
        remediation_state TEXT NOT NULL DEFAULT 'pending',
        remediation_applied INTEGER NOT NULL DEFAULT 0,
        remediation_notes TEXT,
        remediation_updated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_incidents_short_id ON incidents (short_id);
      CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents (status);
      CREATE INDEX IF NOT EXISTS idx_incidents_created_at ON incidents (created_at DESC);

      CREATE TABLE IF NOT EXISTS incident_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id INTEGER NOT NULL,
        actor_hash TEXT,
        action TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_audit_incident_id ON incident_audit_events (incident_id);
    `);

        this.ensureIncidentColumn('reporter_hash', 'TEXT');
        this.ensureIncidentColumn('description', 'TEXT');
        this.ensureIncidentColumn('contact', 'TEXT');
        this.ensureIncidentColumn(
            'consented_at',
            `TEXT NOT NULL DEFAULT '${new Date(0).toISOString()}'`
        );
        this.ensureIncidentColumn(
            'remediation_state',
            `TEXT NOT NULL DEFAULT 'pending'`
        );
        this.ensureIncidentColumn('remediation_updated_at', 'TEXT');

        this.insertIncident = this.db.prepare(`
      INSERT INTO incidents (
        short_id,
        reporter_hash,
        status,
        tags_json,
        description,
        contact,
        consented_at,
        pointers_json,
        remediation_state,
        remediation_applied,
        remediation_notes,
        remediation_updated_at,
        created_at,
        updated_at
      ) VALUES (
        @short_id,
        @reporter_hash,
        @status,
        @tags_json,
        @description,
        @contact,
        @consented_at,
        @pointers_json,
        @remediation_state,
        @remediation_applied,
        @remediation_notes,
        @remediation_updated_at,
        @created_at,
        @updated_at
      )
    `);

        this.updateStatusStatement = this.db.prepare(`
      UPDATE incidents
      SET status = @status, updated_at = @updated_at
      WHERE id = @id
    `);

        this.updateRemediationStatement = this.db.prepare(`
      UPDATE incidents
      SET remediation_state = @remediation_state,
          remediation_applied = @remediation_applied,
          remediation_notes = @remediation_notes,
          remediation_updated_at = @remediation_updated_at,
          updated_at = @updated_at
      WHERE id = @id
    `);

        this.getIncidentByIdStatement = this.db.prepare(`
      SELECT
        id,
        short_id,
        reporter_hash,
        status,
        tags_json,
        description,
        contact,
        consented_at,
        pointers_json,
        remediation_state,
        remediation_applied,
        remediation_notes,
        remediation_updated_at,
        created_at,
        updated_at
      FROM incidents
      WHERE id = ?
      LIMIT 1
    `);

        this.getIncidentByShortIdStatement = this.db.prepare(`
      SELECT
        id,
        short_id,
        reporter_hash,
        status,
        tags_json,
        description,
        contact,
        consented_at,
        pointers_json,
        remediation_state,
        remediation_applied,
        remediation_notes,
        remediation_updated_at,
        created_at,
        updated_at
      FROM incidents
      WHERE short_id = ?
      LIMIT 1
    `);

        this.insertAuditEvent = this.db.prepare(`
      INSERT INTO incident_audit_events (incident_id, actor_hash, action, notes, created_at)
      VALUES (@incident_id, @actor_hash, @action, @notes, @created_at)
    `);

        this.getAuditEventsByIncidentIdStatement = this.db.prepare(`
      SELECT id, incident_id, actor_hash, action, notes, created_at
      FROM incident_audit_events
      WHERE incident_id = ?
      ORDER BY created_at ASC, id ASC
    `);

        incidentLogger.info(
            `Initialized SQLite incident store at ${resolvedPath}`
        );
    }

    /**
     * Adds a missing column for older databases created before the latest
     * incident fields existed.
     */
    private ensureIncidentColumn(name: string, definition: string): void {
        const columns = this.db
            .prepare(`PRAGMA table_info(incidents)`)
            .all() as Array<{ name: string }>;
        if (columns.some((column) => column.name === name)) {
            return;
        }
        this.db.exec(`ALTER TABLE incidents ADD COLUMN ${name} ${definition}`);
    }

    /**
     * Guards the store against unexpected status values before writing.
     */
    private assertValidStatus(status: string): asserts status is IncidentStatus {
        const allowed: IncidentStatus[] = [
            'new',
            'under_review',
            'confirmed',
            'dismissed',
            'resolved',
        ];
        if (!allowed.includes(status as IncidentStatus)) {
            throw new Error(`Invalid incident status: ${status}`);
        }
    }

    /**
     * Guards remediation writes so callers cannot invent a new state by typo.
     */
    private assertValidRemediationState(
        state: string
    ): asserts state is IncidentRemediationState {
        const allowed: IncidentRemediationState[] = [
            'pending',
            'applied',
            'already_marked',
            'skipped_not_assistant',
            'failed',
        ];
        if (!allowed.includes(state as IncidentRemediationState)) {
            throw new Error(`Invalid remediation state: ${state}`);
        }
    }

    private isBusyError(error: unknown): boolean {
        if (!error || typeof error !== 'object') {
            return false;
        }

        const code = (error as { code?: string }).code;
        return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
    }

    /**
     * Retries short-lived SQLite busy/locked failures. These happen often
     * enough under parallel tests or light concurrency that a fail-fast
     * strategy would create noisy false failures.
     */
    private async withRetry<T>(operation: () => T): Promise<T> {
        for (let attempt = 1; attempt <= BUSY_MAX_ATTEMPTS; attempt += 1) {
            try {
                return operation();
            } catch (error) {
                if (this.isBusyError(error) && attempt < BUSY_MAX_ATTEMPTS) {
                    await sleep(BUSY_RETRY_DELAY_MS * attempt);
                    continue;
                }
                throw error;
            }
        }

        throw new Error('Failed to execute SQLite operation after retries.');
    }

    /**
     * Trims tags, removes blanks, and deduplicates them so filtering stays
     * predictable.
     */
    private normalizeTags(tags?: string[]): string[] {
        if (!tags) {
            return [];
        }

        return [...new Set(
            tags
                .map((tag) => String(tag).trim())
                .filter((tag) => tag.length > 0)
        )];
    }

    private generateShortId(): string {
        return crypto.randomBytes(4).toString('hex');
    }

    /**
     * Maps one raw SQLite row into the typed incident record used by the rest
     * of the backend.
     */
    private mapIncidentRow(row: IncidentRow): IncidentRecord {
        return {
            id: row.id,
            shortId: row.short_id,
            reporterHash: row.reporter_hash,
            status: row.status,
            tags: row.tags_json ? (JSON.parse(row.tags_json) as string[]) : [],
            description: row.description,
            contact: row.contact,
            consentedAt: row.consented_at,
            pointers: row.pointers_json
                ? (JSON.parse(row.pointers_json) as IncidentPointers)
                : {},
            remediationState: row.remediation_state,
            remediationApplied: Boolean(row.remediation_applied),
            remediationNotes: row.remediation_notes,
            remediationUpdatedAt: row.remediation_updated_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    /**
     * Maps one raw SQLite audit row into the typed audit event shape.
     */
    private mapAuditRow(row: AuditRow): IncidentAuditEvent {
        return {
            id: row.id,
            incidentId: row.incident_id,
            actorHash: row.actor_hash,
            action: row.action,
            notes: row.notes,
            createdAt: row.created_at,
        };
    }

    private getIncidentRowByIdSync(id: number): IncidentRow | undefined {
        return this.getIncidentByIdStatement.get(id) as IncidentRow | undefined;
    }

    private buildAuditInsertValues(
        incidentId: number,
        event: AppendAuditEventInput,
        createdAt: string
    ): {
        incident_id: number;
        actor_hash: string | null;
        action: IncidentAuditAction;
        notes: string | null;
        created_at: string;
    } {
        const actorHash = pseudonymizeActorId(
            event.actorHash,
            this.pseudonymizationSecret
        );

        return {
            incident_id: incidentId,
            actor_hash: actorHash ?? null,
            action: event.action,
            notes: event.notes ?? null,
            created_at: createdAt,
        };
    }

    private insertIncidentWithUniqueShortIdSync(values: Record<string, unknown>): number {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            try {
                const runResult = this.insertIncident.run({
                    ...values,
                    short_id: this.generateShortId(),
                });
                return Number(runResult.lastInsertRowid);
            } catch (error) {
                if (
                    error instanceof Error &&
                    error.message.includes(
                        'UNIQUE constraint failed: incidents.short_id'
                    )
                ) {
                    continue;
                }
                throw error;
            }
        }

        throw new Error('Failed to generate a unique incident short ID.');
    }

    /**
     * Generates a short operator-facing incident ID and retries on the unlikely
     * collision case instead of exposing an internal numeric ID.
     */
    private async insertIncidentWithUniqueShortId(
        values: Record<string, unknown>
    ): Promise<number> {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const runResult = await this.withRetry(() =>
                this.insertIncident.run({
                    ...values,
                    short_id: this.generateShortId(),
                })
            ).catch((error) => {
                if (
                    error instanceof Error &&
                    error.message.includes('UNIQUE constraint failed: incidents.short_id')
                ) {
                    return null;
                }
                throw error;
            });

            if (runResult) {
                return Number(runResult.lastInsertRowid);
            }
        }

        throw new Error('Failed to generate a unique incident short ID.');
    }

    /**
     * Creates a new incident and pseudonymizes Discord identifiers before any
     * storage or logging happens.
     */
    async createIncident(input: CreateIncidentInput): Promise<IncidentRecord> {
        const now = new Date().toISOString();
        const status = input.status ?? 'new';
        this.assertValidStatus(status);

        const tags = this.normalizeTags(input.tags);
        const reporterHash = pseudonymizeActorId(
            input.reporterId,
            this.pseudonymizationSecret
        );
        const pointers = input.pointers
            ? pseudonymizeIncidentPointers(
                  input.pointers,
                  this.pseudonymizationSecret
              )
            : {};
        const pointerLogValues = ['guildId', 'channelId', 'messageId']
            .map((key) => {
                const value = pointers[key as keyof IncidentPointers];
                return typeof value === 'string' && value.length > 0
                    ? `${key}=${shortHash(value)}`
                    : null;
            })
            .filter((value): value is string => Boolean(value))
            .join(', ');

        const id = await this.insertIncidentWithUniqueShortId({
            reporter_hash: reporterHash ?? null,
            status,
            tags_json: JSON.stringify(tags),
            description: input.description ?? null,
            contact: input.contact ?? null,
            consented_at: input.consentedAt,
            pointers_json: JSON.stringify(pointers),
            remediation_state: 'pending',
            remediation_applied: 0,
            remediation_notes: null,
            remediation_updated_at: null,
            created_at: now,
            updated_at: now,
        });

        incidentLogger.info('Incident created in SQLite store', {
            incidentNumericId: id,
            reporterHash: reporterHash ? shortHash(reporterHash) : null,
            pointers: pointerLogValues || 'none',
        });

        const incident = await this.getIncident(id);
        if (!incident) {
            throw new Error(`Incident ${id} was created but could not be read back`);
        }

        return incident;
    }

    /**
     * Creates an incident and its initial audit event in one transaction so a
     * retry cannot leave a durable incident row without `incident.created`.
     */
    async createIncidentWithAudit(
        input: CreateIncidentAuditInput
    ): Promise<IncidentRecord> {
        const now = new Date().toISOString();
        const status = input.incident.status ?? 'new';
        this.assertValidStatus(status);

        const tags = this.normalizeTags(input.incident.tags);
        const reporterHash = pseudonymizeActorId(
            input.incident.reporterId,
            this.pseudonymizationSecret
        );
        const pointers = input.incident.pointers
            ? pseudonymizeIncidentPointers(
                  input.incident.pointers,
                  this.pseudonymizationSecret
              )
            : {};
        const pointerLogValues = ['guildId', 'channelId', 'messageId']
            .map((key) => {
                const value = pointers[key as keyof IncidentPointers];
                return typeof value === 'string' && value.length > 0
                    ? `${key}=${shortHash(value)}`
                    : null;
            })
            .filter((value): value is string => Boolean(value))
            .join(', ');

        const transaction = this.db.transaction(() => {
            const id = this.insertIncidentWithUniqueShortIdSync({
                reporter_hash: reporterHash ?? null,
                status,
                tags_json: JSON.stringify(tags),
                description: input.incident.description ?? null,
                contact: input.incident.contact ?? null,
                consented_at: input.incident.consentedAt,
                pointers_json: JSON.stringify(pointers),
                remediation_state: 'pending',
                remediation_applied: 0,
                remediation_notes: null,
                remediation_updated_at: null,
                created_at: now,
                updated_at: now,
            });

            this.insertAuditEvent.run(
                this.buildAuditInsertValues(id, input.auditEvent, now)
            );

            const incidentRow = this.getIncidentRowByIdSync(id);
            if (!incidentRow) {
                throw new Error(
                    `Incident ${id} was created but could not be read back`
                );
            }

            return this.mapIncidentRow(incidentRow);
        });

        const incident = await this.withRetry(() => transaction());
        incidentLogger.info('Incident created in SQLite store', {
            incidentNumericId: incident.id,
            reporterHash: reporterHash ? shortHash(reporterHash) : null,
            pointers: pointerLogValues || 'none',
        });
        incidentLogger.info('Incident audit event appended', {
            incidentNumericId: incident.id,
            action: input.auditEvent.action,
            actorHash: input.auditEvent.actorHash
                ? shortHash(
                      pseudonymizeActorId(
                          input.auditEvent.actorHash,
                          this.pseudonymizationSecret
                      ) ?? ''
                  )
                : null,
        });

        return incident;
    }

    /**
     * Reads one incident by numeric database ID. This is mainly used after
     * inserts and updates.
     */
    async getIncident(id: number): Promise<IncidentRecord | null> {
        const row = (await this.withRetry(() =>
            this.getIncidentByIdStatement.get(id)
        )) as IncidentRow | undefined;
        return row ? this.mapIncidentRow(row) : null;
    }

    /**
     * Reads one incident by the short ID exposed to operators and Discord
     * command handlers.
     */
    async getIncidentByShortId(shortId: string): Promise<IncidentRecord | null> {
        const row = (await this.withRetry(() =>
            this.getIncidentByShortIdStatement.get(shortId)
        )) as IncidentRow | undefined;
        return row ? this.mapIncidentRow(row) : null;
    }

    /**
     * Lists incidents newest-first and applies the simple Wave 1 filters. Tag
     * filtering happens after load because tags are stored as JSON.
     */
    async listIncidents(filter: ListIncidentsInput = {}): Promise<IncidentRecord[]> {
        const conditions: string[] = [];
        const values: Record<string, unknown> = {};

        if (filter.status) {
            this.assertValidStatus(filter.status);
            conditions.push('status = @status');
            values.status = filter.status;
        }
        if (filter.createdFrom) {
            conditions.push('created_at >= @created_from');
            values.created_from = filter.createdFrom;
        }
        if (filter.createdTo) {
            conditions.push('created_at <= @created_to');
            values.created_to = filter.createdTo;
        }

        const whereClause =
            conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const statement = this.db.prepare(`
      SELECT
        id,
        short_id,
        reporter_hash,
        status,
        tags_json,
        description,
        contact,
        consented_at,
        pointers_json,
        remediation_state,
        remediation_applied,
        remediation_notes,
        remediation_updated_at,
        created_at,
        updated_at
      FROM incidents
      ${whereClause}
      ORDER BY created_at DESC, id DESC
    `);

        const rows = (await this.withRetry(() => statement.all(values))) as IncidentRow[];
        const incidents = rows.map((row) => this.mapIncidentRow(row));
        if (!filter.tag) {
            return incidents;
        }

        const normalizedTag = filter.tag.trim().toLowerCase();
        return incidents.filter((incident) =>
            incident.tags.some((tag) => tag.toLowerCase() === normalizedTag)
        );
    }

    /**
     * Updates the review status and returns the fresh row for response
     * building.
     */
    async updateStatus(id: number, status: IncidentStatus): Promise<IncidentRecord> {
        this.assertValidStatus(status);
        const updatedAt = new Date().toISOString();
        const result = await this.withRetry(() =>
            this.updateStatusStatement.run({
                id,
                status,
                updated_at: updatedAt,
            })
        );

        if (result.changes === 0) {
            throw new Error(`Incident ${id} not found`);
        }

        const incident = await this.getIncident(id);
        if (!incident) {
            throw new Error(`Incident ${id} was updated but could not be read back`);
        }
        return incident;
    }

    /**
     * Updates review state and appends its audit event inside one transaction
     * so retries cannot split the durable status from the audit trail.
     */
    async updateStatusWithAudit(
        input: UpdateStatusWithAuditInput
    ): Promise<IncidentRecord> {
        this.assertValidStatus(input.status);
        const updatedAt = new Date().toISOString();
        const transaction = this.db.transaction(() => {
            const result = this.updateStatusStatement.run({
                id: input.incidentId,
                status: input.status,
                updated_at: updatedAt,
            });

            if (result.changes === 0) {
                throw new Error(`Incident ${input.incidentId} not found`);
            }

            this.insertAuditEvent.run(
                this.buildAuditInsertValues(
                    input.incidentId,
                    input.auditEvent,
                    updatedAt
                )
            );

            const incidentRow = this.getIncidentRowByIdSync(input.incidentId);
            if (!incidentRow) {
                throw new Error(
                    `Incident ${input.incidentId} was updated but could not be read back`
                );
            }

            return this.mapIncidentRow(incidentRow);
        });

        const incident = await this.withRetry(() => transaction());
        incidentLogger.info('Incident audit event appended', {
            incidentNumericId: input.incidentId,
            action: input.auditEvent.action,
            actorHash: input.auditEvent.actorHash
                ? shortHash(
                      pseudonymizeActorId(
                          input.auditEvent.actorHash,
                          this.pseudonymizationSecret
                      ) ?? ''
                  )
                : null,
        });

        return incident;
    }

    /**
     * Persists the bot's remediation outcome for an already-created incident.
     */
    async updateRemediation(
        id: number,
        input: UpdateRemediationInput
    ): Promise<IncidentRecord> {
        this.assertValidRemediationState(input.state);
        const updatedAt = new Date().toISOString();
        const result = await this.withRetry(() =>
            this.updateRemediationStatement.run({
                id,
                remediation_state: input.state,
                remediation_applied: input.state === 'applied' ? 1 : 0,
                remediation_notes: input.notes ?? null,
                remediation_updated_at: updatedAt,
                updated_at: updatedAt,
            })
        );

        if (result.changes === 0) {
            throw new Error(`Incident ${id} not found`);
        }

        const incident = await this.getIncident(id);
        if (!incident) {
            throw new Error(`Incident ${id} was updated but could not be read back`);
        }
        return incident;
    }

    /**
     * Persists remediation state and, when supplied, its audit event inside one
     * transaction so "applied" cannot commit without `incident.remediated`.
     */
    async updateRemediationWithAudit(
        input: UpdateRemediationWithAuditInput
    ): Promise<IncidentRecord> {
        this.assertValidRemediationState(input.remediation.state);
        const updatedAt = new Date().toISOString();
        const transaction = this.db.transaction(() => {
            const result = this.updateRemediationStatement.run({
                id: input.incidentId,
                remediation_state: input.remediation.state,
                remediation_applied:
                    input.remediation.state === 'applied' ? 1 : 0,
                remediation_notes: input.remediation.notes ?? null,
                remediation_updated_at: updatedAt,
                updated_at: updatedAt,
            });

            if (result.changes === 0) {
                throw new Error(`Incident ${input.incidentId} not found`);
            }

            if (input.auditEvent) {
                this.insertAuditEvent.run(
                    this.buildAuditInsertValues(
                        input.incidentId,
                        input.auditEvent,
                        updatedAt
                    )
                );
            }

            const incidentRow = this.getIncidentRowByIdSync(input.incidentId);
            if (!incidentRow) {
                throw new Error(
                    `Incident ${input.incidentId} was updated but could not be read back`
                );
            }

            return this.mapIncidentRow(incidentRow);
        });

        const incident = await this.withRetry(() => transaction());
        if (input.auditEvent) {
            incidentLogger.info('Incident audit event appended', {
                incidentNumericId: input.incidentId,
                action: input.auditEvent.action,
                actorHash: input.auditEvent.actorHash
                    ? shortHash(
                          pseudonymizeActorId(
                              input.auditEvent.actorHash,
                              this.pseudonymizationSecret
                          ) ?? ''
                      )
                    : null,
            });
        }

        return incident;
    }

    /**
     * Returns the audit trail for one incident in chronological order.
     */
    async listAuditEvents(incidentId: number): Promise<IncidentAuditEvent[]> {
        const rows = (await this.withRetry(() =>
            this.getAuditEventsByIncidentIdStatement.all(incidentId)
        )) as AuditRow[];
        return rows.map((row) => this.mapAuditRow(row));
    }

    /**
     * Appends one audit event after pseudonymizing the actor ID, if present.
     */
    async appendAuditEvent(
        incidentId: number,
        event: AppendAuditEventInput
    ): Promise<IncidentAuditEvent> {
        const createdAt = new Date().toISOString();
        const actorHash = pseudonymizeActorId(
            event.actorHash,
            this.pseudonymizationSecret
        );
        const runResult = await this.withRetry(() =>
            this.insertAuditEvent.run({
                incident_id: incidentId,
                actor_hash: actorHash ?? null,
                action: event.action,
                notes: event.notes ?? null,
                created_at: createdAt,
            })
        );

        incidentLogger.info('Incident audit event appended', {
            incidentNumericId: incidentId,
            action: event.action,
            actorHash: actorHash ? shortHash(actorHash) : null,
        });

        return {
            id: Number(runResult.lastInsertRowid),
            incidentId,
            actorHash,
            action: event.action,
            notes: event.notes ?? null,
            createdAt,
        };
    }

    /**
     * Closes the SQLite handle so tests and shutdown paths can release the file
     * cleanly.
     */
    close(): void {
        this.db.close();
    }
}
