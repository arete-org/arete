/**
 * @description: Minimal OpenAI client wrapper and response metadata builder for reflect API.
 * @arete-scope: utility
 * @arete-module: ReflectOpenAIService
 * @arete-risk: high - Incorrect handling can degrade responses or metadata integrity.
 * @arete-ethics: high - Misreported provenance impacts trust and transparency.
 */
import crypto from 'node:crypto';
import { extractTextAndMetadata } from '../utils/metadata';
import { runtimeConfig } from '../config';
import { logger } from '../shared/logger';
import type { ResponseMetadata, Provenance, Citation, RiskTier } from '../ethics-core';

// --- OpenAI response typing ---
type OpenAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type ParsedMetadata = {
  confidence?: number;
  provenance?: string;
  tradeoffCount?: number;
  citations?: unknown[];
};

type OpenAIResponseMetadata = {
  model: string;
  usage?: OpenAIUsage;
  finishReason?: string;
  reasoningEffort?: string;
  verbosity?: string;
  channelContext?: { channelId: string };
} & ParsedMetadata;

type GenerateResponseResult = {
  normalizedText: string;
  metadata: OpenAIResponseMetadata;
};

// --- OpenAI client wrapper ---
class SimpleOpenAIService {
  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;
  private readonly retryAttempts: number;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.requestTimeoutMs = 15000;
    this.retryAttempts = 1;
  }

  async generateResponse(
    model: string,
    messages: Array<{ role: string; content: string }>
  ): Promise<GenerateResponseResult> {
    const requestBody = JSON.stringify({
      model: model,
      messages: messages,
      max_completion_tokens: 4000
    });

    const performRequest = async (attempt: number): Promise<Response> => {
      let abortSignal: AbortSignal;
      try {
        abortSignal = AbortSignal.timeout(this.requestTimeoutMs);
      } catch {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), this.requestTimeoutMs);
        abortSignal = controller.signal;
      }

      try {
        // Abort slow upstream calls to keep /api/reflect from hanging indefinitely.
        return await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: requestBody,
          signal: abortSignal
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`OpenAI request timed out after ${this.requestTimeoutMs}ms`);
        }

        // Small backoff for transient transport failures.
        if (attempt < this.retryAttempts) {
          const backoffMs = 300 * (attempt + 1);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          return performRequest(attempt + 1);
        }

        throw error;
      }
    };

    // --- OpenAI request ---
    // Build the request payload for the chat completions API.
    let response = await performRequest(0);
    let retryCount = 0;
    while (!response.ok && response.status >= 500 && retryCount < this.retryAttempts) {
      const backoffMs = 300 * (retryCount + 1);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
      retryCount += 1;
      response = await performRequest(retryCount);
    }

    // --- Transport error handling ---
    if (!response.ok) {
      // Log provider errors to help debug auth/limit issues.
      const errorText = await response.text();
      logger.error(`OpenAI API error details: ${errorText}`);
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    // --- Response parsing ---
    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content || 'I was unable to generate a response.';

    // --- Metadata inspection (no user content) ---
    // Debug metadata extraction without logging full user content.
    logger.debug('=== Raw AI Response Debug ===');
    logger.debug(`Raw content length: ${rawContent.length}`);
    logger.debug(`Contains ARETE_METADATA: ${rawContent.includes('<ARETE_METADATA>')}`);
    if (rawContent.includes('<ARETE_METADATA>')) {
      const metadataStart = rawContent.indexOf('<ARETE_METADATA>');
      logger.debug(`Metadata block: ${rawContent.substring(metadataStart, metadataStart + 200)}`);
    }
    logger.debug('============================');

    // --- Metadata extraction ---
    // Extract the <ARETE_METADATA> block without leaking it into the user-visible response.
    const { normalizedText, metadata: parsedMetadata } = extractTextAndMetadata(rawContent);

    // --- Metadata normalization ---
    // Normalize the optional metadata fields into a predictable structure.
    const parsed = parsedMetadata as ParsedMetadata | null;
    const assistantMetadata: OpenAIResponseMetadata = {
      model: model,
      usage: data.usage as OpenAIUsage,
      finishReason: data.choices?.[0]?.finish_reason,
      ...(parsed && {
        ...(typeof parsed.confidence === 'number' &&
            parsed.confidence >= 0 &&
            parsed.confidence <= 1 && {
              confidence: parsed.confidence
            }),
        provenance: parsed.provenance,
        tradeoffCount: parsed.tradeoffCount,
        citations: parsed.citations
      })
    };

    return {
      normalizedText: normalizedText,
      metadata: assistantMetadata
    };
  }
}

// --- Metadata normalization ---
type ResponseMetadataRuntimeContext = {
  modelVersion: string;
  conversationSnapshot: string;
};

const buildResponseMetadata = (
  assistantMetadata: OpenAIResponseMetadata,
  runtimeContext: ResponseMetadataRuntimeContext
): ResponseMetadata => {
  // --- Deterministic identifiers ---
  const responseId = crypto.randomBytes(6).toString('base64url').slice(0, 8);
  const chainHash = crypto.createHash('sha256')
    .update(runtimeContext.conversationSnapshot)
    .digest('hex')
    .substring(0, 16);
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

  // --- Defaulting for missing fields ---
  // Fail-open defaults when metadata is missing.
  const provenance = (assistantMetadata.provenance as Provenance) || 'Inferred';
  const confidence = typeof assistantMetadata.confidence === 'number'
    ? assistantMetadata.confidence
    : 0;
  const tradeoffCount = typeof assistantMetadata.tradeoffCount === 'number'
    ? assistantMetadata.tradeoffCount
    : 0;
  const citations = Array.isArray(assistantMetadata.citations)
    ? (assistantMetadata.citations as Citation[])
    : [];

  // --- Static policy fields ---
  const riskTier: RiskTier = 'Low';
  const licenseContext = 'MIT + HL3';

  // Persist a compact ResponseMetadata payload for downstream trace storage.
  return {
    responseId,
    provenance,
    confidence,
    riskTier,
    tradeoffCount,
    chainHash,
    licenseContext,
    modelVersion: runtimeContext.modelVersion || runtimeConfig.openai.defaultModel,
    staleAfter: new Date(Date.now() + ninetyDaysMs).toISOString(),
    citations
  };
};

export type { OpenAIResponseMetadata, ResponseMetadataRuntimeContext };
export { SimpleOpenAIService, buildResponseMetadata };

