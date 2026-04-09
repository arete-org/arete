/**
 * @description: Defines the canonical Execution Policy Contract (EPC) surface
 * for backend execution decisions and a small factory to build it safely.
 * @footnote-scope: interface
 * @footnote-module: ExecutionPolicyContract
 * @footnote-risk: medium - Contract drift here can fragment policy ownership and create inconsistent execution behavior.
 * @footnote-ethics: high - EPC governs fail-open behavior and policy authority, which directly impacts user outcomes and operator accountability.
 */

/**
 * EPC schema version. Keep this explicit so future breaking changes are easy to
 * identify in reviews and logs.
 */
export type ExecutionPolicyContractVersion = 'v1';

/**
 * Stable policy identifier.
 *
 * Built-in ids stay literal for autocomplete. String extension leaves room for
 * new ids before a registry is introduced.
 */
export type ExecutionPolicyContractId =
    | 'core-balanced'
    | 'core-generate-only'
    | (string & {});

/**
 * Core policy switches enforced by runtime transitions.
 *
 * Keep this focused on execution permissions, not workflow strategy details.
 */
export type ExecutionPolicyControls = {
    allowPlanning: boolean;
    allowToolUse: boolean;
    allowReplanning: boolean;
    allowGeneration: boolean;
    allowAssessment: boolean;
    allowRevision: boolean;
};

/**
 * Quantitative ceilings for one execution loop.
 */
export type ExecutionPolicyLimits = {
    maxWorkflowSteps: number;
    maxToolCalls: number;
    maxDeliberationCalls: number;
    maxTokensTotal: number;
    maxDurationMs: number;
};

/**
 * Fail-open behavior remains backend-owned and explicit.
 *
 * EPC carries policy intent only. Incident management and operator controls stay
 * outside this contract.
 */
export type ExecutionPolicyFailOpen = {
    authority: 'backend';
    allowFallbackGeneration: boolean;
    fallbackTemperature: 'deterministic';
};

/**
 * Model/capability routing intent that policy can declare.
 *
 * This is intentionally small and declarative so routing services can plug in
 * later without putting provider logic inside EPC.
 */
export type ExecutionPolicyRouting = {
    strategy: 'capability-first' | 'profile-first';
    capabilityTags: string[];
};

/**
 * TrustGraph integration seam metadata.
 *
 * TrustGraph remains evidence/provenance input. It is not a second policy
 * authority and cannot block execution through this field.
 */
export type ExecutionPolicyTrustGraphSeam = {
    evidenceMode: 'off' | 'advisory';
    canBlockExecution: false;
};

/**
 * Canonical internal Execution Policy Contract.
 *
 * EPC is the main execution-policy object. Workflow profiles can be represented
 * as presets over this contract, but EPC itself is a serializable data shape.
 */
export type ExecutionPolicyContract = {
    policyId: ExecutionPolicyContractId;
    policyVersion: ExecutionPolicyContractVersion;
    displayName: string;
    controls: ExecutionPolicyControls;
    limits: ExecutionPolicyLimits;
    failOpen: ExecutionPolicyFailOpen;
    routing: ExecutionPolicyRouting;
    trustGraph: ExecutionPolicyTrustGraphSeam;
    metadata?: Record<string, string | number | boolean | null>;
};

/**
 * Preset ids for reusable EPC defaults.
 *
 * A preset is not EPC itself. It is a named override set applied by the builder.
 */
export type ExecutionPolicyPresetId =
    | 'balanced'
    | 'generate-only'
    | (string & {});

/**
 * Named overrides that can be applied while building an EPC.
 */
export type ExecutionPolicyPreset = {
    presetId: ExecutionPolicyPresetId;
    displayName: string;
    overrides: Partial<
        Omit<
            ExecutionPolicyContract,
            'policyId' | 'policyVersion' | 'displayName'
        >
    >;
};

/**
 * Builder input for creating one EPC instance.
 */
export type ExecutionPolicyContractBuilderInput = {
    policyId: ExecutionPolicyContractId;
    displayName: string;
    preset?: ExecutionPolicyPreset;
    overrides?: Partial<
        Omit<
            ExecutionPolicyContract,
            'policyId' | 'policyVersion' | 'displayName'
        >
    >;
};

/**
 * Standard defaults for EPC creation.
 */
