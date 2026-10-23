import { useEffect, useState } from 'react';
import { AreteWordmark } from '@/components/AreteBrand';
import { Button, Field, Input, Panel, Skeleton } from '@/components/ui';
import { FeedbackRating } from '@/components/agent/FeedbackRating';
import { applyTheme, initializeTheme, THEMES, type Theme } from '@/lib/theme';

/** Local gallery: real components and CSS, with no product API or saved preference. */
export default function DesignSystemPage() {
  const [theme, setTheme] = useState<Theme>(() => THEMES.find(item => item.value === document.documentElement.dataset.theme)?.value ?? 'pierre');
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
      <Panel title="Chargement et typographie"><Skeleton label="Chargement du suivi" /><p className="mt-4 tabular-nums">25 min · 4,2 km · 142 bpm</p><code className="font-mono">session.revision = 2</code></Panel>
    </div>
  </div></div>;
}
