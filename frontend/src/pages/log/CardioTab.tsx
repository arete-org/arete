import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Sparkles } from 'lucide-react';
import { ActivityDropzone } from '@/components';
import { Button, Panel } from '@/components/ui';
import { ManualCardioModal } from './ManualCardioModal';
import { tipsApi, type PostSessionFeedback } from '@/lib/api';
import type { ImportResult } from '@/lib/activityImport';
import { RecentSessions } from './RecentSessions';
import { invalidateAfterSession } from '@/lib/queryKeys';
import { useCoachWords } from '@/lib/coachName';

export function CardioTab({ showManual, onManualChange, onManualSaved }: {
  showManual: boolean;
  /** Opens the manual entry, or dismisses it. */
  onManualChange: (open: boolean) => void;
  /** Closes the manual entry after a save. */
  onManualSaved: () => void;
}) {
  const coach = useCoachWords();
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<PostSessionFeedback | null>(null);
  const [feedbackError, setFeedbackError] = useState(false);
  // The coach reads the session before answering, which takes seconds, not
  // milliseconds. Say so rather than leaving the page looking finished.
  const [feedbackPending, setFeedbackPending] = useState(false);

  // Shared by the file import and the manual entry.
  const requestFeedback = async (id: number) => {
    setFeedback(null);
    setFeedbackError(false);
    setFeedbackPending(true);
    try {
      setFeedback(await tipsApi.getPostSession('cardio', id));
    } catch {
      setFeedbackError(true); // best-effort, but say so
    } finally {
      setFeedbackPending(false);
    }
  };

  const onImported = (results: ImportResult[]) => {
    const imported = results.filter((r) => r.status === 'imported' && r.session_id);
    if (imported.length === 0) return;
    invalidateAfterSession(queryClient);
    // One session gets the coach's word now; a batch waits for the daily feedback.
    if (imported.length === 1) void requestFeedback(imported[0].session_id!);
  };

  return (
    <div className="space-y-4 sm:space-y-8">
      <Panel
        title={
          <span className="flex items-center justify-between gap-2 w-full">
            Importer une activité
            <Button variant="ghost" onClick={() => onManualChange(true)}>
              <Plus className="w-4 h-4" />
              Sans montre
            </Button>
          </span>
        }
        animate={false}
      >
        <ActivityDropzone onImported={onImported} />
      </Panel>

      {feedbackPending && (
        <p className="text-sm font-sans text-text-muted flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin text-neon-cyan" />
          Le coach regarde ta séance…
        </p>
      )}

      {feedback && (
        <Panel
          title={
            <span className="flex items-center gap-2">
              <Sparkles className="w-4 h-4" />
              {feedback.source === 'agent' ? `Le regard ${coach.of}` : 'Calculé à partir de la séance'}
            </span>
          }
          titleTone="text-neon-cyan"
        >
          <p className="text-sm font-sans text-text-secondary mb-3">{feedback.feedback}</p>
          {feedback.highlights.length > 0 && (
            <ul className="space-y-1">
              {feedback.highlights.map((h, i) => (
                <li key={i} className="text-xs font-sans text-text-muted flex items-start gap-2">
                  <span className="text-neon-cyan mt-0.5">▸</span>
                  {h}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {feedbackError && (
        <p className="text-xs font-sans text-text-muted">Le coach n'a pas pu commenter cette séance.</p>
      )}

      <RecentSessions />
      <ManualCardioModal
        open={showManual}
        onClose={() => onManualChange(false)}
        onCreated={(id) => { onManualSaved(); void requestFeedback(id); }}
      />
    </div>
  );
}
