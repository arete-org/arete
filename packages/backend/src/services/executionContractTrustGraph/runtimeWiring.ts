/**
 * @description: Resolves runtime TrustGraph integration wiring from config into chat-service options.
 * This centralizes enable/kill-switch policy, adapter binding, and tenancy ownership validator binding.
 * @footnote-scope: core
 * @footnote-module: ExecutionContractTrustGraphRuntimeWiring
 * @footnote-risk: high - Miswiring here can either disable retrieval silently or weaken retrieval safety boundaries.
 * @footnote-ethics: high - Runtime wiring choices govern tenancy checks and advisory-evidence behavior in production.
 */

import type { RuntimeConfig } from '../../config/types.js';
import type { CreateChatServiceOptions } from '../chatService.js';
import { logger } from '../../utils/logger.js';
import { createScopeOwnershipValidatorFromTenancyService } from './tenancyOwnershipValidator.js';
import { createBackendTenancyOwnershipHttpService } from './tenancyOwnershipHttpService.js';
import { createHttpTrustGraphEvidenceAdapter } from './trustGraphHttpAdapter.js';
import { StubTrustGraphEvidenceAdapter } from './trustGraphEvidenceAdapter.js';
import { TrustGraphOwnershipValidationPolicy } from './trustGraphEvidenceTypes.js';

type ExecutionContractTrustGraphRuntimeConfig =
    RuntimeConfig['executionContractTrustGraph'];

const isNonEmptyString = (value: string | null): value is string =>
    typeof value === 'string' && value.trim().length > 0;

const requireHttpAdapterConfig = (input: {
    endpointUrl: string | null;
    apiToken: string | null;
}): { endpointUrl: string; apiToken: string } => {
    if (!isNonEmptyString(input.endpointUrl)) {
        throw new Error(
            'execution_contract_trustgraph_http_adapter_missing_endpoint'
        );
    }
    if (!isNonEmptyString(input.apiToken)) {
        throw new Error(
            'execution_contract_trustgraph_http_adapter_missing_api_token'
        );
    }

    return {
        endpointUrl: input.endpointUrl,
        apiToken: input.apiToken,
    };
};

export const resolveExecutionContractTrustGraphRuntimeOptions = (
    config: ExecutionContractTrustGraphRuntimeConfig
): CreateChatServiceOptions['executionContractTrustGraph'] | undefined => {
    if (!config.enabled) {
        logger.info({
            event: 'chat.execution_contract_trustgraph.runtime_disabled',
            reasonCode: 'disabled_by_config',
        });
        return undefined;
    }

    if (config.killSwitchExternalRetrieval) {
        logger.warn({
            event: 'chat.execution_contract_trustgraph.runtime_disabled',
            reasonCode: 'kill_switch_active',
        });
        return undefined;
    }

    const ownershipValidationPolicy =
        TrustGraphOwnershipValidationPolicy.required({
            policyId: config.policyId,
        });

    let adapter: NonNullable<
        CreateChatServiceOptions['executionContractTrustGraph']
    >['adapter'];
    if (config.adapter.mode === 'http') {
        const adapterConfig = requireHttpAdapterConfig({
            endpointUrl: config.adapter.endpointUrl,
            apiToken: config.adapter.apiToken,
        });
        adapter = createHttpTrustGraphEvidenceAdapter({
            endpointUrl: adapterConfig.endpointUrl,
            apiToken: adapterConfig.apiToken,
            configRef: config.adapter.configRef,
        });
    } else if (config.adapter.mode === 'stub') {
        adapter = new StubTrustGraphEvidenceAdapter(config.adapter.stubMode);
    } else {
        adapter = undefined;
    }

    let scopeOwnershipValidator:
        | CreateChatServiceOptions['executionContractTrustGraph']['scopeOwnershipValidator']
        | undefined;
    if (config.ownership.bindingMode === 'http') {
        if (!isNonEmptyString(config.ownership.endpointUrl)) {
            logger.warn({
                event: 'chat.execution_contract_trustgraph.ownership_wiring',
                reasonCode: 'ownership_http_missing_endpoint',
                ownershipBindingMode: config.ownership.bindingMode,
            });
            scopeOwnershipValidator = undefined;
        } else {
            const tenancyService = createBackendTenancyOwnershipHttpService({
                endpointUrl: config.ownership.endpointUrl,
                apiToken: config.ownership.apiToken,
                timeoutMs: config.timeoutMs,
            });
            scopeOwnershipValidator =
                createScopeOwnershipValidatorFromTenancyService({
                    validatorId: config.ownership.validatorId,
                    service: tenancyService,
                });
        }
    } else {
        scopeOwnershipValidator = undefined;
    }

    logger.info({
        event: 'chat.execution_contract_trustgraph.runtime_wiring',
        enabled: true,
        adapterMode: config.adapter.mode,
        adapterConfigured: adapter !== undefined,
        adapterConfigRef: config.adapter.configRef,
        ownershipBindingMode: config.ownership.bindingMode,
        ownershipValidatorConfigured: scopeOwnershipValidator !== undefined,
        policyId: config.policyId,
    });

    return {
        adapter,
        budget: {
            timeoutMs: config.timeoutMs,
            maxCalls: config.maxCalls,
        },
        ownershipValidationPolicy,
        scopeValidationPolicy: {
            ownershipValidationTimeoutMs: config.timeoutMs,
        },
        scopeOwnershipValidator,
    };
};
