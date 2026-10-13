import { useSyncExternalStore } from 'react';

type Renderer = typeof import('./MarkdownContent').MarkdownContent;
let renderer: Renderer | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** react-markdown and its parsers are a third of the app's code: they load with
 *  the coach, not with the dashboard. A failed load is retried by the next caller
 *  (the next panel opening or answer); meanwhile answers stay plain text. */
export function preloadAgentMarkdown() {
  if (renderer || loading) return;
  loading = import('./MarkdownContent')
    .then((module) => {
      renderer = module.MarkdownContent;
      listeners.forEach((listener) => listener());
    })
    .catch(() => {})
    .finally(() => {
      loading = null;
    });
}

/** After first paint, so a cold coach opening shows formatted answers at once. */
export function preloadAgentMarkdownWhenIdle() {
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(preloadAgentMarkdown, { timeout: 5000 });
  else setTimeout(preloadAgentMarkdown, 2000);
}

/** The loaded renderer, or null until it arrives. */
export function useMarkdownRenderer(): Renderer | null {
  return useSyncExternalStore(subscribe, () => renderer);
}
