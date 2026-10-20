import { useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

/** History state of a session screen the Journal opened over itself. */
export const OPENED_IN_JOURNAL = { openedInJournal: true } as const;

function openedInJournal(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as Record<string, unknown>).openedInJournal === true;
}

/** Whether this tab's history holds an in-app page before the current one. */
function hasPreviousPage(): boolean {
  // React Router numbers its entries in `history.state.idx`: 0 is the tab's first page.
  const index = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof index === 'number' && index > 0;
}

/**
 * Closes a session screen of the Journal (entry or draft). Opened by the Journal,
 * it closes in place; linked from another page (Home, a session, the coach), it
 * goes back there, or Home when the link opened the tab.
 */
export function useEntryClose(closeInPlace: () => void) {
  const navigate = useNavigate();
  const { state, key } = useLocation();
  // The entry being left: a second close before the navigation lands (a double
  // tap, Escape) must not go back one more page.
  const leaving = useRef<string | null>(null);
  return () => {
    if (openedInJournal(state)) return closeInPlace();
    if (leaving.current === key) return;
    leaving.current = key;
    if (hasPreviousPage()) navigate(-1);
    else navigate('/', { replace: true });
  };
}
