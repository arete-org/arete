import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Trash2, UserRound, X } from 'lucide-react';
import { Button, Input, Panel, Select } from '@/components/ui';
import { athleteFactsApi } from '@/lib/api';
import { parseLocalDate } from '@/lib/dates';
import { FACT_KIND_LABEL } from '@/lib/fr';
import { qk } from '@/lib/queryKeys';
import { cn, readableError } from '@/lib/utils';
import type { AthleteFact, FactKind } from '@/types';

const MAX_TEXT = 300;
const KINDS = Object.keys(FACT_KIND_LABEL) as FactKind[];

interface FactActions {
  busyId: number | null;
  onSave: (fact: AthleteFact, text: string) => void;
  onToggle: (fact: AthleteFact) => void;
  onDelete: (fact: AthleteFact) => void;
  onConfirm: (fact: AthleteFact) => void;
}

function FactRow({ fact, compact = false, busyId, onSave, onToggle, onDelete, onConfirm }: FactActions & { fact: AthleteFact; compact?: boolean }) {
  const [showHistory, setShowHistory] = useState(false);
  const [draft, setDraft] = useState<{ text: string; revision: number } | null>(null);
  const resolved = fact.status === 'resolved';
  const busy = busyId === fact.id;
  const save = () => {
    const text = draft?.text.trim();
    if (text && text !== fact.text && draft) onSave({ ...fact, revision: draft.revision }, text);
    setDraft(null);
  };

  return (
    <li
      data-status={fact.status}
      className={cn('rounded border border-text-muted/20 p-3 space-y-2', resolved && 'opacity-50')}
    >
      {!compact && <div className="flex flex-wrap items-center gap-2 text-[11px] font-sans">
        <span className="text-neon-purple uppercase">{FACT_KIND_LABEL[fact.kind] ?? fact.kind}</span>
        <span className="text-text-muted">
          depuis le {parseLocalDate(fact.since).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}
        </span>
        <span
          className={cn(
            'px-1.5 py-0.5 rounded border',
            fact.source === 'coach'
              ? 'border-neon-cyan/30 text-neon-cyan'
              : 'border-neon-gold/30 text-neon-gold'
          )}
        >
          {fact.source === 'coach' ? 'coach' : 'toi'}
        </span>
        <span className="text-text-muted">{fact.evidence === 'explicit' ? 'déclaration explicite' : fact.evidence === 'hypothesis' ? 'hypothèse à confirmer' : 'provenance indéterminée'}</span>
        {fact.valid_until && <span className="text-text-muted">jusqu’au {parseLocalDate(fact.valid_until).toLocaleDateString('fr-FR')}</span>}
        {resolved && <span className="text-text-muted">résolu</span>}
      </div>}
      {compact && <p className="text-xs text-text-muted">{parseLocalDate(fact.since).toLocaleDateString('fr-FR')}{fact.valid_until ? ` · Jusqu’au ${parseLocalDate(fact.valid_until).toLocaleDateString('fr-FR')}` : ''}</p>}
      {draft === null ? (
        <p className="text-sm text-text-primary break-words">{fact.text}</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          className="flex gap-2"
        >
          <Input
            autoFocus
            aria-label="Texte du fait"
            maxLength={MAX_TEXT}
            value={draft.text}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            className="text-sm"
          />
          <Button type="submit" size="sm" aria-label="Enregistrer le fait">
            <Check className="size-3.5" />
          </Button>
          <Button variant="ghost" size="sm" aria-label="Annuler la modification" onClick={() => setDraft(null)}>
            <X className="size-3.5" />
          </Button>
        </form>
      )}
      {fact.source_ref && <p className="text-xs text-text-muted break-words">Source : {fact.source_ref}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {fact.evidence !== 'explicit' && !resolved && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onConfirm(fact)}>Confirmer</Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setShowHistory(!showHistory)}>Historique</Button>
        {draft === null && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft({ text: fact.text, revision: fact.revision })}>
            <Pencil className="size-3.5" /> Corriger
          </Button>
        )}
        {!compact && <Button variant={resolved ? 'cyan' : 'green'} size="sm" disabled={busy} onClick={() => onToggle(fact)}>
          {resolved ? 'Réactiver' : 'Résolu'}
        </Button>}
        <Button variant="ghost" size="sm" disabled={busy} aria-label="Supprimer le fait" onClick={() => onDelete(fact)}>
          <Trash2 className="size-3.5" /> {fact.evidence === 'hypothesis' ? 'Écarter' : 'Oublier'}
        </Button>
      </div>
      {showHistory && <FactHistory factId={fact.id} revision={fact.revision} />}
    </li>
  );
}

function FactHistory({ factId, revision }: { factId: number; revision: number }) {
  const history = useQuery({ queryKey: [...qk.athleteFacts, factId, 'history', revision], queryFn: () => athleteFactsApi.history(factId) });
  if (history.isPending) return <p className="text-xs text-text-muted">Chargement de l’historique…</p>;
  if (history.isError) return <p className="text-xs text-danger-red">{readableError(history.error)}</p>;
  return <ol className="text-xs text-text-muted space-y-2" aria-label="Historique du fait">{history.data.map((item) => (
    <li key={item.revision}>Version {item.revision} — {item.updated_at ? new Date(item.updated_at).toLocaleString('fr-FR') : item.since} : {item.text} ({item.status === 'resolved' ? 'résolu' : 'actif'}, {item.evidence === 'explicit' ? 'déclaration' : item.evidence === 'hypothesis' ? 'hypothèse' : 'provenance indéterminée'})</li>
  ))}</ol>;
}