const EPC_DEFAULTS: Omit<
    ExecutionPolicyContract,
    'policyId' | 'policyVersion' | 'displayName'
> = {
    controls: {
        allowPlanning: true,
        allowToolUse: true,
        allowReplanning: true,
        allowGeneration: true,
        allowAssessment: true,
        allowRevision: true,
    },
    limits: {
        maxWorkflowSteps: 6,
        maxToolCalls: 3,
        maxDeliberationCalls: 2,
        maxTokensTotal: 12_000,
        maxDurationMs: 60_000,
    },
    failOpen: {
        authority: 'backend',
        allowFallbackGeneration: true,
        fallbackTemperature: 'deterministic',
    },
    routing: {
        strategy: 'capability-first',
        capabilityTags: [],
    },
    trustGraph: {
        evidenceMode: 'advisory',
        canBlockExecution: false,
    },
};

/**
 * Canonical, reusable presets over EPC.
 */
export const EXECUTION_POLICY_PRESETS: Readonly<
    Record<'balanced' | 'generate-only', ExecutionPolicyPreset>
> = {
    balanced: {
        presetId: 'balanced',
        displayName: 'Core Balanced',
        overrides: {},
    },
    'generate-only': {
        presetId: 'generate-only',
        displayName: 'Core Generate Only',
        overrides: {
            controls: {
                allowPlanning: false,
                allowToolUse: false,
                allowReplanning: false,
                allowGeneration: true,
                allowAssessment: false,
                allowRevision: false,
            },
            limits: {
                maxWorkflowSteps: 2,
                maxToolCalls: 0,
                maxDeliberationCalls: 0,
                maxTokensTotal: 8_000,
                maxDurationMs: 30_000,
            },
            routing: {
                strategy: 'profile-first',
                capabilityTags: [],
            },
        },
    },
};

/**
 * Explicit list of concerns that stay outside EPC.
 *
 * Keep these boundaries visible so EPC does not become a mini framework.
 */
export const EXECUTION_POLICY_OUTSIDE_SCOPE: ReadonlyArray<string> = [
    'Transport-specific behavior (web/discord response shaping).',
    'TrustGraph evidence retrieval and ingestion implementation.',
    'Operator incident workflows and alerting channels.',
    'Provider-specific model invocation details.',
];

/**
 * Builder/factory entrypoint for one EPC instance.
 *
 * Merge order is defaults -> preset overrides -> explicit overrides so callers
 * can start from a preset and still tune fields for one request/profile.
 */
export const buildExecutionPolicyContract = (
    input: ExecutionPolicyContractBuilderInput
): ExecutionPolicyContract => {
    const presetOverrides = input.preset?.overrides;
    const mergedMetadata = {
        ...(presetOverrides?.metadata ?? {}),
        ...(input.overrides?.metadata ?? {}),
    };

    const mergedControls: ExecutionPolicyControls = {
        ...EPC_DEFAULTS.controls,
        ...presetOverrides?.controls,
        ...input.overrides?.controls,
    };

    const mergedLimits: ExecutionPolicyLimits = {
        ...EPC_DEFAULTS.limits,
        ...presetOverrides?.limits,
        ...input.overrides?.limits,
    };

    const mergedFailOpen: ExecutionPolicyFailOpen = {
        ...EPC_DEFAULTS.failOpen,
        ...presetOverrides?.failOpen,
        ...input.overrides?.failOpen,
        authority: 'backend',
        fallbackTemperature: 'deterministic',
    };

    const mergedRouting: ExecutionPolicyRouting = {
        ...EPC_DEFAULTS.routing,
        ...presetOverrides?.routing,
        ...input.overrides?.routing,
    };

    const mergedTrustGraph: ExecutionPolicyTrustGraphSeam = {
        ...EPC_DEFAULTS.trustGraph,
        ...presetOverrides?.trustGraph,
        ...input.overrides?.trustGraph,
        canBlockExecution: false,
    };

    return {
        policyId: input.policyId,
        policyVersion: 'v1',
        displayName: input.displayName,
        controls: mergedControls,
        limits: mergedLimits,
        failOpen: mergedFailOpen,
        routing: mergedRouting,
        trustGraph: mergedTrustGraph,
        metadata:
            Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
    };
};
