/**
 * @description: Defines small capability-profile policy used to map workflow steps to compatible model profiles.
 * @footnote-scope: core
 * @footnote-module: ModelCapabilityPolicy
 * @footnote-risk: medium - Incorrect compatibility filtering can route steps to weaker or incompatible profiles.
 * @footnote-ethics: medium - Capability floors here affect retrieval reliability and auditability.
 */
import type {
    ModelCostClass,
    ModelLatencyClass,
    ModelProfile,
} from '@footnote/contracts';

export type WorkflowModelStep = 'generation';

export const capabilityProfileIds = [
    'structured-cheap',
    'balanced-general',
    'expressive-generation',
    'strict-review',
] as const;

export type CapabilityProfileId = (typeof capabilityProfileIds)[number];

export type CapabilityProfileOption = {
    id: CapabilityProfileId;
    description: string;
};

export type ModelCapabilityReasonCode =
    | 'planner_requested_capability_profile_invalid'
    | 'planner_requested_capability_profile_no_compatible_model'
    | 'planner_requested_capability_profile_no_floor_match';

const capabilityProfileSet = new Set<CapabilityProfileId>(capabilityProfileIds);

const STEP_ALLOWED_CAPABILITY_PROFILES: Readonly<
    Record<WorkflowModelStep, readonly CapabilityProfileId[]>
> = {
    generation: [
        'structured-cheap',
        'balanced-general',
        'expressive-generation',
    ],
};

const STEP_DEFAULT_CAPABILITY_PROFILE: Readonly<
    Record<WorkflowModelStep, CapabilityProfileId>
> = {
    generation: 'balanced-general',
};

const CAPABILITY_PROFILE_DESCRIPTIONS: Readonly<
    Record<CapabilityProfileId, string>
> = {
    'structured-cheap':
        'Prefer lower latency/cost profiles that still satisfy required runtime capabilities.',
    'balanced-general':
        'Prefer broadly capable general-purpose profiles for normal responses.',
    'expressive-generation':
        'Prefer higher-quality generation-focused profiles when available.',
    'strict-review':
        'Reserve stricter review-oriented profiles for critique/checking flows.',
};

const latencyClassRank: Record<ModelLatencyClass, number> = {
    low: 0,
    medium: 1,
    high: 2,
};

const costClassRank: Record<ModelCostClass, number> = {
    low: 0,
    medium: 1,
    high: 2,
};

const rankLatencyClass = (latencyClass: ModelLatencyClass | undefined) =>
    latencyClass === undefined ? 3 : latencyClassRank[latencyClass];

const rankCostClass = (costClass: ModelCostClass | undefined) =>
    costClass === undefined ? 3 : costClassRank[costClass];

const compareNumbers = (left: number, right: number) => left - right;

const isCapabilityAllowedForStep = (
    step: WorkflowModelStep,
    capabilityProfile: CapabilityProfileId
): boolean =>
    STEP_ALLOWED_CAPABILITY_PROFILES[step].includes(capabilityProfile);

const normalizeCapabilityProfileId = (
    value: unknown
): CapabilityProfileId | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }

    const normalized = value.trim().toLowerCase();
    return capabilityProfileSet.has(normalized as CapabilityProfileId)
        ? (normalized as CapabilityProfileId)
        : undefined;
};

const matchesCapabilityProfile = (
    profile: ModelProfile,
    capabilityProfile: CapabilityProfileId
): boolean => {
    if (capabilityProfile === 'structured-cheap') {
        const hasFastTier = profile.tierBindings.includes('text-fast');
        const acceptsCost =
            profile.costClass === undefined || profile.costClass !== 'high';
        const acceptsLatency =
            profile.latencyClass === undefined ||
            profile.latencyClass !== 'high';
        return hasFastTier || (acceptsCost && acceptsLatency);
    }

    if (capabilityProfile === 'expressive-generation') {
        return (
            profile.tierBindings.includes('text-quality') ||
            profile.costClass === 'high'
        );
    }

    if (capabilityProfile === 'strict-review') {
        return (
            profile.tierBindings.includes('text-quality') ||
            (profile.costClass !== undefined && profile.costClass !== 'low')
        );
    }

    return true;
};

