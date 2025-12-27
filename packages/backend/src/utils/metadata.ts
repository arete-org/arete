/**
 * @description: Extracts and parses metadata appended to AI responses.
 * @arete-scope: utility
 * @arete-module: ResponseMetadataParser
 * @arete-risk: moderate - Parsing failures can drop provenance data but should not block responses.
 * @arete-ethics: moderate - Incorrect parsing could misreport provenance or confidence to users.
 */
import { logger } from '../shared/logger';

// --- Marker configuration ---
const METADATA_MARKER = '<ARETE_METADATA>';

type MetadataParseResult = {
  normalizedText: string;
  metadata: Record<string, unknown> | null;
};

/**
 * Extracts text and metadata from AI response that may contain <ARETE_METADATA> payload.
 */
function extractTextAndMetadata(rawOutputText: string | null | undefined): MetadataParseResult {
  // Guard against null/empty responses.
  if (!rawOutputText) {
    return { normalizedText: '', metadata: null };
  }

  // --- Marker detection ---
  // Look for the last metadata marker to tolerate extra content.
  const markerIndex = rawOutputText.lastIndexOf(METADATA_MARKER);
  if (markerIndex === -1) {
    return { normalizedText: rawOutputText.trimEnd(), metadata: null };
  }

  // --- Split response ---
  // Split response into conversational text + metadata block.
  const conversationalPortion = rawOutputText.slice(0, markerIndex).trimEnd();
  let metadataCandidate = rawOutputText.slice(markerIndex + METADATA_MARKER.length).trim();

  // --- Markdown cleanup ---
  // Strip code fences when the model wraps JSON in markdown.
  metadataCandidate = metadataCandidate.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  metadataCandidate = metadataCandidate.replace(/^```\s*/, '').replace(/\s*```$/, '');

  // --- Empty payload guard ---
  // Treat empty payloads as missing metadata.
  if (!metadataCandidate) {
    return { normalizedText: conversationalPortion, metadata: null };
  }

  // --- JSON parsing ---
  try {
    const parsed = JSON.parse(metadataCandidate) as Record<string, unknown>;
    return { normalizedText: conversationalPortion, metadata: parsed };
  } catch (error) {
    logger.warn(`Failed to parse assistant metadata payload: ${error instanceof Error ? error.message : String(error)}`);
    return { normalizedText: conversationalPortion, metadata: null };
  }
}

export { METADATA_MARKER, extractTextAndMetadata };


