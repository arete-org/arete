import { AutomationReview } from './agent/AutomationReview';
import type { CoachDisplay } from '@/hooks/useCoachDisplay';
import { CoachDisplayOptions } from './agent/CoachDisplayOptions';
import { CoachMemory, MemoryReceipt } from './agent/CoachMemory';
import { CoachReferenceCard } from './agent/CoachReferenceCard';
import { BriefingDiscussion } from './agent/BriefingDiscussion';
import { OnboardingContext } from './agent/OnboardingContext';
import { MessageFeedback } from './agent/MessageFeedback';
import { SkillInput } from './agent/SkillInput';
import { ContextWindowGauge } from './agent/ContextWindowGauge';
import { useGamePreference } from '@/lib/gamification';
import { AreteMark } from './AreteBrand';
import { MessageAttachments } from './agent/MessageAttachments';
import { Maximize2, Minimize2 } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { WorkoutSelection } from './WorkoutSelection';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Minus,
  CircleAlert,
  Send,
  X,
  Plus,
  Ellipsis,
  ChevronDown,
  RotateCcw,
  Square,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePanelContext } from '@/lib/pageContext';
import {
  MAX_MESSAGE_CHARS,
  type ChatMessage,
  type ChatPart,
  type ToolPart,
} from '@/lib/agentStream';
import { useCoachThreads } from '@/hooks/useCoachThreads';
import { starters } from '@/lib/coachPrompts';
import { ThreadHistory } from './agent/ThreadHistory';
import { AgentMarkdown } from './agent/AgentMarkdown';
import { preloadAgentMarkdown } from './agent/markdownRenderer';
import { ToolActivity } from './agent/ToolActivity';
import { CoachActivity, CoachPresence } from './agent/CoachActivity';
import { canRetryMessage, isThinking } from '@/lib/agentActivity';
import { DocumentAttachments, type AttachmentsHandle } from './agent/DocumentAttachments';
import { CalendarActionCard } from './agent/CalendarActionCard';
import { ChartCard } from './agent/ChartCard';

const PAGE_LABELS: Record<string, string> = {
  dashboard: 'Tableau de bord',
  follow_up: 'Suivi',
  planning: 'Planning',
  analytics: 'Analyses',
  log: 'Carnet',
  settings: 'Paramètres',
  profile: 'Mon profil',
};
const MAX_COMPOSER_HEIGHT_PX = 144;
/** On a phone, Enter inserts a new line: the keyboard has no Shift to hold. */
const touchKeyboard = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(pointer: coarse)').matches === true;

/** One activity card per answer, where its first tool ran; texts in order.
 *  A card per tool round read as several answers stacked on each other. */
const MessageSurfaces = memo(function MessageSurfaces({
  message,
  onAction,
  locked,
  chiron = false,
}: {
  onAction?: (text: string) => void;
  locked?: boolean;
  chiron?: boolean;
  message: ChatMessage;
}) {
  const parts: ChatPart[] = message.parts?.length
    ? message.parts
    : message.content
      ? [{ kind: 'text', id: 'answer', text: message.content }]
      : [];
  const tools = parts.filter((part): part is ToolPart => part.kind === 'tool');
  const groups: (ChatPart | ToolPart[])[] = [];
  for (const part of parts) {
    if (part.kind === 'text') {
      if (part.text.trim()) groups.push(part);
    } else if (part.kind === 'chart_card' || part.kind === 'calendar_action' || (part.kind === 'coach_card' && part.ref_kind !== 'fact')) groups.push(part);
    else if (!chiron && part === tools[0]) groups.push(tools);
  }
  return (
    <>
      {groups.map((part) =>
        Array.isArray(part) ? (
          <ToolActivity key={`tool-${part[0].id}`} tools={part} />
        ) : part.kind === 'text' ? (
          chiron ? <div key={`text-${part.id}`} className="coach-answer-part"><AgentMarkdown text={part.text} /></div>
            : <AgentMarkdown key={`text-${part.id}`} text={part.text} />
        ) : part.kind === 'chart_card' ? <ChartCard key={part.id} chart={part} /> : part.kind === 'coach_card' ? <CoachReferenceCard key={part.id} reference={part} /> : part.kind === 'calendar_action' ? (
          <CalendarActionCard key={`calendar-${part.id}`} id={part.id} />
        ) : null
      )}
      {parts.some(p => p.kind === 'coach_card' && p.ref_kind === 'fact') && <MemoryReceipt factIds={parts.flatMap(p => p.kind === 'coach_card' && p.ref_kind === 'fact' ? [p.ref_id] : [])} />}
      {!!message.workouts?.length && <WorkoutSelection sessions={message.workouts} onResult={onAction} locked={locked} />}
      {message.error && (
        <div
          role="alert"
          className="mt-3 flex gap-2 rounded-lg border border-danger-red/20 bg-danger-red/5 p-3 text-xs leading-relaxed text-danger-red"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{message.error}</span>
        </div>
      )}
      {message.interrupted && !chiron && (
        <p className="mt-3 text-xs text-text-muted">Réponse interrompue. Les séances déjà enregistrées sont conservées ; vérifie Garmin avant tout nouvel envoi.</p>
      )}
    </>
  );
});

