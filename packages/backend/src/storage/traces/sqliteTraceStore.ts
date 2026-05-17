/**
 * @description: Persists provenance traces in SQLite with retry handling and validation.
 * @footnote-scope: utility
 * @footnote-module: SqliteTraceStore
 * @footnote-risk: medium - Storage errors can drop trace records or corrupt metadata.
 * @footnote-ethics: medium - Trace accuracy underpins transparency and auditability.
 */
import {
    TRACE_ASSESS_FINAL_TEMPERAMENT_SIGNAL_KEYS,
    type Citation,
    type ResponseMetadata,
} from '@footnote/contracts/policy';
import { ResponseMetadataSchema } from '@footnote/contracts/web/schemas';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';
import { traceStoreJsonReplacer } from './traceStoreUtils.js';

const BUSY_MAX_ATTEMPTS = 5;
const BUSY_RETRY_DELAY_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const traceLogger =
    typeof logger.child === 'function'
        ? logger.child({ module: 'sqliteTraceStore' })
        : logger;
const TRACE_ASSESS_FINAL_AXIS_SIGNAL_KEYS = Object.values(
    TRACE_ASSESS_FINAL_TEMPERAMENT_SIGNAL_KEYS
);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;

const hasFinalTemperamentAxisSignals = (
    signals: Record<string, unknown>
): boolean =>
    TRACE_ASSESS_FINAL_AXIS_SIGNAL_KEYS.some((axisKey) => {
        const score = signals[axisKey];
        return (
            typeof score === 'number' &&
            Number.isInteger(score) &&
            score >= 1 &&
            score <= 5
        );
    });

const normalizeAssessSignalsForCompatibility = (
    signals: Record<string, unknown>
): Record<string, unknown> => {
    const normalizedSignals: Record<string, unknown> = { ...signals };
    const reviewDecision = normalizedSignals.reviewDecision;
    const reviewReason = normalizedSignals.reviewReason;
    if (
        (reviewDecision === 'finalize' || reviewDecision === 'revise') &&
        (typeof reviewReason !== 'string' || reviewReason.trim().length === 0)
    ) {
        normalizedSignals.reviewReason =
            'Compatibility fallback: assess reason unavailable.';
    }
    if (reviewDecision === 'revise') {
        const revisionInstruction = normalizedSignals.revisionInstruction;
        if (
            typeof revisionInstruction !== 'string' ||
            revisionInstruction.trim().length === 0
        ) {
            normalizedSignals.revisionInstruction =
                'Compatibility fallback: revision instruction unavailable.';
        }
    }

    const traceAlignment = normalizedSignals.traceAlignment;
    const hasTraceAlignment =
        traceAlignment === 'aligned' || traceAlignment === 'misaligned';
    if (!hasTraceAlignment) {
        normalizedSignals.traceAlignment = 'aligned';
        return normalizedSignals;
    }

    if (traceAlignment === 'misaligned') {
        const traceAlignmentReason = normalizedSignals.traceAlignmentReason;
        const hasReason =
            typeof traceAlignmentReason === 'string' &&
            traceAlignmentReason.trim().length > 0;
        if (!hasReason || !hasFinalTemperamentAxisSignals(normalizedSignals)) {
            normalizedSignals.traceAlignment = 'aligned';
            delete normalizedSignals.traceAlignmentReason;
        }
    }

    return normalizedSignals;
};

const repairTraceMetadataForCompatibility = (metadata: unknown): unknown => {
    if (!isPlainObject(metadata)) {
        return metadata;
    }

    const root = { ...metadata };
    if (!isPlainObject(root.workflow)) {
        return root;
    }

    const workflow = { ...root.workflow };
    if (!Array.isArray(workflow.steps)) {
        root.workflow = workflow;
        return root;
    }

    workflow.steps = workflow.steps.map((step): unknown => {
        if (!isPlainObject(step)) {
            return step;
        }
        if (step.stepKind !== 'assess') {
            return step;
        }
        if (!isPlainObject(step.outcome)) {
            return step;
        }
        if (step.outcome.status !== 'executed') {
            return step;
        }
        const outcome = { ...step.outcome };
        const existingSignals = isPlainObject(outcome.signals)
            ? outcome.signals
            : {};
        outcome.signals =
            normalizeAssessSignalsForCompatibility(existingSignals);

        return {
            ...step,
            outcome,
        };
    });

    root.workflow = workflow;
    return root;
};

export interface SqliteTraceStoreConfig {
    dbPath: string;
}

export class SqliteTraceStore {
    private readonly db: Database.Database;
    private readonly upsertStatement: Database.Statement;
    private readonly retrieveStatement: Database.Statement;
    private readonly deleteStatement: Database.Statement;
    private readonly deleteTraceCardStatement: Database.Statement;
    private readonly upsertTraceCardStatement: Database.Statement;
    private readonly retrieveTraceCardStatement: Database.Statement;

