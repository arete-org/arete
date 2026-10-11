import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, FileText, LoaderCircle, Paperclip, Trash2, X } from 'lucide-react';
import { ACCEPTED_FILES, documentsApi, downloadDocument, uploadDocument, type CoachDocument } from '@/lib/documents';
import { DocumentPreview } from './DocumentPreview';

export interface AttachmentsHandle { choose: () => void; upload: (files: File[]) => void }

export function DocumentAttachments({ threadId, disabled = false, ref, onBusy, onDocuments, selectedIds = [] }: { threadId: string; disabled?: boolean; ref: Ref<AttachmentsHandle>; onBusy: (busy: boolean) => void; onDocuments: (ids: string[]) => void; selectedIds?: string[] }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['coach-documents', threadId], queryFn: () => documentsApi.list(threadId), retry: false });
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [library, setLibrary] = useState(false);
  const [source, setSource] = useState<CoachDocument | null>(null);
  useEffect(() => () => { controller.current?.abort(); onBusy(false); }, [onBusy]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['coach-documents', threadId] });
  const upload = async (files: File[]) => {
    if (disabled || controller.current || !files.length) return;
    if (files.length > 5) { setErrors(['Maximum 5 fichiers par dépôt.']); return; }
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); onBusy(true); setErrors([]);
    const selected = [...selectedIds];
    try {
      for (const file of files) {
        if (abort.signal.aborted) break;
        try {
          const doc = await uploadDocument(threadId, file, abort.signal, message => setProgress(`${file.name} · ${message}`));
          if (!selected.includes(doc.id)) { selected.push(doc.id); onDocuments([...selected]); }
        }
        catch (error) { setErrors(previous => [...previous, `${file.name} : ${abort.signal.aborted ? 'Envoi annulé. Supprime le fichier incomplet avant de le renvoyer.' : error instanceof Error ? error.message : 'Envoi impossible.'}`]); }
      }
    } finally {
      // Keep Send blocked until the library includes the finalized extraction.
      try { await refresh(); }
      finally { controller.current = null; setBusy(false); onBusy(false); setProgress(''); }
    }
  };
  useImperativeHandle(ref, () => ({ choose: () => input.current?.click(), upload: files => { void upload(files); } }));
  const action = async (work: () => Promise<unknown>) => {
    try { await work(); } catch (error) { setErrors(previous => [...previous.slice(-19), error instanceof Error ? error.message : 'Opération impossible.']); }
  };
  const picker = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!library || source) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !picker.current?.contains(event.target)) setLibrary(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setLibrary(false);
      toggle.current?.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape, true);
    };
  }, [library, source]);
  const documents = query.data ?? [];
  // Keep unavailable selections removable after a failed fetch or a reload.
  const ids = [...new Set([...documents.map(doc => doc.id), ...selectedIds])];
  return <div className="contents text-xs">
    <input ref={input} type="file" multiple accept={ACCEPTED_FILES} className="sr-only" aria-label="Joindre des documents" disabled={busy || disabled} onChange={e => { void upload(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
    {ids.length > 0 && <div ref={picker} className="relative col-start-3 row-start-1">
      <button ref={toggle} aria-label={`Fichiers du fil (${ids.length})`} title={`${selectedIds.length} pièce(s) jointe(s) au prochain message`} aria-expanded={library} onClick={() => setLibrary(!library)} className="flex h-11 min-w-11 items-center justify-center gap-1 rounded-lg text-text-muted hover:text-text-primary">
        <Paperclip size={16} aria-hidden="true" />
        {selectedIds.length > 0 && <span className="text-[11px] tabular-nums text-text-primary">{selectedIds.length}</span>}
      </button>
      {library && <div role="region" aria-label="Fichiers de la conversation" className="absolute bottom-full right-0 z-20 mb-3 w-72 max-w-[calc(100vw-4rem)] max-h-72 overflow-y-auto rounded-2xl border border-[var(--arete-border)] bg-abyss p-3 shadow-lg">
        <div className="flex items-center justify-between gap-2">
          <span className="text-text-secondary">Joindre au prochain message</span>
          <button aria-label="Fermer les fichiers" className="flex size-11 items-center justify-center text-text-muted" onClick={() => { setLibrary(false); toggle.current?.focus(); }}><X size={16} /></button>
        </div>
        {ids.map(id => {
          const doc = documents.find(item => item.id === id);
          const name = doc?.name ?? 'Document indisponible';
          const selected = selectedIds.includes(id);
          return <div key={id} className="flex min-w-0 items-center gap-1">
            <input type="checkbox" aria-label={name} disabled={busy || disabled || (!selected && doc?.status !== 'ready')} checked={selected} onChange={e => onDocuments(e.target.checked ? [...selectedIds, id] : selectedIds.filter(key => key !== id))} className="size-4 shrink-0" />
            <button disabled={doc?.status !== 'ready'} onClick={() => doc && setSource(doc)} aria-label={`Consulter ${name}`} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-2 text-left disabled:text-text-muted">
              <FileText size={14} className="shrink-0" /><span className="truncate">{name}{doc && doc.status !== 'ready' && ' · Incomplet'}</span>
            </button>
            {doc?.status === 'ready' && <button aria-label={`Télécharger ${name}`} className="flex size-11 shrink-0 items-center justify-center text-text-muted" onClick={() => action(() => downloadDocument(threadId, doc))}><ArrowDownToLine size={14} /></button>}
            <button aria-label={`Supprimer définitivement ${name}`} className="flex size-11 shrink-0 items-center justify-center text-text-muted hover:text-danger-red" disabled={busy || disabled} onClick={() => action(async () => { await documentsApi.delete(threadId, id); onDocuments(selectedIds.filter(key => key !== id)); await refresh(); })}><Trash2 size={14} /></button>
          </div>;
        })}
      </div>}
    </div>}
    {(busy || query.error || errors.length > 0) && <div className="col-span-full row-start-2 mt-2 flex min-w-0 flex-col gap-2">
      {busy && <div role="status" aria-live="polite" className="flex items-center gap-2 text-text-secondary"><LoaderCircle size={14} className="animate-spin" /><span className="min-w-0 flex-1 break-words">{progress || 'Préparation…'}</span><button className="min-h-11" onClick={() => controller.current?.abort()}>Annuler</button></div>}
      {query.error && <p role="alert" className="text-danger-red">{query.error.message}</p>}
      {errors.map((error, i) => <p role="alert" key={i} className="text-danger-red break-words">{error}</p>)}
    </div>}
    {source && <DocumentPreview threadId={threadId} document={source} onClose={() => setSource(null)} />}
  </div>;
}
