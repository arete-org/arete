/**
 * @description: Resolves backend model selectors (profile id, tier alias, or raw model) into one executable model profile.
 * @footnote-scope: core
 * @footnote-module: ModelProfileResolver
 * @footnote-risk: high - Wrong fallback behavior can silently route traffic to unintended models.
 * @footnote-ethics: high - Capability resolution here controls retrieval behavior and model governance defaults.
 */

import {
    modelTierAliases,
    type ModelProfile,
    type ModelTierAlias,
} from '@footnote/contracts';
import {
    supportedProviders,
    type SupportedProvider,
} from '@footnote/contracts/providers';

const MODEL_SELECTOR_PATTERN =
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._:-]*)?$/;

type ModelProfileResolverWarning = {
    message: string;
    meta?: Record<string, unknown>;
};

type ModelProfileResolverWarningLogger = {
    warn: (message: string, meta?: Record<string, unknown>) => void;
};

type ModelProfileResolverWarningSink =
    | ((warning: ModelProfileResolverWarning) => void)
    | ModelProfileResolverWarningLogger;

export interface CreateModelProfileResolverOptions {
    catalog: ModelProfile[];
    defaultProfileId: string;
    legacyDefaultModel: string;
    warn: ModelProfileResolverWarningSink;
}

const tierAliasSet = new Set<string>(modelTierAliases);
const supportedProviderSet = new Set<string>(supportedProviders);

type ParsedRawModel = {
    provider?: SupportedProvider;
    providerModel: string;
};

const RAW_MODEL_PROFILE_CAPABILITIES: ModelProfile['capabilities'] = {
    canUseSearch: false,
};

const emitWarning = (
    warn: ModelProfileResolverWarningSink,
    warning: ModelProfileResolverWarning
): void => {
    if (typeof warn === 'function') {
        warn(warning);
        return;
    }

    warn.warn(warning.message, warning.meta);
};

/**
 * Treats blank selector input as "no override" so callers can safely pass
 * optional user/planner values without pre-validating.
 */
