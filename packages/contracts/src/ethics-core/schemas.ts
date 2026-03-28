/**
 * @description: Shared Zod schemas for deterministic safety breaker metadata.
 * @footnote-scope: interface
 * @footnote-module: EthicsCoreSchemaContracts
 * @footnote-risk: medium - Schema drift here can break cross-package metadata validation.
 * @footnote-ethics: high - Breaker metadata correctness is required for auditable safety behavior.
 */

import { z } from 'zod';

export const RiskRuleIdSchema = z.enum([
    'risk.self_harm.crisis_intent.v1',
    'risk.safety.weaponization_request.v1',
    'risk.professional.medical_or_legal_advice.v1',
]);

export const SafetyBreakerActionSchema = z.enum([
    'allow',
    'block',
    'redirect',
    'safe_partial',
    'human_review',
]);

export const SafetyBreakerReasonCodeSchema = z.enum([
    'self_harm_crisis_intent',
    'weaponization_request',
    'professional_advice_guardrail',
]);

export const SafetyBreakerOutcomeSchema = z.discriminatedUnion('action', [
    z
        .object({
            action: z.literal('allow'),
            ruleId: z.null(),
        })
        .strict(),
    z
        .object({
            action: z.enum(['block', 'redirect', 'safe_partial', 'human_review']),
            ruleId: RiskRuleIdSchema,
            reasonCode: SafetyBreakerReasonCodeSchema,
            reason: z.string().min(1),
        })
        .strict(),
]);
