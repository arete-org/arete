/**
 * @description: Assembles a canonical Execution Contract from
 * defaults, optional built-in preset selection, and explicit overrides.
 * @footnote-scope: core
 * @footnote-module: ExecutionContractResolver
 * @footnote-risk: low - Resolver is a thin assembly layer over the canonical contract builder and built-in preset map.
 * @footnote-ethics: medium - Preset-to-policy mapping affects whether runtime follows fast direct or grounded answer expectations.
 */
import {
    EXECUTION_CONTRACT_PRESETS,
    buildExecutionContract,
    type ExecutionContract,
    type ExecutionContractId,
    type ExecutionContractOverrides,
    type ExecutionContractPreset,
    type ExecutionContractPresetId,
} from './executionContract.js';

type BuiltinExecutionContractPresetId = keyof typeof EXECUTION_CONTRACT_PRESETS;

type BuiltinExecutionContractDescriptor = {
    policyId: ExecutionContractId;
    displayName: string;
};

const BUILTIN_EXECUTION_CONTRACT_DESCRIPTORS: Readonly<
    Record<BuiltinExecutionContractPresetId, BuiltinExecutionContractDescriptor>
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

const DEFAULT_EXECUTION_CONTRACT_DESCRIPTOR: BuiltinExecutionContractDescriptor =
    BUILTIN_EXECUTION_CONTRACT_DESCRIPTORS['fast-direct'];

const normalizePresetId = (
    presetId: string | null | undefined
): string | undefined => {
    const trimmedPresetId = presetId?.trim();
    return trimmedPresetId !== undefined && trimmedPresetId.length > 0
        ? trimmedPresetId
        : undefined;
};

const isBuiltinExecutionContractPresetId = (
    value: string
): value is BuiltinExecutionContractPresetId =>
    Object.prototype.hasOwnProperty.call(EXECUTION_CONTRACT_PRESETS, value);

export type ExecutionContractResolverInput = {
    presetId?: ExecutionContractPresetId | null;
    policyId?: ExecutionContractId;
    displayName?: string;
    overrides?: ExecutionContractOverrides;
};

export type ExecutionContractResolverResolution = {
    requestedPresetId?: ExecutionContractPresetId;
    isKnownPresetId: boolean;
    policyContract: ExecutionContract;
};

/**
 * Resolves one Execution Contract instance deterministically from:
 * 1) canonical defaults in the builder,
 * 2) optional built-in preset overrides,
 * 3) explicit call-site overrides.
 */
export const resolveExecutionContract = (
    input: ExecutionContractResolverInput
): ExecutionContractResolverResolution => {
    const requestedPresetId = normalizePresetId(input.presetId);
    const knownPresetId =
        requestedPresetId !== undefined &&
        isBuiltinExecutionContractPresetId(requestedPresetId)
            ? requestedPresetId
            : undefined;
    const preset: ExecutionContractPreset | undefined =
        knownPresetId !== undefined
            ? EXECUTION_CONTRACT_PRESETS[knownPresetId]
            : undefined;
    const descriptor =
        (knownPresetId !== undefined
            ? BUILTIN_EXECUTION_CONTRACT_DESCRIPTORS[knownPresetId]
            : undefined) ?? DEFAULT_EXECUTION_CONTRACT_DESCRIPTOR;

    return {
        ...(requestedPresetId !== undefined && {
            requestedPresetId: requestedPresetId as ExecutionContractPresetId,
        }),
        isKnownPresetId: knownPresetId !== undefined,
        policyContract: buildExecutionContract({
            policyId: input.policyId ?? descriptor.policyId,
            displayName: input.displayName ?? descriptor.displayName,
            preset,
            overrides: input.overrides,
        }),
    };
};
