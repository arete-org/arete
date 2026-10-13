import { inputClasses } from '@/components/ui/Input';
import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { documentRequest, type Prescription, type WorkoutStep, type Target } from '@/lib/documents';
import { formatClock, formatPace, parseClock, parsePace } from '@/lib/utils';

const inputClass = inputClasses('cyan', 'text-sm');
const kinds = { warmup: 'Échauffement', effort: 'Effort', recovery: 'Récupération', cooldown: 'Retour au calme', rest: 'Repos', repeat: 'Répéter un bloc' };
const units = { seconds: 'Durée', meters: 'Mètres', reps: 'Répétitions', lap: 'Appui sur Lap' };
const targets = { pace_sec_km: 'Allure (min/km)', heart_rate_bpm: 'FC (bpm)', power_w: 'Puissance (W)', cadence_rpm: 'Cadence (/min)', hr_zone: 'Zone FC (1 à 5)' };
const newStep = (): WorkoutStep => ({ kind: 'effort', duration_kind: 'seconds', value: 60, steps: [] });
const paceText = (seconds: number) => formatPace(seconds, "'");

/** Typed as the athlete writes it; the step only takes a value that reads in full (null otherwise). */
function NotationInput({ label, value, format, parse, error, onChange }: { label: string; value: number | null; format: (value: number) => string; parse: (text: string) => number | null; error: string; onChange: (value: number | null) => void }) {
  const [draft, setDraft] = useState<{ text: string; value: number | null } | null>(null);
  // A step moved, or a value changed elsewhere, shows the stored value again.
  const text = draft && draft.value === value ? draft.text : value === null ? '' : format(value);
  const invalid = parse(text) === null;
  return <label className="text-xs">{label}
    <input className={inputClass} value={text} aria-invalid={invalid} onChange={e => {
      const parsed = parse(e.target.value);
      setDraft({ text: e.target.value, value: parsed });
      onChange(parsed);
    }} onBlur={() => { if (!invalid && value !== null) setDraft(null); }} />
    {invalid && <span role="alert" className="mt-1 block text-danger-red">{error}</span>}
  </label>;
}

function TargetEditor({ value, onChange, label }: { value?: Target | null; onChange: (value: Target | null) => void; label: string }) {
  return <fieldset className="space-y-1"><legend className="text-xs">{label}</legend>
    <select aria-label={label} className={inputClass} value={value?.kind ?? ''} onChange={e => onChange(e.target.value ? { kind: e.target.value as Target['kind'], low: 1, high: 1 } : null)}>
      <option value="">Sans cible</option>{Object.entries(targets).map(([id, text]) => <option key={id} value={id}>{text}</option>)}
    </select>
    {value && <div className="grid grid-cols-2 gap-2">
      {value.kind === 'pace_sec_km' ? (['low', 'high'] as const).map(bound => <NotationInput key={bound} label={bound === 'low' ? 'Minimum' : 'Maximum'} value={value[bound] || null} format={paceText} parse={parsePace} error="Allure attendue en m'ss (3'30)." onChange={pace => onChange({ ...value, [bound]: pace ?? 0 })} />) : <>
        <label className="text-xs">Minimum<input className={inputClass} type="number" min="1" step="any" value={value.low} onChange={e => onChange({ ...value, low: Number(e.target.value) })} /></label>
        <label className="text-xs">Maximum<input className={inputClass} type="number" min="1" step="any" value={value.high} onChange={e => onChange({ ...value, high: Number(e.target.value) })} /></label>
      </>}
    </div>}
  </fieldset>;
}

