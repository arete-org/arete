import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertCircle, Check, Mic, Square } from 'lucide-react';
import { Button } from '@/components/ui';
import { strengthApi } from '@/lib/api';
import { cn, readableError } from '@/lib/utils';
import { useAudioRecorder, type AudioClip } from '@/hooks/useAudioRecorder';
import type { WorkoutTranscription } from '@/types';

const MAX_DURATION_MS = 120_000;

function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export interface VoiceDictationHandle {
  /** Drop the recording and release the microphone. */
  cancel: () => void;
}

interface VoiceDictationProps {
  onTranscribed: (result: WorkoutTranscription) => void;
  disabled?: boolean;
}

/**
 * Microphone button for the session box: records, sends, and hands back the
 * notation. Nothing is saved here — the athlete proof-reads first.
 */
export const VoiceDictation = forwardRef<VoiceDictationHandle, VoiceDictationProps>(
  function VoiceDictation({ onTranscribed, disabled }, ref) {
    const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    const transcribeMutation = useMutation({
      mutationFn: (clip: AudioClip) => {
        abortRef.current = new AbortController();
        return strengthApi.transcribeWorkout(clip, abortRef.current.signal);
      },
      onSuccess: onTranscribed,
    });

    const recorder = useAudioRecorder({
      maxDurationMs: MAX_DURATION_MS,
      onClip: (clip) => {
        setLastDurationMs(clip.durationMs);
        transcribeMutation.mutate(clip);
      },
    });

    useImperativeHandle(ref, () => ({
      cancel: () => {
        recorder.cancel();
        abortRef.current?.abort();
      },
    }));

    // A browser that cannot record simply does not show the button.
    if (!recorder.isSupported) return null;

    const sending = transcribeMutation.isPending;
    const busy = disabled || sending;
    const failure = recorder.error?.message ?? (
      transcribeMutation.isError ? readableError(transcribeMutation.error) : null
    );

    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          {recorder.isRecording ? (
            <>
              <Button variant="danger" strong onClick={recorder.stop}>
                <Square className="w-4 h-4" />
                Arrêter · {clock(recorder.elapsedMs)}
              </Button>
              <Button variant="outline" size="sm" onClick={recorder.cancel}>
                Annuler
              </Button>
              <span
                className="w-2 h-2 rounded-full bg-danger-red animate-pulse motion-reduce:animate-none"
                aria-hidden
              />
            </>
          ) : (
            <Button
              variant="outline"
              onClick={() => {
                transcribeMutation.reset();
                recorder.clearError();
                void recorder.start();
              }}
              disabled={busy || !recorder.isSecure}
              loading={recorder.status === 'requesting' || sending}
              aria-pressed={false}
            >
              <Mic className="w-4 h-4" />
              {sending
                ? 'Transcription…'
                : recorder.status === 'requesting'
                  ? 'Autorise le micro…'
                  : failure
                    ? 'Réessayer'
                    : 'Dicter la séance'}
            </Button>
          )}

          {sending && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => abortRef.current?.abort()}
            >
              Annuler
            </Button>
          )}
        </div>

        <p aria-live="polite" className="sr-only">
          {recorder.isRecording
            ? 'Enregistrement en cours'
            : sending
              ? 'Transcription en cours'
              : ''}
        </p>

        {!recorder.isRecording && !sending && !failure && (
          <p className="text-xs text-text-muted">
            Dis ta séance à voix haute : « développé couché, 4 séries de 8 à 80 kilos ».
          </p>
        )}

        {recorder.autoStopped && !sending && (
          <p className="text-xs text-warning-orange font-sans">
            Enregistrement arrêté à 2 min.
          </p>
        )}

        {transcribeMutation.isSuccess && !sending && !failure && (
          <p className={cn('text-xs font-sans text-success-green flex items-center gap-1')}>
            <Check className="w-3 h-3" aria-hidden />
            Dictée transcrite
            {lastDurationMs ? ` · ${clock(lastDurationMs)}` : ''}
          </p>
        )}

        {failure && (
          <p
            role="alert"
            className="text-xs font-sans text-danger-red flex items-center gap-1"
          >
            <AlertCircle className="w-3 h-3 shrink-0" aria-hidden />
            {failure}
          </p>
        )}
      </div>
    );
  }
);
