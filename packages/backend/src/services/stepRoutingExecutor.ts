/**
 * @description: Executes workflow step routing chains with strict transient fallback progression and serializable attempt telemetry.
 * @footnote-scope: core
 * @footnote-module: StepRoutingExecutor
 * @footnote-risk: high - Incorrect fallback progression can route steps to wrong providers or stop fail-open behavior.
 * @footnote-ethics: high - Chain execution policy impacts response reliability and transparency.
 */

import type { ModelProfile } from '@footnote/contracts';
import type { ExecutionReasonCode } from '@footnote/contracts/policy';
import type {
    ResolvedStepRoutingCandidate,
    WorkflowModelStep,
} from './stepRoutingChains.js';

export type RoutingChainAttemptStatus =
    | 'executed'
    | 'failed_transient_advanced'
    | 'failed_non_transient_stopped'
    | 'skipped_ineligible';

export type RoutingChainAttemptLog = {
    index: number;
    step: WorkflowModelStep;
    profileId: string;
    provider?: string;
    model?: string;
    status: RoutingChainAttemptStatus;
    reasonCode?: ExecutionReasonCode;
    errorMessage?: string;
    chooseOneUsed: boolean;
    chooseOneCandidates?: string[];
    chooseOneSelectedIndex?: number;
    seedKeyType?: 'session_id' | 'correlation_id';
};

export type RoutingChainExecutionResult<TSuccess> =
    | {
          status: 'executed';
          selected: {
              candidate: ResolvedStepRoutingCandidate;
              profile: ModelProfile;
              index: number;
          };
          value: TSuccess;
          attempts: RoutingChainAttemptLog[];
      }
    | {
          status: 'exhausted';
          reasonCode: ExecutionReasonCode;
          attempts: RoutingChainAttemptLog[];
      };

const isTransientError = (error: unknown): boolean => {
    const message =
        error instanceof Error
            ? error.message.toLowerCase()
            : String(error).toLowerCase();

    return (
        message.includes('timeout') ||
        message.includes('timed out') ||
        message.includes('429') ||
        message.includes('rate limit') ||
        message.includes('quota') ||
        message.includes('billing') ||
        message.includes('503') ||
        message.includes('502') ||
        message.includes('504') ||
        message.includes('service unavailable') ||
        message.includes('temporarily unavailable') ||
        message.includes('overloaded') ||
        message.includes('upstream') ||
        message.includes('network') ||
        message.includes('connection reset')
    );
};

const isCandidateEligible = (
    candidate: ResolvedStepRoutingCandidate,
    profile: ModelProfile,
    input: { requiresSearch: boolean }
): { eligible: boolean; reasonCode?: ExecutionReasonCode } => {
    if (!profile.enabled) {
        return {
            eligible: false,
            reasonCode: 'routing_chain_entry_ineligible',
        };
    }

    if (input.requiresSearch && !profile.capabilities.canUseSearch) {
        return {
            eligible: false,
            reasonCode: 'routing_chain_entry_ineligible',
        };
    }

    if (candidate.profileId.trim().length === 0) {
        return {
            eligible: false,
            reasonCode: 'routing_chain_entry_ineligible',
        };
    }

    return { eligible: true };
};

export const executeStepRoutingChain = async <TSuccess>(input: {
    step: WorkflowModelStep;
    candidates: ResolvedStepRoutingCandidate[];
    enabledProfilesById: Map<string, ModelProfile>;
    requiresSearch: boolean;
    runWithProfile: (
        profile: ModelProfile,
        attemptIndex: number
    ) => Promise<TSuccess>;
}): Promise<RoutingChainExecutionResult<TSuccess>> => {
    const attempts: RoutingChainAttemptLog[] = [];

    for (let index = 0; index < input.candidates.length; index += 1) {
        const candidate = input.candidates[index];
        if (!candidate) {
            continue;
        }

        const profile = input.enabledProfilesById.get(candidate.profileId);
        if (!profile) {
            attempts.push({
                index,
                step: input.step,
                profileId: candidate.profileId,
                status: 'skipped_ineligible',
                reasonCode: 'routing_chain_entry_ineligible',
                chooseOneUsed: candidate.chooseOneUsed,
                chooseOneCandidates: candidate.chooseOneCandidates,
                chooseOneSelectedIndex: candidate.chooseOneSelectedIndex,
                seedKeyType: candidate.seedKeyType,
            });
            continue;
        }

        const eligibility = isCandidateEligible(candidate, profile, {
            requiresSearch: input.requiresSearch,
        });
        if (!eligibility.eligible) {
            attempts.push({
                index,
                step: input.step,
                profileId: profile.id,
                provider: profile.provider,
                model: profile.providerModel,
                status: 'skipped_ineligible',
                reasonCode: eligibility.reasonCode,
                chooseOneUsed: candidate.chooseOneUsed,
                chooseOneCandidates: candidate.chooseOneCandidates,
                chooseOneSelectedIndex: candidate.chooseOneSelectedIndex,
                seedKeyType: candidate.seedKeyType,
            });
            continue;
        }

        try {
            const value = await input.runWithProfile(profile, index);
            attempts.push({
                index,
                step: input.step,
                profileId: profile.id,
                provider: profile.provider,
                model: profile.providerModel,
                status: 'executed',
                chooseOneUsed: candidate.chooseOneUsed,
                chooseOneCandidates: candidate.chooseOneCandidates,
                chooseOneSelectedIndex: candidate.chooseOneSelectedIndex,
                seedKeyType: candidate.seedKeyType,
            });
            return {
                status: 'executed',
                selected: {
                    candidate,
                    profile,
                    index,
                },
                value,
                attempts,
            };
        } catch (error) {
            const transient = isTransientError(error);
            const reasonCode: ExecutionReasonCode = transient
                ? 'routing_chain_transient_error'
                : 'routing_chain_non_transient_error';
            attempts.push({
                index,
                step: input.step,
                profileId: profile.id,
                provider: profile.provider,
                model: profile.providerModel,
                status: transient
                    ? 'failed_transient_advanced'
                    : 'failed_non_transient_stopped',
                reasonCode,
                errorMessage:
                    error instanceof Error ? error.message : String(error),
                chooseOneUsed: candidate.chooseOneUsed,
                chooseOneCandidates: candidate.chooseOneCandidates,
                chooseOneSelectedIndex: candidate.chooseOneSelectedIndex,
                seedKeyType: candidate.seedKeyType,
            });

            if (!transient) {
                return {
                    status: 'exhausted',
                    reasonCode,
                    attempts,
                };
            }
        }
    }

    return {
        status: 'exhausted',
        reasonCode: 'routing_chain_exhausted',
        attempts,
    };
};
