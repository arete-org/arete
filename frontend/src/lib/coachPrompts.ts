/** Opening questions for an empty conversation, fixed per page. */

const GENERAL = [
  'Que peux-tu faire pour moi ?',
  'Analyse ma forme du moment',
  'Aide-moi à planifier ma semaine',
];

const BY_PAGE: Record<string, string[]> = {
  dashboard: [
    "Que dois-je faire aujourd'hui ?",
    'Comment est ma récupération ?',
    'Résume ma semaine',
  ],
  planning: [
    'Ma semaine est-elle bien équilibrée ?',
    'Allège ma semaine, je suis fatigué',
    'Ajoute une sortie longue ce week-end',
  ],
  analytics: [
    'Compare ma charge sur 7 et 28 jours',
    'Mon allure progresse-t-elle ?',
    'Où en est ma forme sur 6 semaines ?',
  ],
  log: [
    'Que retiens-tu de ma dernière séance ?',
    'Mes séances récentes sont-elles trop intenses ?',
    'Je veux enregistrer une séance de musculation',
  ],
  profile: [
    'Explique ma progression et mes Éclats',
    'Quel est mon prochain rang ?',
    'Comment respecter mon objectif cette semaine ?',
  ],
  health: [
    'Ma douleur doit-elle changer ma semaine ?',
    'Comment évolue mon poids ?',
    'Que dire à mon kiné de ces 8 semaines ?',
  ],
  settings: [
    'Mes zones cardiaques sont-elles à jour ?',
    'Explique-moi mon seuil',
    'Que peux-tu faire pour moi ?',
  ],
};

/** Opening questions for an empty thread. */
export function starters(page: string): string[] {
  return BY_PAGE[page] ?? GENERAL;
}
