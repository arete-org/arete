/**
 * @description: Shared model profile catalog contracts used by backend routing and runtime adapters.
 * @footnote-scope: interface
 * @footnote-module: ModelProfileContracts
 * @footnote-risk: medium - Invalid profile shapes can misroute model calls or disable expected capabilities.
 * @footnote-ethics: medium - Profile metadata influences model behavior and retrieval policy decisions.
 */

import { z } from 'zod';
import { supportedProviders } from './providers.js';

/**
 * Stable tier aliases used by callers that want intent-level routing instead of
 * naming one concrete catalog profile id.
 */
export const modelTierAliases = [
    'text-fast',
    'text-medium',
    'text-quality',
] as const;
export type ModelTierAlias = (typeof modelTierAliases)[number];

/** Optional coarse cost bucket for UI and policy hints. */
export const modelCostClasses = ['low', 'medium', 'high'] as const;
export type ModelCostClass = (typeof modelCostClasses)[number];

/** Optional coarse latency bucket for UI and policy hints. */
export const modelLatencyClasses = ['low', 'medium', 'high'] as const;
export type ModelLatencyClass = (typeof modelLatencyClasses)[number];

/**
 * Runtime-facing capability flags for one model profile.
 *
 * These flags describe what the backend may ask this profile to do. They do
 * not override execution policy by themselves.
 */
export interface ModelProfileCapabilities {
    canUseSearch: boolean;
    toolCapabilities?: Record<string, boolean>;
}

/**
 * One catalog entry describing how backend routing should target a concrete
 * provider model.
 */
export interface ModelProfile {
    id: string;
    description: string;
    provider: (typeof supportedProviders)[number];
    providerModel: string;
    enabled: boolean;
    tierBindings: ModelTierAlias[];
    capabilities: ModelProfileCapabilities;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    costClass?: ModelCostClass;
    latencyClass?: ModelLatencyClass;
}

/**
 * Runtime capability schema shared by config loading and tests.
 */
export const ModelProfileCapabilitiesSchema = z
    .object({
        canUseSearch: z.boolean(),
        toolCapabilities: z.record(z.string(), z.boolean()).optional(),
    })
    .strict();

/**
 * Canonical schema for one catalog entry.
 */
export const ModelProfileSchema: z.ZodType<ModelProfile> = z
    .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
        description: z.string().min(1),
        provider: z.enum(supportedProviders),
        providerModel: z.string().min(1),
        enabled: z.boolean(),
        tierBindings: z.array(z.enum(modelTierAliases)).default([]),
        capabilities: ModelProfileCapabilitiesSchema,
        maxInputTokens: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        costClass: z.enum(modelCostClasses).optional(),
        latencyClass: z.enum(modelLatencyClasses).optional(),
    })
    .strict();

/**
 * Canonical schema for the full model profile catalog.
 *
 * Duplicate ids are rejected here so routing code can safely treat `id` as the
 * stable lookup key.
 */
export const ModelProfileCatalogSchema = z
    .array(ModelProfileSchema)
    .superRefine((profiles, context) => {
        const seen = new Set<string>();
        const duplicates = new Set<string>();

        for (const profile of profiles) {
            if (seen.has(profile.id)) {
                duplicates.add(profile.id);
                continue;
            }
            seen.add(profile.id);
        }

        if (duplicates.size > 0) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Duplicate model profile id(s): ${Array.from(duplicates).sort().join(', ')}`,
            });
        }
    });