    constructor(config: SqliteTraceStoreConfig) {
        const resolvedPath = path.resolve(config.dbPath);
        const dir = path.dirname(resolvedPath); // Ensure the parent directory exists before opening the database.
        fs.mkdirSync(dir, { recursive: true });

        this.db = new Database(resolvedPath);
        this.db.pragma('journal_mode = WAL'); // WAL (Write-Ahead Logging) is a journaling mode that allows for concurrent writes to the database.
        this.db.pragma('foreign_keys = ON'); // Foreign keys are enabled to enforce referential integrity.

        this.db.exec(`
      CREATE TABLE IF NOT EXISTS provenance_traces (
        response_id TEXT PRIMARY KEY,
        metadata_json TEXT NOT NULL,
        stale_after TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_provenance_traces_stale_after ON provenance_traces (stale_after);
      CREATE TABLE IF NOT EXISTS provenance_trace_cards (
        response_id TEXT PRIMARY KEY REFERENCES provenance_traces(response_id) ON DELETE CASCADE,
        trace_card_svg TEXT NOT NULL
      );
    `);
        this.ensureTraceCardForeignKey();

        this.upsertStatement = this.db.prepare(`
      INSERT INTO provenance_traces (response_id, metadata_json, stale_after, created_at, updated_at)
      VALUES (@response_id, @metadata_json, @stale_after, @created_at, @updated_at)
      ON CONFLICT(response_id) DO UPDATE SET
        metadata_json = excluded.metadata_json,
        stale_after = excluded.stale_after,
        updated_at = excluded.updated_at
    `);
        this.retrieveStatement = this.db.prepare(
            `SELECT metadata_json FROM provenance_traces WHERE response_id = ? LIMIT 1`
        );
        this.deleteStatement = this.db.prepare(
            `DELETE FROM provenance_traces WHERE response_id = ?`
        );
        this.deleteTraceCardStatement = this.db.prepare(
            `DELETE FROM provenance_trace_cards WHERE response_id = ?`
        );
        this.upsertTraceCardStatement = this.db.prepare(`
      INSERT INTO provenance_trace_cards (response_id, trace_card_svg)
      VALUES (@response_id, @trace_card_svg)
      ON CONFLICT(response_id) DO UPDATE SET
        trace_card_svg = excluded.trace_card_svg
    `);
        this.retrieveTraceCardStatement = this.db.prepare(
            `SELECT trace_card_svg FROM provenance_trace_cards WHERE response_id = ? LIMIT 1`
        );

        traceLogger.info(`Initialized SQLite trace store at ${resolvedPath}`);
    }

    private ensureTraceCardForeignKey(): void {
        type ForeignKeyRow = {
            table: string;
            from: string;
            to: string;
            on_delete: string;
        };

        const foreignKeys = this.db
            .prepare(`PRAGMA foreign_key_list(provenance_trace_cards)`)
            .all() as ForeignKeyRow[];
        const hasExpectedForeignKey = foreignKeys.some(
            (foreignKey) =>
                foreignKey.table === 'provenance_traces' &&
                foreignKey.from === 'response_id' &&
                foreignKey.to === 'response_id' &&
                foreignKey.on_delete.toUpperCase() === 'CASCADE'
        );
        if (hasExpectedForeignKey) {
            return;
        }

        const migrateTraceCardsTable = this.db.transaction(() => {
            this.db.exec(`
                CREATE TABLE provenance_trace_cards_new (
                    response_id TEXT PRIMARY KEY REFERENCES provenance_traces(response_id) ON DELETE CASCADE,
                    trace_card_svg TEXT NOT NULL
                );
            `);
            this.db.exec(`
                INSERT INTO provenance_trace_cards_new (response_id, trace_card_svg)
                SELECT cards.response_id, cards.trace_card_svg
                FROM provenance_trace_cards AS cards
                INNER JOIN provenance_traces AS traces
                    ON traces.response_id = cards.response_id;
            `);
            this.db.exec(`DROP TABLE provenance_trace_cards;`);
            this.db.exec(
                `ALTER TABLE provenance_trace_cards_new RENAME TO provenance_trace_cards;`
            );
        });

        migrateTraceCardsTable();
        traceLogger.info(
            'Migrated provenance_trace_cards to enforce ON DELETE CASCADE foreign key constraint.'
        );
    }

    private normalizeMetadata(metadata: ResponseMetadata): ResponseMetadata {
        const normalizedCitations = metadata.citations.map(
            (citation: Citation) => {
                if (!citation || typeof citation !== 'object') {
                    throw new Error(
                        `Invalid citation entry for response "${metadata.responseId}".`
                    );
                }

                let url: string;
                if (typeof citation.url === 'string') {
                    // Include response context when URL parsing fails so broken traces are easier to debug.
                    try {
                        url = new URL(citation.url).toString();
                    } catch (error) {
                        throw new Error(
                            `Cannot serialize citation URL "${citation.url}" for response "${metadata.responseId}": ${error instanceof Error ? error.message : String(error)}`,
                            { cause: error }
                        );
                    }
                } else {
                    throw new Error(
                        `Cannot serialize citation URL for response "${metadata.responseId}". Expected a string URL.`
                    );
                }

                return {
                    ...citation,
                    url,
                };
            }
        );

        return {
            ...metadata,
            citations: normalizedCitations,
        };
    }

