/**
 * @description: Backend reflect helpers for repo-aware search instructions and response hints.
 * @footnote-scope: core
 * @footnote-module: ReflectGenerationHints
 * @footnote-risk: medium - Bad hint construction can degrade retrieval quality or mislead the model.
 * @footnote-ethics: medium - Repo-aware hints affect how accurately Footnote explains itself.
 */
import type { GenerationSearchRequest } from '@footnote/agent-runtime';
import type {
    ReflectGenerationPlan,
    ReflectRepoSearchHint,
} from './reflectGenerationTypes.js';

const FOOTNOTE_REPO_OWNER = 'footnote-ai';
const FOOTNOTE_REPO_NAME = 'footnote';
const FOOTNOTE_REPO_SLUG = `${FOOTNOTE_REPO_OWNER}/${FOOTNOTE_REPO_NAME}`;
const DEEPWIKI_FOOTNOTE_URL = 'https://deepwiki.com/footnote-ai/footnote';

const REPO_HINT_QUERY_TERMS: Record<ReflectRepoSearchHint, string[]> = {
    architecture: ['architecture'],
    backend: ['backend'],
    contracts: ['contracts'],
    discord: ['discord'],
    images: ['image generation'],
    onboarding: ['onboarding', 'getting started'],
    web: ['web'],
    observability: ['observability'],
    openapi: ['openapi'],
    prompts: ['prompts'],
    provenance: ['provenance'],
    reflect: ['reflect'],
    traces: ['traces'],
    voice: ['voice'],
};

const isReflectRepoSearchHint = (hint: string): hint is ReflectRepoSearchHint =>
    hint in REPO_HINT_QUERY_TERMS;

const dedupeSearchTerms = (terms: string[]): string[] => {
    const seen = new Set<string>();
    const uniqueTerms: string[] = [];

    for (const term of terms) {
        const normalized = term.trim().toLowerCase();
        if (!normalized || seen.has(normalized)) {
            continue;
        }

        seen.add(normalized);
        uniqueTerms.push(term.trim());
    }

    return uniqueTerms;
};

export const buildRepoExplainerQuery = (
    search: Pick<GenerationSearchRequest, 'query' | 'repoHints'>
): string =>
    dedupeSearchTerms([
        FOOTNOTE_REPO_SLUG,
        FOOTNOTE_REPO_OWNER,
        FOOTNOTE_REPO_NAME,
        'DeepWiki',
        ...(search.repoHints?.flatMap((hint) =>
            isReflectRepoSearchHint(hint) ? REPO_HINT_QUERY_TERMS[hint] : [hint]
        ) ?? []),
        search.query.trim(),
    ]).join(' ');

export const buildWebSearchInstruction = (
    search: GenerationSearchRequest
): string => {
    if (search.intent === 'repo_explainer') {
        const repoQuery = buildRepoExplainerQuery(search);
        const hintText =
            (search.repoHints?.length ?? 0) > 0
                ? ` Focus areas: ${search.repoHints?.join(', ')}.`
                : '';

        return [
            'The planner marked this as a Footnote repository explanation lookup.',
            `Treat ${FOOTNOTE_REPO_SLUG} as the canonical repo identity for this search.`,
            `Prefer DeepWiki results from ${DEEPWIKI_FOOTNOTE_URL} when they are relevant.`,
            'If DeepWiki coverage is thin, use broader web context instead of getting stuck.',
            `Search query: ${repoQuery}.${hintText}`.trim(),
            `Original planner query: ${search.query.trim()}.`,
        ].join(' ');
    }

    return `The planner instructed you to perform a web search for: ${search.query.trim()}`;
};

export const buildRepoExplainerResponseHint = (
    generation: ReflectGenerationPlan
): string | null => {
    if (generation.search?.intent !== 'repo_explainer') {
        return null;
    }

    return [
        'Planner note: this is a Footnote repo-explanation lookup.',
        'Prefer DeepWiki-backed explanation when available.',
        'Use broader web context if the wiki is thin.',
    ].join(' ');
};
