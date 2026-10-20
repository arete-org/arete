import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, AlertTriangle, Check, Loader2, Sparkles } from 'lucide-react';
import { cn, readableError } from '@/lib/utils';
import { Button, Field, Input, Modal, ModalHeader, Textarea } from '@/components/ui';
import { ApiError, strengthApi, tipsApi } from '@/lib/api';
import type { ParsedExercise, ParsedWorkout, StrengthDraft, WorkoutTranscription } from '@/types';
import { parseLocalDate, toLocalISODate } from '@/lib/dates';
import { invalidateAfterSession, qk } from '@/lib/queryKeys';
import { VoiceDictation, type VoiceDictationHandle } from './VoiceDictation';
import { RecordsCelebration, SuggestionNote } from './progression';
import { useCoachWords } from '@/lib/coachName';

const today = () => toLocalISODate();

/** The catalog exercise a typed name was read as, in French; null when it is the typed name. */
function readAs(ex: ParsedExercise): string | null {
  const match = ex.suggestions?.find((s) => s.exercise_id === ex.exercise_id);
  const name = match?.name_fr || match?.name;
  return name && name.toLowerCase() !== ex.name.toLowerCase() ? name : null;
}

interface LogSessionModalProps {
  open: boolean;
  onClose: () => void;
  /** A Garmin strength activity awaiting its loads: its text and date, saved onto it. */
  draft?: StrengthDraft | null;
}

/**
 * Paste → parse → preview → save flow for strength sessions.
 *
 * With a draft, the text opens with what Garmin recognised and the date is the
 * activity's; saving completes the draft (one session with the activity).
 */
