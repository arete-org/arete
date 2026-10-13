import { readableError } from '@/lib/utils';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Sparkles } from 'lucide-react';
import { FitDropzone } from '@/components';
import { Button, Panel } from '@/components/ui';
import { ManualCardioModal } from './ManualCardioModal';
import { garminApi, tipsApi, type PostSessionFeedback } from '@/lib/api';
import { RecentSessions } from './RecentSessions';
import { invalidateAfterSession } from '@/lib/queryKeys';

interface Upload {
  filename: string;
  status: 'success' | 'error' | 'uploading';
  message?: string;
}


export function CardioTab({ showManual, onManualChange }: { showManual: boolean; onManualChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [recentUploads, setRecentUploads] = useState<Upload[]>([]);
  const [feedback, setFeedback] = useState<PostSessionFeedback | null>(null);
  const [feedbackError, setFeedbackError] = useState(false);
  // The coach reads the session before answering, which takes seconds, not
  // milliseconds. Say so rather than leaving the page looking finished.
  const [feedbackPending, setFeedbackPending] = useState(false);

  // Shared by the FIT upload and the manual entry.
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

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      setRecentUploads((prev) => [{ filename: file.name, status: 'uploading' }, ...prev]);
      try {
        return await garminApi.uploadFit(file);
      } finally {
        setRecentUploads((prev) => prev.filter((u) => u.status !== 'uploading'));
      }
    },
    onSuccess: async (result) => {
      setRecentUploads((prev) => [
        { filename: result.filename || 'activite.fit', status: 'success', message: 'Importé' },
        ...prev,
      ]);
      invalidateAfterSession(queryClient);
      if (result.activity_id) await requestFeedback(result.activity_id);
    },
    onError: (error) => {
      setRecentUploads((prev) => [
        { filename: 'import', status: 'error', message: readableError(error) },
        ...prev,
      ]);
    },
  });

  return (
    <div className="space-y-4 sm:space-y-8">
      <Panel
        title={
          <span className="flex items-center justify-between gap-2 w-full">
            IMPORTER UNE SÉANCE CARDIO
            <Button variant="ghost" onClick={() => onManualChange(true)}>
              <Plus className="w-4 h-4" />
              SANS MONTRE
            </Button>
          </span>
        }
        animate={false}
      >
        <FitDropzone
          onUpload={async (file) => uploadMutation.mutate(file)}
          isUploading={uploadMutation.isPending}
          recentUploads={recentUploads}
        />
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
              {feedback.source === 'agent' ? 'LE COACH' : 'CALCULÉ À PARTIR DE LA SÉANCE'}
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
        onCreated={(id) => void requestFeedback(id)}
      />
    </div>
  );
}
