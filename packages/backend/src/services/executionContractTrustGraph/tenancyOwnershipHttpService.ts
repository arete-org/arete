/**
 * @description: Implements backend tenancy ownership checks through a production HTTP service boundary.
 * The service returns authoritative ownership decisions that feed required external scope validation.
 * @footnote-scope: interface
 * @footnote-module: ExecutionContractTenancyOwnershipHttpService
 * @footnote-risk: high - Weak validation here can silently permit cross-tenant external retrieval access.
 * @footnote-ethics: high - Ownership validation correctness is a core tenant-isolation guarantee.
 */

import type { ScopeTuple } from './trustGraphEvidenceTypes.js';
import type { BackendTenancyOwnershipService } from './tenancyOwnershipValidator.js';

type BackendTenancyOwnershipHttpServiceConfig = {
    endpointUrl: string;
    apiToken?: string | null;
    timeoutMs?: number;
};

const isString = (value: unknown): value is string => typeof value === 'string';
const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');

const validateResponseShape = (
    payload: unknown
): Awaited<
    ReturnType<BackendTenancyOwnershipService['validateScopeOwnership']>
> => {
    if (typeof payload !== 'object' || payload === null) {
        throw new Error('tenancy_ownership_invalid_response_payload');
    }
    const record = payload as Record<string, unknown>;

    if (typeof record.owned !== 'boolean') {
        throw new Error('tenancy_ownership_invalid_owned');
    }
    if (!isString(record.checkedAt)) {
        throw new Error('tenancy_ownership_invalid_checkedAt');
    }
    if (!isStringArray(record.evidence) || record.evidence.length === 0) {
        throw new Error('tenancy_ownership_invalid_evidence');
    }

    if (record.owned) {
        return {
            owned: true,
            checkedAt: record.checkedAt,
            evidence: record.evidence,
        };
    }

    const denialReason = record.denialReason;
    if (
        denialReason !== undefined &&
        denialReason !== 'tenant_mismatch' &&
        denialReason !== 'scope_not_found' &&
        denialReason !== 'validator_error' &&
        denialReason !== 'insufficient_data'
    ) {
        throw new Error('tenancy_ownership_invalid_denial_reason');
    }

    return {
        owned: false,
        checkedAt: record.checkedAt,
        evidence: record.evidence,
        denialReason,
        details: isString(record.details) ? record.details : undefined,
    };
};

export class BackendTenancyOwnershipHttpService implements BackendTenancyOwnershipService {
    private readonly endpointUrl: string;
    private readonly apiToken: string | null;
    private readonly timeoutMs: number;

    public constructor(config: BackendTenancyOwnershipHttpServiceConfig) {
        this.endpointUrl = config.endpointUrl;
        this.apiToken = config.apiToken ?? null;
        this.timeoutMs = Math.max(1, Math.floor(config.timeoutMs ?? 800));
    }

    public async validateScopeOwnership(
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
    }> {
        const timeoutController = new AbortController();
        const forwardedAbortSignal = options?.abortSignal;
        let timeoutHandle: NodeJS.Timeout | undefined;
        let timeoutTriggered = false;
        let forwardedAbortTriggered = false;

        const handleForwardedAbort = () => {
            forwardedAbortTriggered = true;
            timeoutController.abort();
        };

        try {
            if (forwardedAbortSignal?.aborted) {
                throw new Error('ownership_validator_aborted');
            }
            forwardedAbortSignal?.addEventListener(
                'abort',
                handleForwardedAbort,
                { once: true }
            );
            timeoutHandle = setTimeout(() => {
                timeoutTriggered = true;
                timeoutController.abort();
            }, this.timeoutMs);

            const response = await fetch(this.endpointUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(this.apiToken !== null && {
                        Authorization: `Bearer ${this.apiToken}`,
                    }),
                },
                body: JSON.stringify({
                    scopeTuple: input,
                }),
                signal: timeoutController.signal,
            });

            if (!response.ok) {
                throw new Error(
                    `tenancy_ownership_http_status_${response.status}`
                );
            }

            const payload = (await response.json()) as unknown;
            return validateResponseShape(payload);
        } catch (error: unknown) {
            if (timeoutTriggered) {
                throw new Error('ownership_validator_timeout', {
                    cause: error,
                });
            }
            if (
                forwardedAbortTriggered ||
                (error instanceof Error && error.name === 'AbortError')
            ) {
                throw new Error('ownership_validator_aborted', {
                    cause: error,
                });
            }
            throw error;
        } finally {
            forwardedAbortSignal?.removeEventListener(
                'abort',
                handleForwardedAbort
            );
            if (timeoutHandle !== undefined) {
                clearTimeout(timeoutHandle);
            }
        }
    }
}

export const createBackendTenancyOwnershipHttpService = (
    config: BackendTenancyOwnershipHttpServiceConfig
): BackendTenancyOwnershipService =>
    new BackendTenancyOwnershipHttpService(config);
