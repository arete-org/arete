import { useEffect, useState } from 'react';
import { AreteWordmark } from '@/components/AreteBrand';
import { Button, Field, Input, Panel, Skeleton } from '@/components/ui';
import { GenerationPreviewView } from '@/components/agent/GenerationPreview';
import { HumanInputCard } from '@/components/agent/HumanInputCard';
import { RunActivity } from '@/components/agent/RunActivity';
import type { HumanInterrupt } from '@/lib/humanInput';
import { FeedbackRating } from '@/components/agent/FeedbackRating';
import { applyTheme, initializeTheme, THEMES, type Theme } from '@/lib/theme';

const question: HumanInterrupt = {
  id: 'gallery-question', revision: 1, expires_at: '2099-01-01T00:00:00Z', decision: null,
  payload: { type: 'question', name: 'ask_athlete', args: { question: 'Quel est ton ressenti avant la séance ?' }, description: '' },
  schema: { type: 'object', properties: { rpe: { type: 'number', title: 'Ressenti', minimum: 0, maximum: 10 }, available: { type: 'boolean', title: 'Disponible demain' } }, required: ['rpe','available'], additionalProperties: false },
};

const approval: HumanInterrupt = {
  id: 'gallery-approval', revision: 1, expires_at: '2099-01-01T00:00:00Z', decision: null,
  payload: { name: 'update_planned_session', args: { session_id: 42, target_duration_min: 25 }, description: 'Ramener la séance de demain à 25 minutes.' },
  schema: { oneOf: [{ type: 'object', properties: { type: { const: 'approve' } }, required: ['type'] }, { type: 'object', properties: { type: { const: 'reject' }, message: { type: 'string' } }, required: ['type','message'] }] },
};

/** Local gallery: real components and CSS, with no product API or saved preference. */
export default function DesignSystemPage() {
  const [theme, setTheme] = useState<Theme>(() => THEMES.find(item => item.value === document.documentElement.dataset.theme)?.value ?? 'pierre');
  const [approvalDecision, setApprovalDecision] = useState<Record<string, unknown> | null>(null);
  const [decision, setDecision] = useState<Record<string, unknown> | null>(null);
  const [rating, setRating] = useState<0 | 1 | null>(null);
  useEffect(() => {
    // Restore both the palette and the saved system-following preference.
    return initializeTheme;
  }, []);
  function preview(value: Theme) { setTheme(value); applyTheme(value); }
  return <div className="page-shell"><div className="page-content space-y-6">
    <header className="space-y-3"><AreteWordmark /><h1 className="page-title">Composants Arete</h1><p className="text-ink-secondary">Référence locale · composants réels et données illustratives.</p></header>
    <nav aria-label="Thème de la galerie" className="flex flex-wrap gap-2">{THEMES.map(item => <Button key={item.value} aria-pressed={theme === item.value} onClick={() => preview(item.value)}>{item.label}</Button>)}</nav>
    <div className="grid gap-6 md:grid-cols-2">
      <Panel title="Actions et états"><div className="flex flex-wrap gap-3"><Button strong>Examiner la proposition</Button><Button variant="outline">Plus tard</Button><Button disabled>Indisponible</Button><Button loading>Enregistrement</Button><Button variant="danger">Refuser</Button></div></Panel>
      <Panel title="Saisie"><div className="space-y-3"><Field label="Durée disponible"><Input type="number" defaultValue={25} min={1} /></Field><Field label="Sport"><select className="ui-input w-full"><option>Course à pied</option><option>Musculation</option></select></Field><p role="alert" className="text-sm text-signal-danger">Cette proposition a expiré. Actualise le planning.</p></div></Panel>
      <Panel title="Priorité du coach"><div className="space-y-3"><h2 className="font-display text-3xl">Une séance adaptée à ta journée</h2><p>Tu as déclaré 25 minutes disponibles demain.</p><div className="ui-inset p-4">45 min → 25 min · endurance</div><Button strong>Examiner la proposition</Button><div className="flex gap-2"><FeedbackRating value={rating} onChange={setRating} /></div></div></Panel>
      <Panel title="Activité du coach"><RunActivity message={{ role: 'assistant', content: '', pending: true, streamAccepted: true, activity: [{ id: 'context', state: 'done', label: 'Contexte préparé' }, { id: 'tools', state: 'running', label: 'Consultation des séances et de la mémoire' }] }} /><RunActivity message={{ role: 'assistant', content: '', runState: 'ready' }} /><RunActivity message={{ role: 'assistant', content: '', error: 'Connexion interrompue', runState: 'interrupted' }} /></Panel>
      <Panel title="Question structurée"><HumanInputCard item={{ ...question, decision }} onDecision={async value => setDecision(value)} /></Panel>
      <Panel title="Validation ciblée"><HumanInputCard item={{ ...approval, decision: approvalDecision }} onDecision={async value => setApprovalDecision(value)} /></Panel>
      <Panel title="Génération provisoire"><GenerationPreviewView message={{ role: 'assistant', content: 'Ta charge est stable. Le briefing prépare la suite de ta semaine…', pending: true, runState: 'running', activity: [{ id: 'draft', state: 'running', label: 'Rédaction en cours' }] }} onRetry={() => {}} /></Panel>
      <Panel title="Résultat enregistré"><GenerationPreviewView message={{ role: 'assistant', content: 'Une sortie facile demain pour récupérer.', runState: 'completed', activity: [{ id: 'saved', state: 'done', label: 'Résultat enregistré · calculé à partir de tes métriques' }] }} onRetry={() => {}} /></Panel>
      <Panel title="Chargement et typographie"><Skeleton label="Chargement du suivi" /><p className="mt-4 tabular-nums">25 min · 4,2 km · 142 bpm</p><code className="font-mono">session.revision = 2</code></Panel>
    </div>
  </div></div>;
}
