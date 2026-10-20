/**
 * The glossary's content: one definition per term of `glossary.ts`, with its
 * scale and how to read it. Only the glossary page imports this module, so
 * the dashboard's "?" links do not carry it in the entry chunk.
 *
 * Every number (threshold, band, weight, duration) is the one the app itself
 * applies; the comment above each entry names the code that owns it, and a
 * number that moves there must move here too. The plain-language sentences
 * saying what a notion is (a threshold, Garmin's stress, the HRV) are general
 * definitions, not computations. Values Garmin computes are said to come
 * from Garmin.
 */

import type { GlossaryId } from './glossary';

export type GlossaryCategory = 'charge' | 'intensite' | 'efficacite' | 'terrain' | 'recuperation';

/** How a band reads: the word carries the status, the colour only repeats it. */
export type GlossaryTone = 'good' | 'neutral' | 'caution' | 'bad';

export interface GlossaryEntry {
  /** Anchor on the glossary page (`/analytics/lexique#id`). */
  readonly id: GlossaryId;
  /** The term as the glossary titles it. */
  readonly term: string;
  /** Other names the app or the coach uses for the same value. */
  readonly aliases: readonly string[];
  readonly category: GlossaryCategory;
  /** Plain French, one to three sentences. */
  readonly definition: string;
  /** Unit or scale. */
  readonly scale: string;
  /** Usual values, when the app has a reference. */
  readonly range?: string;
  /** The bands the app applies, each with its word. */
  readonly reading: readonly { readonly tone: GlossaryTone; readonly text: string }[];
  /** Who computes it. */
  readonly source: string;
}

export const GLOSSARY_CATEGORIES: readonly { readonly id: GlossaryCategory; readonly title: string }[] = [
  { id: 'charge', title: 'Charge et forme' },
  { id: 'intensite', title: 'Intensité' },
  { id: 'efficacite', title: 'Efficacité et allure' },
  { id: 'terrain', title: 'Terrain et foulée' },
  { id: 'recuperation', title: 'Récupération' },
];

export const TONE_LABEL: Record<GlossaryTone, string> = {
  good: 'Bon',
  neutral: 'Neutre',
  caution: 'Prudence',
  bad: 'Alerte',
};

