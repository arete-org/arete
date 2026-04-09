/**
 * @description: Defines bounded prototype contracts for advisory TrustGraph evidence intake.
 * These types keep Execution Contract authority backend-owned while allowing typed, auditable evidence bundles.
 * @footnote-scope: interface
 * @footnote-module: ExecutionContractTrustGraphEvidenceTypes
 * @footnote-risk: medium - Contract drift can mis-shape evidence intake and provenance joins at Execution Contract boundaries.
 * @footnote-ethics: high - Evidence and provenance contract clarity directly affects reviewability and trust.
 */

export type ScopeTuple = {
    userId: string;
    projectId?: string;
    collectionId?: string;
};

export type Budget = {
    timeoutMs: number;
    maxCalls: number;
};

export type CoverageEstimate = {
    evaluationUnit: 'claim' | 'subquestion' | 'source';
    scoreRange: '0..1' | '0..100';
    value: number;
    computationBasis: string[];
    comparableAcrossVersions: boolean;
    adapterVersion: string;
};

export type EvidenceItem = {
    evidenceId: string;
    claimText: string;
    sourceRef: string;
    provenancePathRef: string[];
    retrievalReason: string;
    confidenceScore: number;
    confidenceMethodId: string;
    retrievedAt: string;
    collectionScope: string;
    adapterVersion: string;
};

export type EvidenceBundle = {
    bundleId: string;
    queryIntent: string;
    items: EvidenceItem[];
    coverageEstimate: CoverageEstimate;
    conflictSignals: string[];
    traceRefs: string[];
    scopeTuple: ScopeTuple;
    adapterVersion: string;
};

export type ScopeValidationResult =
    | { ok: true; normalizedScope: ScopeTuple }
    | {
          ok: false;
          reasonCode: 'external_scope_validation_failed';
          details: string;
      };

export interface TrustGraphEvidenceAdapter {
    getEvidenceBundle(input: {
        queryIntent: string;
        scopeTuple: ScopeTuple;
        budget: Budget;
        abortSignal?: AbortSignal;
    }): Promise<EvidenceBundle>;
}

export interface ScopeValidator {
    validateScope(input: ScopeTuple): Promise<ScopeValidationResult>;
}

export type TrustGraphOwnershipValidationMode = 'required' | 'explicitly_none';

export type OwnershipBypassJustificationCode =
    | 'benchmark_harness'
    | 'unit_test'
    | 'local_dev_manual';

export class TrustGraphOwnershipBypassCapability {
    public readonly capabilitySource: 'benchmark_harness' | 'integration_test';

    private constructor(
        capabilitySource: 'benchmark_harness' | 'integration_test'
    ) {
        this.capabilitySource = capabilitySource;
        Object.freeze(this);
    }

    public static forBenchmarkHarness(): TrustGraphOwnershipBypassCapability {
        return new TrustGraphOwnershipBypassCapability('benchmark_harness');
    }

    public static forIntegrationTest(): TrustGraphOwnershipBypassCapability {
        return new TrustGraphOwnershipBypassCapability('integration_test');
    }
}

export class TrustGraphOwnershipValidationPolicy {
    public readonly mode: TrustGraphOwnershipValidationMode;
    public readonly justificationCode?: OwnershipBypassJustificationCode;
    public readonly policySource:
        | 'trusted_backend_policy'
        | 'untrusted_callsite';
    public readonly policyId: string;
    public readonly bypassCapability?: TrustGraphOwnershipBypassCapability;

    private constructor(input: {
        mode: TrustGraphOwnershipValidationMode;
        policySource: 'trusted_backend_policy' | 'untrusted_callsite';
        policyId: string;
        justificationCode?: OwnershipBypassJustificationCode;
        bypassCapability?: TrustGraphOwnershipBypassCapability;
    }) {
        this.mode = input.mode;
        this.policySource = input.policySource;
        this.policyId = input.policyId;
        this.justificationCode = input.justificationCode;
        this.bypassCapability = input.bypassCapability;
        Object.freeze(this);
    }

