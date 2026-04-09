/**
 * @description: Builds explicit prototype provenance joins between Execution Contract steps and external evidence artifacts.
 * Join metadata keeps external advisory context reviewer-readable and auditable.
 * @footnote-scope: core
 * @footnote-module: ExecutionContractTrustGraphProvenanceJoin
 * @footnote-risk: medium - Missing join linkage can break traceability of external evidence influence.
 * @footnote-ethics: high - Provenance joins are core to accountability and post-hoc review integrity.
 */

import type {
    EvidenceBundle,
    ExternalArtifactJoin,
    MappingRegistryConsumer,
    TrustGraphProvenanceReasonCode,
} from './trustGraphEvidenceTypes.js';

export type TrustGraphProvenanceJoinRecord = {
    join: ExternalArtifactJoin;
    reasonCodes: TrustGraphProvenanceReasonCode[];
};

export const createTrustGraphProvenanceJoin = (input: {
    bundle: EvidenceBundle;
    consumedGovernedFieldPaths: string[];
    consumedByConsumers: MappingRegistryConsumer[];
    droppedEvidenceIds: string[];
    reasonCodes: TrustGraphProvenanceReasonCode[];
}): TrustGraphProvenanceJoinRecord => ({
    join: {
        externalEvidenceBundleId: input.bundle.bundleId,
        externalTraceRefs: input.bundle.traceRefs,
        adapterVersion: input.bundle.adapterVersion,
        consumedGovernedFieldPaths: input.consumedGovernedFieldPaths,
        consumedByConsumers: input.consumedByConsumers,
        droppedEvidenceIds: input.droppedEvidenceIds,
        reasonCodes: input.reasonCodes,
    },
    reasonCodes: input.reasonCodes,
});
