import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUp, Loader2, SmilePlus } from 'lucide-react';
import { FeedbackRating } from './FeedbackRating';
import { cn } from '@/lib/utils';
import { EMPTY_FEEDBACK, isEmoji, readFeedback, writeFeedback, type FeedbackKey, type MessageFeedback as Feedback, type TraceReceipt } from '@/lib/agentFeedback';

const REACTIONS = ['🎯', '💪', '🔥', '🤔', '❤️', '🙌'];
const BUTTON = 'coach-feedback-action';

export function MessageFeedback({ trace, threadId, feedback, onChange }: {
  trace: TraceReceipt;
  threadId: string;
  feedback?: Feedback;
  onChange: (feedback: Feedback) => void;
}) {
  const [picker, setPicker] = useState(false);
  const [emoji, setEmoji] = useState('');
  const [validation, setValidation] = useState('');
  const inFlight = useRef(false);
  const pickerRef = useRef<HTMLFormElement>(null);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const pickerId = useId();
  const current = feedback ?? { ...EMPTY_FEEDBACK, status: 'saved' as const };
  const pending = current.status === 'pending';
  const uncertain = current.status === 'uncertain';
  const blocked = pending || uncertain;
  useEffect(() => {
    // The picker lives in the scrollable conversation, including on mobile.
    if (picker) pickerRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [picker]);
  function closePicker() {
    setPicker(false);
    pickerButton.current?.focus();
  }

  async function submit(key: FeedbackKey, value: 0 | 1 | string | null) {
    if (inFlight.current || blocked) return;
    inFlight.current = true;
    setPicker(false);
    onChange({ ...current, status: 'pending' });
    try {
      await writeFeedback(trace, threadId, key, value);
      onChange({ ...current, [key]: value, status: 'saved' });
    } catch {
      // A timeout cannot prove that the remote write failed. Read before retry.
      onChange({ ...current, status: 'uncertain' });
    } finally { inFlight.current = false; }
  }

  async function verify() {
    if (inFlight.current || pending) return;
    inFlight.current = true;
    onChange({ ...current, status: 'pending' });
    try { onChange({ ...await readFeedback(trace, threadId), status: 'saved' }); }
    catch { onChange({ ...current, status: 'uncertain' }); }
    finally { inFlight.current = false; }
  }

  function react(value: string) {
    if (!isEmoji(value)) { setValidation('Choisis un seul emoji.'); return; }
    setValidation('');
    void submit('reaction', current.reaction === value ? null : value);
  }

  return <div className="contents" role="group" aria-label="Donner un avis sur cette réponse">
    <div className="inline-flex items-center gap-0.5">
      <FeedbackRating value={current.user_score} disabled={blocked} onChange={score => void submit('user_score', score)} />
      {current.reaction && <button type="button" disabled={blocked} className={cn(BUTTON, 'bg-neon-cyan/10 text-lg')}
        aria-label={`Retirer la réaction ${current.reaction}`} onClick={() => void submit('reaction', null)}>{current.reaction}</button>}
      <button ref={pickerButton} type="button" className={BUTTON} disabled={blocked} aria-label="Choisir une réaction" title="Choisir une réaction"
        aria-expanded={picker} aria-controls={picker ? pickerId : undefined} onClick={() => { setPicker(!picker); setValidation(''); }}><SmilePlus className="size-4" /></button>
      {pending && <Loader2 aria-hidden="true" className="mx-1 size-3 animate-spin motion-reduce:animate-none text-text-muted" />}
      <span role="status" className="sr-only">{pending ? 'Envoi…' : !uncertain && feedback ? 'Enregistré' : ''}</span>
    </div>
    {picker && <div className="order-last mt-1 basis-full"><form ref={pickerRef} id={pickerId} aria-label="Choisir un emoji" className="w-full max-w-64 rounded-lg border border-text-muted/15 bg-abyss p-2"
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); closePicker(); } }}
      onSubmit={e => { e.preventDefault(); react(emoji.trim()); }}>
      <div className="grid grid-cols-6 gap-0.5">{REACTIONS.map(value => <button key={value} type="button" aria-label={`Réagir avec ${value}`}
        className="flex min-h-8 items-center justify-center rounded-md text-lg hover:bg-shadow focus-visible:outline-2 focus-visible:outline-neon-cyan [@media(pointer:coarse)]:min-h-10"
        onClick={() => react(value)}>{value}</button>)}</div>
      <div className="mt-1 flex items-center gap-1 border-t border-text-muted/10 pt-1">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Ou colle ton emoji</span>
          <input value={emoji} onChange={e => setEmoji(e.target.value)} maxLength={64} placeholder="Autre emoji…" className="h-8 w-full rounded-md bg-transparent px-2 text-sm text-text-primary focus:outline-neon-cyan" />
        </label>
        <button type="submit" aria-label="Ajouter la réaction" title="Ajouter la réaction" className={BUTTON}><ArrowUp className="size-4" /></button>
      </div>
      {validation && <p role="alert" className="mt-2 text-xs text-danger-red">{validation}</p>}
    </form></div>}
    {uncertain && <div role="alert" className="order-last mt-1 basis-full text-xs text-warning-orange">
      <p>Enregistrement non confirmé. Vérifie le retour avant de le renvoyer.</p>
      <button type="button" className="min-h-11 underline underline-offset-2" onClick={() => void verify()}>Vérifier le retour enregistré</button>
    </div>}
  </div>;
}
