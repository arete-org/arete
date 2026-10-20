import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Mountain, Repeat2, Target, TrendingUp, Watch } from 'lucide-react';
import { AreteWordmark } from '@/components/AreteBrand';
import { useAuthState } from '@/components/auth/authState';
import { Button } from '@/components/ui';
import { inputClasses } from '@/components/ui/Input';
import { GarminLoginModal } from '@/components/GarminLoginModal';
import { garminApi } from '@/lib/api';
import { readableError } from '@/lib/utils';
import { discussWithCoach } from '@/lib/coachToday';
import { GOALS, SPORTS, DAYS, onboardingApi, onboardingKey, newDraft, readDraft, writeDraft, clearDraft, type Answers } from '@/lib/onboarding';
import { useGarminSync } from './settings/useGarminSync';
import { GarminSyncProgress } from './settings/GarminSyncProgress';
import { useCoachWords, type CoachWords } from '@/lib/coachName';
import './onboarding.css';

const TITLES = ['Un cap qui te ressemble.', 'Du sport, dans ta vraie vie.', 'Ton histoire compte aussi.', 'La base de ton Arete.'];
const intros = (coach: CoachWords) => [`Quelques réponses pour que ${coach.the} parte de toi : ton envie, ton quotidien, tes possibilités.`, 'Le bon rythme est celui qui trouve sa place dans tes semaines. Rien n’est figé.', 'Avec Garmin, Arete peut s’appuyer sur tes activités. Tu peux aussi commencer simplement avec tes réponses.', `Voici ce que tu choisis de partager avec ${coach.the}. Relis, ajuste, puis ouvre la conversation.`];
const ICONS = { restart: Mountain, progress: TrendingUp, race: Target, consistency: Repeat2 };
const FIELD = inputClasses('cyan', 'w-full');
const nullable = (value: string) => value.trim() ? value : null;

function initial(athlete: number) {
  try { return { draft: readDraft(athlete), error: '' }; }
  catch (error) { return { draft: newDraft(), error: readableError(error) }; }
}


function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="onboarding-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function OnboardingPage() {
  const { athleteId } = useAuthState();
  if (athleteId === null) throw new Error('Athlète absent.');
  return <OnboardingFlow key={athleteId} athleteId={athleteId} />;
}

