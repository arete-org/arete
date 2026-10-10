import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ArrowDownToLine, ChevronLeft, ChevronRight, FileSearch, ScanText, X, ZoomIn, ZoomOut } from 'lucide-react';
import { documentsApi, originalDocument, type CoachDocument, type SourceBlock } from '@/lib/documents';
import { cn } from '@/lib/utils';
import { Button, Modal } from '../ui';

const BLOCKS_PER_VIEW = 50;
const REVIEW_CONFIDENCE = 80;
const needsReview = (block: SourceBlock) => block.method === 'ocr' && (block.confidence == null || block.confidence < REVIEW_CONFIDENCE);
const groupName = (block: SourceBlock) => {
  const page = /^page (\d+)/i.exec(block.locator);
  return page ? `Page ${page[1]}` : block.locator.includes('!') ? block.locator.split('!')[0] : 'Document';
};

function OriginalLink({ blob, name }: { blob: Blob; name: string }) {
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const url = URL.createObjectURL(blob);
    if (link.current) link.current.href = url;
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return <a ref={link} download={name} className="inline-flex items-center gap-2 text-xs text-text-secondary transition-colors hover:text-neon-cyan"><ArrowDownToLine size={14} />Télécharger l’original</a>;
}

function SourceView({ blob, name, group }: { blob: Blob; name: string; group: string }) {
  const [zoom, setZoom] = useState(100);
  const image = useRef<HTMLImageElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const pdf = name.toLowerCase().endsWith('.pdf');
  useEffect(() => {
    const url = URL.createObjectURL(blob);
    if (image.current) image.current.src = url;
    // A number, not the group's text: only a page index may reach the frame's URL.
    const page = Number(/^Page (\d+)$/.exec(group)?.[1] ?? 1);
    if (frame.current) frame.current.src = `${url}#page=${page}&toolbar=0`;
    return () => URL.revokeObjectURL(url);
  }, [blob, group]);
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/5 px-4">
      <span className="text-xs font-medium text-text-secondary">Original</span>
      {!pdf && <div className="flex items-center gap-2 text-xs text-text-muted">
        <button aria-label="Réduire l’original" disabled={zoom <= 50} onClick={() => setZoom(z => z - 25)} className="rounded p-1.5 hover:bg-white/5 disabled:opacity-30"><ZoomOut size={15} /></button>
        <button onClick={() => setZoom(100)} className="w-10 tabular-nums" aria-label="Réinitialiser le zoom">{zoom} %</button>
        <button aria-label="Agrandir l’original" disabled={zoom >= 200} onClick={() => setZoom(z => z + 25)} className="rounded p-1.5 hover:bg-white/5 disabled:opacity-30"><ZoomIn size={15} /></button>
      </div>}
    </div>
    {pdf ? <iframe title={`Original : ${name}`} ref={frame} className="min-h-0 w-full flex-1 border-0 bg-white" /> :
      <div className="min-h-0 flex-1 overflow-auto bg-void/50 p-5 sm:p-8">
        <img ref={image} alt={`Original : ${name}`} className="mx-auto block max-w-none rounded shadow-xl" style={{ width: `${zoom}%` }} />
      </div>}
  </div>;
}

