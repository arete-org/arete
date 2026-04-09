/**
 * @description: Implements governed prototype field mapping from adapter outputs to Execution Contract predicates.
 * Only explicitly registered fields can be consumed by P_SUFF and P_EVID.
 * @footnote-scope: core
 * @footnote-module: ExecutionContractTrustGraphMappingRegistry
 * @footnote-risk: medium - Registry mistakes can leak unauthorized adapter signals into Execution Contract predicate paths.
 * @footnote-ethics: high - Field governance prevents opaque confidence/ranking shortcuts from bypassing verification.
 */

import type {
    EvidenceBundle,
    MappingRegistryConsumer,
    TrustGraphConsumerEvidenceView,
    TrustGraphMappingRegistryEntry,
} from './trustGraphEvidenceTypes.js';

export const TRUST_GRAPH_APPROVED_PREDICATE_CONSUMERS: readonly MappingRegistryConsumer[] =
    Object.freeze(['P_SUFF', 'P_EVID']);

const TRUST_GRAPH_APPROVED_FIELDS_SEED: readonly TrustGraphMappingRegistryEntry[] =
    [
        {
            path: 'coverageEstimate.value',
            consumers: Object.freeze(['P_SUFF']),
            notes: 'Policy-relevant only through explicit Execution Contract mapping rules.',
        },
        {
            path: 'coverageEstimate.evaluationUnit',
            consumers: Object.freeze(['P_SUFF']),
            notes: 'Must be interpreted with scoreRange and adapterVersion.',
        },
        {
            path: 'conflictSignals',
            consumers: Object.freeze(['P_SUFF', 'P_EVID']),
            notes: 'Advisory only.',
        },
        {
            path: 'items[].sourceRef',
            consumers: Object.freeze(['P_EVID']),
            notes: 'Used for evidence traceability.',
        },
        {
            path: 'items[].provenancePathRef',
            consumers: Object.freeze(['P_EVID']),
            notes: 'Used for provenance reviewability.',
        },
        {
            path: 'traceRefs',
            consumers: Object.freeze(['P_EVID']),
            notes: 'Artifact linkage only.',
        },
    ];

export const TRUST_GRAPH_APPROVED_FIELDS: readonly TrustGraphMappingRegistryEntry[] =
    Object.freeze(
        TRUST_GRAPH_APPROVED_FIELDS_SEED.map((entry) => Object.freeze(entry))
    );

export const TRUST_GRAPH_FORBIDDEN_DIRECT_CONTROL_FIELDS: readonly string[] =
    Object.freeze([
        'confidenceScore',
        'items[].confidenceScore',
        'anyRawAdapterRanking',
        'anyUnregisteredField',
    ]);

export const isTrustedFieldApprovedForConsumer = (
    path: string,
    consumer: MappingRegistryConsumer
): boolean =>
    TRUST_GRAPH_APPROVED_FIELDS.some(
        (entry) => entry.path === path && entry.consumers.includes(consumer)
    );

const collectUniqueNonEmptyStrings = (values: string[]): string[] => {
    const seen = new Set<string>();
    for (const value of values) {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
            seen.add(trimmed);
        }
    }
    return [...seen];
};

export const buildTrustGraphConsumerView = (
    consumer: MappingRegistryConsumer,
    bundle: EvidenceBundle
): TrustGraphConsumerEvidenceView => {
    const conflictSignals = isTrustedFieldApprovedForConsumer(
        'conflictSignals',
        consumer
    )
        ? collectUniqueNonEmptyStrings(bundle.conflictSignals)
        : [];
    const traceRefs = isTrustedFieldApprovedForConsumer('traceRefs', consumer)
        ? collectUniqueNonEmptyStrings(bundle.traceRefs)
        : [];
    const sourceRefs = isTrustedFieldApprovedForConsumer(
        'items[].sourceRef',
        consumer
    )
        ? collectUniqueNonEmptyStrings(
              bundle.items.map((item) => item.sourceRef)
          )
        : [];
    const provenancePathRefs = isTrustedFieldApprovedForConsumer(
        'items[].provenancePathRef',
        consumer
    )
        ? collectUniqueNonEmptyStrings(
              bundle.items.flatMap((item) => item.provenancePathRef)
          )
        : [];

    const view: TrustGraphConsumerEvidenceView = {
        consumer,
        conflictSignals,
        sourceRefs,
        provenancePathRefs,
        traceRefs,
    };

    if (isTrustedFieldApprovedForConsumer('coverageEstimate.value', consumer)) {
        view.coverageValue = bundle.coverageEstimate.value;
    }
    if (
        isTrustedFieldApprovedForConsumer(
            'coverageEstimate.evaluationUnit',
            consumer
        )
    ) {
        view.coverageEvaluationUnit = bundle.coverageEstimate.evaluationUnit;
    }

    return view;
};

export const buildTrustGraphConsumerViews = (
    bundle: EvidenceBundle
): Record<MappingRegistryConsumer, TrustGraphConsumerEvidenceView> => ({
    P_SUFF: buildTrustGraphConsumerView('P_SUFF', bundle),
    P_EVID: buildTrustGraphConsumerView('P_EVID', bundle),
});

export const listTrustGraphApprovedFieldPaths = (): readonly string[] =>
    Object.freeze(TRUST_GRAPH_APPROVED_FIELDS.map((entry) => entry.path));