export const GLOSSARY = [
  // features/workload.py (sRPE, acute 7-day sum, chronic mean of four 7-day
  // sums, get_acwr_zone), dataio/queries.daily_loads (RPE 5 when unset),
  // services/coaching_rules.generate_daily_tip, services/adaptation (1.5),
  // services/weekly_review (ACWR_HIGH 1.3).
  {
    id: 'acwr',
    term: 'Ratio charge aiguë / chronique (ACWR)',
    aliases: ['ACWR', 'Équilibre de charge', 'Charge aiguë/chronique'],
    category: 'charge',
    definition:
      'Ta charge des 7 derniers jours divisée par ta charge hebdomadaire moyenne des 4 dernières semaines (celle-ci comprise). La charge d’une journée vaut ses minutes d’entraînement multipliées par le RPE moyen de ses séances (5 pour une séance sans RPE). À 1,27, ta semaine pèse 27 % de plus que ta moyenne récente.',
    scale: 'Ratio sans unité, à deux décimales.',
    range: 'Autour de 1 quand la charge est stable.',
    reading: [
      { tone: 'good', text: 'De 0,8 à 1,3 : zone optimale, la charge progresse sans à-coup.' },
      { tone: 'neutral', text: 'Sous 0,8 : charge basse par rapport à tes 4 dernières semaines (reprise, affûtage, coupure).' },
      { tone: 'caution', text: 'De 1,3 à 1,5 : prudence, la charge monte vite. Le conseil du jour demande de stabiliser et le bilan de la semaine propose d’alléger la suite.' },
      { tone: 'bad', text: 'Au-dessus de 1,5 : zone à risque de blessure. La séance du jour (course, vélo ou natation) devient du repos.' },
    ],
    source: 'Calculé par Arete à partir de tes séances.',
  },
  // dataio/queries.TSS_EXPR; services/metrics (TSS_PER_SESSION 50, weekly goal).
  {
    id: 'tss',
    term: 'Charge d’entraînement (TSS)',
    aliases: ['TSS', 'Charge', 'Charge de la semaine', 'Objectif de charge'],
    category: 'charge',
    definition:
      'Le coût d’une séance en points. Arete le calcule à partir de ton RPE s’il est noté, sinon de ta fréquence cardiaque moyenne rapportée à ta FC au seuil, sinon comme une séance d’intensité moyenne. Il alimente la forme de fond, la fatigue et la fraîcheur.',
    scale: 'Points par séance, additionnés par jour et par semaine.',
    range:
      '1 h au seuil vaut 100 ; 1 h à RPE 6 vaut 60. L’objectif de la semaine vaut 50 points par séance de ton objectif hebdomadaire (Réglages) : 300 pour 6 séances.',
    reading: [
      { tone: 'good', text: 'Une semaine qui atteint l’objectif compte dans les « semaines à l’objectif de charge » de l’accueil.' },
      { tone: 'neutral', text: 'Le chiffre seul n’est ni bon ni mauvais : c’est sa progression qui compte, lue par l’ACWR et la fraîcheur.' },
    ],
    source: 'Calculé par Arete à partir de tes séances.',
  },
  // features/fitness.calculate_ctl (42-day time constant).
  {
    id: 'ctl',
    term: 'Forme de fond (CTL)',
    aliases: ['CTL', 'Forme de fond', 'Forme (Analyses)'],
    category: 'charge',
    definition:
      'La moyenne de ta charge quotidienne, lissée sur environ six semaines : ce que ton corps a appris à encaisser. Elle monte lentement quand tu t’entraînes avec régularité et redescend lentement quand tu coupes. La page Analyses l’appelle « Forme ».',
    scale: 'Points de charge par jour (même unité que le TSS).',
    range: 'Propre à chacun : compare-la à tes propres semaines.',
    reading: [
      { tone: 'good', text: 'En hausse régulière : la base s’élargit.' },
      { tone: 'neutral', text: 'Stable ou en légère baisse : entretien, affûtage ou récupération.' },
    ],
    source: 'Calculé par Arete (modèle de Banister).',
  },
  // features/fitness.calculate_atl (7-day time constant).
  {
    id: 'atl',
    term: 'Fatigue (ATL)',
    aliases: ['ATL', 'Fatigue'],
    category: 'charge',
    definition:
      'La moyenne de ta charge quotidienne, lissée sur environ une semaine. Elle réagit vite : une grosse séance la fait monter dès le lendemain, quelques jours calmes la font baisser.',
    scale: 'Points de charge par jour (même unité que le TSS).',
    reading: [
      { tone: 'neutral', text: 'Plus haute que la forme de fond : tu es en bloc de charge.' },
      { tone: 'neutral', text: 'Plus basse que la forme de fond : tu récupères.' },
    ],
    source: 'Calculé par Arete (modèle de Banister).',
  },
  // features/fitness.get_form_zone; services/coaching_rules (-25 alert, -10
  // warning); features/insights.pmc_insight (+25); services/adaptation
  // (TSB_EASE_AT -25); services/weekly_review (TSB_LOW -20).
  {
    id: 'tsb',
    term: 'Fraîcheur (TSB)',
    aliases: ['TSB', 'Fraîcheur', 'Forme (accueil)'],
    category: 'charge',
    definition:
      'Ta forme de fond moins ta fatigue. Négative, la fatigue récente dépasse ce que tu encaisses d’habitude ; positive, tu es reposé. L’accueil et le bilan de la semaine l’appellent « Forme ».',
    scale: 'Points, avec un signe : de −30 à +30 la plupart du temps.',
    reading: [
      { tone: 'good', text: 'De +10 à +25 : frais, bon moment pour une course ou un test.' },
      { tone: 'neutral', text: 'De −10 à +10 : neutre, entraînement normal.' },
      { tone: 'caution', text: 'De −25 à −10 : fatigué, normal en bloc de charge ; le conseil du jour invite à prévoir une semaine de récupération. Sous −20, le bilan de la semaine propose d’alléger la suite.' },
      { tone: 'caution', text: 'Au-dessus de +25 : très frais, c’est le moment de performer, ou de recharger.' },
      { tone: 'bad', text: 'Sous −25 : épuisé, prévois une décharge. Les séances dures du jour passent en endurance.' },
    ],
    source: 'Calculé par Arete (modèle de Banister).',
  },
  // components/RpePicker (Borg CR-10 words), components/ui/RpeBadge (6 / 8),
  // dataio/queries (TSS from RPE, RPE 5 when unset).
  {
    id: 'rpe',
    term: 'Effort ressenti (RPE)',
    aliases: ['RPE'],
    category: 'intensite',
    definition:
      'La note que tu donnes à la difficulté d’une séance, juste après. C’est l’entrée la plus fiable de ta charge : sans elle, Arete estime la séance par la fréquence cardiaque ou la compte comme moyenne (5).',
    scale:
      'De 1 à 10, échelle de Borg CR-10 : 1 très facile, 2 facile, 3 modéré, 4 un peu dur, 5 dur, 6 dur +, 7 très dur, 8 très dur +, 9 extrêmement dur, 10 maximal.',
    reading: [
      { tone: 'neutral', text: 'De 1 à 6 : badge vert.' },
      { tone: 'neutral', text: '7 et 8 : badge orange.' },
      { tone: 'neutral', text: '9 et 10 : badge rouge. Une séance dure n’est pas une erreur : c’est la charge de la semaine qui compte.' },
    ],
    source: 'Ta saisie.',
  },
  // features/hr_zones (LTHR_FRACTIONS, MAX_HR_FRACTIONS, ZONE_LABELS_FR);
  // features/insights.zones_insight (75 / 20, 60, 60 min).
  {
    id: 'zones',
    term: 'Zones cardiaques (Z1 à Z5)',
    aliases: ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Zones cardiaques', 'Répartition polarisée'],
    category: 'intensite',
    definition:
      'Cinq plages de fréquence cardiaque calculées à partir de ta FC au seuil : Z1 récupération, Z2 endurance, Z3 tempo, Z4 seuil, Z5 VO2max. Sans seuil, elles se calculent sur ta FC max.',
    scale:
      'Avec le seuil : Z1 sous 85 %, Z2 de 85 à 89 %, Z3 de 90 à 94 %, Z4 de 95 à 99 %, Z5 à partir de 100 % de la FC au seuil. Avec la FC max : Z2 dès 60 %, Z3 dès 70 %, Z4 dès 80 %, Z5 dès 90 %.',
    reading: [
      { tone: 'good', text: 'Au moins 75 % du temps en Z1-Z2 et au plus 20 % en Z4-Z5 : répartition polarisée, la cible est 80/20.' },
      { tone: 'caution', text: 'Moins de 60 % en Z1-Z2 : trop d’intensité moyenne.' },
      { tone: 'neutral', text: 'Moins d’une heure avec une mesure de FC sur la période : pas assez pour juger.' },
    ],
    source: 'Calculé par Arete à partir de ton seuil (Réglages › Objectifs).',
  },
  // garmin/threshold (Garmin's lactate threshold refreshes the settings),
  // features/hr_zones (LTHR_FROM_MAX_HR 0.9, DEFAULT_MAX_HR 190).
  {
    id: 'seuil',
    term: 'Seuil (FC et allure au seuil)',
    aliases: ['FC au seuil', 'Allure au seuil', 'Seuil lactique', 'LTHR'],
    category: 'intensite',
    definition:
      'La fréquence cardiaque d’un effort soutenu, à fond mais régulier. Arete la mesure comme les Réglages : un test de 30 min, dont tu retiens la FC moyenne des 20 dernières minutes. Elle sert de référence aux zones et à la charge estimée par la FC ; Garmin la remesure de lui-même et chaque synchronisation adopte un test plus récent.',
    scale: 'Battements par minute (bpm) ; l’allure au seuil en min/km.',
    range: 'Sans mesure, Arete l’estime à 90 % de ta FC max ou, sans FC max, à 171 bpm (90 % de 190).',
    reading: [
      { tone: 'neutral', text: 'Ce n’est pas un score : une valeur à jour rend tes zones et ta charge justes.' },
    ],
    source: 'Mesuré par Garmin, ou saisi dans Réglages › Objectifs.',
  },
  // garmin/time_series._calculate_decoupling (session, > 5 % flagged),
  // services/activity_detail (20 min), features/hr_drift + insights
  // (DECOUPLING_GOOD_PCT 5, DECOUPLING_OK_PCT 10), services/analytics (40 min).
  {
    id: 'decouplage',
    term: 'Découplage cardiaque',
    aliases: ['Découplage'],
    category: 'efficacite',
    definition:
      'Ce que ton efficacité (vitesse par battement de cœur) perd entre la première et la seconde moitié d’une sortie régulière. Positif, le cœur travaille plus pour la même vitesse : fatigue, chaleur, déshydratation ou base aérobie à développer. Il se calcule de deux façons : la page d’une séance compare la vitesse par battement des deux moitiés, seconde par seconde ; Analyses additionne le ralentissement et la dérive de la FC entre les deux moitiés de tes tours au kilomètre.',
    scale: 'Pourcentage, positif quand l’efficacité baisse.',
    range:
      'Page d’une séance : séance régulière d’au moins 20 min avec les flux de la montre. Analyses : sorties de course d’au moins 40 min avec au moins 4 tours au kilomètre, moyenne de la période.',
    reading: [
      { tone: 'good', text: 'Analyses, sous 5 % : base aérobie solide.' },
      { tone: 'neutral', text: 'Analyses, de 5 à 10 % : correct, encore de la marge.' },
      { tone: 'caution', text: 'Analyses, 10 % et plus : base aérobie à travailler, ou conditions difficiles. Sur une séance, au-delà de 5 %, l’efficacité aérobie a baissé.' },
    ],
    source: 'Calculé par Arete à partir des flux et des tours de ta montre.',
  },
  // garmin/time_series._calculate_drift (session page, 20 min: services/activity_detail).
  {
    id: 'derive-fc',
    term: 'Dérive de la FC',
    aliases: ['Dérive de la FC', 'Dérive cardiaque'],
    category: 'efficacite',
    definition:
      'L’écart entre ta fréquence cardiaque moyenne de la seconde moitié d’une sortie et celle de la première. Contrairement au découplage, elle ne tient pas compte de l’allure : une seconde moitié plus rapide la fait monter sans fatigue.',
    scale: 'Pourcentage, positif quand la FC monte.',
    range: 'Affichée sur la page d’une séance régulière d’au moins 20 min.',
    reading: [
      { tone: 'neutral', text: 'Arete ne lui applique pas de seuil : lis-la avec l’allure des deux moitiés, le terrain et la chaleur.' },
    ],
    source: 'Calculé par Arete à partir des flux de ta montre.',
  },
  // features/overview.build_decoupling_card (avg HR / speed, weighted by duration).
  {
    id: 'cout-cardiaque',
    term: 'Coût cardiaque',
    aliases: ['Coût cardiaque'],
    category: 'efficacite',
    definition:
      'Ta fréquence cardiaque moyenne divisée par ta vitesse en course : combien de battements te coûte chaque km/h. Il baisse quand tu cours plus vite pour le même effort.',
    scale: 'Battements par minute par km/h, pondéré par la durée des sorties.',
    reading: [
      { tone: 'good', text: 'En baisse d’une période à l’autre : tu gagnes en économie.' },
      { tone: 'caution', text: 'En hausse : fatigue, chaleur, ou terrain plus dur.' },
    ],
    source: 'Calculé par Arete à partir de tes sorties de course.',
  },
  // features/insights.pace_insight (PACE_TREND_SIGNIFICANT 3 s/km per month,
  // PACE_TREND_MIN_RUNS 5), services/analytics.effort_pace.
  {
    id: 'allure',
    term: 'Allure',
    aliases: ['Allure de course', 'min/km'],
    category: 'efficacite',
    definition:
      'Le temps mis pour parcourir un kilomètre. La tendance d’Analyses lit l’allure ajustée à la pente des sorties vallonnées, pour ne pas confondre une semaine en montagne avec une perte de forme.',
    scale: 'Minutes et secondes par kilomètre : plus c’est bas, plus c’est rapide.',
    reading: [
      { tone: 'good', text: 'Au moins 3 s/km gagnées par mois : allure en progression.' },
      { tone: 'neutral', text: 'Moins de 3 s/km d’écart par mois : stable. Il faut au moins 5 sorties pour une tendance.' },
      { tone: 'caution', text: 'Au moins 3 s/km perdues par mois : allure qui se dégrade.' },
    ],
    source: 'Mesuré par ta montre ; tendance calculée par Arete.',
  },
  // services/activity_detail + features/terrain (Minetti);
  // features/insights (FLAT_M_PER_KM 10, HILLY_M_PER_KM 25).
  {
    id: 'gap',
    term: 'Allure ajustée à la pente (GAP)',
    aliases: ['GAP'],
    category: 'terrain',
    definition:
      'L’allure que tu aurais tenue à plat pour le même effort, d’après le coût énergétique de la pente (Minetti). En montée, elle est plus rapide que ton allure réelle.',
    scale: 'Minutes et secondes par kilomètre.',
    range: 'Une sortie compte comme vallonnée à partir de 10 m de dénivelé positif par km, montagneuse à partir de 25.',
    reading: [
      { tone: 'neutral', text: 'Compare-la à ton allure à plat pour juger l’effort d’une sortie vallonnée.' },
    ],
    source: 'Calculé par Arete à partir des flux de ta montre.',
  },
  // features/running (Daniels), pages/settings/TrainingPacesPanel.
  {
    id: 'vdot',
    term: 'VDOT et allures d’entraînement',
    aliases: ['VDOT', 'Allures d’entraînement', 'Équivalences de course'],
    category: 'efficacite',
    definition:
      'Un indice de niveau en course à pied (Jack Daniels), déduit de la prédiction 10 km de Garmin ou de ton allure au seuil. Il donne tes allures d’entraînement : E endurance, M marathon, T seuil, I intervalles, R répétitions, et tes temps équivalents sur d’autres distances.',
    scale: 'Indice sans unité : plus il est élevé, plus tu es rapide.',
    reading: [
      { tone: 'neutral', text: 'Ce n’est pas un objectif en soi : il sert à caler chaque type de séance à la bonne allure.' },
    ],
    source: 'Calculé par Arete (Réglages › Objectifs).',
  },
  // features/terrain (VAM_MINUTES), features/insights.vam_insight.
  {
    id: 'vam',
    term: 'Vitesse ascensionnelle (VAM)',
    aliases: ['VAM', 'Vitesse ascensionnelle'],
    category: 'terrain',
    definition:
      'Les mètres de dénivelé positif gagnés par heure sur ta meilleure montée continue de 5, 10, 20, 30 ou 60 minutes, à pied.',
    scale: 'Mètres par heure (m/h).',
    range: 'Propre à chacun : compare-la à ton record, affiché à côté.',
    reading: [
      { tone: 'good', text: 'Égale ou au-dessus de ton record sur une durée : record battu.' },
      { tone: 'neutral', text: 'En dessous : le pourcentage du record dit l’écart.' },
    ],
    source: 'Calculé par Arete à partir des flux de ta montre.',
  },
  // features/insights.cadence_insight (LOW_CADENCE 160, CADENCE_SHIFT 3).
  {
    id: 'cadence',
    term: 'Cadence',
    aliases: ['Cadence', 'pas/min'],
    category: 'terrain',
    definition: 'Le nombre de pas par minute en course, les deux pieds comptés.',
    scale: 'Pas par minute.',
    reading: [
      { tone: 'neutral', text: 'À partir de 160 pas/min : rien à signaler ; un écart de 3 pas/min ou plus d’une période à l’autre est noté.' },
      { tone: 'caution', text: 'Sous 160 pas/min : plutôt basse, une foulée plus courte allège les impacts.' },
    ],
    source: 'Mesuré par ta montre.',
  },
  // services/metrics.current_readiness (sources), garmin/readiness (Arete's
  // score), services/adaptation (KEEP_AT 80, EASE_AT 60, REPLACE_AT 40),
  // pages/HUD readinessTone (threshold, 60 %), services/weekly_review (50).
  {
    id: 'preparation',
    term: 'Préparation (récupération du jour)',
    aliases: ['Récupération', 'Préparation', 'Préparation Garmin', 'Préparation à l’entraînement Garmin', 'Seuil de préparation'],
    category: 'recuperation',
    definition:
      'Un score qui dit si ton corps est prêt à encaisser une séance. Arete lit d’abord la préparation à l’entraînement de ta montre Garmin, sinon son propre score tiré de tes données Garmin (VFC face à ta moyenne de 14 jours pour 40 %, sommeil face à 8 h pour 30 %, Body Battery pour 30 %, moins un malus si stress ou FC de repos sont au-dessus de ta moyenne), sinon une estimation par la charge.',
    scale: 'De 0 à 100.',
    reading: [
      { tone: 'good', text: '80 et plus : la séance prévue est maintenue.' },
      { tone: 'caution', text: 'De 60 à 79 : une séance dure du jour est allégée en endurance Z2.' },
      { tone: 'caution', text: 'De 40 à 59 : la séance devient 30 min de récupération en Z1.' },
      { tone: 'bad', text: 'Sous 40 : repos. Sur une moyenne de la semaine sous 50, le bilan propose d’alléger la suite.' },
      { tone: 'neutral', text: 'Ces paliers de 80, 60 et 40 sont fixes : ton seuil de préparation ne les change pas.' },
      { tone: 'neutral', text: 'Ton seuil de préparation (Réglages › Objectifs, 85 par défaut) colore l’accueil : « bonne » à partir du seuil, « moyenne » à partir de 60 % du seuil, « basse » en dessous. Atteint, il fait proposer une séance dure ou un test par le conseil du jour, si l’ACWR et la fraîcheur ne demandent pas d’abord de lever le pied.' },
    ],
    source: 'Garmin (préparation à l’entraînement) ou calculé par Arete.',
  },
  // features/insights.hrv_insight (+5 %, -10 %), pages/HUD HRV_WORD (Garmin status).
  {
    id: 'vfc',
    term: 'Variabilité de la fréquence cardiaque (VFC)',
    aliases: ['VFC', 'HRV'],
    category: 'recuperation',
    definition:
      'La variation de l’intervalle entre deux battements, mesurée par ta montre pendant la nuit. Une VFC plus haute que d’habitude signale en général un corps reposé ; plus basse, de la fatigue, du stress ou un début de maladie.',
    scale: 'Millisecondes (ms), moyenne de la nuit.',
    range: 'Très variable d’une personne à l’autre : compare-la seulement à ta propre moyenne. Garmin la qualifie d’équilibrée, de déséquilibrée, de basse ou de faible.',
    reading: [
      { tone: 'good', text: 'Plus de 5 % au-dessus de la période précédente : bonne adaptation.' },
      { tone: 'neutral', text: 'Entre −10 % et +5 % : stable.' },
      { tone: 'caution', text: 'Plus de 10 % en dessous : fatigue ou stress.' },
    ],
    source: 'Mesuré par Garmin.',
  },
  // features/insights.resting_hr_insight (+3, -2 bpm).
  {
    id: 'fc-repos',
    term: 'Fréquence cardiaque au repos',
    aliases: ['FC de repos', 'FC au repos'],
    category: 'recuperation',
    definition:
      'Ta FC mesurée au repos par ta montre. Il baisse avec l’entraînement d’endurance et remonte avec la fatigue, le manque de sommeil ou une infection.',
    scale: 'Battements par minute (bpm).',
    range: 'Propre à chacun : c’est son évolution qui compte.',
    reading: [
      { tone: 'good', text: 'Plus de 2 bpm de moins que sur la période précédente : bon signe.' },
      { tone: 'neutral', text: 'De −2 à +3 bpm : stable.' },
      { tone: 'caution', text: 'Plus de 3 bpm au-dessus : fatigue ou début de maladie ?' },
    ],
    source: 'Mesuré par Garmin.',
  },
  // features/insights (SLEEP_SHORT_SEC 6 h 30, SLEEP_GOOD_SEC 7 h 30),
  // garmin/readiness (SLEEP_TARGET_SEC 8 h).
  {
    id: 'sommeil',
    term: 'Sommeil',
    aliases: ['Sommeil', 'Score de sommeil'],
    category: 'recuperation',
    definition:
      'La durée de ta nuit et le score que Garmin lui donne. Arete compte la durée dans ta préparation, avec 8 h pour cible.',
    scale: 'Heures et minutes ; score de 0 à 100.',
    reading: [
      { tone: 'good', text: '7 h 30 et plus en moyenne : sommeil suffisant.' },
      { tone: 'neutral', text: 'De 6 h 30 à 7 h 30 : moyen.' },
      { tone: 'caution', text: 'Moins de 6 h 30 : sommeil court.' },
    ],
    source: 'Mesuré par Garmin.',
  },
  // pages/HUD stressTone/stressWord (25, 40), garmin/readiness (stress penalty).
  {
    id: 'stress',
    term: 'Stress',
    aliases: ['Stress'],
    category: 'recuperation',
    definition:
      'La moyenne de la journée du stress que ta montre déduit de ta fréquence cardiaque et de ta VFC, au repos. Un stress au-dessus de ta moyenne de 14 jours retire des points à ta préparation.',
    scale: 'De 0 à 100.',
    reading: [
      { tone: 'good', text: 'Jusqu’à 25 : faible.' },
      { tone: 'caution', text: 'De 26 à 40 : modéré.' },
      { tone: 'bad', text: 'Au-dessus de 40 : élevé.' },
    ],
    source: 'Mesuré par Garmin.',
  },
  // garmin/readiness (BB_WEIGHT 0.30, body_battery_high).
  {
    id: 'body-battery',
    term: 'Body Battery',
    aliases: ['Body Battery'],
    category: 'recuperation',
    definition:
      'L’énergie disponible selon Garmin : elle se recharge au repos et se vide avec l’effort et le stress. Arete retient le pic de la journée, qui compte pour 30 % de son score de préparation.',
    scale: 'De 0 à 100.',
    reading: [
      { tone: 'neutral', text: 'Plus le pic du matin est haut, mieux tu as récupéré ; Arete n’applique pas d’autre seuil.' },
    ],
    source: 'Mesuré par Garmin.',
  },
  // services/adaptation (CHECKIN_LOW_AT 2), components/dashboard/CheckinCard.
  {
    id: 'checkin',
    term: 'Check-in du matin',
    aliases: ['Check-in', 'Jambes', 'Motivation / stress'],
    category: 'recuperation',
    definition:
      'Trois questions sur ton sommeil, tes jambes et ta motivation. Seuls le sommeil et les jambes pèsent sur la décision du jour, et uniquement à la baisse : une bonne réponse ne remplace jamais une mesure basse. La motivation est transmise au coach pour son message, sans effet sur la décision.',
    scale: 'De 1 (le pire) à 5 (le mieux) pour chaque question.',
    reading: [
      { tone: 'neutral', text: '3 et plus : rien ne change.' },
      { tone: 'caution', text: 'Sommeil ou jambes à 2 ou moins : la préparation descend d’un palier (maintenue, allégée, récupération, repos).' },
    ],
    source: 'Ta saisie.',
  },
  // garmin/matcher._calculate_match_score (50 / 30 / 10 / 10).
  {
    id: 'adherence',
    term: 'Adhérence d’une séance',
    aliases: ['Adhérence'],
    category: 'intensite',
    definition:
      'À quel point une séance réalisée ressemble à celle prévue ce jour-là : 50 points pour la date (25 de moins par jour d’écart), jusqu’à 30 pour la durée, 10 pour le type de séance et 10 pour l’intensité (FC moyenne face au milieu de la zone prévue).',
    scale: 'De 0 à 100 %.',
    reading: [
      { tone: 'good', text: '85 et plus : séance faite comme prévue.' },
      { tone: 'neutral', text: 'De 65 à 84 : proche du plan.' },
      { tone: 'caution', text: 'Sous 65 : séance assez différente du plan.' },
    ],
    source: 'Calculé par Arete en reliant ta séance au planning.',
  },
  // services/weekly_review (ADHERENCE_LOW 0.6, at least 3 planned),
  // components/AdherenceBar (90 / 75 / 50).
  {
    id: 'regularite',
    term: 'Régularité de la semaine',
    aliases: ['Régularité', 'Séances faites / prévues'],
    category: 'charge',
    definition: 'La part des séances prévues la semaine passée que tu as faites.',
    scale: 'Pourcentage.',
    reading: [
      { tone: 'good', text: 'À partir de 75 % : la semaine a tenu l’essentiel du plan. La barre change de couleur à 90, 75 et 50 %.' },
      { tone: 'caution', text: 'Sous 60 % avec au moins 3 séances prévues : le bilan propose de retirer une séance facile pour tenir les autres, sauf s’il propose déjà d’alléger la suite pour la charge, la fraîcheur ou la préparation.' },
      { tone: 'bad', text: 'Sous 50 % : moins d’une séance sur deux faite.' },
    ],
    source: 'Calculé par Arete à partir du planning.',
  },
] as const satisfies readonly GlossaryEntry[];

/** Lower case, accents dropped: « fraicheur » finds « Fraîcheur ». */
const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** The entries whose term, aliases or definition contain every word of `query`. */
export function searchGlossary(query: string): GlossaryEntry[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...GLOSSARY];
  return GLOSSARY.filter((entry) => {
    const haystack = fold([entry.term, ...entry.aliases, entry.definition].join(' '));
    return words.every((word) => haystack.includes(word));
  });
}
