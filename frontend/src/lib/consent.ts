/** A consent timestamp (UTC ISO from the server) on the reader's clock, in French. */
export function formatConsentDate(iso: string): string {
  // The server sends an offset; an older answer without one is UTC as well.
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`);
  return date.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
}
