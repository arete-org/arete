import terms from './conditions.md?raw';
import privacy from './confidentialite.md?raw';

/** The version a published text declares in its header (`Version : \`…\``). */
export function versionOf(text: string): string {
  const match = /^Version : `([^`]+)`$/m.exec(text);
  if (!match) throw new Error('Version absente du texte publié.');
  return match[1];
}

/**
 * The versions of the texts this build shows: what a consent accepts. The
 * server refuses them when it publishes newer ones (409, "recharge la page").
 */
export const LEGAL_VERSIONS = { terms: versionOf(terms), privacy: versionOf(privacy) };
