/**
 * The glossary's terms: the anchor of each entry on the glossary page and the
 * words a "?" link says. Light on purpose, so the dashboard's links stay in
 * the entry chunk without the definitions (`glossaryEntries.ts`, one per term).
 */

/** Each term with its article, for « Qu’est-ce que … ? ». */
export const GLOSSARY_TERMS = {
  acwr: 'le ratio charge aiguë / chronique (ACWR)',
  monotonie: 'la monotonie',
  tss: 'la charge d’entraînement (TSS)',
  ctl: 'la forme de fond (CTL)',
  atl: 'la fatigue (ATL)',
  tsb: 'la fraîcheur (TSB)',
  rpe: 'l’effort ressenti (RPE)',
  zones: 'les zones cardiaques',
  seuil: 'le seuil',
  decouplage: 'le découplage cardiaque',
  'derive-fc': 'la dérive de la FC',
  'cout-cardiaque': 'le coût cardiaque',
  allure: 'l’allure',
  gap: 'l’allure ajustée à la pente (GAP)',
  vdot: 'le VDOT',
  vam: 'la vitesse ascensionnelle (VAM)',
  cadence: 'la cadence',
  preparation: 'la préparation',
  vfc: 'la VFC',
  'fc-repos': 'la FC de repos',
  sommeil: 'le sommeil',
  stress: 'le stress',
  'body-battery': 'le Body Battery',
  checkin: 'le check-in du matin',
  adherence: 'l’adhérence',
  regularite: 'la régularité',
} as const;

export type GlossaryId = keyof typeof GLOSSARY_TERMS;

/** The page's address; `#term` lands on its entry. */
const GLOSSARY_PATH = '/analytics/lexique';

export const glossaryHref = (term: GlossaryId): string => `${GLOSSARY_PATH}#${term}`;

/**
 * The accessible name of a term's "?" link; `about` names the spot when one
 * page links the same term twice, so a screen reader's link list tells them apart.
 */
export const glossaryQuestion = (term: GlossaryId, about?: string): string =>
  `Qu’est-ce que ${GLOSSARY_TERMS[term]} ?${about ? ` (${about})` : ''}`;

export const isGlossaryId = (value: string): value is GlossaryId => Object.hasOwn(GLOSSARY_TERMS, value);