function StepsEditor({ steps, sport, onChange, depth = 0, exerciseList }: { steps: WorkoutStep[]; sport: string; onChange: (steps: WorkoutStep[]) => void; depth?: number; exerciseList: string }) {
  const move = (index: number, direction: number) => {
    const next = [...steps];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    onChange(next);
  };
  const patch = (index: number, change: Partial<WorkoutStep>) => onChange(steps.map((s, i) => i === index ? { ...s, ...change } : s));
  return <div className="space-y-3">{steps.map((step, index) => <details key={index} className="rounded border border-text-muted/20 p-3 space-y-3">
    <summary className="cursor-pointer min-h-11 text-sm font-medium flex items-center">{index + 1}. {kinds[step.kind]} · {step.kind === 'repeat' ? `${step.repeat} fois` : step.duration_kind === 'lap' ? 'Appui sur Lap' : step.duration_kind === 'seconds' && step.value ? formatClock(step.value) : `${step.value ?? "—"} ${step.duration_kind === 'seconds' ? 's' : step.duration_kind === 'meters' ? 'm' : 'répétitions'}`}</summary>
    <div className="flex flex-wrap gap-3 text-xs"><button type="button" disabled={index === 0} aria-label={`Monter l’étape ${index + 1}`} onClick={() => move(index, -1)}>↑ Monter</button><button type="button" disabled={index === steps.length - 1} aria-label={`Descendre l’étape ${index + 1}`} onClick={() => move(index, 1)}>↓ Descendre</button></div>
    <div className="flex gap-2"><select aria-label={`Type de l’étape ${index + 1}`} className={inputClass} value={step.kind} onChange={e => {
      const kind = e.target.value as WorkoutStep['kind'];
      patch(index, kind === 'repeat' ? { ...newStep(), kind, repeat: 2, value: null, duration_kind: 'lap', steps: [newStep()], target: null, secondary_target: null, exercise: '', weight_kg: null, stroke: null, skip_last_recovery: true } : { kind, repeat: null, steps: [], skip_last_recovery: null });
    }}>{Object.entries(kinds).filter(([id]) => id !== 'repeat' || depth < 2).map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select>
      <button type="button" aria-label={`Supprimer l’étape ${index + 1}`} className="text-danger-red text-xs" onClick={() => onChange(steps.filter((_, i) => i !== index))}>Supprimer</button></div>
    {step.kind === 'repeat' ? <>
      <label className="text-xs">Nombre de répétitions<input className={inputClass} type="number" min="2" max="100" value={step.repeat ?? 2} onChange={e => patch(index, { repeat: Number(e.target.value) })} /></label>
      <label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" className="size-4 accent-neon-cyan" checked={step.skip_last_recovery === true} onChange={e => patch(index, { skip_last_recovery: e.target.checked })} />Ne pas faire la dernière récup</label>
      <StepsEditor steps={step.steps} sport={sport} depth={depth + 1} exerciseList={exerciseList} onChange={children => patch(index, { steps: children })} />
    </> : <>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs">Fin de l’étape<select className={inputClass} value={step.duration_kind} onChange={e => patch(index, { duration_kind: e.target.value as WorkoutStep['duration_kind'], value: e.target.value === 'lap' ? null : step.value ?? 1 })}>{Object.entries(units).map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></label>
        {step.duration_kind === 'seconds' ? <NotationInput label="Durée (mm:ss)" value={step.value ?? null} format={formatClock} parse={parseClock} error="Durée attendue en mm:ss (20:00) ou en minutes (20)." onChange={value => patch(index, { value })} />
          : step.duration_kind !== 'lap' && <label className="text-xs">Valeur<input className={inputClass} type="number" min="1" step="any" value={step.value ?? ''} onChange={e => patch(index, { value: Number(e.target.value) })} /></label>}
      </div>
      {sport === 'strength' && <div className="space-y-2">
        <label className="block text-xs">Exercice<input className={inputClass} value={step.exercise ?? ''} onChange={e => patch(index, { exercise: e.target.value })} /></label>
        <label className="block text-xs">Correspondance Garmin<input className={inputClass} list={exerciseList} value={step.garmin_exercise ?? ''} placeholder="Choisir le nom exact du catalogue" onChange={e => patch(index, { garmin_exercise: e.target.value })} /></label>
        <label className="block text-xs">Charge (kg)<input className={inputClass} type="number" min="0" step="0.5" value={step.weight_kg ?? ''} onChange={e => patch(index, { weight_kg: e.target.value === '' ? null : Number(e.target.value) })} /></label>
      </div>}
      {sport === 'swimming' && <label className="block text-xs">Nage<select className={inputClass} value={step.stroke ?? ''} onChange={e => patch(index, { stroke: (e.target.value || null) as WorkoutStep['stroke'] })}><option value="">Non précisée</option><option value="free">Libre</option><option value="back">Dos</option><option value="breast">Brasse</option><option value="butterfly">Papillon</option><option value="mixed">Mixte</option></select></label>}
      <TargetEditor label="Cible" value={step.target} onChange={target => patch(index, { target })} />
      <TargetEditor label="Cible secondaire" value={step.secondary_target} onChange={secondary_target => patch(index, { secondary_target })} />
      <label className="block text-xs">Consignes<input className={inputClass} value={step.notes ?? ''} maxLength={500} onChange={e => patch(index, { notes: e.target.value })} /></label>
    </>}
  </details>)}
    <button type="button" className="text-neon-cyan text-sm" disabled={steps.length >= 100} onClick={() => onChange([...steps, newStep()])}>+ Ajouter une étape</button>
  </div>;
}

export function PrescriptionEditor({ value, sport, onChange }: { value: Prescription; sport: string; onChange: (value: Prescription) => void }) {
  const exerciseList = useId();
  const exercises = useQuery({ queryKey: ['garmin-exercise-catalog'], queryFn: () => documentRequest<{ name: string }[]>('/garmin/workout-exercises'), enabled: sport === 'strength', staleTime: Infinity, retry: false });
  return <div className="space-y-3">
    {sport === 'swimming' && <label className="block text-xs">Longueur du bassin (m)<input className={inputClass} type="number" min="1" max="100" value={value.pool_length_m ?? ''} onChange={e => onChange({ ...value, pool_length_m: Number(e.target.value) })} /></label>}
    {exercises.error && <p role="alert" className="text-danger-red text-xs">Catalogue Garmin indisponible : {exercises.error.message}</p>}
    <datalist id={exerciseList}>{exercises.data?.map(e => <option value={e.name} key={e.name} />)}</datalist>
    <StepsEditor steps={value.steps} sport={sport} exerciseList={exerciseList} onChange={steps => onChange({ ...value, steps })} />
  </div>;
}