function PreviewContent({ threadId, document: doc }: { threadId: string; document: CoachDocument }) {
  const visual = /\.(pdf|png|jpe?g|webp)$/i.test(doc.name);
  const source = useQuery({
    queryKey: ['coach-document-preview', threadId, doc.id],
    queryFn: async ({ signal }) => {
      const [extraction, original] = await Promise.all([
        documentsApi.extraction(threadId, doc.id, signal), originalDocument(threadId, doc, signal),
      ]);
      return { extraction, original };
    },
    retry: false,
    staleTime: Infinity,
    gcTime: 0, // A closed preview must not retain a 20 MiB original in the cache.
  });
  const [group, setGroup] = useState('');
  const [reviewOnly, setReviewOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<SourceBlock | null>(null);
  const [mobileView, setMobileView] = useState<'original' | 'text'>('text');
  const groups = useMemo(() => {
    const result = new Map<string, SourceBlock[]>();
    for (const block of source.data?.extraction.blocks ?? []) {
      const name = groupName(block);
      const items = result.get(name) ?? [];
      items.push(block); result.set(name, items);
    }
    return result;
  }, [source.data]);
  const activeGroup = group || groups.keys().next().value || 'Document';
  const all = groups.get(activeGroup) ?? [];
  const uncertain = all.filter(needsReview).length;
  const blocks = reviewOnly ? all.filter(needsReview) : all;
  const visible = blocks.slice(offset, offset + BLOCKS_PER_VIEW);
  const hasOcr = all.some(b => b.method === 'ocr');
  const warnings = source.data?.extraction.warnings ?? [];

  if (source.isPending) return <div className="flex min-h-80 items-center justify-center gap-3 text-sm text-text-muted" role="status"><FileSearch size={20} className="animate-pulse text-neon-cyan" />Chargement du document…</div>;
  if (source.error) return <div className="space-y-4 p-8"><p role="alert" className="text-sm text-danger-red">{source.error.message}</p><Button onClick={() => source.refetch()}>Réessayer</Button></div>;
  return <>
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-white/[0.02] px-5 py-3 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        {groups.size > 1 ? <select aria-label="Page ou feuille du document" value={activeGroup} onChange={e => { setGroup(e.target.value); setOffset(0); setSelected(null); }} className="max-w-48 rounded-md border border-white/10 bg-abyss px-3 py-1.5 text-xs">{Array.from(groups.keys(), name => <option key={name}>{name}</option>)}</select> : <span className="text-xs text-text-muted">{activeGroup}</span>}
        <span className="h-3 w-px bg-white/10" />
        <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary"><ScanText size={14} />{hasOcr ? 'Texte reconnu par OCR' : 'Texte extrait'}</span>
        <span className="text-xs text-text-muted">{all.length} passage{all.length > 1 ? 's' : ''}</span>
      </div>
      {source.data && <OriginalLink blob={source.data.original} name={doc.name} />}
    </div>
    {hasOcr && <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/5 px-5 py-3 sm:px-6">
      <p className="text-xs leading-relaxed text-text-muted">Compare les dates, chiffres et unités avec l’original.</p>
      <button aria-pressed={reviewOnly} onClick={() => { setReviewOnly(!reviewOnly); setOffset(0); setSelected(null); }} className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors', reviewOnly ? 'border-warning-orange/50 bg-warning-orange/15 text-warning-orange' : 'border-white/10 text-text-secondary hover:border-warning-orange/40')}>
        <AlertCircle size={12} />{reviewOnly ? 'Afficher tout' : `${uncertain} à vérifier`}
      </button>
    </div>}
    {visual && <div className="flex shrink-0 gap-1 border-b border-white/10 p-2 md:hidden">{(['original', 'text'] as const).map(view => <button key={view} aria-pressed={mobileView === view} onClick={() => setMobileView(view)} className={cn('flex-1 rounded-md px-3 py-2 text-sm', mobileView === view ? 'bg-neon-cyan/10 text-neon-cyan' : 'text-text-muted')}>{view === 'original' ? 'Original' : 'Texte extrait'}</button>)}</div>}
    <div className={cn('grid min-h-0 flex-1', visual && 'md:grid-cols-2')}>
      {visual && <div className={cn('min-h-0 border-r border-white/10 md:block', mobileView !== 'original' && 'hidden')}>
        {source.data && <SourceView blob={source.data.original} name={doc.name} group={activeGroup} />}
      </div>}
      <div className={cn('flex min-h-0 flex-col bg-abyss md:flex', visual && mobileView !== 'text' && 'hidden')}>
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/5 px-5"><span className="text-xs font-medium text-text-secondary">{hasOcr ? 'Transcription' : 'Contenu du document'}</span><span className="text-[11px] text-text-muted">Sélectionne un passage pour sa référence</span></div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-5" aria-label="Texte du document">
          {!visible.length && <p className="px-2 py-6 text-sm text-text-muted">Aucun passage incertain sur cette page. Vérifie aussi les valeurs dans l’original.</p>}
          {visible.map((block, index) => <button key={`${offset + index}-${block.locator}`} onClick={() => setSelected(block)} aria-pressed={selected === block} className={cn('mb-1 block w-full rounded-lg border px-3 py-2.5 text-left transition-colors', selected === block ? 'border-neon-cyan/30 bg-neon-cyan/5' : needsReview(block) ? 'border-warning-orange/15 bg-warning-orange/5 hover:bg-warning-orange/10' : 'border-transparent hover:bg-white/[0.03]')}>
            {needsReview(block) && <span className="mb-1.5 flex items-center gap-1.5 text-[11px] text-warning-orange"><AlertCircle size={12} />À vérifier{block.confidence != null ? ` · confiance ${Math.round(block.confidence)} %` : ''}</span>}
            {block.method === 'cell' && <span className="mb-1 block font-mono text-[10px] text-text-muted">{block.locator}</span>}
            <span className="block whitespace-pre-wrap break-words text-sm leading-7 text-text-primary">{block.text}</span>
          </button>)}
        </div>
        <div className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-t border-white/10 px-5 py-3 text-[11px] text-text-muted">
          <span className="min-w-0 truncate" title={selected?.locator}>{selected ? `${selected.locator}${selected.confidence != null ? ` · confiance OCR ${Math.round(selected.confidence)} %` : ''}` : 'Le texte reconnu peut contenir des erreurs.'}</span>
          {blocks.length > BLOCKS_PER_VIEW && <div className="flex shrink-0 items-center gap-2"><button aria-label="Passages précédents" disabled={!offset} onClick={() => setOffset(n => n - BLOCKS_PER_VIEW)} className="p-1 disabled:opacity-30"><ChevronLeft size={16} /></button><span className="tabular-nums">{offset + 1}–{Math.min(offset + BLOCKS_PER_VIEW, blocks.length)} / {blocks.length}</span><button aria-label="Passages suivants" disabled={offset + BLOCKS_PER_VIEW >= blocks.length} onClick={() => setOffset(n => n + BLOCKS_PER_VIEW)} className="p-1 disabled:opacity-30"><ChevronRight size={16} /></button></div>}
        </div>
      </div>
    </div>
    {!!warnings.length && <details className="shrink-0 border-t border-white/10 px-5 py-3 text-xs text-text-muted sm:px-6"><summary className="cursor-pointer">Notes de lecture ({warnings.length})</summary><div className="max-h-24 space-y-2 overflow-y-auto pt-3">{warnings.map((warning, index) => <p key={index} className="leading-relaxed">{warning}</p>)}</div></details>}
  </>;
}

export function DocumentPreview({ threadId, document: doc, onClose }: { threadId: string; document: CoachDocument; onClose: () => void }) {
  return createPortal(<Modal open onClose={onClose} padded={false} label={`Aperçu de ${doc.name}`} className="flex h-[min(860px,92dvh)] max-w-6xl flex-col overflow-hidden rounded-xl border-white/10 bg-abyss! shadow-2xl">
    <header className="flex shrink-0 items-center gap-4 border-b border-white/10 px-5 py-5 sm:px-6">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-neon-cyan/15 bg-neon-cyan/5 text-neon-cyan"><FileSearch size={20} /></div>
      <div className="min-w-0 flex-1"><p className="mb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-text-muted">Aperçu du document</p><h2 className="truncate text-sm font-medium text-text-primary sm:text-base" title={doc.name}>{doc.name}</h2></div>
      <button aria-label="Fermer l’aperçu" onClick={onClose} className="rounded-lg p-2 text-text-muted transition-colors hover:bg-white/5 hover:text-text-primary"><X size={20} /></button>
    </header>
    <PreviewContent threadId={threadId} document={doc} />
  </Modal>, document.body);
}
