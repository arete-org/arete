import { useLayoutEffect } from 'react';

/** One viewport owner for dialogs and the coach; no React render per keyboard frame. */
export function useVisualViewport() {
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    const update = () => {
      root.style.setProperty('--visible-height', `${viewport?.height ?? window.innerHeight}px`);
      root.style.setProperty('--visible-top', `${viewport?.offsetTop ?? 0}px`);
      root.style.setProperty('--keyboard-inset', `${Math.max(0, window.innerHeight - (viewport?.height ?? window.innerHeight) - (viewport?.offsetTop ?? 0))}px`);
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      for (const name of ['--visible-height', '--visible-top', '--keyboard-inset']) root.style.removeProperty(name);
    };
  }, []);
}
