/**
 * @description: Contains ethical evaluation logic and risk assessment algorithms.
 * @footnote-scope: core
 * @footnote-module: EthicsEvaluators
 * @footnote-risk: medium - Evaluation failures can lead to inappropriate AI behavior or missed ethical concerns.
 * @footnote-ethics: high - These classifiers influence transparency, accountability, and user trust in AI responses.
 */
import type {
    Provenance,
    RiskEvaluationResult,
    RiskRuleId,
    RiskTier,
} from '@footnote/contracts/ethics-core';
import { logger } from '../utils/logger.js';

/**
 * Computes the provenance type for a given context.
 *
 * @param context - Array of recent message strings
 * @returns Provenance type (stub: always "retrieved")
 *
 * TODO: Implement real logic:
 * - Check if web_search was called
 * - Inspect context length and recency
 * - Detect speculation signals (hedging language, conditional statements)
 */
export function computeProvenance(context: string[]): Provenance {
    // Stub: always return "retrieved" for now
    logger.debug(`[computeProvenance] Context length: ${context.length}`);
    return 'Retrieved';
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
