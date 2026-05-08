/**
 * @description: Provider-agnostic policy helpers for web search context integration selection and fallback planning.
 * @footnote-scope: utility
 * @footnote-module: WebSearchProviderPolicy
 * @footnote-risk: medium - Incorrect provider ranking can degrade retrieval behavior or availability.
 * @footnote-ethics: medium - Provider policy shapes evidence quality and user-visible grounding behavior.
 */
import type {
    WebSearchProviderId,
    WebSearchProviderMode,
} from '../../../config/types.js';

/**
 * Policy inputs for provider selection planning in web search Context Integration.
 *
 * - `mode`: selection posture (`auto`, `strict`, `preferred_order`)
 * - `enabledProviders`: providers allowed by backend policy/config
 * - `providerOrder`: explicit preference order for ordered selection
 *
 * Invariants:
 * - Providers should be listed using `WebSearchProviderId`.
 * - Empty lists are allowed and resolve fail-open to empty candidates.
 */
export type WebSearchProviderPolicy = {
    mode: WebSearchProviderMode;
    enabledProviders: WebSearchProviderId[];
    providerOrder: WebSearchProviderId[];
};

/**
 * Planned provider candidates for one execution attempt.
 *
 * - `candidates`: ordered provider ids to try
 * - `mode`: mode used to derive this plan
 *
 * Empty candidates indicate no eligible+available provider could be selected.
 */
export type WebSearchProviderSelectionPlan = {
    candidates: WebSearchProviderId[];
    mode: WebSearchProviderMode;
};

const uniqueProviders = (
    providers: readonly WebSearchProviderId[]
): WebSearchProviderId[] => [...new Set(providers)];

/**
 * Resolves provider candidates for web search execution.
 *
 * Algorithm:
 * 1) Ordered branch: pick providers in `providerOrder` that are both enabled
 *    and available.
 * 2) If ordered branch returns candidates, use them for all modes.
 * 3) `strict` mode: if ordered branch is empty, return empty candidates.
 * 4) Non-strict fallback (`auto`/`preferred_order`): use enabled providers
 *    that are available, preserving enabledProviders order.
 *
 * Fail-open semantics:
 * - Never throws.
 * - Returns empty candidates when policy/availability cannot yield a runnable
 *   provider; caller decides skip/failure behavior.
 *
 * Authority:
 * - Backend policy/config is authoritative for enabled/order constraints.
 */
export const resolveWebSearchProviderSelectionPlan = (input: {
    policy: WebSearchProviderPolicy;
    availableProviders: readonly WebSearchProviderId[];
}): WebSearchProviderSelectionPlan => {
    const enabled = new Set(uniqueProviders(input.policy.enabledProviders));
    const available = new Set(uniqueProviders(input.availableProviders));

    const orderedCandidates = uniqueProviders(
        input.policy.providerOrder.filter(
            (providerId) => enabled.has(providerId) && available.has(providerId)
        )
    );
    if (orderedCandidates.length > 0) {
        return {
            candidates: orderedCandidates,
            mode: input.policy.mode,
        };
    }
    if (input.policy.mode === 'strict') {
        return {
            candidates: [],
            mode: input.policy.mode,
        };
    }

    const fallbackCandidates = uniqueProviders(
        input.policy.enabledProviders.filter((providerId) =>
            available.has(providerId)
        )
    );
    return {
        candidates: fallbackCandidates,
        mode: input.policy.mode,
    };
};
