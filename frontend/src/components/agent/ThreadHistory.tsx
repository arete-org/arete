import { Loader2, Plus, Trash2, X, Pencil } from 'lucide-react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CoachThread } from '@/lib/agentThreads';
import { conversationsApi } from '@/lib/conversations';
import { conversationsKey } from '@/hooks/useConversationArchive';
import { readableError } from '@/lib/utils';
import { Button } from '../ui/Button';

const DATE_FORMAT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });

export function ThreadHistory({ threads, activeId, runningId, onSelect, onCreate, onDelete, onClose, onRename }: {
  threads: CoachThread[]; activeId: string; runningId: string | null;
  onSelect: (id: string) => void; onCreate: () => void; onDelete: (id: string) => void;
  onClose?: () => void; onRename?: (id: string, title: string) => void;
}) {
  const [draftQuery, setDraftQuery] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const client = useQueryClient();
  const archive = useQuery({ queryKey: [...conversationsKey, query, offset], queryFn: () => conversationsApi.list(query, offset), retry: false });
  const rename = useMutation({ mutationFn: ({ id, title }: { id: string; title: string }) => conversationsApi.rename(id, title), onSuccess: (result, input) => { onRename?.(input.id, result.title); window.dispatchEvent(new CustomEvent("arete:conversation-renamed", { detail: { id: input.id, title: result.title } })); setEditing(null); void client.invalidateQueries({ queryKey: conversationsKey }); } });
  const items = new Map((archive.data?.items ?? []).map(t => [t.id, { id: t.id, title: t.title, updatedAt: Date.parse(t.updated_at), excerpt: t.excerpt, local: false, draft: '' }]));
  if (offset === 0) for (const t of threads) {
    if (query && !`${t.title} ${t.messages.map(m => m.content).join(' ')}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
    items.set(t.id, { id: t.id, title: t.title, updatedAt: t.updatedAt, excerpt: query ? t.messages.find(m => m.content.toLocaleLowerCase().includes(query.toLocaleLowerCase()))?.content ?? '' : '', local: !t.archiveRevision, draft: t.draft });
  }
  return <section className="min-h-0 flex-1 overflow-y-auto px-4 py-5" aria-label="Conversations du coach">
    <div className="mb-4 flex items-center justify-between gap-3"><div><h3 className="coach-title suivi-section-title">Tes conversations</h3><p className="mt-1 text-xs text-text-muted">Sauvegardées dans ton compte après chaque échange</p></div>{onClose && <Button variant="ghost" aria-label="Revenir à la conversation" onClick={onClose}><X className="size-4" /></Button>}</div>
    <Button className="mb-5" onClick={onCreate}><Plus className="size-4" /> Nouvelle conversation</Button>
    <form className="mb-4 flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); setQuery(draftQuery.trim()); setOffset(0); }}><input className="ui-inset min-h-11 min-w-0 flex-1 px-3 text-base" aria-label="Rechercher dans les conversations" placeholder="Rechercher un sujet, une séance…" maxLength={200} value={draftQuery} onChange={e => setDraftQuery(e.target.value)} /><Button type="submit">Rechercher</Button></form>
    {archive.isPending && <p role="status" className="text-sm text-text-muted">Chargement de l’historique…</p>}
    {(archive.error || rename.error) && <p role="alert" className="text-sm text-danger-red">{readableError(archive.error || rename.error)}</p>}
    {!archive.isPending && !archive.error && !items.size && <p className="py-4 text-sm text-text-muted">{query ? 'Aucune conversation trouvée.' : 'Ton premier échange apparaîtra ici.'}</p>}
    <ul className="divide-y divide-text-muted/20">{[...items.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(thread => <li key={thread.id}>
      {editing?.id === thread.id ? <form className="flex flex-wrap gap-2 py-3" onSubmit={e => { e.preventDefault(); rename.mutate(editing); }}><input aria-label="Titre de la conversation" autoFocus maxLength={120} required value={editing.title} className="ui-inset min-h-11 min-w-0 flex-1 px-3" onChange={e => setEditing({ ...editing, title: e.target.value })} /><Button type="submit" disabled={rename.isPending}>Enregistrer</Button><Button variant="ghost" onClick={() => setEditing(null)}>Annuler</Button></form> : <div className="flex items-center gap-1 py-2">
        <button onClick={() => onSelect(thread.id)} aria-current={thread.id === activeId ? 'true' : undefined} className="min-w-0 flex-1 rounded-lg px-1 py-3 text-left hover:bg-shadow">
          <span className="block w-full min-w-0">
          <span className="flex gap-2 text-sm">{thread.id === runningId && <Loader2 className="size-4 shrink-0 animate-spin" />}<span className="truncate">{thread.title}</span></span>
          <span className="mt-1 block text-xs text-text-muted">{thread.id === runningId ? 'Réponse en cours' : thread.draft ? 'Brouillon' : thread.local ? 'Copie locale' : 'Sauvegardée'} · {DATE_FORMAT.format(thread.updatedAt)}</span>
          {query && thread.excerpt && <span className="mt-2 line-clamp-2 text-xs text-text-secondary">{thread.excerpt}</span>}
          </span>
        </button>
        {!thread.local && <Button variant="ghost" aria-label={`Renommer « ${thread.title} »`} onClick={() => setEditing({ id: thread.id, title: thread.title })}><Pencil className="size-4" /></Button>}
        <Button variant="ghost" aria-label={`Supprimer « ${thread.title} »`} onClick={() => onDelete(thread.id)}><Trash2 className="size-4" /></Button>
      </div>}
    </li>)}</ul>
    <div className="mt-4 flex gap-2">{offset > 0 && <Button variant="ghost" onClick={() => setOffset(Math.max(0, offset - 30))}>Précédent</Button>}{archive.data?.next_offset != null && <Button variant="ghost" onClick={() => setOffset(archive.data!.next_offset!)}>Conversations précédentes</Button>}</div>
  </section>;
}
