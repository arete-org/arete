/**
 * @description: Assembles a canonical Execution Policy Contract (EPC) from
 * defaults, optional built-in preset selection, and explicit overrides.
 * @footnote-scope: core
 * @footnote-module: ExecutionPolicyResolver
 * @footnote-risk: low - Resolver is a thin assembly layer over the canonical EPC builder and built-in preset map.
 * @footnote-ethics: medium - Preset-to-policy mapping affects whether runtime follows fast direct or grounded answer expectations.
 */
import {
    EXECUTION_POLICY_PRESETS,
    buildExecutionPolicyContract,
    type ExecutionPolicyContract,
    type ExecutionPolicyContractId,
    type ExecutionPolicyContractOverrides,
    type ExecutionPolicyPreset,
    type ExecutionPolicyPresetId,
} from './executionPolicyContract.js';

type BuiltinExecutionPolicyPresetId = keyof typeof EXECUTION_POLICY_PRESETS;

type BuiltinExecutionPolicyDescriptor = {
    policyId: ExecutionPolicyContractId;
    displayName: string;
};

const BUILTIN_EXECUTION_POLICY_DESCRIPTORS: Readonly<
    Record<BuiltinExecutionPolicyPresetId, BuiltinExecutionPolicyDescriptor>
> = {
    'fast-direct': {
        policyId: 'core-fast-direct',
        displayName: 'Core Fast Direct',
    },
    'quality-grounded': {
        policyId: 'core-quality-grounded',
        displayName: 'Core Quality Grounded',
    },
};

const DEFAULT_EXECUTION_POLICY_DESCRIPTOR: BuiltinExecutionPolicyDescriptor =
    BUILTIN_EXECUTION_POLICY_DESCRIPTORS['fast-direct'];

const normalizePresetId = (
    presetId: string | null | undefined
): string | undefined => {
    const trimmedPresetId = presetId?.trim();
    return trimmedPresetId !== undefined && trimmedPresetId.length > 0
        ? trimmedPresetId
        : undefined;
};

const isBuiltinExecutionPolicyPresetId = (
    value: string
): value is BuiltinExecutionPolicyPresetId => value in EXECUTION_POLICY_PRESETS;

export type ExecutionPolicyResolverInput = {
    presetId?: ExecutionPolicyPresetId | null;
    policyId?: ExecutionPolicyContractId;
    displayName?: string;
    overrides?: ExecutionPolicyContractOverrides;
};

export type ExecutionPolicyResolverResolution = {
    requestedPresetId?: ExecutionPolicyPresetId;
    isKnownPresetId: boolean;
    policyContract: ExecutionPolicyContract;
};

/**
 * Resolves one EPC contract deterministically from:
 * 1) canonical defaults in the builder,
 * 2) optional built-in preset overrides,
 * 3) explicit call-site overrides.
 */
export const resolveExecutionPolicyContract = (
    input: ExecutionPolicyResolverInput
): ExecutionPolicyResolverResolution => {
    const requestedPresetId = normalizePresetId(input.presetId);
    const knownPresetId =
        requestedPresetId !== undefined &&
        isBuiltinExecutionPolicyPresetId(requestedPresetId)
            ? requestedPresetId
            : undefined;
    const preset: ExecutionPolicyPreset | undefined =
        knownPresetId !== undefined
            ? EXECUTION_POLICY_PRESETS[knownPresetId]
            : undefined;
    const descriptor =
        (knownPresetId !== undefined
            ? BUILTIN_EXECUTION_POLICY_DESCRIPTORS[knownPresetId]
            : undefined) ?? DEFAULT_EXECUTION_POLICY_DESCRIPTOR;

    return {
        ...(requestedPresetId !== undefined && {
            requestedPresetId: requestedPresetId as ExecutionPolicyPresetId,
        }),
        isKnownPresetId: knownPresetId !== undefined,
        policyContract: buildExecutionPolicyContract({
            policyId: input.policyId ?? descriptor.policyId,
            displayName: input.displayName ?? descriptor.displayName,
            preset,
            overrides: input.overrides,
        }),
    };
};
