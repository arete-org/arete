/**
 * @description: Composes bounded assess and refinement prompts for reviewed
 * workflow runs using shared prompt-registry fragments.
 * @footnote-scope: core
 * @footnote-module: ReviewPromptComposer
 * @footnote-risk: medium - Incorrect composition can degrade refinement quality or bloat prompt input.
 * @footnote-ethics: medium - Prompt wording influences style quality but must not encode policy authority.
 */
import { renderPromptBundle } from '@footnote/prompts';
import type { PromptKey } from '@footnote/prompts';
import type { PromptRegistry } from '@footnote/prompts';
import {
    REVIEW_MODULE_PROMPT_KEYS,
    sanitizeReviewModuleIds,
    type ReviewModuleId,
} from '../reviewModules.js';
import { promptRegistry } from './promptRegistry.js';

const DEFAULT_ASSESS_PROMPT_KEY: PromptKey = 'chat.review.assess.system';
const DEFAULT_REFINE_PROMPT_KEY: PromptKey = 'chat.review.refine.system';
const MAX_REVISION_INSTRUCTION_LENGTH = 320;

const trimBoundedText = (value: string, maxLength: number): string => {
    const normalized = value.trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return normalized.slice(0, maxLength);
};

const renderReviewModulePromptBundle = (input: {
    registry: PromptRegistry;
    moduleIds: readonly ReviewModuleId[];
    mode: 'assess' | 'refine';
}): string => {
    const promptKeys = input.moduleIds.map((moduleId) =>
        input.mode === 'assess'
            ? REVIEW_MODULE_PROMPT_KEYS[moduleId].assessPromptKey
            : REVIEW_MODULE_PROMPT_KEYS[moduleId].refinePromptKey
    );
    if (promptKeys.length === 0) {
        return '';
    }

    return renderPromptBundle(input.registry, promptKeys).trim();
};

/**
 * Compose the assess system prompt from a base prompt override or registry default plus
 * allowlisted review-module fragments in deterministic order.
 * Authority note: caller-provided `basePromptOverride` text wins for wording, but module IDs
 * are always sanitized against the backend registry; this function does not decide legality.
 * Returns a non-empty prompt string when defaults exist and the exact applied module IDs.
 */
export const composeAssessPrompt = (input: {
    moduleIds?: readonly string[];
    basePromptOverride?: string;
    registry?: PromptRegistry;
}): {
    prompt: string;
    appliedModuleIds: ReviewModuleId[];
} => {
    const registry = input.registry ?? promptRegistry;
    const appliedModuleIds = sanitizeReviewModuleIds(input.moduleIds);
    const basePrompt =
        input.basePromptOverride?.trim() ||
        registry.renderPrompt(DEFAULT_ASSESS_PROMPT_KEY).content.trim();
    const modulePrompt = renderReviewModulePromptBundle({
        registry,
        moduleIds: appliedModuleIds,
        mode: 'assess',
    });
    const prompt = [basePrompt, modulePrompt]
        .filter((part) => part.trim().length > 0)
        .join('\n\n')
        .trim();

    return {
        prompt,
        appliedModuleIds,
    };
};

/**
 * Compose refinement guidance from registry defaults, optional revision prefix, bounded
 * revision instruction text, and sanitized allowlisted module fragments.
 * Authority note: backend registry controls which module IDs can render; this function only
 * assembles bounded wording and may trim overlong revision instructions for fail-open safety.
 * Returns the composed prompt string and deterministic applied module IDs.
 */
export const composeRefinementPrompt = (input: {
    revisionPromptPrefix?: string;
    revisionInstruction?: string;
    moduleIds?: readonly string[];
    registry?: PromptRegistry;
}): {
    prompt: string;
    appliedModuleIds: ReviewModuleId[];
} => {
    const registry = input.registry ?? promptRegistry;
    const appliedModuleIds = sanitizeReviewModuleIds(input.moduleIds);
    const refineBasePrompt = registry
        .renderPrompt(DEFAULT_REFINE_PROMPT_KEY)
        .content.trim();
    const revisionPrefix = input.revisionPromptPrefix?.trim();
    const boundedRevisionInstruction = trimBoundedText(
        input.revisionInstruction ?? '',
        MAX_REVISION_INSTRUCTION_LENGTH
    );
    const modulePrompt = renderReviewModulePromptBundle({
        registry,
        moduleIds: appliedModuleIds,
        mode: 'refine',
    });
    const prompt = [
        revisionPrefix && revisionPrefix.length > 0 ? revisionPrefix : '',
        refineBasePrompt,
        modulePrompt,
        boundedRevisionInstruction.length > 0
            ? `Revision instruction: ${boundedRevisionInstruction}`
            : '',
    ]
        .filter((part) => part.trim().length > 0)
        .join('\n\n')
        .trim();

    return {
        prompt,
        appliedModuleIds,
    };
};
