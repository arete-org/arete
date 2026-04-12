/**
 * @description: Resolves deterministic precedence for current internal steerability controls.
 * @footnote-scope: core
 * @footnote-module: SteerabilityControlPrecedence
 * @footnote-risk: medium - Precedence drift here can silently change conflict outcomes across orchestration and metadata paths.
 * @footnote-ethics: high - Authority-boundary mistakes can misrepresent which controls are policy authority versus presentation or preference.
 */

type ProfilePreferenceSource = 'request_override' | 'planner_output';

export type ProviderPreferenceOutcomeState =
    | 'requested_honored'
    | 'requested_overridden'
    | 'advisory_honored'
    | 'advisory_overridden'
    | 'fallback_resolved';

export type PersonaToneOverlayOutcomeState =
    | 'presentation_applied'
    | 'presentation_not_applied';

export type SteerabilityAuthorityClass =
    | 'execution_policy'
    | 'preference_signal'
    | 'presentation_only';

export type InternalSteerabilityPrecedenceRule = {
    higherAuthority: SteerabilityAuthorityClass;
    lowerAuthority: SteerabilityAuthorityClass;
    outcome: 'higher_wins';
    rationale: string;
};

export const INTERNAL_STEERABILITY_PRECEDENCE_MATRIX: readonly InternalSteerabilityPrecedenceRule[] =
    [
        {
            higherAuthority: 'execution_policy',
            lowerAuthority: 'preference_signal',
            outcome: 'higher_wins',
            rationale:
                'Execution-policy controls remain authoritative when provider preference conflicts with runtime policy/capability routing.',
        },
        {
            higherAuthority: 'execution_policy',
            lowerAuthority: 'presentation_only',
            outcome: 'higher_wins',
            rationale:
                'Presentation controls shape tone only and cannot alter execution-policy authority.',
        },
        {
            higherAuthority: 'preference_signal',
            lowerAuthority: 'presentation_only',
            outcome: 'higher_wins',
            rationale:
                'Provider preference controls profile selection only; persona tone overlay remains presentation-scoped.',
        },
    ] as const;

const trimOptional = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

export type ResolveInternalSteerabilityControlConflictsInput = {
    requestedProfileId?: string;
    plannerSelectedProfileId?: string;
    selectedProfileId: string;
    personaOverlaySource: 'none' | 'inline' | 'file';
};

export type ProviderPreferenceConflictOutcome = {
    authorityClass: 'preference_signal';
    source: ProfilePreferenceSource | 'fail_open_default';
    state: ProviderPreferenceOutcomeState;
    requestedProfileId?: string;
    advisoryProfileId?: string;
    resolvedProfileId: string;
    wasOverriddenByExecutionPolicy: boolean;
    canEscalateIntoExecutionPolicyAuthority: false;
};

export type PersonaToneOverlayConflictOutcome = {
    authorityClass: 'presentation_only';
    state: PersonaToneOverlayOutcomeState;
    overlaySource: 'none' | 'inline' | 'file';
    overlayApplied: boolean;
    canEscalateIntoExecutionPolicyAuthority: false;
};

export type InternalSteerabilityConflictResolution = {
    precedenceMatrix: readonly InternalSteerabilityPrecedenceRule[];
    providerPreference: ProviderPreferenceConflictOutcome;
    personaToneOverlay: PersonaToneOverlayConflictOutcome;
};

const resolveProviderPreferenceConflict = (input: {
    requestedProfileId?: string;
    plannerSelectedProfileId?: string;
    selectedProfileId: string;
}): ProviderPreferenceConflictOutcome => {
    const requestedProfileId = trimOptional(input.requestedProfileId);
    if (requestedProfileId !== undefined) {
        const state: ProviderPreferenceOutcomeState =
            requestedProfileId === input.selectedProfileId
                ? 'requested_honored'
                : 'requested_overridden';
        return {
            authorityClass: 'preference_signal',
            source: 'request_override',
            state,
            requestedProfileId,
            resolvedProfileId: input.selectedProfileId,
            wasOverriddenByExecutionPolicy: state === 'requested_overridden',
            canEscalateIntoExecutionPolicyAuthority: false,
        };
    }

    const plannerSelectedProfileId = trimOptional(
        input.plannerSelectedProfileId
    );
    if (plannerSelectedProfileId !== undefined) {
        const state: ProviderPreferenceOutcomeState =
            plannerSelectedProfileId === input.selectedProfileId
                ? 'advisory_honored'
                : 'advisory_overridden';
        return {
            authorityClass: 'preference_signal',
            source: 'planner_output',
            state,
            advisoryProfileId: plannerSelectedProfileId,
            resolvedProfileId: input.selectedProfileId,
            wasOverriddenByExecutionPolicy: state === 'advisory_overridden',
            canEscalateIntoExecutionPolicyAuthority: false,
        };
    }

    return {
        authorityClass: 'preference_signal',
        source: 'fail_open_default',
        state: 'fallback_resolved',
        resolvedProfileId: input.selectedProfileId,
        wasOverriddenByExecutionPolicy: false,
        canEscalateIntoExecutionPolicyAuthority: false,
    };
};

const resolvePersonaToneOverlayConflict = (
    personaOverlaySource: 'none' | 'inline' | 'file'
): PersonaToneOverlayConflictOutcome => {
    const overlayApplied = personaOverlaySource !== 'none';
    return {
        authorityClass: 'presentation_only',
        state: overlayApplied
            ? 'presentation_applied'
            : 'presentation_not_applied',
        overlaySource: personaOverlaySource,
        overlayApplied,
        canEscalateIntoExecutionPolicyAuthority: false,
    };
};

export const resolveInternalSteerabilityControlConflicts = (
    input: ResolveInternalSteerabilityControlConflictsInput
): InternalSteerabilityConflictResolution => ({
    precedenceMatrix: INTERNAL_STEERABILITY_PRECEDENCE_MATRIX,
    providerPreference: resolveProviderPreferenceConflict({
        requestedProfileId: input.requestedProfileId,
        plannerSelectedProfileId: input.plannerSelectedProfileId,
        selectedProfileId: input.selectedProfileId,
    }),
    personaToneOverlay: resolvePersonaToneOverlayConflict(
        input.personaOverlaySource
    ),
});
