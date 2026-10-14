import { useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

const MAX_SAVED_POSITIONS = 100;
const RESTORE_TIMEOUT_MS = 2000;

/** Restore recent history entries after lazy content arrives, never after user input. */
export function RouteScroll() {
  const { key, pathname } = useLocation();
  const navigation = useNavigationType();
  const positions = useRef(new Map<string, number>());
  const previousPath = useRef(pathname);
  useLayoutEffect(() => {
    const previous = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    return () => { history.scrollRestoration = previous; };
  }, []);
  useLayoutEffect(() => {
    const saved = positions.current;
    const target = navigation === 'POP' ? saved.get(key) : undefined;
    const changedPage = pathname !== previousPath.current;
    previousPath.current = pathname;
    let observer: ResizeObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { observer?.disconnect(); clearTimeout(timer); };
    if (target !== undefined) {
      const restore = () => {
        window.scrollTo({ top: target, behavior: 'instant' });
        if (Math.abs(window.scrollY - target) < 2) stop();
      };
      observer = new ResizeObserver(restore);
      observer.observe(document.body);
      timer = setTimeout(stop, RESTORE_TIMEOUT_MS);
      restore();
    } else if (changedPage) window.scrollTo({ top: 0, behavior: 'instant' });
    const remember = () => { saved.set(key, window.scrollY); };
    remember();
    // Retention is deliberately limited to the most recent 100 history entries.
    if (saved.size > MAX_SAVED_POSITIONS) saved.delete(saved.keys().next().value!);
    window.addEventListener('scroll', remember, { passive: true });
    window.addEventListener('touchstart', stop, { passive: true });
    window.addEventListener('wheel', stop, { passive: true });
    window.addEventListener('keydown', stop);
    return () => {
      stop();
      window.removeEventListener('scroll', remember);
      window.removeEventListener('touchstart', stop);
      window.removeEventListener('wheel', stop);
      window.removeEventListener('keydown', stop);
    };
  }, [key, pathname, navigation]);
  return null;
}