    public static required(input: {
        policyId: string;
        policySource?: 'trusted_backend_policy' | 'untrusted_callsite';
    }): TrustGraphOwnershipValidationPolicy {
        return new TrustGraphOwnershipValidationPolicy({
            mode: 'required',
            policySource: input.policySource ?? 'trusted_backend_policy',
            policyId: input.policyId,
        });
    }

    public static explicitlyNoneForNonProduction(input: {
        policyId: string;
        justificationCode: OwnershipBypassJustificationCode;
        bypassCapability: TrustGraphOwnershipBypassCapability;
    }): TrustGraphOwnershipValidationPolicy {
        return new TrustGraphOwnershipValidationPolicy({
            mode: 'explicitly_none',
            policySource: 'trusted_backend_policy',
            policyId: input.policyId,
            justificationCode: input.justificationCode,
            bypassCapability: input.bypassCapability,
        });
    }
}

export type ExternalArtifactJoin = {
    externalEvidenceBundleId: string;
    externalTraceRefs: string[];
    adapterVersion: string;
    consumedGovernedFieldPaths: string[];
    consumedByConsumers: MappingRegistryConsumer[];
    droppedEvidenceIds: string[];
    reasonCodes: TrustGraphProvenanceReasonCode[];
};

export type MappingRegistryConsumer = 'P_SUFF' | 'P_EVID';

export type TrustGraphPredicateConsumer =
    | MappingRegistryConsumer
    | 'P_VER'
    | 'P_POLICY'
    | 'P_BUDGET';

export type LocalTerminalOutcome = 'complete' | 'degraded' | 'stopped';

export type TrustGraphAdapterStatus =
    | 'off'
    | 'scope_denied'
    | 'success'
    | 'timeout'
    | 'error';

export type TrustGraphProvenanceReasonCode =
    | 'external_scope_validation_failed'
    | 'adapter_scope_mismatch'
    | 'adapter_disabled'
    | 'adapter_timeout'
    | 'adapter_timeout_cancellation_requested'
    | 'adapter_error'
    | 'adapter_processing_failed'
    | 'poisoned_evidence_dropped'
    | 'aggregate_signals_neutralized_after_filtering'
    | 'ownership_validation_explicitly_none_denied'
    | 'ownership_validation_explicitly_none_allowed_non_production';

export type TrustGraphConsumerEvidenceView = {
    consumer: MappingRegistryConsumer;
    coverageValue?: number;
    coverageEvaluationUnit?: CoverageEstimate['evaluationUnit'];
    conflictSignals: string[];
    sourceRefs: string[];
    provenancePathRefs: string[];
    traceRefs: string[];
};

export type TrustGraphMappingRegistryEntry = {
    path: string;
    consumers: readonly MappingRegistryConsumer[];
    notes: string;
};

export type GovernedPredicateViews = Record<
    MappingRegistryConsumer,
    TrustGraphConsumerEvidenceView
>;

export type TrustGraphEvidenceIngestionResult = {
    adapterStatus: TrustGraphAdapterStatus;
    scopeValidation: ScopeValidationResult;
    localTerminalOutcome: LocalTerminalOutcome;
    terminalAuthority: 'backend_execution_contract';
    failOpenBehavior: 'local_behavior';
    verificationRequired: true;
    advisoryEvidenceItemCount: number;
    droppedEvidenceCount: number;
    droppedEvidenceIds: string[];
    provenanceReasonCodes: TrustGraphProvenanceReasonCode[];
    predicateViews: GovernedPredicateViews;
    provenanceJoin?: ExternalArtifactJoin;
};

export type TrustGraphScopeOwnershipValidationResult =
    | {
          decision: 'allow';
          validatorId: string;
          checkedAt: string;
          evidence: string[];
      }
    | {
          decision: 'deny';
          validatorId: string;
          checkedAt: string;
          denialReason:
              | 'tenant_mismatch'
              | 'scope_not_found'
              | 'validator_error'
              | 'insufficient_data';
          details: string;
          evidence: string[];
      };

export interface ScopeOwnershipValidator {
    readonly validatorSource:
        | 'backend_tenancy_service'
        | 'custom_untrusted_validator';
    readonly validatorId: string;
    validateOwnership(
        input: ScopeTuple,
        options?: {
            abortSignal?: AbortSignal;
        }
    ): Promise<TrustGraphScopeOwnershipValidationResult>;
}
