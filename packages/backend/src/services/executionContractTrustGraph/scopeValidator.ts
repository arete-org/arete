/**
 * @description: Validates external retrieval scope for the TrustGraph prototype before adapter calls.
 * Scope failures deny external retrieval and preserve backend fail-open local behavior.
 * @footnote-scope: core
 * @footnote-module: ExecutionContractTrustGraphScopeValidator
 * @footnote-risk: medium - Weak scope checks can expand retrieval tenancy and violate policy boundaries.
 * @footnote-ethics: high - Scope safety directly impacts data governance and cross-tenant exposure risk.
 */

import type {
    TrustGraphOwnershipValidationMode,
    ScopeOwnershipValidator,
    ScopeTuple,
    TrustGraphScopeOwnershipValidationResult,
    ScopeValidationResult,
    ScopeValidator,
} from './trustGraphEvidenceTypes.js';

const OWNERSHIP_VALIDATOR_TIMEOUT_ERROR = 'ownership_validator_timeout';
const OWNERSHIP_VALIDATOR_ABORTED_ERROR = 'ownership_validator_aborted';

const normalizeOptionalScopeField = (
    value: string | undefined
): string | undefined => {
    if (value === undefined) {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const isIsoTimestamp = (value: string): boolean => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed);
};

type OwnershipDenyReason = Extract<
    TrustGraphScopeOwnershipValidationResult,
    { decision: 'deny' }
>['denialReason'];

const ALLOWED_DENIAL_REASONS: ReadonlySet<OwnershipDenyReason> = new Set([
    'tenant_mismatch',
    'scope_not_found',
    'validator_error',
    'insufficient_data',
]);

const normalizeOwnershipValidationResult = (
    result: TrustGraphScopeOwnershipValidationResult
):
    | { ok: true }
    | {
          ok: false;
          details: string;
      } => {
    if (typeof result !== 'object' || result === null) {
        return {
            ok: false,
            details: 'Ownership validator returned a non-object result.',
        };
    }
    if (!('decision' in result)) {
        return {
            ok: false,
            details: 'Ownership validator result is missing decision.',
        };
    }
    if (
        typeof result.validatorId !== 'string' ||
        result.validatorId.trim().length === 0
    ) {
        return {
            ok: false,
            details: 'Ownership validator result is missing validatorId.',
        };
    }
    if (
        typeof result.checkedAt !== 'string' ||
        !isIsoTimestamp(result.checkedAt)
    ) {
        return {
            ok: false,
            details:
                'Ownership validator result has invalid checkedAt timestamp.',
        };
    }
    if (
        !Array.isArray(result.evidence) ||
        result.evidence.length === 0 ||
        result.evidence.some(
            (item) => typeof item !== 'string' || item.trim().length === 0
        )
    ) {
        return {
            ok: false,
            details: 'Ownership validator result has invalid evidence list.',
        };
    }
    if (result.decision === 'allow') {
        return { ok: true };
    }
    if (result.decision === 'deny') {
        if (!ALLOWED_DENIAL_REASONS.has(result.denialReason)) {
            return {
                ok: false,
                details:
                    'Ownership validator deny result has unsupported denialReason.',
            };
        }
        if (
            typeof result.details !== 'string' ||
            result.details.trim().length === 0
        ) {
            return {
                ok: false,
                details:
                    'Ownership validator deny result is missing human-readable details.',
            };
        }
        return {
            ok: false,
            details: `${result.denialReason}: ${result.details.trim()}`,
        };
    }
    return {
        ok: false,
        details: 'Ownership validator result contains unsupported decision.',
    };
};

