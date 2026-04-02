/**
 * @description: Shared Zod schemas for deterministic safety breaker metadata.
 * @footnote-scope: interface
 * @footnote-module: EthicsCoreSchemaContracts
 * @footnote-risk: medium - Schema drift here can break cross-package metadata validation.
 * @footnote-ethics: high - Breaker metadata correctness is required for auditable safety behavior.
 */

import { z } from 'zod';
import { SAFETY_RULE_METADATA } from './safetyRuleMetadata.js';

const SafetyTierSchema = z.enum(['Low', 'Medium', 'High']);

export const SafetyRuleIdSchema = z.custom<keyof typeof SAFETY_RULE_METADATA>(
    (value) =>
        typeof value === 'string' && Object.hasOwn(SAFETY_RULE_METADATA, value),
    {
        message: 'Unknown deterministic safety rule id.',
    }
);

export const SafetyActionSchema = z.enum([
    'allow',
    'block',
    'redirect',
    'safe_partial',
    'human_review',
]);

export const SafetyReasonCodeSchema = z.enum([
    'self_harm_crisis_intent',
    'weaponization_request',
    'professional_advice_guardrail',
]);

export const SafetyDecisionSchema = z.discriminatedUnion('action', [
    z
        .object({
            action: z.literal('allow'),
            safetyTier: SafetyTierSchema,
            ruleId: z.null(),
        })
        .strict(),
    z
        .object({
            action: z.enum([
                'block',
                'redirect',
                'safe_partial',
                'human_review',
            ]),
            safetyTier: SafetyTierSchema,
            ruleId: SafetyRuleIdSchema,
            reasonCode: SafetyReasonCodeSchema,
            reason: z.string().min(1),
        })
        .superRefine((value, context) => {
            const expected = SAFETY_RULE_METADATA[value.ruleId];
            if (!expected) {
                return;
            }

            if (value.safetyTier !== expected.safetyTier) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['safetyTier'],
                    message: `safetyTier "${value.safetyTier}" does not match canonical rule tuple for "${value.ruleId}" (expected "${expected.safetyTier}").`,
                });
            }

            if (value.action !== expected.action) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['action'],
                    message: `action "${value.action}" does not match canonical rule tuple for "${value.ruleId}" (expected "${expected.action}").`,
                });
            }

            if (value.reasonCode !== expected.reasonCode) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['reasonCode'],
                    message: `reasonCode "${value.reasonCode}" does not match canonical rule tuple for "${value.ruleId}" (expected "${expected.reasonCode}").`,
                });
            }
        })
        .strict(),
]);