function OnboardingFlow({ athleteId }: { athleteId: number }) {
  const coach = useCoachWords();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [loaded] = useState(() => initial(athleteId));
  const [draft, setDraft] = useState(loaded.draft);
  const [storageError, setStorageError] = useState(loaded.error);
  const [storageReady, setStorageReady] = useState(!loaded.error);
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [login, setLogin] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const lock = useRef(false);
  const query = useQuery({ queryKey: onboardingKey, queryFn: onboardingApi.get, retry: false });
  const status = useQuery({ queryKey: ['syncStatus'], queryFn: garminApi.getSyncStatus, retry: false });
  const sync = useGarminSync();
  const a = draft.answers;
  const step = draft.step;
  const detectedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  useLayoutEffect(() => { heading.current?.closest('.onboarding-scroll')?.scrollTo({ top: 0 }); heading.current?.focus({ preventScroll: true }); }, [step]);
  useEffect(() => {
    if (!storageReady) return;
    try { writeDraft(athleteId, draft); setStorageError(''); }
    catch (error) { setStorageError(`Brouillon non sauvegardé sur cet appareil : ${readableError(error)}`); }
  }, [athleteId, draft, storageReady]);
  const update = (changes: Partial<Answers>) => {
    setDraft(old => ({ ...old, command_id: crypto.randomUUID(), answers: { ...old.answers, ...changes } }));
    setSaveError('');
  };
  const go = (next: number) => { setDraft(old => ({ ...old, step: next })); };
  const defer = () => {
    const next = { ...draft, deferred: true };
    try { writeDraft(athleteId, next); navigate('/'); }
    catch (error) { setStorageError(`Tes réponses restent à l’écran. Impossible de sauvegarder : ${readableError(error)}`); }
  };
  const finish = async (chiron: boolean) => {
    if (lock.current || !query.data) return;
    lock.current = true; setSaving(true); setSaveError('');
    try {
      const saved = await onboardingApi.confirm(draft, query.data.revision);
      client.setQueryData(onboardingKey, saved);
      await client.invalidateQueries({ queryKey: ['onboarding-context'] });
      try { clearDraft(athleteId); } catch { /* Durable confirmation is authoritative even if local cleanup is denied. */ }
      navigate('/');
      if (chiron) discussWithCoach({ kind: 'onboarding', id: 1 });
    } catch (error) { setSaveError(`Enregistrement non confirmé. Tes réponses sont conservées. ${readableError(error)}`); }
    finally { lock.current = false; setSaving(false); }
  };
  const dataLabel = sync.isPending ? 'Import en cours — résultat non confirmé' : sync.error || sync.data?.success === false ? 'Import interrompu — des activités peuvent avoir été enregistrées' : sync.data?.errors.length ? 'Import partiel — certaines activités n’ont pas été importées' : status.isPending ? 'Vérification des données…' : status.isError ? 'État des données indisponible' : !status.data?.garmin_authenticated ? 'Sans connexion Garmin' : `${status.data.activities_synced} activité(s) enregistrée(s) · ${status.data.last_sync ? 'dernière synchronisation disponible' : 'aucun import confirmé'}`;

  if (query.data?.status === 'completed') return <div className="onboarding-finished glass-panel"><AreteWordmark /><h1 className="page-title">Ton Arete est prêt.</h1><p>Tu as déjà terminé cette configuration. Retrouve ta mémoire actuelle avec {coach.the}, pour la compléter, la corriger ou l’oublier.</p><Button strong onClick={() => { navigate('/'); discussWithCoach({ kind: 'onboarding', id: 1 }); }}>Ouvrir {coach.the}</Button><Link to="/">Explorer Arete</Link></div>;

  return <div className="onboarding-shell">
    <header className="onboarding-header"><AreteWordmark /><Button variant="ghost" onClick={defer} disabled={saving}>Plus tard</Button></header>
    <div className="onboarding-scroll">
      <div className="onboarding-layout">
        <aside className="onboarding-intro">
          <p className="onboarding-eyebrow">Ton point de départ <span>{String(step).padStart(2, '0')} / 04</span></p>
          <ol className="onboarding-steps" aria-label="Étapes de configuration">{['Objectif', 'Rythme', 'Données', coach.name].map((label, index) => <li key={label} aria-current={step === index + 1 ? 'step' : undefined}><span className={step >= index + 1 ? 'is-current' : ''} /><span className="sr-only">{index + 1} · {label}</span></li>)}</ol>
          <h1 ref={heading} tabIndex={-1}>{TITLES[step - 1]}</h1>
          <p>{intros(coach)[step - 1]}</p>
          <div className="onboarding-note"><span>À ton rythme.</span><p>Tout reste modifiable. Les réponses non renseignées restent à préciser.</p></div>
        </aside>
        <form id="onboarding-form" className="onboarding-panel glass-panel" onSubmit={event => { event.preventDefault(); if (step < 4) go(step + 1); else void finish(true); }}>
          {query.isError && <div role="alert" className="onboarding-error">Impossible de vérifier ta configuration. <Button variant="ghost" onClick={() => void query.refetch()}>Réessayer</Button></div>}
          {storageError && <div role="alert" className="onboarding-error"><p>{storageError}</p><Button variant="ghost" onClick={() => { try { writeDraft(athleteId, draft); setStorageReady(true); setStorageError(''); } catch (error) { setStorageError(readableError(error)); } }}>{storageReady ? 'Réessayer la sauvegarde locale' : 'Remplacer le brouillon local par ces réponses'}</Button></div>}
          {step === 1 && <>
            <Field label="Ton prénom" hint="Facultatif"><input className={FIELD} autoComplete="given-name" maxLength={80} value={a.display_name ?? ''} onChange={event => update({ display_name: nullable(event.target.value) })} placeholder="Comment t’appelles-tu ?" /></Field>
            <fieldset><legend>Qu’aimerais-tu accomplir avec Arete ?</legend><div className="onboarding-goals">{Object.entries(GOALS).map(([key, [title, description]]) => {
              const value = key as keyof typeof GOALS; const Icon = ICONS[value];
              return <button type="button" key={key} aria-pressed={a.goal === key} onClick={() => update({ goal: a.goal === key ? null : value, race_name: null, race_date: null })}><span className="onboarding-choice-icon"><Icon size={22} />{a.goal === key && <Check size={18} />}</span><strong>{title}</strong><span>{description}</span></button>;
            })}</div></fieldset>
            {a.goal === 'race' && <div className="onboarding-race"><Field label="Nom de la course · facultatif"><input className={FIELD} maxLength={180} value={a.race_name ?? ''} onChange={event => update({ race_name: nullable(event.target.value) })} /></Field><Field label="Date envisagée · facultative"><input type="date" className={FIELD} value={a.race_date ?? ''} onChange={event => update({ race_date: nullable(event.target.value) })} /></Field><p className="onboarding-help">Un cap pour échanger avec {coach.the}. Aucun plan n’est créé automatiquement.</p></div>}
            <Field label="En quelques mots · facultatif"><textarea className={FIELD} rows={2} maxLength={280} value={a.description ?? ''} onChange={event => update({ description: nullable(event.target.value) })} placeholder="Ce qui te motive, ce que tu aimerais changer…" /></Field>
          </>}
          {step === 2 && <>
            <fieldset><legend>Quels sports pratiques-tu ?</legend><div className="onboarding-options">{Object.entries(SPORTS).map(([key, label]) => { const value = key as keyof typeof SPORTS; return <button type="button" key={key} aria-pressed={a.sports.includes(value)} onClick={() => update({ sports: a.sports.includes(value) ? a.sports.filter(s => s !== value) : [...a.sports, value] })}>{label}{a.sports.includes(value) && <Check size={16} />}</button>; })}</div></fieldset>
            <Field label="Combien de séances souhaites-tu par semaine ?" hint={`De 1 à 14. Laisse vide si tu préfères en parler avec ${coach.the}.`}><input className={FIELD} type="number" inputMode="numeric" min={1} max={14} value={a.weekly_training_goal ?? ''} onChange={event => update({ weekly_training_goal: event.target.value ? Number(event.target.value) : null })} placeholder="À préciser" /></Field>
            <fieldset><legend>Des jours de repos préférés ? <small>Facultatif</small></legend><div className="onboarding-days">{Object.entries(DAYS).map(([key, label]) => { const value = key as keyof typeof DAYS; return <button type="button" key={key} aria-pressed={a.rest_day_preference?.includes(value) ?? false} onClick={() => { const days = a.rest_day_preference ?? []; const next = days.includes(value) ? days.filter(d => d !== value) : [...days, value]; update({ rest_day_preference: next.length ? next : null }); }}>{label}</button>; })}</div></fieldset>
            <Field label="Tes contraintes · facultatif" hint="Horaires, disponibilité, gêne à prendre en compte… Vide signifie « à préciser »."><textarea rows={2} className={FIELD} maxLength={280} value={a.constraints ?? ''} onChange={event => update({ constraints: nullable(event.target.value) })} /></Field>
            <Field label="Ton fuseau horaire" hint={`Détecté sur cet appareil : ${detectedZone}. Confirme-le ou indique un autre fuseau.`}><input className={FIELD} maxLength={80} value={a.timezone ?? ''} placeholder={detectedZone} onChange={event => update({ timezone: nullable(event.target.value) })} /><Button variant="ghost" onClick={() => update({ timezone: detectedZone })}>{a.timezone === detectedZone ? 'Fuseau confirmé' : `Confirmer ${detectedZone}`}</Button></Field>
          </>}
          {step === 3 && <>
            <div className="onboarding-garmin"><Watch size={32} /><h2>Garmin mesure, Arete ajuste.</h2><p>Ta montre enregistre tes séances, ton sommeil et ta récupération.</p><ul><li>{coach.The} les lit pour ajuster ton plan avec toi</li><li>Tes séances planifiées peuvent partir sur ta montre</li></ul></div>
            <div className="onboarding-data-status" role="status"><strong>{status.isPending ? 'Vérification de Garmin…' : status.isError ? 'Connexion non vérifiée' : status.data?.garmin_authenticated ? 'Garmin connecté' : 'Garmin non connecté'}</strong><p>{dataLabel}</p></div>
            {status.isError ? <Button onClick={() => void status.refetch()}>Vérifier à nouveau Garmin</Button> : status.data?.garmin_authenticated ? <Button disabled={sync.isPending} onClick={() => sync.mutate({ max_activities: 20, download_fit: false })}>{sync.isPending ? 'Import en cours…' : sync.isError || sync.data?.success === false || sync.data?.errors.length ? 'Réessayer l’import' : 'Importer mes activités récentes'}</Button> : <Button disabled={status.isPending} onClick={() => setLogin(true)}>Connecter Garmin</Button>}
            <GarminSyncProgress progress={sync.progress} isPending={sync.isPending} result={sync.data} error={sync.error} />
            {sync.data?.success && !sync.data.errors.length && sync.data.activities_synced + sync.data.activities_merged + sync.data.activities_skipped === 0 && <p>Aucune activité trouvée dans cette période. Tu peux continuer.</p>}
            <p className="onboarding-help">Tu peux commencer sans Garmin. {coach.The} s’appuiera sur ce que tu lui partages.</p>
          </>}
          {step === 4 && <>
            <h2>Ce que {coach.the} retiendra de toi</h2>
            <p className="onboarding-help">Ces réponses seront enregistrées dans ta mémoire personnelle. Tu pourras demander {coach.to} de les corriger ou de les oublier.</p>
            <dl className="onboarding-summary">
              <div><dt>Toi et ton objectif <button type="button" onClick={() => go(1)}>Modifier</button></dt><dd>{a.display_name ?? 'Prénom à préciser'} · {a.goal ? GOALS[a.goal][0] : 'Objectif à préciser'}</dd>{a.description && <dd>{a.description}</dd>}{a.goal === 'race' && <dd>{a.race_name ?? 'Course à préciser'} · {a.race_date ?? 'Date à préciser'}</dd>}</div>
              <div><dt>Ton rythme <button type="button" onClick={() => go(2)}>Modifier</button></dt><dd>{a.sports.map(s => SPORTS[s]).join(', ') || 'Sports à préciser'}</dd><dd>{a.weekly_training_goal ? `${a.weekly_training_goal} séance(s) par semaine` : 'Rythme à préciser'}</dd><dd>Repos : {a.rest_day_preference?.map(d => DAYS[d]).join(', ') || 'à préciser'}</dd><dd>Contraintes : {a.constraints || 'à préciser'}</dd><dd>Fuseau : {a.timezone || 'non confirmé'}</dd></div>
              <div><dt>Tes données <button type="button" onClick={() => go(3)}>Modifier</button></dt><dd>{dataLabel}</dd></div>
            </dl>
            {sync.isPending && <p role="status">L’import n’est pas terminé. En quittant cette page, son suivi sera interrompu ; les activités déjà enregistrées resteront disponibles.</p>}
            {saveError && <div role="alert" className="onboarding-error">{saveError}<Button onClick={() => void finish(true)} disabled={saving}>Réessayer l’enregistrement</Button><Button variant="ghost" onClick={() => void query.refetch()} disabled={saving}>Vérifier le profil enregistré</Button></div>}
            <p className="onboarding-help">Ouvrir {coach.the} ne lance aucune réponse automatique. Tu choisis comment commencer.</p>
          </>}
        </form>
      </div>
    </div>
    <footer className="onboarding-footer"><div>{step > 1 ? <Button variant="ghost" onClick={() => go(step - 1)} disabled={saving}><ArrowLeft size={16} />Retour</Button> : <span /> }<Button form="onboarding-form" type="submit" strong loading={saving} disabled={!query.data}>{step === 4 ? `Enregistrer et ouvrir ${coach.the}` : step === 3 ? status.data?.garmin_authenticated ? 'Continuer' : 'Continuer sans connexion' : 'Continuer'}<ArrowRight size={16} /></Button>{step === 4 && <Button variant="ghost" disabled={saving || !query.data} onClick={() => void finish(false)}>Enregistrer et explorer Arete</Button>}</div><p>Brouillon sur cet appareil · Réponses confirmées dans ta mémoire personnelle</p></footer>
    <GarminLoginModal isOpen={login} onClose={() => setLogin(false)} onSuccess={() => void status.refetch()} />
  </div>;
}
