/**
 * @description: Shared types for outbound message filters and pipeline composition.
 * @arete-scope: interface
 * @arete-module: OutboundFilterTypes
 * @arete-risk: low - Typing mismatches could hide filter output errors.
 * @arete-ethics: low - Type safety affects developer clarity more than user impact.
 */

export interface OutboundFilterResult {
    content: string;
    changes: string[];
}

// Outbound filters operate on plain text and describe their edits for logging.
export type OutboundFilter = (content: string) => OutboundFilterResult;
