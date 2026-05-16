/**
 * @description: Defines bounded backend-owned review module IDs and their
 * prompt-key mapping for reviewed workflow prompt composition.
 * @footnote-scope: core
 * @footnote-module: ReviewModules
 * @footnote-risk: medium - Incorrect mapping can apply wrong refinement guidance.
 * @footnote-ethics: medium - Review modules shape wording quality but must not become policy authority.
 */
import type { PromptKey } from '@footnote/prompts';

export const SUPPORTED_REVIEW_MODULE_IDS = [
    'natural_human_style',
    'concise_answer',
] as const;

export type ReviewModuleId = (typeof SUPPORTED_REVIEW_MODULE_IDS)[number];

export const MAX_REVIEW_MODULES = 2;

export type ReviewModulePromptKeys = {
    assessPromptKey: PromptKey;
    refinePromptKey: PromptKey;
};

export const REVIEW_MODULE_PROMPT_KEYS: Readonly<
    Record<ReviewModuleId, ReviewModulePromptKeys>
> = {
    natural_human_style: {
        assessPromptKey: 'chat.review.module.natural_human_style.assess',
        refinePromptKey: 'chat.review.module.natural_human_style.refine',
    },
    concise_answer: {
        assessPromptKey: 'chat.review.module.concise_answer.assess',
        refinePromptKey: 'chat.review.module.concise_answer.refine',
    },
};

export const isReviewModuleId = (value: string): value is ReviewModuleId =>
    SUPPORTED_REVIEW_MODULE_IDS.includes(value as ReviewModuleId);

export const sanitizeReviewModuleIds = (
    moduleIds: readonly string[] | undefined
): ReviewModuleId[] => {
    if (!Array.isArray(moduleIds)) {
        return [];
    }

    const normalized = moduleIds
        .map((moduleId) => moduleId.trim())
        .filter((moduleId) => moduleId.length > 0)
        .filter(isReviewModuleId);
    const deduped = Array.from(new Set(normalized));

    return SUPPORTED_REVIEW_MODULE_IDS.filter((id) =>
        deduped.includes(id)
    ).slice(0, MAX_REVIEW_MODULES);
};
