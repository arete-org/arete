/**
 * @description: Adapts backend tenancy ownership lookups into the TrustGraph scope ownership validator contract.
 * This provides one canonical integration seam for authoritative user/project/collection ownership checks.
 * @footnote-scope: interface
 * @footnote-module: ExecutionContractTenancyOwnershipValidator
 * @footnote-risk: medium - Weak tenancy adapters can allow cross-tenant scope access during external retrieval.
 * @footnote-ethics: high - Ownership validation quality directly affects tenant isolation and governance.
 */

import type {
    ScopeOwnershipValidator,
    ScopeTuple,
    TrustGraphScopeOwnershipValidationResult,
} from './trustGraphEvidenceTypes.js';

export interface BackendTenancyOwnershipService {
    validateScopeOwnership(
        input: ScopeTuple,
        options?: {
            abortSignal?: AbortSignal;
        }
    ): Promise<{
        owned: boolean;
        checkedAt: string;
        evidence: string[];
        denialReason?:
            | 'tenant_mismatch'
            | 'scope_not_found'
            | 'validator_error'
            | 'insufficient_data';
        details?: string;
    }>;
}

export const createScopeOwnershipValidatorFromTenancyService = (input: {
    validatorId: string;
    service: BackendTenancyOwnershipService;
}): ScopeOwnershipValidator => ({
    validatorSource: 'backend_tenancy_service',
    validatorId: input.validatorId,
    async validateOwnership(
        scope: ScopeTuple,
        options?: {
            abortSignal?: AbortSignal;
        }
    ): Promise<TrustGraphScopeOwnershipValidationResult> {
        const decision = await input.service.validateScopeOwnership(scope, {
            abortSignal: options?.abortSignal,
        });
        if (decision.owned) {
            return {
                decision: 'allow',
                validatorId: input.validatorId,
                checkedAt: decision.checkedAt,
                evidence: decision.evidence,
            };
        }

        return {
            decision: 'deny',
            validatorId: input.validatorId,
            checkedAt: decision.checkedAt,
            denialReason: decision.denialReason ?? 'validator_error',
            details:
                decision.details ??
                'Scope ownership validation failed without details.',
            evidence: decision.evidence,
        };
    },
});