/** Active facts first, then resolved ones, dimmed; server order within each. */
export function FactList({ facts, compact, ...actions }: FactActions & { facts: AthleteFact[]; compact?: boolean }) {
  const ordered = [
    ...facts.filter((f) => f.status === 'active'),
    ...facts.filter((f) => f.status !== 'active'),
  ];
  return (
    <ul className="space-y-2">
      {ordered.map((fact) => (
        <FactRow key={fact.id} fact={fact} compact={compact} {...actions} />
      ))}
    </ul>
  );
}

function AddFactForm() {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<FactKind>('injury');
  const [text, setText] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const add = useMutation({
    mutationFn: (fact: { kind: FactKind; text: string; valid_until?: string }) => athleteFactsApi.create(fact),
    onSuccess: () => {
      setText('');
      setValidUntil('');
      queryClient.invalidateQueries({ queryKey: qk.athleteFacts });
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) add.mutate({ kind, text: text.trim(), ...(validUntil ? { valid_until: validUntil } : {}) });
      }}
      className="space-y-2 border-t border-text-muted/10 pt-3"
    >
      <div className="flex flex-col sm:flex-row gap-2">
        <Select
          aria-label="Type de fait"
          value={kind}
          onChange={(e) => setKind(e.target.value as FactKind)}
          className="sm:w-40 text-sm"
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {FACT_KIND_LABEL[k]}
            </option>
          ))}
        </Select>
        <Input
          aria-label="Nouveau fait"
          maxLength={MAX_TEXT}
          placeholder="Tendinite d’Achille gauche, pas de côtes"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="text-sm"
        />
        <Button type="submit" size="sm" loading={add.isPending} disabled={!text.trim()}>
          Ajouter
        </Button>
      </div>
      <label className="block text-xs text-text-muted">Fin de validité (facultative, pour une exception temporaire)
        <Input type="date" aria-label="Fin de validité" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
      </label>
      {add.isError && <p className="text-xs text-danger-red">{readableError(add.error)}</p>}
    </form>
  );
}

/** The durable facts the coach reads every turn; editable at once, apart from the form's save. */
export function AthleteFactsPanel({ factId, embedded = false }: { factId?: number; embedded?: boolean } = {}) {
  const queryClient = useQueryClient();
  const facts = useQuery({ queryKey: qk.athleteFacts, queryFn: athleteFactsApi.list, refetchOnMount: 'always' });
  const [busyId, setBusyId] = useState<number | null>(null);
  const settle = {
    onSettled: () => {
      setBusyId(null);
      queryClient.invalidateQueries({ queryKey: qk.athleteFacts });
    },
  };
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Parameters<typeof athleteFactsApi.update>[1] }) =>
      athleteFactsApi.update(id, patch),
    ...settle,
  });
  const remove = useMutation({ mutationFn: (fact: AthleteFact) => athleteFactsApi.remove(fact.id, fact.revision), ...settle });
  const error = update.error ?? remove.error;
  const selected = factId ? facts.data?.filter(f => f.id === factId) : facts.data;

  const content = (
      <div className="space-y-3">
        {!factId && <p className="text-xs text-text-muted">
          Blessures, contraintes et préférences que le coach garde en tête à chaque échange. Il en ajoute
          quand tu lui en parles ; tu peux les corriger ici. Les hypothèses restent séparées de tes déclarations. Confirmer indique que le fait est exact ; supprimer efface aussi son historique.
        </p>}
        {facts.isLoading && <p className="text-sm text-text-muted">Chargement…</p>}
        {facts.isError && <p className="text-sm text-danger-red">Faits indisponibles.</p>}
        {selected?.length === 0 && <p className="text-sm text-text-muted italic">Ce souvenir n’est plus disponible.</p>}
        {selected && selected.length > 0 && (
          <FactList
            compact={embedded}
            facts={selected}
            busyId={busyId}
            onSave={(fact, text) => {
              setBusyId(fact.id);
              update.mutate({ id: fact.id, patch: { text, expected_revision: fact.revision } });
            }}
            onToggle={(fact) => {
              setBusyId(fact.id);
              update.mutate({ id: fact.id, patch: { status: fact.status === 'active' ? 'resolved' : 'active', expected_revision: fact.revision } });
            }}
            onConfirm={(fact) => {
              setBusyId(fact.id);
              update.mutate({ id: fact.id, patch: { evidence: 'explicit', expected_revision: fact.revision } });
            }}
            onDelete={(fact) => {
              setBusyId(fact.id);
              remove.mutate(fact);
            }}
          />
        )}
        {error && <p className="text-xs text-danger-red">{readableError(error)}</p>}
        {!factId && <AddFactForm />}
      </div>
  );
  if (embedded) return content;
  return <Panel title={<span className="flex items-center gap-2"><UserRound className="size-4 text-neon-purple" />{factId ? selected?.[0]?.evidence === 'hypothesis' ? 'À confirmer' : 'Retenu' : 'Ce que Chiron sait de moi'}</span>}>{content}</Panel>;
}
