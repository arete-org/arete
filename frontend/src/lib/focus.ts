const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Before a control removes `root` (a dismissed banner), move the focus to the
 * nearest visible control outside it, the one before or else the one after,
 * so it never falls back to the page.
 */
export function focusNear(root: HTMLElement): void {
  if (!root.contains(document.activeElement)) return;
  const all = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !root.contains(element) && element.getClientRects().length > 0,
  );
  const position = (element: HTMLElement) => root.compareDocumentPosition(element);
  const before = all.filter((element) => position(element) & Node.DOCUMENT_POSITION_PRECEDING).pop();
  const after = all.find((element) => position(element) & Node.DOCUMENT_POSITION_FOLLOWING);
  (before ?? after)?.focus({ preventScroll: true });
}
