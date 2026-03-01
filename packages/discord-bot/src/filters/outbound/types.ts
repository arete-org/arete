/**
 * @description: Shared types for outbound message filters and pipeline composition.
 * @footnote-scope: interface
 * @footnote-module: OutboundFilterTypes
 * @footnote-risk: low - Typing mismatches could hide filter output errors.
 * @footnote-ethics: low - Type safety affects developer clarity more than user impact.
 */

export interface OutboundFilterResult {
    content: string;
    changes: string[];
}

// Outbound filters operate on plain text and describe their edits for logging.
export type OutboundFilter = (content: string) => OutboundFilterResult;