const invokeOwnershipValidatorWithTimeout = async (input: {
    ownershipValidator: ScopeOwnershipValidator;
    scopeTuple: ScopeTuple;
    timeoutMs: number;
}): Promise<TrustGraphScopeOwnershipValidationResult> => {
    const timeoutMs = Math.max(1, Math.floor(input.timeoutMs));
    const abortController = new AbortController();
    let timeoutHandle: NodeJS.Timeout | undefined;
    let timeoutTriggered = false;

    try {
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
                timeoutTriggered = true;
                abortController.abort();
                reject(new Error(OWNERSHIP_VALIDATOR_TIMEOUT_ERROR));
            }, timeoutMs);
        });

        const ownershipResult = await Promise.race([
            input.ownershipValidator.validateOwnership(input.scopeTuple, {
                abortSignal: abortController.signal,
            }),
            timeoutPromise,
        ]);

        return ownershipResult;
    } catch (error: unknown) {
        if (timeoutTriggered) {
            throw new Error(OWNERSHIP_VALIDATOR_TIMEOUT_ERROR);
        }

        if (
            error instanceof Error &&
            error.message === OWNERSHIP_VALIDATOR_ABORTED_ERROR
        ) {
            throw error;
        }

        throw error;
    } finally {
        if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
        }
    }
};

export type ScopeValidationPolicy = {
    requireProjectOrCollection: boolean;
    allowProjectAndCollectionTogether: boolean;
    ownershipValidationMode: TrustGraphOwnershipValidationMode;
    ownershipValidationTimeoutMs?: number;
};

export const DEFAULT_SCOPE_VALIDATION_POLICY: ScopeValidationPolicy = {
    requireProjectOrCollection: true,
    allowProjectAndCollectionTogether: false,
    ownershipValidationMode: 'required',
    ownershipValidationTimeoutMs: 800,
};

export class TrustGraphScopeValidator implements ScopeValidator {
    private readonly policy: ScopeValidationPolicy;
    private readonly ownershipValidator?: ScopeOwnershipValidator;

    public constructor(
        input:
            | ScopeValidationPolicy
            | {
                  policy?: ScopeValidationPolicy;
                  ownershipValidator?: ScopeOwnershipValidator;
              } = DEFAULT_SCOPE_VALIDATION_POLICY
    ) {
        if ('requireProjectOrCollection' in input) {
            this.policy = input;
            this.ownershipValidator = undefined;
            return;
        }

        this.policy = input.policy ?? DEFAULT_SCOPE_VALIDATION_POLICY;
        this.ownershipValidator = input.ownershipValidator;
    }

