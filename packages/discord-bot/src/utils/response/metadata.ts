/**
 * @description: Builds response metadata for provenance, risk, and trace storage.
 * @arete-scope: utility
 * @arete-module: ResponseMetadataBuilder
 * @arete-risk: moderate - Metadata errors can break trace integrity or auditing.
 * @arete-ethics: moderate - Provenance accuracy affects transparency and trust.
 */
import crypto from 'crypto';
import type { ResponseMetadata, RiskTier, Provenance, Citation } from '@arete/backend/ethics-core';
import { AssistantMetadataPayload } from '../openaiService.js';

interface RuntimeContext {
  modelVersion: string;
  conversationSnapshot: string;
}

export function buildResponseMetadata(
  assistantPayload: AssistantMetadataPayload | null,
  plannerRiskTier: RiskTier,
  runtimeContext: RuntimeContext
): ResponseMetadata {
  // Generate responseId: 8 URL-safe characters derived from crypto.randomBytes
  const responseId = crypto.randomBytes(6).toString('base64url').slice(0, 8);

  // Compute chainHash: SHA-256 of conversationSnapshot, first 16 hex chars
  const chainHash = crypto.createHash('sha256').update(runtimeContext.conversationSnapshot).digest('hex').substring(0, 16);

  // Calculate staleAfter: ISO 8601 timestamp 90 days from now
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  const staleAfter = new Date(Date.now() + ninetyDaysMs).toISOString();

  // Enforce defaults
  const provenance: Provenance = assistantPayload?.provenance || 'Inferred';
  const confidence: number = assistantPayload?.confidence ?? 0.0;
  const tradeoffCount: number = assistantPayload?.tradeoffCount ?? 0;
  const citations: Citation[] = assistantPayload?.citations?.map(c => ({
    title: c.title,
    url: c.url,
    snippet: c.snippet
  })) || [];

  // Hardcoded licenseContext
  const licenseContext = 'MIT + HL3';

  // Model version from runtimeContext
  const modelVersion = runtimeContext.modelVersion;

  // Risk tier from planner
  const riskTier = plannerRiskTier;

  return {
    responseId,
    provenance,
    confidence,
    riskTier,
    tradeoffCount,
    chainHash,
    licenseContext,
    modelVersion,
    staleAfter,
    citations
  };
}

