import { isWorkoutUpdate } from './workouts';
import { isTraceReceipt, isFeedbackState } from './agentFeedback';
import {
  settleMessage,
  type ChatMessage,
  type ChatPart,
  type ToolPart,
} from './agentStream';

export const STORAGE_KEY = 'arete.coach.conversation';
const MAX_STORAGE_CHARS = 4_000_000;

/** Preserve old plain-text conversations and migrate the former tool timeline. */
export function restoreConversation(raw: string | null): ChatMessage[] {
  if (!raw) return [];
  if (raw.length > MAX_STORAGE_CHARS)
    throw new Error('Conversation sauvegardée trop volumineuse.');
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data))
    throw new Error('Conversation sauvegardée invalide.');
  return data.map((m, index) => {
    if (
      !m ||
      typeof m !== 'object' ||
      (m.role !== 'user' && m.role !== 'assistant') ||
      typeof m.content !== 'string'
    )
      throw new Error('Message sauvegardé invalide.');
    if (m.attachmentIds !== undefined && (!Array.isArray(m.attachmentIds) || m.attachmentIds.length > 20 || !m.attachmentIds.every((id: unknown) => typeof id === 'string'))) throw new Error('Pièces jointes sauvegardées invalides.');
    let parts: ChatPart[] | undefined;
    if (Array.isArray(m.parts)) {
      parts = m.parts.map((p: ChatPart) => {
        if (!p || typeof p.id !== 'string')
          throw new Error('Activité sauvegardée invalide.');
        if (p.kind === 'coach_card' && (p.ref_kind === 'fact' || p.ref_kind === 'followup') && Number.isSafeInteger(p.ref_id) && p.ref_id > 0 && p.id === `${p.ref_kind}:${p.ref_id}`) return p;
        if (p.kind === 'text' && typeof p.text === 'string') return p;
        if (p.kind === 'calendar_action' && /^[a-f0-9]{32}$/.test(p.id))
          return { kind: 'calendar_action', id: p.id };
        if (
          p.kind === 'tool' &&
          typeof p.name === 'string' &&
          ['running', 'done', 'error', 'interrupted'].includes(p.status)
        ) {
          for (const preview of [p.args, p.output]) {
            if (
              preview !== undefined &&
              (!preview ||
                typeof preview.text !== 'string' ||
                typeof preview.truncated !== 'boolean')
            )
              throw new Error('Aperçu sauvegardé invalide.');
          }
          return p;
        }
        throw new Error('Activité sauvegardée invalide.');
      });
    } else if (Array.isArray(m.steps)) {
      parts = m.steps.map(
        (
          s: { name: string; status: string; args?: string },
          i: number
        ): ToolPart => ({
          kind: 'tool',
          id: `legacy-${index}-${i}`,
          name: String(s.name),
          status: s.status === 'done' ? 'done' : 'interrupted',
          args:
            typeof s.args === 'string'
              ? { text: s.args, truncated: false }
              : undefined,
        })
      );
      if (m.content)
        parts?.push({ kind: 'text', id: `legacy-${index}`, text: m.content });
    }
    if (m.workouts !== undefined && (!Array.isArray(m.workouts) || m.workouts.length > 50 || !m.workouts.every(isWorkoutUpdate))) throw new Error('Séances sauvegardées invalides.');
    return settleMessage(
      {
        trace: m.role === 'assistant' && isTraceReceipt(m.trace) ? m.trace : undefined,
        feedback: isTraceReceipt(m.trace) && isFeedbackState(m.feedback) ? {
          ...m.feedback,
          status: m.feedback.status === 'saved' ? 'saved' : 'uncertain',
        } : undefined,
        attachmentIds: Array.isArray(m.attachmentIds) && m.attachmentIds.length <= 20 && m.attachmentIds.every((id: unknown) => typeof id === 'string') ? m.attachmentIds : undefined,
        workouts: m.workouts,
        role: m.role,
        content: m.content,
        parts,
      },
      typeof m.error === 'string' ? m.error : undefined,
      m.interrupted === true || m.pending === true
    );
  });
}
