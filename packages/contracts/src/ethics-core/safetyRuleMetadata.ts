/**
 * @description: Canonical deterministic safety rule metadata shared by
 * evaluator and schema validation.
 * @footnote-scope: interface
 * @footnote-module: SafetyRuleMetadata
 * @footnote-risk: medium - Drift in this map can misalign evaluator behavior and validation.
 * @footnote-ethics: high - This map defines safety action and reason semantics.
 */

import type {
    SafetyRuleId,
    SafetyTier,
    SafetyAction,
    SafetyReasonCode,
} from './types.js';

export type SafetyRuleMetadata = {
    action: Exclude<SafetyAction, 'allow'>;
    safetyTier: SafetyTier;
    reasonCode: SafetyReasonCode;
    reason: string;
};

export const SAFETY_RULE_METADATA: Readonly<
    Record<SafetyRuleId, SafetyRuleMetadata>
> = {
    'safety.self_harm.crisis_intent.v1': {
        action: 'block',
        safetyTier: 'High',
        reasonCode: 'self_harm_crisis_intent',
        reason: 'Deterministic crisis-intent rule matched.',
    },
    'safety.weaponization_request.v1': {
        action: 'block',
        safetyTier: 'High',
        reasonCode: 'weaponization_request',
        reason: 'Deterministic weaponization-request rule matched.',
    },
    'safety.professional.medical_or_legal_advice.v1': {
        action: 'safe_partial',
        safetyTier: 'Medium',
        reasonCode: 'professional_advice_guardrail',
        reason: 'Deterministic professional-advice guardrail rule matched.',
    },
} as const;
