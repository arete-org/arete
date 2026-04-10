/**
 * @description: Runs bounded prototype evidence intake with strict scope checks and governed field mapping.
 * Adapter failures fail open to local Execution Contract behavior without changing terminal authority semantics.
 * @footnote-scope: core
 * @footnote-module: ExecutionContractTrustGraphEvidenceIngestion
 * @footnote-risk: high - Intake boundary mistakes can leak advisory signals into authority-critical Execution Contract decisions.
 * @footnote-ethics: high - This boundary controls whether external evidence stays auditable and non-authoritative.
 */

import {
    buildTrustGraphConsumerViews,
    listTrustGraphApprovedFieldPaths,
    TRUST_GRAPH_APPROVED_PREDICATE_CONSUMERS,
} from './mappingRegistry.js';
import { createTrustGraphProvenanceJoin } from './provenanceJoin.js';
import {
    TrustGraphScopeValidator,
    type ScopeValidationPolicy,
} from './scopeValidator.js';
import {
    TrustGraphOwnershipBypassCapability,
    TrustGraphOwnershipValidationPolicy,
} from './trustGraphEvidenceTypes.js';
import type {
    Budget,
    EvidenceBundle,
    EvidenceItem,
    GovernedPredicateViews,
    LocalTerminalOutcome,
    MappingRegistryConsumer,
    ScopeOwnershipValidator,
    ScopeTuple,
    TrustGraphEvidenceAdapter,
    TrustGraphEvidenceIngestionResult,
    TrustGraphProvenanceReasonCode,
} from './trustGraphEvidenceTypes.js';

const TRUSTGRAPH_TIMEOUT_ERROR = 'trustgraph_adapter_timeout';
const TRUSTGRAPH_ABORT_ERROR = 'trustgraph_adapter_aborted_by_signal';

class TrustGraphAdapterTimeoutError extends Error {
    public readonly cancellationRequested: boolean;

    public constructor(cancellationRequested: boolean) {
        super(TRUSTGRAPH_TIMEOUT_ERROR);
        this.name = 'TrustGraphAdapterTimeoutError';
        this.cancellationRequested = cancellationRequested;
    }
}

const isPoisonedClaimText = (claimText: string): boolean =>
    /<\s*script\b/i.test(claimText);

const isNonEmptyString = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0;

const invokeAdapterWithTimeout = async (input: {
    adapter: TrustGraphEvidenceAdapter;
    queryIntent: string;
    scopeTuple: ScopeTuple;
    budget: Budget;
}): Promise<EvidenceBundle> => {
    const timeoutMs = Math.max(1, Math.floor(input.budget.timeoutMs));
    const abortController = new AbortController();
    let cancellationRequested = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
                cancellationRequested = true;
                abortController.abort(TRUSTGRAPH_ABORT_ERROR);
                reject(new TrustGraphAdapterTimeoutError(true));
            }, timeoutMs);
        });

        const bundle = await Promise.race([
            input.adapter.getEvidenceBundle({
                queryIntent: input.queryIntent,
                scopeTuple: input.scopeTuple,
                budget: input.budget,
                abortSignal: abortController.signal,
            }),
            timeoutPromise,
        ]);

        return bundle;
    } catch (error: unknown) {
        if (error instanceof TrustGraphAdapterTimeoutError) {
            throw error;
        }
        if (cancellationRequested && error instanceof Error) {
            throw new TrustGraphAdapterTimeoutError(true);
        }
        throw error;
    } finally {
        if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
        }
    }
};

