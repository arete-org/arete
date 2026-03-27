/**
 * @description: Contains ethical evaluation logic and risk assessment algorithms.
 * @footnote-scope: core
 * @footnote-module: EthicsEvaluators
 * @footnote-risk: medium - Evaluation failures can lead to inappropriate AI behavior or missed ethical concerns.
 * @footnote-ethics: high - These classifiers influence transparency, accountability, and user trust in AI responses.
 */
import type {
    Provenance,
    ProvenanceSignals,
    RiskTier,
} from '@footnote/contracts/ethics-core';
import { logger } from '../utils/logger.js';

const RETRIEVAL_PATTERNS: readonly RegExp[] = [
    /https?:\/\//i,
    /\burl_citation\b/i,
    /\bweb[_\s-]?search\b/i,
    /\bcitation(s)?\b/i,
    /\bsources?\b/i,
    /\baccording to\b/i,
    /\breported by\b/i,
    /\bfrom (the )?(article|report|source)\b/i,
    /\[\d+\]\([^)]+\)/,
];

const SPECULATION_PATTERNS: readonly RegExp[] = [
    /\bi think\b/i,
    /\bi guess\b/i,
    /\bmay\b/i,
    /\bmight\b/i,
    /\bcould\b/i,
    /\bpossibly\b/i,
    /\bprobably\b/i,
    /\blikely\b/i,
    /\bunclear\b/i,
    /\bnot sure\b/i,
    /\bcannot verify\b/i,
    /\bunverified\b/i,
    /\bappears to\b/i,
    /\bestimate\b/i,
];

const normalizeContext = (context: string[]): string[] =>
    context
        .filter((entry) => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

const matchesAnyPattern = (
    text: string,
    patterns: readonly RegExp[]
): boolean => patterns.some((pattern) => pattern.test(text));

/**
 * Computes deterministic provenance signals from context.
 * The signal map is intentionally compact and serializable for trace metadata.
 */
export function computeProvenanceSignals(context: string[]): ProvenanceSignals {
    const normalizedContext = normalizeContext(context);
    const mergedContext = normalizedContext.join('\n');
    const hasContext = normalizedContext.length > 0;

    return {
        retrieval:
            hasContext && matchesAnyPattern(mergedContext, RETRIEVAL_PATTERNS),
        speculation:
            hasContext &&
            matchesAnyPattern(mergedContext, SPECULATION_PATTERNS),
        hasContext,
    };
}

/**
 * Computes the provenance type for a given context.
 *
 * @param context - Array of recent message strings
 * @returns Deterministic provenance classification with conservative precedence
 * Retrieved > Speculative > Inferred.
 */
export function computeProvenance(context: string[]): Provenance {
    const signals = computeProvenanceSignals(context);

    let provenance: Provenance = 'Inferred';
    if (signals.retrieval) {
        provenance = 'Retrieved';
    } else if (signals.speculation || !signals.hasContext) {
        provenance = 'Speculative';
    }

    logger.debug(
        `[computeProvenance] Context length: ${context.length}, hasContext: ${signals.hasContext}, retrieval: ${signals.retrieval}, speculation: ${signals.speculation}, classified: ${provenance}`
    );

    return provenance;
}

/**
 * Computes the risk tier for a given message.
 *
 * @param content - The message content being evaluated
 * @param context - Array of recent message strings
 * @returns RiskTier classification (stub: always "low")
 *
 * TODO: Implement real logic:
 * - Apply circuit breaker keyword matching
 * - Check domain heuristics (medical, legal, self-harm)
 * - Analyze sentiment and urgency markers
 */
export function computeRiskTier(content: string, context: string[]): RiskTier {
    // Stub: always return "low" for now
    logger.debug(`[computeRiskTier] Content length: ${content.length}`);
    logger.debug(`[computeRiskTier] Context length: ${context.length}`);
    return 'Low';
}