    private isBusyError(error: unknown): boolean {
        if (!error || typeof error !== 'object') {
            return false;
        }

        const code = (error as { code?: string }).code;
        return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
    }

    private async withRetry<T>(operation: () => T): Promise<T> {
        for (let attempt = 1; attempt <= BUSY_MAX_ATTEMPTS; attempt++) {
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

    async upsert(metadata: ResponseMetadata): Promise<void> {
        const normalized = this.normalizeMetadata(metadata);
        const serialized = JSON.stringify(normalized, traceStoreJsonReplacer);
        const now = new Date().toISOString();

        await this.withRetry(() =>
            this.upsertStatement.run({
                response_id: normalized.responseId,
                metadata_json: serialized,
                stale_after: normalized.staleAfter,
                created_at: now,
                updated_at: now,
            })
        );
        traceLogger.info(`Trace stored in SQLite: ${normalized.responseId}`);
    }

    async retrieve(responseId: string): Promise<ResponseMetadata | null> {
        const row = await this.withRetry(
            () =>
                this.retrieveStatement.get(responseId) as
                    | { metadata_json: string }
                    | undefined
        );
        if (!row) {
            return null;
        }

        let parsedJson: unknown;
        try {
            parsedJson = JSON.parse(row.metadata_json) as unknown;
        } catch (error) {
            traceLogger.warn(
                `Trace record "${responseId}" failed JSON parsing; returning null fail-open.`,
                {
                    responseId,
                    reasonCode: 'trace_json_parse_error',
                    error:
                        error instanceof Error ? error.message : String(error),
                }
            );
            return null;
        }

        const strictParsed = ResponseMetadataSchema.safeParse(parsedJson);
        if (strictParsed.success) {
            if (strictParsed.data.responseId !== responseId) {
                traceLogger.warn(
                    `Trace record "${responseId}" has mismatched responseId "${strictParsed.data.responseId}"; returning null fail-open.`
                );
                return null;
            }
            return strictParsed.data;
        }

        const repairedPayload = repairTraceMetadataForCompatibility(parsedJson);
        const repairedParsed =
            ResponseMetadataSchema.safeParse(repairedPayload);
        if (repairedParsed.success) {
            if (repairedParsed.data.responseId !== responseId) {
                traceLogger.warn(
                    `Compatibility-repaired trace "${responseId}" still has mismatched responseId "${repairedParsed.data.responseId}"; returning null fail-open.`
                );
                return null;
            }
            traceLogger.warn(
                `Trace record "${responseId}" required compatibility repair to satisfy metadata schema.`
            );
            return repairedParsed.data;
        }

        const firstIssue = repairedParsed.error.issues[0];
        const issuePath =
            firstIssue && firstIssue.path.length > 0
                ? firstIssue.path.join('.')
                : 'root';
        const issueMessage =
            firstIssue?.message ?? 'Invalid trace metadata payload.';
        traceLogger.warn(
            `Trace record "${responseId}" remains invalid after compatibility repair (${issuePath}: ${issueMessage}); returning null fail-open.`
        );
        return null;
    }

    async delete(responseId: string): Promise<void> {
        await this.withRetry(() => {
            const deleteTrace = this.deleteStatement;
            const deleteTraceCard = this.deleteTraceCardStatement;
            const transaction = this.db.transaction((id: string) => {
                deleteTrace.run(id);
                deleteTraceCard.run(id);
            });
            transaction(responseId);
        });
    }

    /**
     * Stores the canonical trace-card SVG for a response id.
     * Upserts so callers can refresh the card without deleting first.
     */
    async upsertTraceCardSvg(responseId: string, svg: string): Promise<void> {
        await this.withRetry(() =>
            this.upsertTraceCardStatement.run({
                response_id: responseId,
                trace_card_svg: svg,
            })
        );
    }

    /**
     * Loads a trace-card SVG by response id.
     * Returns null when no card is stored yet.
     */
    async getTraceCardSvg(responseId: string): Promise<string | null> {
        const row = await this.withRetry(
            () =>
                this.retrieveTraceCardStatement.get(responseId) as
                    | { trace_card_svg: string }
                    | undefined
        );

        return row?.trace_card_svg ?? null;
    }

    /**
     * Flushes and truncates the WAL file so shutdown leaves less recovery work
     * for Litestream snapshots and next process start.
     */
    checkpointWalTruncate(): void {
        this.db.pragma('wal_checkpoint(TRUNCATE)');
        traceLogger.info('Trace store WAL checkpoint completed (TRUNCATE).');
    }

    close(): void {
        // Close the SQLite handle so Windows can clean up temp DB files.
        this.db.close();
    }
}
