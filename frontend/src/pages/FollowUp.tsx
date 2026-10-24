import { GenerationPreview } from '@/components/agent/GenerationPreview';
import { ThreadHistory } from '@/components/agent/ThreadHistory';
import { conversationsApi, openConversation } from '@/lib/conversations';
import { conversationsKey } from '@/hooks/useConversationArchive';
import { Button } from '@/components/ui';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CoachingAttention } from '@/components/agent/CoachingAttention';
import { useCoachingAttention } from '@/hooks/useCoachingAttention';
import { NoticeActions } from '@/components/AutomationInbox';
import { automationApi, automationsKey, inboxKey, scheduleLabel, stateLabel, type Automation, type Definition, type Trigger } from '@/lib/automations';
import { coachApi, coachTodayKey, discussWithCoach } from '@/lib/coachToday';
import { readableError } from '@/lib/utils';
import { garminApi } from '@/lib/api';
import { sportLabel } from '@/lib/fr';
import './followUp.css';
import { useCoachWords } from '@/lib/coachName';

const examples = [
  { title: 'Préparer ma semaine', mission: 'Examiner mon objectif, ma disponibilité déclarée, ma récupération et mon planning de la semaine à venir. Proposer les ajustements utiles avec un aperçu avant/après, soumis à mon accord. Si rien ne doit changer, le dire sans inventer de tâche.', trigger: { kind: 'weekly', time: '18:00', weekdays: [6] } },
  { title: 'Adapter après mes séances', mission: 'Examiner la séance qui vient d’arriver et ma récupération. Réutiliser mon ressenti existant. Préparer un ajustement du planning seulement si les faits le justifient, avec un aperçu avant/après soumis à mon accord.', trigger: { kind: 'session', delay_minutes: 30 } },
  { title: 'Donner suite à mes réponses du soir', mission: 'Tenir compte de ma réponse du soir pour préparer la journée suivante. Si mon planning doit changer, me présenter un aperçu avant/après à valider. Si une précision manque, me la demander. Après mon accord, confirmer le résultat et expliquer la prochaine séance.', trigger: { kind: 'evening' } },
  { title: 'Débrief après sortie longue', mission: 'Analyser ma prochaine sortie longue et me demander le ressenti manquant.', trigger: { kind: 'session', sport: 'running', session_type: 'long_run', delay_minutes: 0 } },
  { title: 'Récupération le lendemain', mission: 'Examiner ma récupération après la séance et proposer un ajustement si nécessaire.', trigger: { kind: 'session', delay_minutes: 1440 } },
  { title: 'Bilan hebdomadaire ciblé', mission: 'Faire le bilan de ma semaine : régularité, charge et récupération.', trigger: { kind: 'weekly', time: '18:00', weekdays: [6] } },
  { title: 'Préparation avant une course', mission: 'Vérifier mon planning et ma récupération avant ma course.', trigger: { kind: 'once', at: '' } },
] satisfies Omit<Definition, 'timezone'>[];

function ErrorText({ error }: { error: unknown }) { return error ? <p role="alert">{readableError(error)}</p> : null; }
function Pager({ offset, next, change }: { offset: number; next: number | null | undefined; change: (value: number) => void }) { return <div className="suivi-actions">{offset > 0 && <Button variant="ghost" onClick={() => change(Math.max(0, offset - 50))}>Précédent</Button>}{next != null && <Button variant="ghost" onClick={() => change(next)}>Suivant</Button>}</div>; }

