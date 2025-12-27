/**
 * @description: Persists provenance traces in SQLite with retry handling and validation.
 * @arete-scope: utility
 * @arete-module: SqliteTraceStore
 * @arete-risk: moderate - Storage errors can drop trace records or corrupt metadata.
 * @arete-ethics: moderate - Trace accuracy underpins transparency and auditability.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { ResponseMetadata } from '../ethics-core';
import { logger } from './logger';
import { assertValidResponseMetadata, traceStoreJsonReplacer } from './traceStoreUtils';

const BUSY_MAX_ATTEMPTS = 5;
const BUSY_RETRY_DELAY_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const traceLogger = typeof logger.child === 'function' ? logger.child({ module: 'sqliteTraceStore' }) : logger;

export interface SqliteTraceStoreConfig {
  dbPath: string;
}

export class SqliteTraceStore {
  private readonly db: Database.Database;
  private readonly upsertStatement: Database.Statement;
  private readonly retrieveStatement: Database.Statement;
  private readonly deleteStatement: Database.Statement;

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
    `);

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
    this.deleteStatement = this.db.prepare(`DELETE FROM provenance_traces WHERE response_id = ?`);

    traceLogger.info(`Initialized SQLite trace store at ${resolvedPath}`);
  }

  private normalizeMetadata(metadata: ResponseMetadata): ResponseMetadata {
    const normalizedCitations = metadata.citations.map((citation) => {
      if (!citation || typeof citation !== 'object') {
        throw new Error(`Invalid citation entry for response "${metadata.responseId}".`);
      }

      let url: URL;
      if (citation.url instanceof URL) {
        url = citation.url;
      } else if (typeof citation.url === 'string') {
        url = new URL(citation.url);
      } else {
        throw new Error(
          `Cannot serialize citation URL for response "${metadata.responseId}". Expected string or URL instance.`
        );
      }

      return {
        ...citation,
        url
      };
    });

    return {
      ...metadata,
      citations: normalizedCitations
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
        updated_at: now
      })
    );
    traceLogger.info(`Trace stored in SQLite: ${normalized.responseId}`);
  }

  async retrieve(responseId: string): Promise<ResponseMetadata | null> {
    const row = await this.withRetry(() => this.retrieveStatement.get(responseId) as { metadata_json: string } | undefined);
    if (!row) {
      return null;
    }

    const filePath = `sqlite:${responseId}`;
    const parsed = JSON.parse(row.metadata_json) as unknown;

    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { citations?: unknown }).citations)) {
      throw new Error(`Trace record "${responseId}" is invalid: missing citations array.`);
    }

    const citations = (parsed as { citations: unknown[] }).citations;
    for (const citation of citations) {
      if (!citation || typeof citation !== 'object') {
        throw new Error(`Trace record "${responseId}" is invalid: citation entry is invalid.`);
      }

      const citationRecord = citation as Record<string, unknown>;
      if (typeof citationRecord.url === 'string') {
        citationRecord.url = new URL(citationRecord.url);
      } else if (!(citationRecord.url instanceof URL)) {
        throw new Error(`Trace record "${responseId}" is invalid: citation URL missing or malformed.`);
      }
    }

    assertValidResponseMetadata(parsed, filePath, responseId);
    if ((parsed as ResponseMetadata).responseId !== responseId) {
      throw new Error(
        `Trace record "${responseId}" is corrupted: responseId mismatch (expected "${responseId}" but found "${(parsed as ResponseMetadata).responseId}").`
      );
    }

    return parsed as ResponseMetadata;
  }

  async delete(responseId: string): Promise<void> {
    await this.withRetry(() => this.deleteStatement.run(responseId));
  }

  close(): void {
    // Close the SQLite handle so Windows can clean up temp DB files.
    this.db.close();
  }
}