    public async validateScope(
        input: ScopeTuple
    ): Promise<ScopeValidationResult> {
        const fieldPattern = /^[a-zA-Z0-9._:-]{1,128}$/;
        const normalizedUserId = input.userId.trim();
        const normalizedProjectId = normalizeOptionalScopeField(
            input.projectId
        );
        const normalizedCollectionId = normalizeOptionalScopeField(
            input.collectionId
        );

        if (normalizedUserId.length === 0) {
            return {
                ok: false,
                reasonCode: 'external_scope_validation_failed',
                details: 'Missing userId in external retrieval scope.',
            };
        }
        if (!fieldPattern.test(normalizedUserId)) {
            return {
                ok: false,
                reasonCode: 'external_scope_validation_failed',
                details: 'Invalid userId format in external retrieval scope.',
            };
        }
        if (
            normalizedProjectId !== undefined &&
            !fieldPattern.test(normalizedProjectId)
        ) {
            return {
                ok: false,
                reasonCode: 'external_scope_validation_failed',
                details:
                    'Invalid projectId format in external retrieval scope.',
            };
        }
        if (
            normalizedCollectionId !== undefined &&
            !fieldPattern.test(normalizedCollectionId)
        ) {
            return {
                ok: false,
                reasonCode: 'external_scope_validation_failed',
                details:
                    'Invalid collectionId format in external retrieval scope.',
            };
        }

        if (
            this.policy.requireProjectOrCollection &&
            normalizedProjectId === undefined &&
            normalizedCollectionId === undefined
        ) {
            return {
                ok: false,
                reasonCode: 'external_scope_validation_failed',
                details:
                    'Scope must include projectId or collectionId for external retrieval.',
            };
        }
        if (
            !this.policy.allowProjectAndCollectionTogether &&
            normalizedProjectId !== undefined &&
            normalizedCollectionId !== undefined
        ) {
            return {
                ok: false,
                reasonCode: 'external_scope_validation_failed',
                details:
                    'Ambiguous scope tuple: projectId and collectionId cannot both be set.',
            };
        }
        if (
            normalizedProjectId !== undefined &&
            normalizedCollectionId !== undefined &&
            normalizedProjectId === normalizedCollectionId
        ) {
            return {
                ok: false,
                reasonCode: 'external_scope_validation_failed',
                details:
                    'Conflicting scope tuple: projectId and collectionId must refer to distinct namespaces.',
            };
        }

        const normalizedScope: ScopeTuple = {
            userId: normalizedUserId,
            ...(normalizedProjectId !== undefined && {
                projectId: normalizedProjectId,
            }),
            ...(normalizedCollectionId !== undefined && {
                collectionId: normalizedCollectionId,
            }),
        };

        if (
            this.policy.ownershipValidationMode === 'required' &&
            this.ownershipValidator === undefined
        ) {
            return {
                ok: false,
                reasonCode: 'external_scope_validation_failed',
                details:
                    'Ownership validation required but validator is not configured.',
            };
        }
        if (
            this.policy.ownershipValidationMode === 'required' &&
            this.ownershipValidator !== undefined
        ) {
            if (
                this.ownershipValidator.validatorSource !==
                'backend_tenancy_service'
            ) {
                return {
                    ok: false,
                    reasonCode: 'external_scope_validation_failed',
                    details:
                        'Ownership validation required but validator source is not trusted backend tenancy service.',
                };
            }
            let ownershipResult: TrustGraphScopeOwnershipValidationResult;
            try {
                ownershipResult = await invokeOwnershipValidatorWithTimeout({
                    ownershipValidator: this.ownershipValidator,
                    scopeTuple: normalizedScope,
                    timeoutMs:
                        this.policy.ownershipValidationTimeoutMs ??
                        DEFAULT_SCOPE_VALIDATION_POLICY.ownershipValidationTimeoutMs ??
                        800,
                });
            } catch (error: unknown) {
                if (
                    error instanceof Error &&
                    error.message === OWNERSHIP_VALIDATOR_TIMEOUT_ERROR
                ) {
                    return {
                        ok: false,
                        reasonCode: 'external_scope_validation_failed',
                        details:
                            'validator_error: Ownership validator timed out before a decision was returned.',
                    };
                }
                if (
                    error instanceof Error &&
                    error.message === OWNERSHIP_VALIDATOR_ABORTED_ERROR
                ) {
                    return {
                        ok: false,
                        reasonCode: 'external_scope_validation_failed',
                        details:
                            'validator_error: Ownership validator request was aborted before completion.',
                    };
                }
                const errorMessage =
                    error instanceof Error
                        ? error.message
                        : 'Unknown ownership validator error.';
                return {
                    ok: false,
                    reasonCode: 'external_scope_validation_failed',
                    details: `validator_error: Ownership validator threw an error (${errorMessage}).`,
                };
            }
            const ownership =
                normalizeOwnershipValidationResult(ownershipResult);
            if (!ownership.ok) {
                return {
                    ok: false,
                    reasonCode: 'external_scope_validation_failed',
                    details: ownership.details,
                };
            }
        }

        return {
            ok: true,
            normalizedScope,
        };
    }
}

export const validateTrustGraphScope = (
    input: ScopeTuple,
    policy: ScopeValidationPolicy = DEFAULT_SCOPE_VALIDATION_POLICY
): Promise<ScopeValidationResult> =>
    new TrustGraphScopeValidator(policy).validateScope(input);
