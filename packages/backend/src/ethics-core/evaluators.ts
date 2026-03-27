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
    RiskEvaluationResult,
    RiskRuleId,
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

const matchesProvenancePattern = (
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
            hasContext &&
            matchesProvenancePattern(mergedContext, RETRIEVAL_PATTERNS),
        speculation:
            hasContext &&
            matchesProvenancePattern(mergedContext, SPECULATION_PATTERNS),
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
 * @returns RiskTier classification
 */
export function computeRiskTier(content: string, context: string[]): RiskTier {
    return evaluateRiskTierDeterministic(content, context).riskTier;
}

const RISK_RULE_IDS = {
    selfHarmCrisisIntent: 'risk.self_harm.crisis_intent.v1',
    weaponizationRequest: 'risk.safety.weaponization_request.v1',
    medicalOrLegalAdvice: 'risk.professional.medical_or_legal_advice.v1',
} as const satisfies Record<string, RiskRuleId>;

const HIGH_RISK_RULE_IDS: ReadonlySet<RiskRuleId> = new Set<RiskRuleId>([
    RISK_RULE_IDS.selfHarmCrisisIntent,
    RISK_RULE_IDS.weaponizationRequest,
]);

const SELF_HARM_CRISIS_PATTERNS: ReadonlyArray<RegExp> = [
    /\b(kill myself|end my life|want to die|hurt myself|self[- ]harm)\b/i,
    /\b(suicide plan|commit suicide|overdose on purpose)\b/i,
];

const WEAPONIZATION_PATTERNS: ReadonlyArray<RegExp> = [
    /\b(make|build|assemble)\s+(a\s+)?(bomb|explosive|pipe bomb|molotov)\b/i,
    /\b(weaponize|weaponisation|weaponization)\b/i,
    /\b(how to)\s+(hack|ddos|phish|make malware|create ransomware)\b/i,
];

const MEDICAL_DOMAIN_PATTERNS: ReadonlyArray<RegExp> = [
    /\b(diagnose|diagnosis|prescribe|prescription|dosage|dose)\b/i,
    /\b(treatment plan|medical advice|doctor recommended)\b/i,
];

const LEGAL_DOMAIN_PATTERNS: ReadonlyArray<RegExp> = [
    /\b(legal advice|lawsuit|sue|contract loophole)\b/i,
    /\b(evade taxes|tax fraud|hide income)\b/i,
];

const ADVICE_INTENT_PATTERNS: ReadonlyArray<RegExp> = [
    /\b(what should i do|tell me exactly|step[- ]by[- ]step|how do i)\b/i,
    /\b(give me instructions|best way to)\b/i,
];

const matchesAnyPattern = (
    text: string,
    patterns: ReadonlyArray<RegExp>
): boolean => patterns.some((pattern) => pattern.test(text));

/**
 * Deterministic risk evaluator with stable rule IDs.
 * Fail-open policy: evaluator failures degrade to low risk.
 */
export function evaluateRiskTierDeterministic(
    content: string,
    context: string[]
): RiskEvaluationResult {
    try {
        const combinedText = [content, ...context].join('\n');
        const matchedRuleIds: RiskRuleId[] = [];

        if (matchesAnyPattern(combinedText, SELF_HARM_CRISIS_PATTERNS)) {
            matchedRuleIds.push(RISK_RULE_IDS.selfHarmCrisisIntent);
        }

        if (matchesAnyPattern(combinedText, WEAPONIZATION_PATTERNS)) {
            matchedRuleIds.push(RISK_RULE_IDS.weaponizationRequest);
        }

        const requestsActionableAdvice = matchesAnyPattern(
            combinedText,
            ADVICE_INTENT_PATTERNS
        );
        const matchesMedicalOrLegalDomain =
            matchesAnyPattern(combinedText, MEDICAL_DOMAIN_PATTERNS) ||
            matchesAnyPattern(combinedText, LEGAL_DOMAIN_PATTERNS);

        if (requestsActionableAdvice && matchesMedicalOrLegalDomain) {
            matchedRuleIds.push(RISK_RULE_IDS.medicalOrLegalAdvice);
        }

        let riskTier: RiskTier = 'Low';
        let ruleId: RiskRuleId | null = null;
        if (
            matchedRuleIds.some((candidate) =>
                HIGH_RISK_RULE_IDS.has(candidate)
            )
        ) {
            riskTier = 'High';
            ruleId =
                matchedRuleIds.find((candidate) =>
                    HIGH_RISK_RULE_IDS.has(candidate)
                ) ?? null;
        } else if (matchedRuleIds.length > 0) {
            riskTier = 'Medium';
            ruleId = matchedRuleIds[0] ?? null;
        }

        logger.debug(
            `[evaluateRiskTierDeterministic] tier=${riskTier} ruleId=${ruleId ?? 'none'} matchCount=${matchedRuleIds.length}`
        );
        return { riskTier, ruleId, matchedRuleIds };
    } catch (error) {
        logger.warn(
            `[evaluateRiskTierDeterministic] Failed-open to Low risk: ${error instanceof Error ? error.message : String(error)}`
        );
        return {
            riskTier: 'Low',
            ruleId: null,
            matchedRuleIds: [],
        };
    }
}
