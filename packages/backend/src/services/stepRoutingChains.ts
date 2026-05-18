/**
 * @description: Resolves per-step routing chains from runtime config with deterministic choose-one selection and optional TRACE band routing.
 * @footnote-scope: core
 * @footnote-module: StepRoutingChains
 * @footnote-risk: high - Incorrect chain resolution can misroute planner/generate/assess providers and break fail-open fallback.
 * @footnote-ethics: high - Routing policy changes answer quality, grounding posture, and operator transparency.
 */

import type { ModelProfile, WorkflowModeProfileId } from '@footnote/contracts';
import type { PostChatRequest } from '@footnote/contracts/web';
import type { TraceAxisScore } from '@footnote/contracts/policy';
import { runtimeConfig } from '../config.js';

export type WorkflowModelStep = 'planner' | 'generate' | 'assess';

export type ResolvedStepRoutingCandidate = {
    profileId: string;
    chooseOneUsed: boolean;
    chooseOneCandidates?: string[];
    chooseOneSelectedIndex?: number;
    seedKeyType?: 'session_id' | 'correlation_id';
};

export type ResolveStepRoutingChainInput = {
    modeId: WorkflowModeProfileId;
    step: WorkflowModelStep;
    request: Pick<PostChatRequest, 'sessionId' | 'traceTarget'>;
    correlationId: string;
    stepOverrideProfileId?: string;
};

const isTraceScoreInBand = (
    value: TraceAxisScore | undefined,
    min: number,
    max: number
): boolean => {
    if (value === undefined) {
        return false;
    }
    return value >= min && value <= max;
};

const hashString = (value: string): number => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return Math.abs(hash >>> 0);
};

const expandProfileOrPool = (
    profileId: string,
    pools: Record<string, string[]>
): string[] => pools[profileId] ?? [profileId];

const buildBaseEntries = (input: {
    modeId: WorkflowModeProfileId;
    step: WorkflowModelStep;
}): Array<string | { chooseOne: string[] }> =>
    runtimeConfig.modelProfiles.stepRoutingChains[input.modeId][input.step];

const maybeApplyTraceBandRule = (
    entries: Array<string | { chooseOne: string[] }>,
    input: Pick<ResolveStepRoutingChainInput, 'request' | 'modeId' | 'step'>
): Array<string | { chooseOne: string[] }> => {
    if (input.modeId !== 'grounded') {
        return entries;
    }

    // Bounded v1 TRACE-aware routing: rationale axis only.
    if (isTraceScoreInBand(input.request.traceTarget?.rationale, 4, 5)) {
        return [
            { chooseOne: ['openai-text-medium', 'ollama-text-qwen'] },
            ...entries,
        ];
    }
    if (isTraceScoreInBand(input.request.traceTarget?.rationale, 1, 2)) {
        return ['openai-text-fast', ...entries];
    }

    return entries;
};

export const resolveStepRoutingChain = (
    input: ResolveStepRoutingChainInput,
    enabledProfilesById: Map<string, ModelProfile>,
    allProfilesById: Map<string, ModelProfile>
): ResolvedStepRoutingCandidate[] => {
    const seedKeyType: 'session_id' | 'correlation_id' =
        input.request.sessionId?.trim() ? 'session_id' : 'correlation_id';
    const seedValue =
        input.request.sessionId?.trim() || input.correlationId || 'fallback';

    const entries = maybeApplyTraceBandRule(
        buildBaseEntries({ modeId: input.modeId, step: input.step }),
        input
    );

    const prefixedEntries: Array<string | { chooseOne: string[] }> =
        input.stepOverrideProfileId &&
        input.stepOverrideProfileId.trim().length > 0
            ? [input.stepOverrideProfileId.trim(), ...entries]
            : entries;

    const resolved: ResolvedStepRoutingCandidate[] = [];
    const seenProfileIds = new Set<string>();
    const pools = runtimeConfig.modelProfiles.pools;

    prefixedEntries.forEach((entry, index) => {
        if (typeof entry === 'string') {
            const expandedIds = expandProfileOrPool(entry, pools);
            for (const expandedId of expandedIds) {
                if (seenProfileIds.has(expandedId)) {
                    continue;
                }
                resolved.push({
                    profileId: expandedId,
                    chooseOneUsed: false,
                });
                seenProfileIds.add(expandedId);
            }
            return;
        }

        const chooseOnePool = entry.chooseOne.flatMap((candidateId) =>
            expandProfileOrPool(candidateId, pools)
        );
        const enabledCandidates = chooseOnePool.filter((profileId) =>
            enabledProfilesById.has(profileId)
        );
        if (enabledCandidates.length === 0) {
            return;
        }
        const selectedIndex =
            hashString(`${seedValue}:${input.step}:${index}`) %
            enabledCandidates.length;
        const selectedProfileId = enabledCandidates[selectedIndex];
        if (!selectedProfileId || seenProfileIds.has(selectedProfileId)) {
            return;
        }
        resolved.push({
            profileId: selectedProfileId,
            chooseOneUsed: true,
            chooseOneCandidates: enabledCandidates,
            chooseOneSelectedIndex: selectedIndex,
            seedKeyType,
        });
        seenProfileIds.add(selectedProfileId);
    });

    if (resolved.length > 0) {
        return resolved;
    }

    const fallback = allProfilesById.get(
        runtimeConfig.modelProfiles.defaultProfileId
    );
    if (fallback?.enabled) {
        return [
            {
                profileId: fallback.id,
                chooseOneUsed: false,
            },
        ];
    }

    const firstEnabled = [...enabledProfilesById.values()][0];
    if (!firstEnabled) {
        return [];
    }

    return [
        {
            profileId: firstEnabled.id,
            chooseOneUsed: false,
        },
    ];
};
