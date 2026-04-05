/**
 * @description: Provides the production HTTP adapter for TrustGraph evidence retrieval.
 * This keeps external retrieval bounded to one request and preserves AbortSignal cancellation semantics.
 * @footnote-scope: interface
 * @footnote-module: ExecutionContractTrustGraphHttpAdapter
 * @footnote-risk: high - Malformed adapter responses can corrupt advisory evidence ingestion behavior.
 * @footnote-ethics: high - External evidence quality and provenance directly affect reviewer trust.
 */

import type {
    Budget,
    CoverageEstimate,
    EvidenceBundle,
    EvidenceItem,
    ScopeTuple,
    TrustGraphEvidenceAdapter,
} from './trustGraphEvidenceTypes.js';

type HttpTrustGraphAdapterConfig = {
    endpointUrl: string;
    apiToken?: string | null;
    configRef?: string | null;
};

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');

const isScopeTuple = (value: unknown): value is ScopeTuple => {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const record = value as Record<string, unknown>;
    if (!isString(record.userId)) {
        return false;
    }
    if (record.projectId !== undefined && !isString(record.projectId)) {
        return false;
    }
    if (record.collectionId !== undefined && !isString(record.collectionId)) {
        return false;
    }
    return true;
};

const isCoverageEstimate = (value: unknown): value is CoverageEstimate => {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return (
        (record.evaluationUnit === 'claim' ||
            record.evaluationUnit === 'subquestion' ||
            record.evaluationUnit === 'source') &&
        (record.scoreRange === '0..1' || record.scoreRange === '0..100') &&
        isNumber(record.value) &&
        isStringArray(record.computationBasis) &&
        typeof record.comparableAcrossVersions === 'boolean' &&
        isString(record.adapterVersion)
    );
};

const isEvidenceItem = (value: unknown): value is EvidenceItem => {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return (
        isString(record.evidenceId) &&
        isString(record.claimText) &&
        isString(record.sourceRef) &&
        isStringArray(record.provenancePathRef) &&
        isString(record.retrievalReason) &&
        isNumber(record.confidenceScore) &&
        isString(record.confidenceMethodId) &&
        isString(record.retrievedAt) &&
        isString(record.collectionScope) &&
        isString(record.adapterVersion)
    );
};

const isEvidenceBundle = (value: unknown): value is EvidenceBundle => {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return (
        isString(record.bundleId) &&
        isString(record.queryIntent) &&
        Array.isArray(record.items) &&
        record.items.every(isEvidenceItem) &&
        isCoverageEstimate(record.coverageEstimate) &&
        isStringArray(record.conflictSignals) &&
        isStringArray(record.traceRefs) &&
        isScopeTuple(record.scopeTuple) &&
        isString(record.adapterVersion)
    );
};

const toEvidenceBundle = (payload: unknown): EvidenceBundle => {
    if (isEvidenceBundle(payload)) {
        return payload;
    }
    if (typeof payload === 'object' && payload !== null) {
        const record = payload as Record<string, unknown>;
        if (isEvidenceBundle(record.bundle)) {
            return record.bundle;
        }
    }
    throw new Error('trustgraph_adapter_invalid_response_payload');
};

export class HttpTrustGraphEvidenceAdapter implements TrustGraphEvidenceAdapter {
    private readonly endpointUrl: string;
    private readonly apiToken: string | null;
    private readonly configRef: string | null;

    public constructor(config: HttpTrustGraphAdapterConfig) {
        this.endpointUrl = config.endpointUrl;
        this.apiToken = config.apiToken ?? null;
        this.configRef = config.configRef ?? null;
    }

    public async getEvidenceBundle(input: {
        queryIntent: string;
        scopeTuple: ScopeTuple;
        budget: Budget;
        abortSignal?: AbortSignal;
    }): Promise<EvidenceBundle> {
        const response = await fetch(this.endpointUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(this.apiToken !== null && {
                    Authorization: `Bearer ${this.apiToken}`,
                }),
                ...(this.configRef !== null && {
                    'X-TrustGraph-Config-Ref': this.configRef,
                }),
            },
            body: JSON.stringify({
                queryIntent: input.queryIntent,
                scopeTuple: input.scopeTuple,
                budget: input.budget,
            }),
            signal: input.abortSignal,
        });

        if (!response.ok) {
            throw new Error(
                `trustgraph_adapter_http_status_${response.status}`
            );
        }

        const payload = (await response.json()) as unknown;
        return toEvidenceBundle(payload);
    }
}

export const createHttpTrustGraphEvidenceAdapter = (
    config: HttpTrustGraphAdapterConfig
): TrustGraphEvidenceAdapter => new HttpTrustGraphEvidenceAdapter(config);