const sanitizeEvidenceItem = (
    item: EvidenceItem
): { valid: true; item: EvidenceItem } | { valid: false } => {
    if (
        !isNonEmptyString(item.evidenceId) ||
        !isNonEmptyString(item.claimText) ||
        !isNonEmptyString(item.sourceRef) ||
        !isNonEmptyString(item.retrievalReason) ||
        !isNonEmptyString(item.confidenceMethodId) ||
        !isNonEmptyString(item.retrievedAt) ||
        !isNonEmptyString(item.collectionScope) ||
        !isNonEmptyString(item.adapterVersion)
    ) {
        return { valid: false };
    }

    if (isPoisonedClaimText(item.claimText)) {
        return { valid: false };
    }

    const provenancePathRef = item.provenancePathRef.filter(isNonEmptyString);
    if (provenancePathRef.length === 0) {
        return { valid: false };
    }

    return {
        valid: true,
        item: {
            ...item,
            evidenceId: item.evidenceId.trim(),
            claimText: item.claimText.trim(),
            sourceRef: item.sourceRef.trim(),
            provenancePathRef,
            retrievalReason: item.retrievalReason.trim(),
            confidenceMethodId: item.confidenceMethodId.trim(),
            retrievedAt: item.retrievedAt.trim(),
            collectionScope: item.collectionScope.trim(),
            adapterVersion: item.adapterVersion.trim(),
        },
    };
};

const clampCoverageValue = (
    value: number,
    scoreRange: '0..1' | '0..100'
): number => {
    if (!Number.isFinite(value)) {
        return 0;
    }

    const normalizedValue = Math.max(0, value);
    if (scoreRange === '0..1') {
        return Math.min(1, normalizedValue);
    }
    return Math.min(100, normalizedValue);
};

const sanitizeEvidenceBundle = (
    bundle: EvidenceBundle
): {
    bundle: EvidenceBundle;
    droppedEvidenceCount: number;
    droppedEvidenceIds: string[];
    reasonCodes: TrustGraphProvenanceReasonCode[];
    neutralizeAggregateSignals: boolean;
} => {
    const sanitizedItems: EvidenceItem[] = [];
    const droppedEvidenceIds: string[] = [];

    for (const item of bundle.items) {
        const sanitized = sanitizeEvidenceItem(item);
        if (!sanitized.valid) {
            if (isNonEmptyString(item.evidenceId)) {
                droppedEvidenceIds.push(item.evidenceId.trim());
            }
            continue;
        }
        sanitizedItems.push(sanitized.item);
    }

    const droppedEvidenceCount = droppedEvidenceIds.length;
    const neutralizeAggregateSignals =
        droppedEvidenceCount > 0 || sanitizedItems.length === 0;
    const reasonCodes: TrustGraphProvenanceReasonCode[] = [];
    if (droppedEvidenceCount > 0) {
        reasonCodes.push('poisoned_evidence_dropped');
    }
    if (neutralizeAggregateSignals) {
        reasonCodes.push('aggregate_signals_neutralized_after_filtering');
    }

    return {
        bundle: {
            ...bundle,
            bundleId: bundle.bundleId.trim(),
            queryIntent: bundle.queryIntent.trim(),
            items: sanitizedItems,
            coverageEstimate: {
                ...bundle.coverageEstimate,
                value: clampCoverageValue(
                    bundle.coverageEstimate.value,
                    bundle.coverageEstimate.scoreRange
                ),
                computationBasis:
                    bundle.coverageEstimate.computationBasis.filter(
                        isNonEmptyString
                    ),
                adapterVersion: bundle.coverageEstimate.adapterVersion.trim(),
            },
            conflictSignals: bundle.conflictSignals.filter(isNonEmptyString),
            traceRefs: bundle.traceRefs.filter(isNonEmptyString),
            scopeTuple: {
                userId: bundle.scopeTuple.userId.trim(),
                ...(bundle.scopeTuple.projectId !== undefined && {
                    projectId: bundle.scopeTuple.projectId.trim(),
                }),
                ...(bundle.scopeTuple.collectionId !== undefined && {
                    collectionId: bundle.scopeTuple.collectionId.trim(),
                }),
            },
            adapterVersion: bundle.adapterVersion.trim(),
        },
        droppedEvidenceCount,
        droppedEvidenceIds,
        reasonCodes,
        neutralizeAggregateSignals,
    };
};

const defaultLocalExecutionContractOutcome = (): LocalTerminalOutcome =>
    'complete';

