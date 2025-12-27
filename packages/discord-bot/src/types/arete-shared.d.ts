/**
 * @description: Ambient declarations for @arete/backend/shared to support local builds.
 * @arete-scope: interface
 * @arete-module AreteSharedTypes
 * @arete-risk: low - Drift can break type checking or build tooling.
 * @arete-ethics: low - Types do not change runtime behavior.
 */
declare module '@arete/backend/shared' {
  import type { ResponseMetadata } from '@arete/backend/ethics-core';
  import type { Logger } from 'winston';

  export type PromptKey =
    | 'discord.chat.system'
    | 'discord.image.system'
    | 'discord.image.developer'
    | 'discord.realtime.system'
    | 'discord.planner.system'
    | 'discord.summarizer.system'
    | 'discord.news.system';

  export interface PromptCachePolicy {
    strategy?: string;
    ttlSeconds?: number;
    [key: string]: unknown;
  }

  export interface PromptMetadata {
    description?: string;
    cache?: PromptCachePolicy;
  }

  export interface PromptDefinition extends PromptMetadata {
    template: string;
  }

  export type PromptVariables = Record<string, string | number | boolean | null | undefined>;

  export interface RenderedPrompt extends PromptMetadata {
    content: string;
  }

  export interface PromptRegistryOptions {
    overridePath?: string;
  }

  export class PromptRegistry {
    constructor(options?: PromptRegistryOptions);
    getPrompt(key: PromptKey): PromptDefinition;
    renderPrompt(key: PromptKey, variables?: PromptVariables): RenderedPrompt;
    hasPrompt(key: PromptKey): boolean;
    assertKeys(keys: PromptKey[]): void;
  }

  export function renderPrompt(key: PromptKey, variables?: PromptVariables): RenderedPrompt;

  export function setActivePromptRegistry(registry: PromptRegistry): void;

  export function getActivePromptRegistry(): PromptRegistry;

  // Trace store helpers mirror the shared package so consumers can persist provenance data.
  export class SqliteTraceStore {
    constructor(config: { dbPath: string });
    upsert(metadata: ResponseMetadata): Promise<void>;
    retrieve(responseId: string): Promise<ResponseMetadata | null>;
    delete(responseId: string): Promise<void>;
    close(): void;
  }

  export type TraceStore = SqliteTraceStore;

  /**
   * Default trace store instance using environment configuration.
   */
  export function createTraceStoreFromEnv(): TraceStore;
  export const defaultTraceStore: TraceStore;
  export const traceStoreJsonReplacer: (_key: string, value: unknown) => unknown;
  export function assertValidResponseMetadata(
    value: unknown,
    source: string,
    responseId: string
  ): asserts value is ResponseMetadata;

  export type IncidentStatus = 'new' | 'under_review' | 'confirmed' | 'dismissed' | 'resolved';

  export interface IncidentPointers {
    responseId?: string;
    traceId?: string;
    guildId?: string;
    channelId?: string;
    messageId?: string;
    jumpUrl?: string;
    modelVersion?: string;
    chainHash?: string;
    [key: string]: unknown;
  }

  export interface IncidentRecord {
    id: number;
    shortId: string;
    status: IncidentStatus;
    tags: string[];
    pointers: IncidentPointers;
    remediationApplied: boolean;
    remediationNotes?: string | null;
    createdAt: string;
    updatedAt: string;
  }

  export interface IncidentAuditEvent {
    id: number;
    incidentId: number;
    actorHash?: string | null;
    action: string;
    notes?: string | null;
    createdAt: string;
  }

  export interface CreateIncidentInput {
    status?: IncidentStatus;
    tags?: string[];
    pointers?: IncidentPointers;
    remediationApplied?: boolean;
    remediationNotes?: string | null;
  }

  export interface AppendAuditEventInput {
    actorHash?: string | null;
    action: string;
    notes?: string | null;
  }

  export class SqliteIncidentStore {
    constructor(config: { dbPath: string; pseudonymizationSecret: string });
    createIncident(input: CreateIncidentInput): Promise<IncidentRecord>;
    getIncident(id: number): Promise<IncidentRecord | null>;
    updateStatus(id: number, status: IncidentStatus): Promise<void>;
    appendAuditEvent(incidentId: number, event: AppendAuditEventInput): Promise<IncidentAuditEvent>;
    close(): void;
  }

  export type IncidentStore = SqliteIncidentStore;
  export function createIncidentStoreFromEnv(): IncidentStore;
  export const defaultIncidentStore: IncidentStore;

  /**
   * Logging utilities
   */
  export const logger: Logger;
  export const formatUsd: (amount: number) => string;

  export interface LLMCostTotals {
    totalCostUsd: number;
    totalCalls: number;
    totalTokensIn: number;
    totalTokensOut: number;
  }

  export type LLMCostSummaryProvider = () => LLMCostTotals | null | undefined;
  export function logLLMCostSummary(getTotals?: LLMCostSummaryProvider): void;
  export function sanitizeLogData<T>(value: T): T;

  /**
   * Pseudonymization helpers
   */
  export function hmacId(secret: string, id: string, namespace: string): string;
  export function shortHash(hash: string, length?: number): string;
  export function pseudonymizeActorId(actorId: string | null | undefined, secret: string): string | null;
  export function pseudonymizeIncidentPointers(pointers: IncidentPointers, secret: string): IncidentPointers;
}

