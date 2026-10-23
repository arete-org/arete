import { useLayoutEffect, type RefObject } from 'react';

const DESKTOP = '(min-width: 768px)';

/**
 * Publishes `--navigation-bottom`, where the desktop bar really ends, while `active`.
 * A notice rendered above the sticky bar pushes it down until the page scrolls it
 * away, so the open coach reads this edge instead of assuming the bar's height.
 * Phones hide the bar: nothing is measured or published there.
 */
export function useNavigationBottom(bar: RefObject<HTMLElement | null>, active: boolean) {
  useLayoutEffect(() => {
    const element = bar.current;
    const shell = element?.parentElement;
    if (!active || !element || !shell) return;
    const root = document.documentElement;
    const desktop = window.matchMedia(DESKTOP);
    const viewport = window.visualViewport;
    let frame = 0;
    const measure = () => {
      frame = 0;
      // `rect + scrollY` is a document coordinate in every engine: client rectangles
      // follow the layout viewport in Chromium and the visual viewport in WebKit,
      // whose scrollY follows it too. The fixed panel is placed in the layout
      // viewport, whose document top is `pageTop - offsetTop`. In WebKit's mobile
      // emulation, after a scroll the visual viewport sat 8 px below the layout
      // one: the raw rectangle put the panel 8 px under the bar.
      const layoutTop = viewport ? viewport.pageTop - viewport.offsetTop : window.scrollY;
      const bottom = element.getBoundingClientRect().bottom + window.scrollY - layoutTop;
      root.style.setProperty('--navigation-bottom', `${Math.max(0, bottom)}px`);
    };
    // Scroll and resize events can fire several times a frame: measure once.
    const schedule = () => { frame ||= requestAnimationFrame(measure); };
    // Size changes above the bar move it; the observer already reports once a frame.
    const resized = new ResizeObserver(measure);
    const observeAbove = () => {
      resized.disconnect();
      resized.observe(shell);
      for (let above: Element | null = element; above; above = above.previousElementSibling) resized.observe(above);
    };
    // An element inserted above the bar after the coach opened is observed too.
    const inserted = new MutationObserver(() => { observeAbove(); measure(); });
    const stop = () => {
      resized.disconnect();
      inserted.disconnect();
      for (const target of [window, viewport]) {
        target?.removeEventListener('scroll', schedule);
        target?.removeEventListener('resize', schedule);
      }
      cancelAnimationFrame(frame);
      frame = 0;
      root.style.removeProperty('--navigation-bottom');
    };
    const follow = () => {
      stop();
      if (!desktop.matches) return;
      observeAbove();
      inserted.observe(shell, { childList: true });
      for (const target of [window, viewport]) {
        target?.addEventListener('scroll', schedule, { passive: true });
        target?.addEventListener('resize', schedule);
      }
      measure();
    };
    follow();
    desktop.addEventListener('change', follow);
    return () => {
      desktop.removeEventListener('change', follow);
      stop();
    };
  }, [bar, active]);
}