export type RunEvidenceIngestionInput = {
    queryIntent: string;
    scopeTuple: ScopeTuple;
    budget: Budget;
    ownershipValidationPolicy: TrustGraphOwnershipValidationPolicy;
    adapter?: TrustGraphEvidenceAdapter;
    scopeValidationPolicy?: Partial<
        Pick<
            ScopeValidationPolicy,
            | 'requireProjectOrCollection'
            | 'allowProjectAndCollectionTogether'
            | 'ownershipValidationTimeoutMs'
        >
    >;
    scopeOwnershipValidator?: ScopeOwnershipValidator;
    evaluateLocalExecutionContractOutcome?: () => LocalTerminalOutcome;
};

const createEmptyConsumerViews = (): GovernedPredicateViews => ({
    P_SUFF: {
        consumer: 'P_SUFF',
        conflictSignals: [],
        sourceRefs: [],
        provenancePathRefs: [],
        traceRefs: [],
    },
    P_EVID: {
        consumer: 'P_EVID',
        conflictSignals: [],
        sourceRefs: [],
        provenancePathRefs: [],
        traceRefs: [],
    },
});

const neutralizeAggregateSignals = (
    views: GovernedPredicateViews
): GovernedPredicateViews => ({
    P_SUFF: {
        ...views.P_SUFF,
        coverageValue: undefined,
        coverageEvaluationUnit: undefined,
        conflictSignals: [],
    },
    P_EVID: {
        ...views.P_EVID,
        conflictSignals: [],
    },
});

const scopesMatchExactly = (left: ScopeTuple, right: ScopeTuple): boolean => {
    const normalized = (value: string | undefined): string | undefined => {
        if (value === undefined) {
            return undefined;
        }
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    };

    return (
        normalized(left.userId) === normalized(right.userId) &&
        normalized(left.projectId) === normalized(right.projectId) &&
        normalized(left.collectionId) === normalized(right.collectionId)
    );
};

const deriveConsumedGovernedFieldPaths = (
    views: GovernedPredicateViews
): string[] => {
    const approvedFieldPaths = new Set(listTrustGraphApprovedFieldPaths());
    const consumed = new Set<string>();

    if (views.P_SUFF.coverageValue !== undefined) {
        consumed.add('coverageEstimate.value');
    }
    if (views.P_SUFF.coverageEvaluationUnit !== undefined) {
        consumed.add('coverageEstimate.evaluationUnit');
    }
    if (
        views.P_SUFF.conflictSignals.length > 0 ||
        views.P_EVID.conflictSignals.length > 0
    ) {
        consumed.add('conflictSignals');
    }
    if (views.P_EVID.sourceRefs.length > 0) {
        consumed.add('items[].sourceRef');
    }
    if (views.P_EVID.provenancePathRefs.length > 0) {
        consumed.add('items[].provenancePathRef');
    }
    if (views.P_EVID.traceRefs.length > 0) {
        consumed.add('traceRefs');
    }

    return [...consumed].filter((path) => approvedFieldPaths.has(path));
};

const deriveConsumersWithSignals = (
    views: GovernedPredicateViews
): MappingRegistryConsumer[] => {
    const activeConsumers = new Set<MappingRegistryConsumer>();
    if (
        views.P_SUFF.coverageValue !== undefined ||
        views.P_SUFF.coverageEvaluationUnit !== undefined ||
        views.P_SUFF.conflictSignals.length > 0
    ) {
        activeConsumers.add('P_SUFF');
    }
    if (
        views.P_EVID.conflictSignals.length > 0 ||
        views.P_EVID.sourceRefs.length > 0 ||
        views.P_EVID.provenancePathRefs.length > 0 ||
        views.P_EVID.traceRefs.length > 0
    ) {
        activeConsumers.add('P_EVID');
    }

    const ordered: MappingRegistryConsumer[] = [];
    for (const consumer of TRUST_GRAPH_APPROVED_PREDICATE_CONSUMERS) {
        if (activeConsumers.has(consumer)) {
            ordered.push(consumer);
        }
    }
    return ordered;
};