function AutomationForm({ initial, item, close }: { initial: Definition; item?: Automation; close: () => void }) {
  const [value, setValue] = useState(initial);
  const [at, setAt] = useState(initial.trigger.kind === 'once' && initial.trigger.at ? new Date(initial.trigger.at).toLocaleString('sv-SE').slice(0, 16).replace(' ', 'T') : '');
  const client = useQueryClient();
  const save = useMutation({ mutationFn: (definition: Definition) => item ? automationApi.update(item, definition) : automationApi.create(definition), onSuccess: async () => { await client.invalidateQueries({ queryKey: automationsKey }); close(); } });
  const trigger = value.trigger;
  const [sessionWindow] = useState(() => {
    const start = new Date();
    const end = new Date(start);
    end.setDate(end.getDate() + 90);
    return [start.toLocaleDateString('sv-SE'), end.toLocaleDateString('sv-SE')] as const;
  });
  const sessions = useQuery({ queryKey: ['planned', ...sessionWindow], queryFn: () => garminApi.getPlanned(...sessionWindow), enabled: trigger.kind === 'session' });
  const setTrigger = (next: Trigger) => setValue({ ...value, trigger: next });
  const submit = (event: FormEvent) => { event.preventDefault(); save.mutate({ ...value, trigger: trigger.kind === 'once' ? { kind: 'once', at: new Date(at).toISOString() } : trigger }); };
  return <form className="suivi-form" onSubmit={submit}>
    <h2>{item ? 'Modifier le suivi' : 'Programmer un suivi'}</h2>
    <label>Titre<input required maxLength={120} value={value.title} onChange={e => setValue({ ...value, title: e.target.value })} /></label>
    <label>Mission<textarea required maxLength={4000} value={value.mission} onChange={e => setValue({ ...value, mission: e.target.value })} /></label>
    <label>Déclencheur<select className="ui-input" aria-label="Déclencheur" value={trigger.kind} onChange={e => setTrigger(e.target.value === 'once' ? { kind: 'once', at: '' } : e.target.value === 'session' ? { kind: 'session', delay_minutes: 0 } : e.target.value === 'evening' ? { kind: 'evening' } : { kind: e.target.value as 'daily' | 'weekly', time: '08:00', weekdays: e.target.value === 'weekly' ? [0] : [] })}><option value="once">Une fois</option><option value="daily">Chaque jour</option><option value="weekly">Certains jours</option><option value="session">Après une séance</option><option value="evening">Après une réponse du soir</option></select></label>
    {trigger.kind === 'evening' && <p>Après ta prochaine réponse au message du soir, si le suivi coordonné est activé. Aucune ancienne réponse ne sera reprise. Les modifications attendront ton accord.</p>}
    {trigger.kind === 'once' && <label>Date et heure · heure de cet appareil<input type="datetime-local" required value={at} onChange={e => setAt(e.target.value)} /></label>}
    {(trigger.kind === 'daily' || trigger.kind === 'weekly') && <label>Heure dans le fuseau choisi<input type="time" required value={trigger.time} onChange={e => setTrigger({ ...trigger, time: e.target.value })} /></label>}
    {trigger.kind === 'weekly' && <fieldset><legend>Jours</legend><div className="suivi-actions">{['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map((day, index) => <label key={day}><input type="checkbox" checked={trigger.weekdays.includes(index)} onChange={e => setTrigger({ ...trigger, weekdays: e.target.checked ? [...trigger.weekdays, index].sort() : trigger.weekdays.filter(d => d !== index) })} /> {day}</label>)}</div></fieldset>}
    {trigger.kind === 'session' && <>
      <p>Après l’enregistrement dans Arete. La synchronisation peut arriver après la fin réelle de la séance. Aucune ancienne séance ne sera rattrapée.</p>
      <label>Séance<select className="ui-input" aria-label="Séance" value={trigger.session_key ?? ''} disabled={sessions.isPending} onChange={e => setTrigger({ ...trigger, session_key: e.target.value || null })}><option value="">Les prochaines séances</option>{trigger.session_key && !sessions.data?.some(session => `planned:${session.id}` === trigger.session_key) && <option value={trigger.session_key}>Séance déjà sélectionnée</option>}{sessions.data?.filter(session => session.status === 'pending' || session.status === 'modified').map(session => <option key={session.id} value={`planned:${session.id}`}>{new Date(`${session.date}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} · {session.description || sportLabel(session.sport)}{session.target_duration_min ? ` · ${session.target_duration_min} min` : ''}</option>)}</select></label>
      <ErrorText error={sessions.error} />
      <label>Sport<select className="ui-input" value={trigger.sport ?? ''} onChange={e => setTrigger({ ...trigger, sport: e.target.value || null })}><option value="">Tous</option><option value="running">Course</option><option value="cycling">Vélo</option><option value="swimming">Natation</option><option value="strength">Musculation</option></select></label>
      <label>Type<select className="ui-input" value={trigger.session_type ?? ''} onChange={e => setTrigger({ ...trigger, session_type: e.target.value || null })}><option value="">Tous</option><option value="long_run">Sortie longue</option><option value="endurance">Endurance</option><option value="intervals">Fractionné</option><option value="tempo">Tempo</option><option value="recovery">Récupération</option></select></label>
      <label>Délai après enregistrement · minutes<input type="number" min={0} max={10080} value={trigger.delay_minutes} onChange={e => setTrigger({ ...trigger, delay_minutes: Number(e.target.value) })} /></label>
    </>}
    <label>Fuseau horaire<input required value={value.timezone} onChange={e => setValue({ ...value, timezone: e.target.value })} /></label>
    <p>Exécution au prochain passage après l’échéance. Un retard proche de deux heures est possible. Les écritures attendent ton approbation.</p>
    <ErrorText error={save.error} /><div className="suivi-actions"><Button type="submit" strong className="suivi-primary" disabled={save.isPending}>{save.isPending ? 'Enregistrement…' : item ? 'Enregistrer' : 'Activer ce suivi'}</Button><Button variant="ghost" type="button" onClick={close}>Annuler</Button></div>
  </form>;
}

function AutomationList() {
  const [offset, setOffset] = useState(0);
  const [form, setForm] = useState<{ definition: Definition; item?: Automation } | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const client = useQueryClient();
  const query = useQuery({ queryKey: [...automationsKey, offset], queryFn: () => automationApi.list(offset) });
  const runs = useQuery({ queryKey: ['automation-history', history], queryFn: () => automationApi.runs(history!), enabled: history !== null });
  const action = useMutation({ mutationFn: async ({ item, kind }: { item: Automation; kind: 'active' | 'paused' | 'delete' }) => { if (kind === 'delete') await automationApi.remove(item); else await automationApi.state(item, kind); }, onSuccess: () => client.invalidateQueries({ queryKey: automationsKey }) });
  if (form) return <AutomationForm key={form.item?.id ?? form.definition.title} initial={form.definition} item={form.item} close={() => setForm(null)} />;
  return <div className="suivi-stack">
    <Button strong className="suivi-primary justify-self-start" onClick={() => setForm({ definition: { title: '', mission: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, trigger: { kind: 'daily', time: '08:00', weekdays: [] } } })}>Créer une routine</Button>
    {query.isPending && <p role="status">Chargement des routines…</p>}<ErrorText error={query.error ?? action.error} />
    {query.data?.items.map(item => <article className="suivi-row" key={item.id}>
      <div className="min-w-0 flex-1"><h2>{item.title}</h2><p className="suivi-note">{scheduleLabel(item.trigger)} · {item.timezone}</p><p className="suivi-note">{stateLabel[item.state]}{item.next_due_at ? ` · ${new Date(item.next_due_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}` : ''}</p></div>
      {item.state === 'proposed' && <Button size="sm" strong disabled={action.isPending} onClick={() => action.mutate({ item, kind: 'active' })}>Activer</Button>}
      <details className="suivi-menu"><summary aria-label={`Options de ${item.title}`}>•••</summary><div className="suivi-menu-content"><Button variant="ghost" disabled={action.isPending} onClick={() => action.mutate({ item, kind: item.state === 'active' ? 'paused' : 'active' })}>{item.state === 'active' ? 'Suspendre' : 'Réactiver'}</Button><Button variant="ghost" onClick={() => setForm({ definition: item, item })}>Modifier</Button><Button variant="ghost" onClick={() => setHistory(history === item.id ? null : item.id)}>Historique</Button><Button variant="ghost" disabled={action.isPending} onClick={() => action.mutate({ item, kind: 'delete' })}>Supprimer</Button></div></details>
      {history === item.id && <div className="suivi-history"><ErrorText error={runs.error} />{runs.data?.items.length === 0 && <p>Aucune exécution.</p>}{runs.data?.items.map(run => <Link key={run.id} to={`/follow-up?run=${run.id}`}>{new Date(run.due_at).toLocaleString('fr-FR')} · {stateLabel[run.state]}</Link>)}</div>}
    </article>)}
    <Pager offset={offset} next={query.data?.next_offset} change={setOffset} />
    <section aria-label="Routines proposées" className="space-y-3"><h2 className="text-lg font-medium">Un coach qui prépare la suite</h2><p className="text-sm text-text-secondary">Choisis le rythme, vérifie la mission, puis active la routine. Chaque modification attend ton accord.</p><div className="grid gap-3 sm:grid-cols-3">{examples.slice(0, 3).map(example => <article className="ui-inset p-4 space-y-3" key={example.title}><h3 className="text-sm font-medium">{example.title}</h3><p className="text-xs text-text-secondary">{scheduleLabel(example.trigger)}</p><Button size="sm" onClick={() => setForm({ definition: { ...example, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } })}>Configurer</Button></article>)}</div></section>
    <details className="suivi-ideas"><summary>Autres idées de suivi</summary>{examples.slice(3).map(example => <Button variant="ghost" key={example.title} onClick={() => setForm({ definition: { ...example, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } })}>{example.title} ↗</Button>)}</details>
  </div>;
}

function ConversationArchive() {
  const [deleting, setDeleting] = useState<string | null>(null);
  const coach = useCoachWords();
  const client = useQueryClient();
  const remove = useMutation({ mutationFn: conversationsApi.remove, onSuccess: (_data, id) => { window.dispatchEvent(new CustomEvent("arete:conversation-deleted", { detail: id })); setDeleting(null); void client.invalidateQueries({ queryKey: conversationsKey }); } });
  return <>{deleting && <div role="alert" className="ui-inset p-4"><p>Supprimer cette conversation et ses documents ? Le coach ne pourra plus la relire ; ce qu’il a noté dans son journal (dont tes réponses aux questions du soir) y reste : consultable dans Réglages › Coach, {coach.the} peut l’oublier si tu le lui demandes.</p><Button onClick={() => remove.mutate(deleting)} disabled={remove.isPending}>Supprimer</Button><Button variant="ghost" onClick={() => setDeleting(null)}>Annuler</Button><ErrorText error={remove.error} /></div>}<ThreadHistory threads={[]} activeId="" runningId={null} onSelect={openConversation} onCreate={() => { window.dispatchEvent(new Event("arete:conversation-new")); window.dispatchEvent(new Event("arete:coach-open")); }} onDelete={setDeleting} /></>;
}

export function FollowUpPage() {
  const coach = useCoachWords();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'conversations' ? 'conversations' : params.get('tab') === 'automations' ? 'automations' : 'inbox';
  const thread = params.get('thread');
  useEffect(() => { if (thread && tab === 'conversations') openConversation(thread); }, [thread, tab, location.key]);
  const [filter, setFilter] = useState('todo');
  const [offset, setOffset] = useState(0);
  const query = useQuery({ queryKey: [...inboxKey, filter, offset], queryFn: () => automationApi.inbox(filter, offset), enabled: tab === 'inbox' });
  const run = params.get('run');
  // Selecting the same link again must reopen a previously hidden Chiron panel.
  useEffect(() => { if (run) discussWithCoach({ kind: 'automation_run', id: run }); }, [run, location.key]);
  // The evening message's push and inbox item open Chiron on it (ARE-64).
  // After the commit: on a cold start from the push, the panel's listeners are
  // registered by effects that run after this page's.
  const evening = Number(params.get('evening'));
  useEffect(() => {
    if (!Number.isSafeInteger(evening) || evening <= 0) return;
    const timer = window.setTimeout(() => discussWithCoach({ kind: 'evening', id: evening }));
    return () => window.clearTimeout(timer);
  }, [evening, location.key]);
  const selectedProposal = Number(params.get('proposal'));
  const selectedFollowup = Number(params.get('followup'));
  useEffect(() => {
    const kind = selectedProposal > 0 ? 'proposal' : 'followup';
    const id = selectedProposal > 0 ? selectedProposal : selectedFollowup;
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const timer = window.setTimeout(() => discussWithCoach({ kind, id }));
    return () => window.clearTimeout(timer);
  }, [selectedProposal, selectedFollowup, location.key]);
  const attention = useCoachingAttention(tab === 'inbox' && filter === 'todo');
  const coaching = useQuery({ queryKey: coachTodayKey, queryFn: coachApi.today, enabled: tab === 'inbox' && filter === 'todo' });
  return <div className="suivi-page">
    <header className="suivi-header"><h1 className="page-title">Suivi</h1><p>Les prochains échanges avec {coach.the}.</p></header>
    <nav className="suivi-tabs" aria-label="Suivi et routines"><Button variant="ghost" aria-current={tab === 'inbox' ? 'page' : undefined} onClick={() => setParams({})}>Suivi{query.data?.unread ? ` · ${query.data.unread}` : ''}</Button><Button variant="ghost" aria-current={tab === 'automations' ? 'page' : undefined} onClick={() => setParams({ tab: 'automations' })}>Routines</Button><Button variant="ghost" aria-current={tab === "conversations" ? "page" : undefined} onClick={() => setParams({ tab: "conversations" })}>Conversations</Button></nav>
    <div className="suivi-grid"><div className="suivi-stack">{tab === 'conversations' ? <ConversationArchive /> : tab === 'automations' ? <AutomationList /> : <>
      <div className="suivi-actions" aria-label="Filtres">{[['todo', 'À traiter'], ['all', 'Tout'], ['archives', 'Archives']].map(([value, label]) => <Button variant="ghost" key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setOffset(0); }}>{label}</Button>)}</div>
      {filter === 'todo' && <><GenerationPreview kind="evening" activeOnly /><CoachingAttention compact /></>}
      {filter === 'todo' && !attention.data?.enabled && coaching.data?.items.map(item => <article className="suivi-row" key={`${item.kind}-${item.record.id}`}><div className="flex-1"><h2>{item.kind === 'followup' ? item.record.question : 'Une proposition pour ton entraînement'}</h2><p className="suivi-note">{coach.The} attend ton retour</p></div><Button variant="ghost" onClick={() => discussWithCoach({ kind: item.kind, id: item.record.id })}>En parler ↗</Button></article>)}
      {query.isPending && <p role="status">Chargement du suivi…</p>}<ErrorText error={query.error} />
      {query.data?.items.length === 0 && (filter !== 'todo' || (!attention.data?.enabled && coaching.data?.items.length === 0)) && <div className="suivi-empty"><h2>{filter === 'archives' ? 'Aucune archive' : 'Le suivi est à jour'}</h2><p>Les prochaines questions et notifications apparaîtront ici.</p></div>}
      <div className="suivi-list">{query.data?.items.map(item => <article className="suivi-row" key={item.id}><Link className="suivi-plain suivi-row-main" to={item.url}><div className="min-w-0 flex-1"><h2>{item.title}</h2><p className="suivi-note line-clamp-2">{item.body}</p><p className="suivi-note">{new Date(item.created_at).toLocaleDateString('fr-FR')}{!item.read_at ? ' · non lu' : ''}</p></div><span aria-hidden="true">↗</span></Link><NoticeActions id={item.id} read={Boolean(item.read_at)} archived={Boolean(item.archived_at)} /></article>)}</div>
      <Pager offset={offset} next={query.data?.next_offset} change={setOffset} />
    </>}</div></div>
  </div>;
}