const normalizeSelector = (value: string | undefined): string | null => {
    if (!value) {
        return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
};

/**
 * Parses raw model selectors into provider + model pieces.
 *
 * Accepted forms:
 * - `model-name` (provider stays unset so resolver can apply runtime defaults)
 * - `provider/model-name` (provider must be supported)
 */
const parseRawModel = (selector: string): ParsedRawModel | null => {
    if (!MODEL_SELECTOR_PATTERN.test(selector)) {
        return null;
    }

    if (!selector.includes('/')) {
        return {
            providerModel: selector,
        };
    }

    const [providerPart, modelPart] = selector.split('/', 2);
    if (!providerPart || !modelPart) {
        return null;
    }

    const normalizedProvider = providerPart.toLowerCase();
    if (!supportedProviderSet.has(normalizedProvider)) {
        return null;
    }

    return {
        provider: normalizedProvider as SupportedProvider,
        providerModel: modelPart,
    };
};

/**
 * Builds a synthetic profile when catalog defaults are unusable.
 *
 * This keeps routing fail-open for existing deployments that still rely on
 * `DEFAULT_MODEL` while catalog migration completes.
 */
const buildLegacyDefaultProfile = (
    legacyDefaultModel: string,
    fallbackProvider: SupportedProvider
): ModelProfile => ({
    id: 'legacy-default-model',
    description:
        'Compatibility profile synthesized from DEFAULT_MODEL fallback behavior.',
    provider: fallbackProvider,
    providerModel: legacyDefaultModel,
    enabled: true,
    tierBindings: [],
    capabilities: {
        canUseSearch: true,
    },
});

/**
 * Wraps a raw model selector in one profile-shaped object so downstream code
 * can keep using one `ModelProfile` contract.
 */
const buildRawModelProfile = (
    selector: string,
    parsed: ParsedRawModel,
    fallbackProvider: SupportedProvider
): ModelProfile => {
    const provider = parsed.provider ?? fallbackProvider;
    return {
        id: `raw-${provider}-${parsed.providerModel.replace(/[^a-zA-Z0-9-]+/g, '-')}`.toLowerCase(),
        description: `Raw model selector passthrough for "${selector}".`,
        provider,
        providerModel: parsed.providerModel,
        enabled: true,
        tierBindings: [],
        capabilities: RAW_MODEL_PROFILE_CAPABILITIES,
    };
};

/**
 * Creates a deterministic, fail-open model profile resolver.
 */
export const createModelProfileResolver = ({
    catalog,
    defaultProfileId,
    legacyDefaultModel,
    warn,
}: CreateModelProfileResolverOptions) => {
    // Fast lookup by id for explicit profile-id selectors.
    const catalogById = new Map(
        catalog.map((profile) => [profile.id, profile])
    );
    // Ordered enabled list powers default fallback behavior.
    const enabledCatalog = catalog.filter((profile) => profile.enabled);
    const configuredDefaultProvider =
        catalogById.get(defaultProfileId)?.provider;
    const legacyDefaultModelParsed = parseRawModel(legacyDefaultModel);
    const normalizedLegacyDefaultModel =
        legacyDefaultModelParsed?.providerModel ?? legacyDefaultModel;
    const legacyDefaultProvider =
        legacyDefaultModelParsed?.provider ??
        configuredDefaultProvider ??
        enabledCatalog[0]?.provider ??
        catalog[0]?.provider ??
        'openai';

    /**
     * Resolves startup default profile with fail-open fallback order:
     * 1) enabled configured DEFAULT_PROFILE_ID
     * 2) first enabled catalog profile
     * 3) synthetic legacy DEFAULT_MODEL profile
     */
    const resolveDefaultProfile = (): ModelProfile => {
        const configuredDefault = catalogById.get(defaultProfileId);
        if (configuredDefault?.enabled) {
            return configuredDefault;
        }

        if (configuredDefault && !configuredDefault.enabled) {
            emitWarning(warn, {
                message:
                    'Configured DEFAULT_PROFILE_ID is disabled. Falling back to first enabled catalog profile.',
                meta: {
                    defaultProfileId,
                },
            });
        } else {
            emitWarning(warn, {
                message:
                    'Configured DEFAULT_PROFILE_ID was not found. Falling back to first enabled catalog profile.',
                meta: {
                    defaultProfileId,
                },
            });
        }

        if (enabledCatalog.length > 0) {
            return enabledCatalog[0];
        }

        emitWarning(warn, {
            message:
                'Model profile catalog has no enabled entries. Falling back to legacy DEFAULT_MODEL compatibility profile.',
            meta: {
                legacyDefaultModel,
            },
        });
        return buildLegacyDefaultProfile(
            normalizedLegacyDefaultModel,
            legacyDefaultProvider
        );
    };

    const defaultProfile = resolveDefaultProfile();

    /**
     * Resolves explicit profile ids, but never returns disabled profiles.
     */
    const resolveByProfileId = (selector: string): ModelProfile | null => {
        const matchedProfile = catalogById.get(selector);
        if (!matchedProfile) {
            return null;
        }

        if (!matchedProfile.enabled) {
            emitWarning(warn, {
                message:
                    'Requested model profile is disabled. Falling back to default profile.',
                meta: {
                    selector,
                    defaultProfileId: defaultProfile.id,
                },
            });
            return defaultProfile;
        }

        return matchedProfile;
    };

    /**
     * Resolves tier aliases (`text-fast`, etc.) to the first enabled profile
     * that declares the requested binding.
     */
    const resolveByTierAlias = (selector: string): ModelProfile | null => {
        if (!tierAliasSet.has(selector)) {
            return null;
        }

        const tierMatch = catalog.find(
            (profile) =>
                profile.enabled &&
                profile.tierBindings.includes(selector as ModelTierAlias)
        );
        if (tierMatch) {
            return tierMatch;
        }

        emitWarning(warn, {
            message:
                'Requested model tier has no enabled profile binding. Falling back to default profile.',
            meta: {
                selector,
                defaultProfileId: defaultProfile.id,
            },
        });
        return defaultProfile;
    };

    /**
     * Resolves raw model selectors.
     *
     * If selector already matches an enabled catalog profile model string, we
     * reuse that profile. Otherwise we synthesize a raw passthrough profile.
     */
    const resolveByRawModel = (selector: string): ModelProfile | null => {
        const parsedRawModel = parseRawModel(selector);
        if (!parsedRawModel) {
            return null;
        }

        const resolvedProvider =
            parsedRawModel.provider ?? defaultProfile.provider;
        const exactMatches = catalog.filter(
            (profile) =>
                profile.enabled &&
                profile.provider === resolvedProvider &&
                profile.providerModel === parsedRawModel.providerModel
        );
        const existingExact =
            exactMatches.length === 1 ? exactMatches[0] : null;

        if (existingExact) {
            return existingExact;
        }

        if (exactMatches.length > 1) {
            emitWarning(warn, {
                message:
                    'Multiple enabled catalog profiles matched raw selector. Falling back to synthetic passthrough profile.',
                meta: {
                    selector,
                    provider: resolvedProvider,
                    providerModel: parsedRawModel.providerModel,
                    matchCount: exactMatches.length,
                    defaultProfileId: defaultProfile.id,
                },
            });
        }

        return buildRawModelProfile(selector, parsedRawModel, resolvedProvider);
    };

    /**
     * Public resolver entrypoint.
     *
     * Resolution order:
     * 1) profile id
     * 2) tier alias
     * 3) raw model selector
     * 4) default profile fallback
     */
    const resolve = (selector?: string): ModelProfile => {
        const normalizedSelector = normalizeSelector(selector);
        if (!normalizedSelector) {
            return defaultProfile;
        }

        const byProfileId = resolveByProfileId(normalizedSelector);
        if (byProfileId) {
            return byProfileId;
        }

        const byTierAlias = resolveByTierAlias(normalizedSelector);
        if (byTierAlias) {
            return byTierAlias;
        }

        const byRawModel = resolveByRawModel(normalizedSelector);
        if (byRawModel) {
            return byRawModel;
        }

        emitWarning(warn, {
            message:
                'Requested model selector could not be resolved. Falling back to default profile.',
            meta: {
                selector: normalizedSelector,
                defaultProfileId: defaultProfile.id,
            },
        });
        return defaultProfile;
    };

    return {
        resolve,
        defaultProfile,
    };
};
