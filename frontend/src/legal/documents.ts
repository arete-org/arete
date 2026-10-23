/**
 * The published texts (Markdown beside this file, in French). Each carries its
 * version in its header; the server holds the versions to accept
 * (`services/consent.py`), and a backend test keeps the two aligned.
 */
export const LEGAL_DOCUMENTS = [
  { id: 'terms', title: "Conditions d'utilisation" },
  { id: 'privacy', title: 'Politique de confidentialité' },
] as const;

export type LegalId = (typeof LEGAL_DOCUMENTS)[number]['id'];
