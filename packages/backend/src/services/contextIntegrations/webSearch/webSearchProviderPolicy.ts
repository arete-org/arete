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

export type WebSearchProviderPolicy = {
    mode: WebSearchProviderMode;
    enabledProviders: WebSearchProviderId[];
    providerOrder: WebSearchProviderId[];
};

export type WebSearchProviderSelectionPlan = {
    candidates: WebSearchProviderId[];
    mode: WebSearchProviderMode;
};

const uniqueProviders = (
    providers: readonly WebSearchProviderId[]
): WebSearchProviderId[] => [...new Set(providers)];

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
