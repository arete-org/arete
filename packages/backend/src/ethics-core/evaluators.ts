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
    SafetyRuleId,
    SafetyTier,
    SafetyDecision,
    SafetyEvaluationInput,
    SafetyEvaluationResult,
} from '@footnote/contracts/ethics-core';
import { SAFETY_RULE_METADATA } from '@footnote/contracts/ethics-core';
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
    /\bmay\b(?=\s+[a-z])/,
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
 * Determine the provenance category for the provided message context.
 *
 * @param context - Recent message strings used to assess provenance
 * @returns `'Retrieved'` if context indicates sourced/retrieved content; `'Speculative'` if context indicates hedging/speculation or no context is present; otherwise `'Inferred'`
 */
export function computeProvenance(context: string[]): Provenance {
    const signals = computeProvenanceSignals(context);

    let provenance: Provenance = 'Inferred';
    if (signals.retrieval) {
        provenance = 'Retrieved';
    } else if (signals.speculation || !signals.hasContext) {
        provenance = 'Speculative';
    }

    logger.debug('computeProvenance evaluated', {
        event: 'computeProvenance',
        contextLength: context.length,
        hasContext: signals.hasContext,
        retrieval: signals.retrieval,
        speculation: signals.speculation,
        provenance,
    });

    return provenance;
}

const SAFETY_RULE_IDS = {
    selfHarmCrisisIntent: 'safety.self_harm.crisis_intent.v1',
    weaponizationRequest: 'safety.weaponization_request.v1',
    medicalOrLegalAdvice: 'safety.professional.medical_or_legal_advice.v1',
} as const satisfies Record<string, SafetyRuleId>;

const HIGH_SAFETY_RULE_IDS: ReadonlySet<SafetyRuleId> = new Set<SafetyRuleId>([
    SAFETY_RULE_IDS.selfHarmCrisisIntent,
    SAFETY_RULE_IDS.weaponizationRequest,
]);

const RULE_PRECEDENCE: ReadonlyArray<SafetyRuleId> = [
    SAFETY_RULE_IDS.selfHarmCrisisIntent,
    SAFETY_RULE_IDS.weaponizationRequest,
    SAFETY_RULE_IDS.medicalOrLegalAdvice,
];

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

const selectDeterministicWinner = (
    matchedRuleIds: SafetyRuleId[]
): { safetyTier: SafetyTier; ruleId: SafetyRuleId | null } => {
    if (matchedRuleIds.length === 0) {
        return {
            safetyTier: 'Low',
            ruleId: null,
        };
    }

    const matchedSet = new Set(matchedRuleIds);
    const winningRule =
        RULE_PRECEDENCE.find((ruleId) => matchedSet.has(ruleId)) ?? null;
    if (!winningRule) {
        return {
            safetyTier: 'Low',
            ruleId: null,
        };
    }

    if (HIGH_SAFETY_RULE_IDS.has(winningRule)) {
        return {
            safetyTier: 'High',
            ruleId: winningRule,
        };
    }

    return {
        safetyTier: 'Medium',
        ruleId: winningRule,
    };
};

/**
 * Constructs a SafetyDecision from a SafetyEvaluationResult.
 *
 * @param evaluation - The safety evaluation result to convert into a decision
 * @returns A SafetyDecision reflecting `evaluation`; if `evaluation.action` is `allow` the decision will set `ruleId` to `null` and include only `action` and `safetyTier`, otherwise it will include `action`, `safetyTier`, `ruleId`, `reasonCode`, and `reason`
 */
export function buildSafetyDecision(
    evaluation: SafetyEvaluationResult
): SafetyDecision {
    if (evaluation.action === 'allow') {
        return {
            action: 'allow',
            safetyTier: evaluation.safetyTier,
            ruleId: null,
        };
    }

    return {
        action: evaluation.action,
        safetyTier: evaluation.safetyTier,
        ruleId: evaluation.ruleId,
        reasonCode: evaluation.reasonCode,
        reason: evaluation.reason,
    };
}

/**
 * Deterministically evaluates the safety of the latest user input using rule-based regex matching.
 *
 * Performs pattern matching against the trimmed `input.latestUserInput` to detect safety rule triggers
 * (e.g., self-harm crisis intent, weaponization requests, actionable medical/legal advice) and selects
 * a single deterministic outcome. On internal errors the function fails open and returns an allow/Low result.
 *
 * @param input - Evaluation input containing `latestUserInput`; only the trimmed `latestUserInput` is used for matching.
 * @returns A SafetyEvaluationResult describing the decision:
 *          - `action`: the resulting action (e.g., `'allow'` or a blocking action)
 *          - `safetyTier`: the computed tier (`'High' | 'Medium' | 'Low'`)
 *          - `ruleId`: the winning `SafetyRuleId` or `null` when no rule applies
 *          - `matchedRuleIds`: all rule IDs that matched the input
 *          - `reasonCode` and `reason`: included when a specific rule wins to explain the decision
 */
export function evaluateSafetyDeterministic(
    input: SafetyEvaluationInput
): SafetyEvaluationResult {
    try {
        const combinedText = input.latestUserInput.trim();
        // TODO(v2-safety-rules): Expand to role-aware conversation context once
        // conversation lifecycle and summarization contracts are finalized.
        const matchedRuleIds: SafetyRuleId[] = [];

        if (matchesAnyPattern(combinedText, SELF_HARM_CRISIS_PATTERNS)) {
            matchedRuleIds.push(SAFETY_RULE_IDS.selfHarmCrisisIntent);
        }

        if (matchesAnyPattern(combinedText, WEAPONIZATION_PATTERNS)) {
            matchedRuleIds.push(SAFETY_RULE_IDS.weaponizationRequest);
        }

        const requestsActionableAdvice = matchesAnyPattern(
            combinedText,
            ADVICE_INTENT_PATTERNS
        );
        const matchesMedicalOrLegalDomain =
            matchesAnyPattern(combinedText, MEDICAL_DOMAIN_PATTERNS) ||
            matchesAnyPattern(combinedText, LEGAL_DOMAIN_PATTERNS);

        if (requestsActionableAdvice && matchesMedicalOrLegalDomain) {
            matchedRuleIds.push(SAFETY_RULE_IDS.medicalOrLegalAdvice);
        }

        const { safetyTier, ruleId } =
            selectDeterministicWinner(matchedRuleIds);
        if (!ruleId) {
            return {
                action: 'allow',
                safetyTier,
                ruleId: null,
                matchedRuleIds,
            };
        }

        const ruleDecision = SAFETY_RULE_METADATA[ruleId];
        return {
            action: ruleDecision.action,
            safetyTier: ruleDecision.safetyTier,
            ruleId,
            matchedRuleIds,
            reasonCode: ruleDecision.reasonCode,
            reason: ruleDecision.reason,
        };
    } catch (error) {
        logger.warn('Failed-open to allow/Low', {
            event: 'evaluateSafetyDeterministic.failOpen',
            error,
        });
        return {
            action: 'allow',
            safetyTier: 'Low',
            ruleId: null,
            matchedRuleIds: [],
        };
    }
}