export function LogSessionModal({ open, onClose, draft = null }: LogSessionModalProps) {
  const coach = useCoachWords();
  const queryClient = useQueryClient();
  const [workoutText, setWorkoutText] = useState(() => draft?.notation ?? '');
  const [workoutDate, setWorkoutDate] = useState(() => draft?.date ?? today());
  const [parseResult, setParseResult] = useState<ParsedWorkout | null>(null);
  const [step, setStep] = useState<'input' | 'preview' | 'saved'>('input');
  const [heard, setHeard] = useState<WorkoutTranscription | null>(null);
  const [textBeforeDictation, setTextBeforeDictation] = useState<string | null>(null);
  const dictationRef = useRef<VoiceDictationHandle>(null);

  /** Dictation is incremental: one exercise, then the next. Append, never overwrite. */
  const insertDictation = (result: WorkoutTranscription) => {
    setHeard(result);
    if (!result.notation.trim()) return;
    setWorkoutText((current) => {
      setTextBeforeDictation(current);
      const existing = current.replace(/\s+$/, '');
      return existing ? `${existing}\n${result.notation}` : result.notation;
    });
  };

  const undoDictation = () => {
    if (textBeforeDictation === null) return;
    setWorkoutText(textBeforeDictation);
    setTextBeforeDictation(null);
  };

  const parseMutation = useMutation({
    mutationFn: ({ save }: { save: boolean }) => strengthApi.parseWorkout(workoutText, workoutDate, save),
    onSuccess: (data) => {
      setParseResult(data);
      if (data.session_id) {
        setStep('saved');
        invalidateAfterSession(queryClient);
      } else {
        setStep('preview');
      }
    },
  });

  // A draft completed elsewhere (another tab, a log of that day) answers 409: nothing written.
  const completeMutation = useMutation({
    mutationFn: () => strengthApi.completeDraft(draft!.id, workoutText),
    onSuccess: (data) => {
      setParseResult((current) =>
        current && { ...current, session_id: data.session_id, message: data.message, records: data.records }
      );
      setStep('saved');
      invalidateAfterSession(queryClient);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        queryClient.invalidateQueries({ queryKey: qk.strengthDrafts });
      }
    },
  });
  // Names the catalog table does not know: listed, never pre-filled as notation.
  const freeExercises = draft?.exercises.filter((e) => !e.exercise_id) ?? [];
  const save = () => (draft ? completeMutation.mutate() : parseMutation.mutate({ save: true }));
  const saving = draft ? completeMutation.isPending : parseMutation.isPending;

  // The coach's word on the saved session; it also files it in its journal.
  const savedId = step === 'saved' ? parseResult?.session_id : undefined;
  const feedback = useQuery({
    queryKey: ['postSession', 'strength', savedId],
    queryFn: () => tipsApi.getPostSession('strength', savedId as number),
    enabled: savedId != null,
    staleTime: Infinity,
    retry: false,
  });

  const reset = () => {
    dictationRef.current?.cancel();
    setHeard(null);
    setTextBeforeDictation(null);
    setWorkoutText(draft?.notation ?? '');
    setWorkoutDate(draft?.date ?? today());
    setParseResult(null);
    completeMutation.reset();
    setStep('input');
    onClose();
  };

  const unparsed = parseResult?.unparsed_lines ?? [];

  return (
    <Modal mobileSheet open={open} onClose={reset} className="max-w-lg overflow-y-auto">
      <ModalHeader
        title={draft ? 'Ajoute tes charges' : 'Saisir une séance'}
        tone="text-neon-gold"
        icon={<Sparkles className="w-5 h-5" />}
        onClose={reset}
      />

      {step === 'input' && (
        <div className="space-y-4">
          {draft ? (
            <div className="space-y-2 text-sm text-text-muted font-sans">
              <p>
                Séance du{' '}
                {parseLocalDate(draft.date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}
                {draft.notation
                  ? '. Ajoute la charge au bout de chaque ligne («\u00a03x10@80\u00a0»), ou dicte-la.'
                  : '. Saisis ou dicte tes exercices avec leurs charges («\u00a0Squat 5x5@100\u00a0»).'}
              </p>
              {freeExercises.length > 0 && (
                <p className="text-xs">
                  Aussi vu par ta montre, à écrire avec tes mots :{' '}
                  {freeExercises.map((e) => (e.sets ? `${e.name} (${e.sets} séries)` : e.name)).join(' · ')}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-text-muted font-sans">
              Dicte ta séance ou colle-la ci-dessous. Les exercices, séries et charges sont
              extraits automatiquement.
            </p>
          )}

          <VoiceDictation
            ref={dictationRef}
            onTranscribed={insertDictation}
            disabled={parseMutation.isPending}
          />

          {!draft && (
            <Field label="Date">
              <Input
                type="date"
                accent="gold"
                value={workoutDate}
                onChange={(e) => setWorkoutDate(e.target.value)}
              />
            </Field>
          )}

          <Field label="Séance en texte libre">
            <Textarea
              accent="gold"
              aria-label="Séance en texte libre"
              value={workoutText}
              onChange={(e) => setWorkoutText(e.target.value)}
              onKeyDown={(e) => {
                // Enter inserts a line; Ctrl/Cmd+Enter runs the parser
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && workoutText.trim()) {
                  e.preventDefault();
                  parseMutation.mutate({ save: false });
                }
              }}
              placeholder={`Bench press 4x8 80kg
4x10 @60 incline db press r2'
5x(10 pull ups, 15 dips) r1'30
(dips) 3x amrap
squat 2x5@60 echauf, 5x5@100 RIR 2`}
              rows={8}
            />
          </Field>

          {heard && (
            <div className="p-3 rounded border border-neon-cyan/30 bg-neon-cyan/5 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-sans text-neon-cyan">
                  Ce qui a été entendu
                </span>
                {textBeforeDictation !== null && (
                  <button
                    type="button"
                    onClick={undoDictation}
                    className="text-[10px] font-sans text-text-muted hover:text-text-primary"
                  >
                    Annuler l'insertion
                  </button>
                )}
              </div>
              <p className="text-xs font-sans text-text-secondary italic max-h-24 overflow-y-auto">
                {heard.transcript}
              </p>
              {heard.unparsed.length > 0 && (
                <p className="text-[10px] font-sans text-warning-orange">
                  Non compris, à écrire à la main : {heard.unparsed.join(' · ')}
                </p>
              )}
            </div>
          )}

          <Button
            variant="gold"
            strong
            size="lg"
            fullWidth
            onClick={() => parseMutation.mutate({ save: false })}
            disabled={!workoutText.trim()}
            loading={parseMutation.isPending}
          >
            {parseMutation.isPending ? (
              'Analyse…'
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                Analyser
              </>
            )}
          </Button>

          {parseMutation.isError && (
            <div className="flex items-center gap-2 text-danger-red text-sm font-sans">
              <AlertCircle className="w-4 h-4" />
              {readableError(parseMutation.error) || 'Analyse impossible'}
            </div>
          )}
        </div>
      )}

      {step === 'preview' && parseResult && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-success-green text-sm font-sans">
            <Check className="w-4 h-4" />
            {parseResult.exercises.length} exercice(s) détecté(s)
          </div>

          <div className="space-y-3 max-h-[40vh] overflow-y-auto">
            {parseResult.exercises.map((ex, i) => {
              const warmups = ex.sets.filter((s) => s.is_warmup).length;
              // Describe the work, not the first warm-up.
              const work = ex.sets.find((s) => !s.is_warmup) ?? ex.sets[0];
              return (
                <div
                  key={i}
                  className={cn(
                    'p-3 rounded border bg-abyss',
                    ex.exercise_matched ? 'border-success-green/30' : 'border-warning-orange/30'
                  )}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-sans text-sm text-text-primary">{ex.name}</span>
                    {ex.exercise_matched ? (
                      <span className="text-[10px] font-sans text-success-green text-right">
                        ✓ RECONNU
                        {readAs(ex) ? ` : ${readAs(ex)}` : ''}
                      </span>
                    ) : (
                      <span className="text-[10px] font-sans text-warning-orange">⚠ INCONNU</span>
                    )}
                  </div>
                  <div className="text-xs font-sans text-text-muted">
                    {ex.sets.length - warmups} série(s) •
                    {work?.weight_kg && ` ${work.weight_kg} kg`}
                    {work?.is_failure ? " × jusqu'à l'échec" : work?.reps && ` × ${work.reps} rép.`}
                    {work?.rpe && ` @ RPE ${work.rpe}`}
                    {work?.rir != null && ` • RIR ${work.rir}`}
                    {work?.tempo && ` • tempo ${work.tempo}`}
                    {warmups > 0 && ` • + ${warmups} d'échauffement`}
                  </div>
                  {ex.progression && <SuggestionNote suggestion={ex.progression} />}
                </div>
              );
            })}
          </div>

          {unparsed.length > 0 && (
            <div className="p-3 rounded border border-warning-orange/30 bg-warning-orange/5">
              <div className="flex items-center gap-2 text-warning-orange text-xs font-sans mb-2">
                <AlertTriangle className="w-4 h-4" />
                Lignes non reconnues ({unparsed.length})
              </div>
              <ul className="space-y-1">
                {unparsed.map((line, i) => (
                  <li key={i} className="text-xs font-sans text-text-secondary truncate">
                    › {line}
                  </li>
                ))}
              </ul>
              <p className="text-[10px] font-sans text-text-muted mt-2">
                Ces lignes ne seront pas enregistrées. Corrige le texte ou vérifie la notation.
              </p>
            </div>
          )}

          <div className="flex gap-3">
            <Button variant="outline" className="flex-1" onClick={() => setStep('input')}>
              ← MODIFIER
            </Button>
            <Button
              variant="gold"
              strong
              className="flex-1"
              onClick={save}
              loading={saving}
            >
              {!saving && <Check className="w-4 h-4" />}
              Enregistrer
            </Button>
          </div>

          {completeMutation.isError && (
            <div role="alert" className="flex items-center gap-2 text-danger-red text-sm font-sans">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {readableError(completeMutation.error) || 'Enregistrement impossible'}
            </div>
          )}
        </div>
      )}

      {step === 'saved' && parseResult && (
        <div className="space-y-4 text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-success-green/20 flex items-center justify-center">
            <Check className="w-8 h-8 text-success-green" />
          </div>
          <div>
            <h4 className="font-sans text-lg text-success-green">Séance enregistrée</h4>
            <p className="text-sm font-sans text-text-muted mt-1">
              {parseResult.message || `${parseResult.exercises.length} exercice(s) enregistré(s)`}
            </p>
          </div>
          <RecordsCelebration records={parseResult.records ?? []} />
          {feedback.isLoading && (
            <p className="text-sm font-sans text-text-muted flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-neon-cyan" />
              Le coach regarde ta séance…
            </p>
          )}
          {feedback.data && (
            <div className="text-left glass-panel p-3">
              <p className="text-[11px] font-sans text-neon-cyan mb-1">
                {feedback.data.source === 'agent' ? `Le regard ${coach.of}` : 'Calculé à partir de la séance'}
              </p>
              <p className="text-sm font-sans text-text-secondary">{feedback.data.feedback}</p>
            </div>
          )}
          <Button variant="outline" strong size="lg" fullWidth onClick={reset}>
            Fermer
          </Button>
        </div>
      )}
    </Modal>
  );
}
