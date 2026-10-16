import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle, PencilLine } from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import { ApiError, planApi } from '@/lib/api';
import { coachTodayKey, discussWithCoach } from '@/lib/coachToday';
import { invalidateAfterSession, qk } from '@/lib/queryKeys';
import { readableError } from '@/lib/utils';
import type { Renegotiation } from '@/lib/renegotiation';
import type { PlannedSession, RenegotiationReason } from '@/types';


const renegotiationKey = (sessionId: number) => ['renegotiation', sessionId] as const;

/**
 * « Modifier » on today's session: the fixed reasons, each with the options the
 * server's rules compute, read when the menu opens (no dashboard request).
 * Modifier → option is the whole answer. « Autre… » opens the coach with the
 * session as the active thread's reference; the composer stays as it was.
 */
export function RenegotiateMenu({
  session,
  onDone,
}: {
  session: PlannedSession;
  /** The choice is written: the panel shows its outcome (the card may leave, for a move). */
  onDone: (done: Renegotiation) => void;
}) {
  const client = useQueryClient();
  const id = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Set on the tap itself: a second tap lands before the mutation's state does.
  const sending = useRef(false);
  const menu = useQuery({
    queryKey: renegotiationKey(session.id),
    queryFn: ({ signal }) => planApi.renegotiationOptions(session.id, signal),
    enabled: open,
    // Computed from the session's current state: never shown from an old read.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const choose = useMutation({
    mutationFn: (choice: { reason: string; option: RenegotiationReason['options'][number] }) =>
      planApi.renegotiate(session.id, {
        reason: choice.reason,
        option: choice.option.id,
        version: menu.data!.version,
      }),
    onSuccess: async (result, choice) => {
      setOpen(false);
      onDone({ result, option: choice.option });
      // A dashboard read in flight predates the choice: it must not land after it.
      await client.cancelQueries({ queryKey: qk.dashboard() });
      invalidateAfterSession(client);
      void client.invalidateQueries({ queryKey: coachTodayKey });
    },
    // Refused (changed since, another tab): the options are read again.
    onError: () => {
      void menu.refetch();
      invalidateAfterSession(client);
    },
    onSettled: () => {
      sending.current = false;
    },
  });

  // Opening moves the focus into the menu once it has something to focus.
  useEffect(() => {
    if (open && !menu.isPending) panel.current?.querySelector<HTMLElement>('button, [tabindex]')?.focus();
  }, [open, menu.isPending]);

  const close = () => {
    setOpen(false);
    choose.reset();
    toggle.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (open && event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };
  const other = () => {
    setOpen(false);
    discussWithCoach({ kind: 'session', id: session.id });
  };
  // One choice at a time, and none from options being read again.
  const waiting = choose.isPending || menu.isFetching;
  const send = (reason: string, option: RenegotiationReason['options'][number]) => {
    if (sending.current || waiting) return;
    sending.current = true;
    choose.mutate({ reason, option });
  };
  const refused =
    choose.error instanceof ApiError && choose.error.status === 409
      ? choose.error.detail ?? 'Ta séance a changé : voici les options à jour.'
      : choose.error
        ? readableError(choose.error)
        : null;

  return (
    <div className="mt-2" onKeyDown={onKeyDown}>
      <button
        ref={toggle}
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        onClick={() => (open ? close() : setOpen(true))}
        className="inline-flex min-h-11 items-center gap-1.5 rounded border border-text-muted/25 px-3 text-xs font-sans text-text-secondary hover:border-neon-cyan/50 hover:text-text-primary"
      >
        <PencilLine aria-hidden className="h-3.5 w-3.5" />
        Modifier
      </button>
      {open && (
        <div
          ref={panel}
          id={`${id}-menu`}
          role="group"
          aria-label="Modifier la séance du jour"
          aria-busy={menu.isPending || choose.isPending}
          className="mt-2 space-y-3 rounded-lg border border-text-muted/20 bg-abyss/60 p-3"
        >
          {menu.isPending ? (
            <p role="status" className="flex items-center gap-2 text-xs font-sans text-text-muted">
              <Spinner className="h-3 w-3" /> Calcul des options…
            </p>
          ) : menu.isError ? (
            <p role="alert" className="text-xs font-sans text-danger-red">
              {menu.error instanceof ApiError && menu.error.detail ? menu.error.detail : 'Options indisponibles.'}{' '}
              <button type="button" className="min-h-11 text-neon-cyan hover:underline" onClick={() => void menu.refetch()}>
                Réessayer
              </button>
            </p>
          ) : (
            <>
              {refused && (
                <p role="alert" className="text-xs font-sans text-danger-red">
                  {refused}
                </p>
              )}
              {menu.data.blocked ? (
                <p className="text-xs font-sans text-text-secondary">{menu.data.blocked}</p>
              ) : (
                menu.data.reasons.map((reason) => (
                  <section key={reason.id} aria-labelledby={`${id}-${reason.id}`}>
                    <h3 id={`${id}-${reason.id}`} className="text-[11px] font-sans uppercase tracking-wider text-text-muted">
                      {reason.label}
                    </h3>
                    <div className="mt-1 grid gap-1.5 sm:grid-cols-2">
                      {reason.options.map((option) => {
                        const busy = choose.isPending && choose.variables?.option === option && choose.variables.reason === reason.id;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            // Not `disabled`: the tapped option keeps the focus while it is sent.
                            aria-disabled={waiting}
                            onClick={() => send(reason.id, option)}
                            className="flex min-h-11 min-w-0 flex-col items-start justify-center rounded border border-neon-cyan/25 bg-neon-cyan/5 px-3 py-1.5 text-left font-sans hover:bg-neon-cyan/15 aria-disabled:opacity-50"
                          >
                            <span className="flex items-center gap-1.5 text-xs text-text-primary">
                              {busy && <Spinner className="h-3 w-3" />}
                              {option.label}
                            </span>
                            <span className="text-[11px] text-text-muted [overflow-wrap:anywhere]">{option.detail}</span>
                          </button>
                        );
                      })}
                    </div>
                    {reason.note && <p className="mt-1 text-[11px] font-sans text-text-muted">{reason.note}</p>}
                  </section>
                ))
              )}
              <button
                type="button"
                onClick={() => {
                  if (!sending.current) other();
                }}
                aria-disabled={choose.isPending}
                className="inline-flex min-h-11 items-center gap-1.5 text-xs font-sans text-neon-cyan hover:underline aria-disabled:opacity-50"
              >
                <MessageCircle aria-hidden className="h-3.5 w-3.5" />
                Autre… en parler au coach
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