export function AgentSidePanel({
  open,
  onClose,
  onBusyChange,
  display = 'sidebar',
  onDisplayChange,
  displayError,
}: {
  display?: CoachDisplay;
  onDisplayChange?: (mode: CoachDisplay) => void;
  displayError?: string | null;
  open: boolean;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const floating = display === 'floating';
  const panelContext = usePanelContext();
  const [showMemory, setShowMemory] = useState(false);
  const { data: preference } = useGamePreference();
  const rpg = preference?.enabled === true;
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const coach = useCoachThreads(panelContext, true);
  const { active, store, runningId } = coach;
  const reference = active.reference;
  const messages = active.messages;
  const attachmentsRef = useRef<AttachmentsHandle>(null);
  const [documentBusyByThread, setDocumentBusyByThread] = useState<Record<string, boolean>>({});
  const documentsBusy = documentBusyByThread[active.id] ?? false;
  const setDocumentsBusy = useCallback((value: boolean) => {
    setDocumentBusyByThread(previous => ({ ...previous, [active.id]: value }));
  }, [active.id]);
  const streaming = runningId === active.id;
  const busy = runningId !== null || documentsBusy;
  const [showHistory, setShowHistory] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  const followRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const resize = () => {
      cancelAnimationFrame(frame);
      // App updates the shared viewport geometry first. Follow only after layout,
      // and never pull someone away from the older messages they are reading.
      frame = requestAnimationFrame(() => {
        if (followRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      });
    };
    viewport.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', resize);
    };
  }, [open]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    // Grow the draft between the inline actions, then scroll at the height limit.
    const resize = () => {
      input.style.height = 'auto';
      const height = input.scrollHeight;
      input.style.height = `${Math.min(height, MAX_COMPOSER_HEIGHT_PX)}px`;
      input.style.overflowY = height > MAX_COMPOSER_HEIGHT_PX ? 'auto' : 'hidden';
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [active.draft, active.id, rpg, open, showHistory, showMemory, expanded, display]);

  useLayoutEffect(() => {
    if (followRef.current)
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, open, showHistory, showMemory, display, expanded]);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => {
    if (open) preloadAgentMarkdown();
  }, [open]);
  useEffect(() => {
    if (open && !showHistory) inputRef.current?.focus({ preventScroll: true });
  }, [open, showHistory, active.id]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      if (e.key === 'Escape') {
        if (deleteId) setDeleteId(null);
        else if (showHistory) setShowHistory(false);
        else if (showMemory) setShowMemory(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, showHistory, showMemory, deleteId]);

  useEffect(() => {
    const reveal = () => { setShowHistory(false); setShowMemory(false); followRef.current = true; setFollowing(true); };
    window.addEventListener('arete:coach-discuss', reveal);
    window.addEventListener('arete:conversation-open', reveal);
    return () => { window.removeEventListener('arete:coach-discuss', reveal); window.removeEventListener('arete:conversation-open', reveal); };
  }, []);

  const followLatest = () => {
    followRef.current = true;
    setFollowing(true);
  };
  const selectThread = (id: string) => {
    void coach.openArchived(id);
    setShowHistory(false);
    followLatest();
  };
  const newThread = () => {
    coach.create();
    setShowHistory(false);
    followLatest();
  };
  const send = (prompt?: string) => {
    if (!busy && coach.send(prompt)) followLatest();
  };

  if (!open) return null;
  const page = reference?.kind === 'briefing' ? 'Briefing' : PAGE_LABELS[panelContext.page] ?? panelContext.page;
  return (
    <aside
      onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current += 1; setDragging(true); } }}
      onDragLeave={event => { if (event.dataTransfer.types.includes('Files')) { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); } }}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
      onDrop={event => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); dragDepth.current = 0; setDragging(false); if (!busy) attachmentsRef.current?.upload(Array.from(event.dataTransfer.files)); }}
      id="coach-panel"
      data-display={display}
      data-view={showMemory || showHistory ? 'auxiliary' : 'conversation'}
      className={cn("coach-panel fixed right-0 z-40 flex w-full flex-col border-l border-text-muted/20 shadow-2xl", rpg ? 'bg-void' : 'bg-abyss', !floating && rpg && expanded ? "max-w-none md:px-[max(24px,calc((100vw-800px)/2))]" : "max-w-[520px]")}
      role="complementary"
      aria-label="Coach IA"
    >
      {dragging && <div className="absolute inset-3 z-50 pointer-events-none flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-neon-cyan bg-abyss/95 p-6 text-center"><p className="text-xl font-bold">Dépose tes fichiers ici</p><p className="mt-3 text-sm text-text-secondary">Ils seront joints au brouillon, sans envoyer le message.</p><p className="mt-2 text-xs text-text-muted">5 fichiers maximum · 20 Mio par fichier</p></div>}
      <header className="coach-header flex shrink-0 items-center gap-2 border-b border-text-muted/15 px-4 py-3">
        {floating ? <>
          <AreteMark size={18} />
          <h2 className="coach-title">Chiron</h2>
          <span className="min-w-0 flex-1 truncate text-[11px] text-text-muted">{page}</span>
        </> : <>
        <div className={cn('flex size-9 shrink-0 items-center justify-center', !rpg && 'rounded-xl border border-neon-cyan/15 bg-neon-cyan/5')}>
          <AreteMark size={36} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="coach-title text-sm font-semibold">{rpg ? 'Chiron' : 'Coach Arete'}</h2>
          {rpg ? <button onClick={() => setShowHistory(true)} aria-label="Changer de conversation" className="mt-0.5 flex max-w-full items-center gap-1 text-[11px] text-text-muted hover:text-text-primary"><span className="truncate">{active.title}</span><ChevronDown className="size-3 shrink-0" /></button> : <p className="mt-0.5 text-[11px] text-text-muted">{page}</p>}
        </div>
        <button className="min-h-11 rounded px-2 text-xs text-text-muted hover:text-text-primary" aria-label="Ce que Chiron sait de moi" aria-expanded={showMemory} onClick={() => { setShowMemory(value => !value); setShowHistory(false); }}>Mémoire</button>
        {rpg && <button aria-label={expanded ? 'Réduire la conversation' : 'Agrandir la conversation'} onClick={() => setExpanded(!expanded)} className="ml-auto hidden md:flex size-11 items-center justify-center text-text-muted">{expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>}
        <button
          onClick={() => { setShowHistory((v) => !v); setShowMemory(false); }}
          className="ml-auto flex size-11 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-text-muted/10"
          aria-label="Historique des conversations"
          aria-expanded={showHistory}
          title="Historique des conversations"
        >
          <Ellipsis className="size-4" />
        </button>
        </>}
        {onDisplayChange && <CoachDisplayOptions mode={display} onChange={onDisplayChange}
          onHistory={() => { setShowHistory(value => !value); setShowMemory(false); }}
          onMemory={() => { setShowMemory(value => !value); setShowHistory(false); }}
          onCreate={() => { newThread(); setShowMemory(false); }} />}
        <button
          onClick={onClose}
          className="rounded-lg p-2 text-text-muted hover:bg-text-muted/10"
          aria-label="Masquer le coach"
          title="Masquer le coach"
        >
          {floating ? <Minus className="size-4" /> : <X className="size-5" />}
        </button>
      </header>
      {displayError && <p role="alert" className="px-4 py-2 text-xs text-warning-orange">{displayError}</p>}
      {coach.storageError && (
        <p
          role="alert"
          className="border-b border-warning-orange/20 bg-warning-orange/5 px-4 py-2 text-xs text-warning-orange"
        >
          {coach.storageError}
          <button className="ml-2 min-h-11 underline" onClick={coach.retryArchive}>Réessayer</button>
          <button className="ml-2 min-h-11 underline" onClick={() => void coach.recoverArchive()}>Conserver une copie et recharger le fil</button>
        </p>
      )}
      {coach.error && (
        <p role="alert" className="px-4 py-2 text-xs text-danger-red">
          {coach.error}
        </p>
      )}
      {deleteId && (
        <div
          role="alert"
          className="border-b border-text-muted/15 bg-shadow px-4 py-3 text-xs"
        >
          <p>
            Supprimer « {store.threads.find((t) => t.id === deleteId)?.title} »
            ? Cette conversation sera effacée de ce navigateur.
          </p>
          <div className="mt-2 flex gap-3">
            <button
              onClick={() => {
                coach.remove(deleteId);
                setDeleteId(null);
              }}
              className="rounded bg-danger-red/15 px-3 py-1.5 text-danger-red"
            >
              Supprimer
            </button>
            <button
              onClick={() => setDeleteId(null)}
              className="rounded px-3 py-1.5 text-text-muted"
            >
              Annuler
            </button>
          </div>
        </div>
      )}
      {reference && reference.kind !== 'briefing' && reference.kind !== 'onboarding' && (reference.kind !== 'automation_run' || reference.mode === 'discussion') && <div className="border-b border-text-muted/15 px-4 py-2">
        <p className="text-xs text-text-secondary">{{ proposal: 'Proposition sélectionnée', followup: 'Suivi sélectionné', review: 'Bilan de la semaine sélectionné', session: 'Séance du jour sélectionnée', automation_run: 'Exécution sélectionnée' }[reference.kind]} · prêt à en parler <button className="min-h-11 px-2 underline" onClick={coach.clearReference}>Retirer</button></p>
      </div>}
      {!showMemory && !showHistory && reference?.kind === 'automation_run' && reference.mode !== 'discussion' ? <AutomationReview id={reference.id} /> : showMemory ? <div className="min-h-0 flex-1 overflow-y-auto p-5"><h3 className="text-lg font-semibold">Ce que je retiens de toi</h3><p className="mt-2 mb-4 text-sm text-text-muted">Tu peux tout corriger ou me demander d’oublier.</p><CoachMemory /></div> : showHistory ? (
        <ThreadHistory
          threads={store.threads}
          activeId={active.id}
          runningId={runningId}
          onSelect={selectThread}
          onRename={coach.renameLocal}
          onCreate={newThread}
          onDelete={setDeleteId}
          onClose={() => setShowHistory(false)}
        />
      ) : (
        <>
          {!rpg && !floating && <button
            onClick={() => setShowHistory(true)}
            className="flex shrink-0 items-center gap-2 border-b border-text-muted/10 px-5 py-2.5 text-left text-xs text-text-secondary hover:bg-shadow/40"
            aria-label="Changer de conversation"
          >
            <span className="min-w-0 flex-1 truncate">{active.title}</span>
            <ChevronDown className="size-3.5 text-text-muted" />
          </button>}
          {runningId !== null && !streaming && (
            <div
              role="status"
              className="border-b border-neon-cyan/10 bg-neon-cyan/5 px-4 py-3 text-xs text-text-secondary"
            >
              <p className="flex items-center gap-2">
                <CoachPresence />
                Le coach répond dans un autre fil.
              </p>
              <button
                onClick={() => selectThread(runningId!)}
                className="mt-2 text-neon-cyan underline underline-offset-2"
              >
                Revenir à la réponse
              </button>
              <span className="mx-2">·</span>
              <button
                onClick={coach.stop}
                className="text-text-muted underline underline-offset-2"
              >
                Arrêter
              </button>
            </div>
          )}
          <div
            ref={scrollRef}
            onScroll={() => {
              const el = scrollRef.current;
              if (!el) return;
              const nearBottom =
                el.scrollHeight - el.scrollTop - el.clientHeight < 64;
              followRef.current = nearBottom;
              setFollowing(nearBottom);
            }}
            className="coach-thread min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-6"
          >
            {reference?.kind === 'briefing' && <BriefingDiscussion key={reference.id} id={reference.id} />}
            {reference?.kind === 'onboarding' && <OnboardingContext key={active.id} />}
            {!messages.length && reference?.kind !== 'briefing' && (
              <div className="coach-empty mx-auto mt-10 max-w-sm">
                {!floating && <AreteMark size={48} />}
                <h3 className="text-lg font-semibold">On prépare la suite ?</h3>
                {!floating && <p className="mt-2 text-sm leading-relaxed text-text-muted">
                  Ta forme, tes séances, tes objectifs. Pose une question, je
                  consulte les données utiles.
                </p>}
                <div className="mt-6 space-y-2">
                  {(reference?.kind === 'onboarding' ? ['Comment avancer vers mon objectif ?', 'Aide-moi à trouver un rythme réaliste'] : starters(panelContext.page).slice(0, floating ? 2 : 3)).map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => send(prompt)}
                      disabled={busy}
                      className={cn('block w-full rounded-xl px-3.5 py-3 text-left text-sm text-text-secondary hover:bg-neon-cyan/5', !rpg && 'border border-text-muted/15 hover:border-neon-cyan/30')}
                    >
                      {prompt}{floating && <ArrowUpRight className="size-3.5 shrink-0" />}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="space-y-6">
              {messages.map((message, i) => (
                <article
                  key={`${active.id}-${i}`}
                  aria-label={
                    message.role === 'user' ? 'Ton message' : 'Réponse du coach'
                  }
                  className={cn(
                    'min-w-0',
                    message.role === 'user' && 'flex justify-end'
                  )}
                >
                  {message.role === 'user' ? (
                    <div className="max-w-[90%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm bg-neon-purple/15 px-4 py-3 text-sm leading-relaxed">
                      {message.content}
                      {!!message.attachmentIds?.length && <MessageAttachments ids={message.attachmentIds} threadId={active.id} />}
                    </div>
                  ) : (
                    <div className="min-w-0">
                      {/* While Chiron thinks, its laurel turns in the status line instead. */}
                      {!isThinking(message) && (
                        <div className="mb-3 flex items-center gap-2 text-[11px] font-medium text-text-muted">
                          <AreteMark size={24} /> CHIRON
                        </div>
                      )}
                      <CoachActivity message={message} />
                      <MessageSurfaces message={message} chiron locked={busy} onAction={text => coach.recordAction(active.id, text)} />
                      <div className="mt-1 flex flex-wrap items-center gap-x-0.5">
                        {message.trace && !message.pending && !message.error && !message.interrupted && <MessageFeedback
                          key={message.trace.trace_id} trace={message.trace} threadId={active.id} feedback={message.feedback}
                          onChange={feedback => coach.feedback(active.id, message.trace!.trace_id, feedback)}
                        />}
                        {i === messages.length - 1 && !busy && !message.pending && canRetryMessage(message) && (
                          <button
                            onClick={() => coach.retry() && followLatest()}
                            aria-label={message.error || message.interrupted ? 'Réessayer' : 'Regénérer'}
                            title={message.error || message.interrupted ? 'Réessayer' : 'Regénérer'}
                            className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-shadow hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-neon-cyan [@media(pointer:coarse)]:size-10"
                          >
                            <RotateCcw className="size-3.5" />
                          </button>
                        )}
                      </div>

                    </div>
                  )}
                </article>
              ))}
            </div>
          </div>
          {!following && (
            <button
              onClick={() => {
                followRef.current = true;
                setFollowing(true);
                scrollRef.current?.scrollTo({
                  top: scrollRef.current.scrollHeight,
                  behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
                });
              }}
              className="absolute bottom-36 right-5 flex items-center gap-1.5 rounded-full border border-text-muted/20 bg-shadow px-3 py-2 text-xs shadow-lg"
            >
              <ArrowDown className="size-3" /> Derniers messages
            </button>
          )}
          <footer className={cn('shrink-0 px-4 pb-4 pt-3', !floating && !rpg && 'border-t border-text-muted/15 bg-abyss')}>
            <div className="coach-composer relative grid grid-cols-[44px_minmax(0,1fr)_auto_44px] items-end gap-x-1 rounded-[var(--radius-control)] border border-[var(--arete-border)] bg-void px-2 py-1 focus-within:border-neon-cyan/40">
              <DocumentAttachments key={active.id} threadId={active.id} selectedIds={active.attachmentIds ?? []} disabled={runningId !== null} ref={attachmentsRef} onBusy={setDocumentsBusy} onDocuments={coach.attachments} />
              <div className="contents">
                <button
                  type="button"
                  disabled={busy}
                  aria-label="Joindre un fichier"
                  title="Joindre un fichier · PDF, Excel, images, texte · 20 Mio par fichier"
                  onClick={() => attachmentsRef.current?.choose()}
                  className="col-start-1 row-start-1 flex size-11 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:text-text-primary focus-visible:outline-2 focus-visible:outline-neon-cyan disabled:opacity-30"
                ><Plus className="size-4" aria-hidden="true" /></button>
                <SkillInput
                  key={active.id}
                  inputRef={inputRef}
                  aria-label="Message au coach"
                  value={active.draft}
                  onValueChange={coach.draft}
                  onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); if (!busy) attachmentsRef.current?.upload(Array.from(event.clipboardData.files)); } }}
                  rows={1}
                  wrap="soft"
                  maxLength={MAX_MESSAGE_CHARS}
                  onKeyDown={(e) => {
                    if (
                      e.key === 'Enter' &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing &&
                      !touchKeyboard()
                    ) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder={floating ? 'Demander à Chiron…' : 'Ton message…'}
                  className={cn('coach-composer-input block min-h-11 max-h-36 min-w-0 flex-1 resize-none appearance-none overflow-x-hidden overflow-y-auto bg-transparent py-1.5 text-sm leading-relaxed outline-none', 'col-start-2 row-start-1 w-full px-1')}
                />
                {streaming ? (
                  <button
                    onClick={coach.stop}
                    className={cn('flex items-center justify-center gap-2 rounded-lg bg-text-muted/10 hover:bg-text-muted/20', 'col-start-4 row-start-1 size-11')}
                    aria-label="Arrêter la réponse"
                  >
                    <Square className="size-4" />
                  </button>
                ) : (
                  <button
                    onClick={() => send()}
                    disabled={busy || !active.draft.trim()}
                    className={cn('flex shrink-0 items-center justify-center rounded-lg bg-neon-cyan/15 text-neon-cyan hover:bg-neon-cyan/25 disabled:opacity-30', 'col-start-4 row-start-1 size-11')}
                    aria-label="Envoyer"
                  >
                    {floating ? <ArrowUp className="size-4" /> : <Send className="size-4" />}
                  </button>
                )}
              </div>
            </div>
            <ContextWindowGauge key={active.id} usage={active.contextWindowUsage} compacting={coach.compacting} />
            {!floating && (!rpg || streaming) && <p className="mt-2 text-center text-[10px] text-text-muted">
              {rpg && streaming ? 'Tu peux préparer ton prochain message.' : touchKeyboard()
                ? 'Touche Envoyer pour envoyer'
                : 'Entrée pour envoyer · Maj + Entrée pour une nouvelle ligne'}
            </p>}
          </footer>
        </>
      )}
    </aside>
  );
}