export const runEvidenceIngestion = async (
    input: RunEvidenceIngestionInput
): Promise<TrustGraphEvidenceIngestionResult> => {
    const evaluateLocalExecutionContractOutcome =
        input.evaluateLocalExecutionContractOutcome ??
        defaultLocalExecutionContractOutcome;
    const localTerminalOutcome = evaluateLocalExecutionContractOutcome();
    const ownershipValidationPolicy = input.ownershipValidationPolicy;
    if (
        !(
            ownershipValidationPolicy instanceof
            TrustGraphOwnershipValidationPolicy
        )
    ) {
        return {
            evidenceMode: 'advisory',
            canBlockExecution: false,
            adapterStatus: 'scope_denied',
            scopeValidation: {
                ok: false,
                reasonCode: 'external_scope_validation_failed',
                details:
                    'Ownership validation policy must be created with TrustGraphOwnershipValidationPolicy.',
            },
            localTerminalOutcome,
            terminalAuthority: 'backend_execution_contract',
            failOpenBehavior: 'local_behavior',
            verificationRequired: true,
            advisoryEvidenceItemCount: 0,
            droppedEvidenceCount: 0,
            droppedEvidenceIds: [],
            provenanceReasonCodes: ['external_scope_validation_failed'],
            predicateViews: createEmptyConsumerViews(),
        };
    }
    const ownershipValidationMode = ownershipValidationPolicy.mode;
    const provenanceReasonCodes: TrustGraphProvenanceReasonCode[] = [];
    if (
        ownershipValidationMode !== 'required' &&
        ownershipValidationMode !== 'explicitly_none'
    ) {
        provenanceReasonCodes.push('external_scope_validation_failed');
        return {
            evidenceMode: 'advisory',
            canBlockExecution: false,
            adapterStatus: 'scope_denied',
            scopeValidation: {
                ok: false,
                reasonCode: 'external_scope_validation_failed',
                details:
                    'Missing explicit ownership validation policy for external retrieval.',
            },
            localTerminalOutcome,
            terminalAuthority: 'backend_execution_contract',
            failOpenBehavior: 'local_behavior',
            verificationRequired: true,
            advisoryEvidenceItemCount: 0,
            droppedEvidenceCount: 0,
            droppedEvidenceIds: [],
            provenanceReasonCodes,
            predicateViews: createEmptyConsumerViews(),
        };
    }
    if (ownershipValidationMode === 'explicitly_none') {
        if (
            ownershipValidationPolicy.policySource !== 'trusted_backend_policy'
        ) {
            provenanceReasonCodes.push(
                'ownership_validation_explicitly_none_denied'
            );
            provenanceReasonCodes.push('external_scope_validation_failed');
            return {
                evidenceMode: 'advisory',
                canBlockExecution: false,
                adapterStatus: 'scope_denied',
                scopeValidation: {
                    ok: false,
                    reasonCode: 'external_scope_validation_failed',
                    details:
                        'explicitly_none ownership validation requires trusted backend policy source.',
                },
                localTerminalOutcome,
                terminalAuthority: 'backend_execution_contract',
                failOpenBehavior: 'local_behavior',
                verificationRequired: true,
                advisoryEvidenceItemCount: 0,
                droppedEvidenceCount: 0,
                droppedEvidenceIds: [],
                provenanceReasonCodes,
                predicateViews: createEmptyConsumerViews(),
            };
        }
        if (
            !(
                ownershipValidationPolicy.bypassCapability instanceof
                TrustGraphOwnershipBypassCapability
            )
        ) {
            provenanceReasonCodes.push(
                'ownership_validation_explicitly_none_denied'
            );
            provenanceReasonCodes.push('external_scope_validation_failed');
            return {
                evidenceMode: 'advisory',
                canBlockExecution: false,
                adapterStatus: 'scope_denied',
                scopeValidation: {
                    ok: false,
                    reasonCode: 'external_scope_validation_failed',
                    details:
                        'explicitly_none ownership validation requires trusted bypass capability.',
                },
                localTerminalOutcome,
                terminalAuthority: 'backend_execution_contract',
                failOpenBehavior: 'local_behavior',
                verificationRequired: true,
                advisoryEvidenceItemCount: 0,
                droppedEvidenceCount: 0,
                droppedEvidenceIds: [],
                provenanceReasonCodes,
                predicateViews: createEmptyConsumerViews(),
            };
        }
        if (
            !(
                typeof ownershipValidationPolicy.justificationCode ===
                    'string' &&
                ownershipValidationPolicy.justificationCode.trim().length > 0
            )
        ) {
            provenanceReasonCodes.push('external_scope_validation_failed');
            return {
                evidenceMode: 'advisory',
                canBlockExecution: false,
                adapterStatus: 'scope_denied',
                scopeValidation: {
                    ok: false,
                    reasonCode: 'external_scope_validation_failed',
                    details:
                        'explicitly_none requires a non-empty justification code.',
                },
                localTerminalOutcome,
                terminalAuthority: 'backend_execution_contract',
                failOpenBehavior: 'local_behavior',
                verificationRequired: true,
                advisoryEvidenceItemCount: 0,
                droppedEvidenceCount: 0,
                droppedEvidenceIds: [],
                provenanceReasonCodes,
                predicateViews: createEmptyConsumerViews(),
            };
        }
        provenanceReasonCodes.push(
            'ownership_validation_explicitly_none_allowed_non_production'
        );
    }

    const scopeValidator = new TrustGraphScopeValidator({
        policy: {
            requireProjectOrCollection:
                input.scopeValidationPolicy?.requireProjectOrCollection ?? true,
            allowProjectAndCollectionTogether:
                input.scopeValidationPolicy
                    ?.allowProjectAndCollectionTogether ?? false,
            ownershipValidationTimeoutMs:
                input.scopeValidationPolicy?.ownershipValidationTimeoutMs ??
                input.budget.timeoutMs,
            ownershipValidationMode,
        },
        ownershipValidator: input.scopeOwnershipValidator,
    });
    const scopeValidation = await scopeValidator.validateScope(
        input.scopeTuple
    );

    if (!scopeValidation.ok) {
        provenanceReasonCodes.push('external_scope_validation_failed');
        return {
            evidenceMode: 'advisory',
            canBlockExecution: false,
            adapterStatus: 'scope_denied',
            scopeValidation,
            localTerminalOutcome,
            terminalAuthority: 'backend_execution_contract',
            failOpenBehavior: 'local_behavior',
            verificationRequired: true,
            advisoryEvidenceItemCount: 0,
            droppedEvidenceCount: 0,
            droppedEvidenceIds: [],
            provenanceReasonCodes,
            predicateViews: createEmptyConsumerViews(),
        };
    }

    if (input.adapter === undefined) {
        provenanceReasonCodes.push('adapter_disabled');
        return {
            evidenceMode: 'advisory',
            canBlockExecution: false,
            adapterStatus: 'off',
            scopeValidation,
            localTerminalOutcome,
            terminalAuthority: 'backend_execution_contract',
            failOpenBehavior: 'local_behavior',
            verificationRequired: true,
            advisoryEvidenceItemCount: 0,
            droppedEvidenceCount: 0,
            droppedEvidenceIds: [],
            provenanceReasonCodes,
            predicateViews: createEmptyConsumerViews(),
        };
    }

    let adapterBundle: EvidenceBundle;
    try {
        const adapterInvocation = await invokeAdapterWithTimeout({
            adapter: input.adapter,
            queryIntent: input.queryIntent,
            scopeTuple: scopeValidation.normalizedScope,
            budget: input.budget,
        });
        adapterBundle = adapterInvocation;
    } catch (error: unknown) {
        if (error instanceof TrustGraphAdapterTimeoutError) {
            provenanceReasonCodes.push('adapter_timeout');
            if (error.cancellationRequested) {
                provenanceReasonCodes.push(
                    'adapter_timeout_cancellation_requested'
                );
            }
            return {
                evidenceMode: 'advisory',
                canBlockExecution: false,
                adapterStatus: 'timeout',
                scopeValidation,
                localTerminalOutcome,
                terminalAuthority: 'backend_execution_contract',
                failOpenBehavior: 'local_behavior',
                verificationRequired: true,
                advisoryEvidenceItemCount: 0,
                droppedEvidenceCount: 0,
                droppedEvidenceIds: [],
                provenanceReasonCodes,
                predicateViews: createEmptyConsumerViews(),
            };
        }
        provenanceReasonCodes.push('adapter_error');
        return {
            evidenceMode: 'advisory',
            canBlockExecution: false,
            adapterStatus: 'error',
            scopeValidation,
            localTerminalOutcome,
            terminalAuthority: 'backend_execution_contract',
            failOpenBehavior: 'local_behavior',
            verificationRequired: true,
            advisoryEvidenceItemCount: 0,
            droppedEvidenceCount: 0,
            droppedEvidenceIds: [],
            provenanceReasonCodes,
            predicateViews: createEmptyConsumerViews(),
        };
    }

    let droppedEvidenceCount = 0;
    let droppedEvidenceIds: string[] = [];
    try {
        const sanitized = sanitizeEvidenceBundle(adapterBundle);
        droppedEvidenceCount = sanitized.droppedEvidenceCount;
        droppedEvidenceIds = sanitized.droppedEvidenceIds;
        provenanceReasonCodes.push(...sanitized.reasonCodes);
        if (
            !scopesMatchExactly(
                sanitized.bundle.scopeTuple,
                scopeValidation.normalizedScope
            )
        ) {
            provenanceReasonCodes.push('adapter_scope_mismatch');
            return {
                evidenceMode: 'advisory',
                canBlockExecution: false,
                adapterStatus: 'scope_denied',
                scopeValidation: {
                    ok: false,
                    reasonCode: 'external_scope_validation_failed',
                    details:
                        'Adapter scope tuple did not match the normalized external retrieval scope.',
                },
                localTerminalOutcome,
                terminalAuthority: 'backend_execution_contract',
                failOpenBehavior: 'local_behavior',
                verificationRequired: true,
                advisoryEvidenceItemCount: 0,
                droppedEvidenceCount,
                droppedEvidenceIds,
                provenanceReasonCodes,
                predicateViews: createEmptyConsumerViews(),
            };
        }
        let predicateViews = buildTrustGraphConsumerViews(sanitized.bundle);
        if (sanitized.neutralizeAggregateSignals) {
            predicateViews = neutralizeAggregateSignals(predicateViews);
        }

        const consumedGovernedFieldPaths =
            deriveConsumedGovernedFieldPaths(predicateViews);
        const consumedByConsumers = deriveConsumersWithSignals(predicateViews);
        const provenanceJoin = createTrustGraphProvenanceJoin({
            bundle: sanitized.bundle,
            consumedGovernedFieldPaths,
            consumedByConsumers,
            droppedEvidenceIds,
            reasonCodes: provenanceReasonCodes,
        }).join;

        return {
            evidenceMode: 'advisory',
            canBlockExecution: false,
            adapterStatus: 'success',
            scopeValidation,
            localTerminalOutcome,
            terminalAuthority: 'backend_execution_contract',
            failOpenBehavior: 'local_behavior',
            verificationRequired: true,
            advisoryEvidenceItemCount: sanitized.bundle.items.length,
            droppedEvidenceCount,
            droppedEvidenceIds,
            provenanceReasonCodes,
            predicateViews,
            provenanceJoin,
        };
    } catch (_error: unknown) {
        provenanceReasonCodes.push('adapter_processing_failed');
        return {
            evidenceMode: 'advisory',
            canBlockExecution: false,
            adapterStatus: 'error',
            scopeValidation,
            localTerminalOutcome,
            terminalAuthority: 'backend_execution_contract',
            failOpenBehavior: 'local_behavior',
            verificationRequired: true,
            advisoryEvidenceItemCount: 0,
            droppedEvidenceCount,
            droppedEvidenceIds,
            provenanceReasonCodes,
            predicateViews: createEmptyConsumerViews(),
        };
    }
};

export const getRegistryMetadata = (): {
    approvedFieldPaths: readonly string[];
    approvedConsumers: readonly MappingRegistryConsumer[];
} => ({
    approvedFieldPaths: listTrustGraphApprovedFieldPaths(),
    approvedConsumers: TRUST_GRAPH_APPROVED_PREDICATE_CONSUMERS,
});
