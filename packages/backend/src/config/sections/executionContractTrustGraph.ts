/**
 * @description: Builds Execution Contract TrustGraph runtime config for advisory external retrieval wiring.
 * This keeps runtime policy, adapter mode, tenancy binding, and kill-switch controls centralized.
 * @footnote-scope: utility
 * @footnote-module: ExecutionContractTrustGraphConfigSection
 * @footnote-risk: high - Misparsed TrustGraph runtime config can silently change external retrieval behavior.
 * @footnote-ethics: high - This config controls tenancy validation and advisory evidence governance boundaries.
 */

import {
    parseBooleanEnv,
    parseOptionalTrimmedString,
    parsePositiveIntEnv,
    parseStringUnionEnv,
} from '../parsers.js';
import type { RuntimeConfig, WarningSink } from '../types.js';

type AdapterMode =
    RuntimeConfig['executionContractTrustGraph']['adapter']['mode'];
type OwnershipBindingMode =
    RuntimeConfig['executionContractTrustGraph']['ownership']['bindingMode'];
type StubAdapterMode =
    RuntimeConfig['executionContractTrustGraph']['adapter']['stubMode'];

const ADAPTER_MODES: ReadonlySet<AdapterMode> = new Set([
    'none',
    'stub',
    'http',
]);
const OWNERSHIP_BINDING_MODES: ReadonlySet<OwnershipBindingMode> = new Set([
    'none',
    'http',
]);
const STUB_ADAPTER_MODES: ReadonlySet<StubAdapterMode> = new Set([
    'success',
    'failure',
    'timeout',
    'poisoned',
]);

/**
 * Resolves explicit runtime policy and connection settings for advisory
 * TrustGraph integration.
 */
export const buildExecutionContractTrustGraphSection = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): RuntimeConfig['executionContractTrustGraph'] => ({
    enabled: parseBooleanEnv(
        env.EXECUTION_CONTRACT_TRUSTGRAPH_ENABLED,
        false,
        'EXECUTION_CONTRACT_TRUSTGRAPH_ENABLED',
        warn
    ),
    killSwitchExternalRetrieval: parseBooleanEnv(
        env.EXECUTION_CONTRACT_TRUSTGRAPH_KILL_SWITCH,
        false,
        'EXECUTION_CONTRACT_TRUSTGRAPH_KILL_SWITCH',
        warn
    ),
    policyId:
        parseOptionalTrimmedString(
            env.EXECUTION_CONTRACT_TRUSTGRAPH_POLICY_ID
        ) ?? 'server_chat_runtime_policy',
    timeoutMs: parsePositiveIntEnv(
        env.EXECUTION_CONTRACT_TRUSTGRAPH_TIMEOUT_MS,
        800,
        'EXECUTION_CONTRACT_TRUSTGRAPH_TIMEOUT_MS',
        warn
    ),
    maxCalls: parsePositiveIntEnv(
        env.EXECUTION_CONTRACT_TRUSTGRAPH_MAX_CALLS,
        1,
        'EXECUTION_CONTRACT_TRUSTGRAPH_MAX_CALLS',
        warn
    ),
    adapter: {
        mode: parseStringUnionEnv<AdapterMode>(
            env.EXECUTION_CONTRACT_TRUSTGRAPH_ADAPTER_MODE,
            'none',
            'EXECUTION_CONTRACT_TRUSTGRAPH_ADAPTER_MODE',
            ADAPTER_MODES,
            warn
        ),
        endpointUrl: parseOptionalTrimmedString(
            env.EXECUTION_CONTRACT_TRUSTGRAPH_ADAPTER_ENDPOINT_URL
        ),
        apiToken: parseOptionalTrimmedString(
            env.EXECUTION_CONTRACT_TRUSTGRAPH_ADAPTER_API_TOKEN
        ),
        configRef: parseOptionalTrimmedString(
            env.EXECUTION_CONTRACT_TRUSTGRAPH_ADAPTER_CONFIG_REF
        ),
        stubMode: parseStringUnionEnv<StubAdapterMode>(
            env.EXECUTION_CONTRACT_TRUSTGRAPH_STUB_ADAPTER_MODE,
            'success',
            'EXECUTION_CONTRACT_TRUSTGRAPH_STUB_ADAPTER_MODE',
            STUB_ADAPTER_MODES,
            warn
        ),
    },
    ownership: {
        bindingMode: parseStringUnionEnv<OwnershipBindingMode>(
            env.EXECUTION_CONTRACT_TRUSTGRAPH_OWNERSHIP_BINDING_MODE,
            'none',
            'EXECUTION_CONTRACT_TRUSTGRAPH_OWNERSHIP_BINDING_MODE',
            OWNERSHIP_BINDING_MODES,
            warn
        ),
        validatorId:
            parseOptionalTrimmedString(
                env.EXECUTION_CONTRACT_TRUSTGRAPH_OWNERSHIP_VALIDATOR_ID
            ) ?? 'backend_tenancy_http_v1',
        endpointUrl: parseOptionalTrimmedString(
            env.EXECUTION_CONTRACT_TRUSTGRAPH_OWNERSHIP_ENDPOINT_URL
        ),
        apiToken: parseOptionalTrimmedString(
            env.EXECUTION_CONTRACT_TRUSTGRAPH_OWNERSHIP_API_TOKEN
        ),
    },
});