const rankModelProfiles = (profiles: readonly ModelProfile[]): ModelProfile[] =>
    [...profiles].sort((left, right) => {
        const latencyRank = compareNumbers(
            rankLatencyClass(left.latencyClass),
            rankLatencyClass(right.latencyClass)
        );
        if (latencyRank !== 0) {
            return latencyRank;
        }

        const costRank = compareNumbers(
            rankCostClass(left.costClass),
            rankCostClass(right.costClass)
        );
        if (costRank !== 0) {
            return costRank;
        }

        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });

export const normalizeRequestedCapabilityProfile = (
    step: WorkflowModelStep,
    value: unknown
): CapabilityProfileId | undefined => {
    const normalized = normalizeCapabilityProfileId(value);
    if (!normalized) {
        return undefined;
    }

    return isCapabilityAllowedForStep(step, normalized)
        ? normalized
        : undefined;
};

export const listCapabilityProfileOptionsForStep = (
    step: WorkflowModelStep
): CapabilityProfileOption[] =>
    STEP_ALLOWED_CAPABILITY_PROFILES[step].map((id) => ({
        id,
        description: CAPABILITY_PROFILE_DESCRIPTIONS[id],
    }));

const filterCapabilityFloor = (
    profiles: readonly ModelProfile[],
    requiresSearch: boolean
): ModelProfile[] =>
    requiresSearch
        ? profiles.filter((profile) => profile.capabilities.canUseSearch)
        : [...profiles];

export const selectModelProfileForWorkflowStep = (input: {
    step: WorkflowModelStep;
    requestedCapabilityProfile?: unknown;
    profiles: readonly ModelProfile[];
    requiresSearch: boolean;
}): {
    selectedProfile?: ModelProfile;
    selectedCapabilityProfile: CapabilityProfileId;
    reasonCode?: ModelCapabilityReasonCode;
} => {
    const defaultCapabilityProfile =
        STEP_DEFAULT_CAPABILITY_PROFILE[input.step];
    const normalizedRequestedCapabilityProfile =
        normalizeRequestedCapabilityProfile(
            input.step,
            input.requestedCapabilityProfile
        );
    const selectedCapabilityProfile =
        normalizedRequestedCapabilityProfile ?? defaultCapabilityProfile;
    const rankedEnabledProfiles = rankModelProfiles(input.profiles);
    const floorCandidates = filterCapabilityFloor(
        rankedEnabledProfiles,
        input.requiresSearch
    );

    if (floorCandidates.length === 0) {
        return {
            selectedProfile: undefined,
            selectedCapabilityProfile,
            reasonCode: 'planner_requested_capability_profile_no_floor_match',
        };
    }

    const compatibleCandidates = floorCandidates.filter((profile) =>
        matchesCapabilityProfile(profile, selectedCapabilityProfile)
    );
    if (compatibleCandidates.length > 0) {
        return {
            selectedProfile: compatibleCandidates[0],
            selectedCapabilityProfile,
            ...(normalizedRequestedCapabilityProfile === undefined &&
                input.requestedCapabilityProfile !== undefined && {
                    reasonCode:
                        'planner_requested_capability_profile_invalid' as const,
                }),
        };
    }

    const defaultCompatibleCandidates = floorCandidates.filter((profile) =>
        matchesCapabilityProfile(profile, defaultCapabilityProfile)
    );
    if (defaultCompatibleCandidates.length > 0) {
        return {
            selectedProfile: defaultCompatibleCandidates[0],
            selectedCapabilityProfile: defaultCapabilityProfile,
            reasonCode:
                'planner_requested_capability_profile_no_compatible_model',
        };
    }

    return {
        selectedProfile: floorCandidates[0],
        selectedCapabilityProfile: defaultCapabilityProfile,
        reasonCode: 'planner_requested_capability_profile_no_compatible_model',
    };
};
