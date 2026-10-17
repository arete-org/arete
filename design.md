# Arete — Design system commun aux huit thèmes

## Références et décision

- [Identité retenue dans Figma](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=5-82) : « Cormorant Garamond pour la marque et les grands titres. Inter pour les données, les boutons et la navigation. »
- [Maquette comparative ARE-33, éditable](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=17-111) : huit déclinaisons du même spécimen, avec les composants de marque existants et les palettes du produit.
- La capture de l’incident montre **Plus sombre** : marque serif, titres sans serif, navigation et contrôles monospace.

La référence définit cette hiérarchie pour Pierre et Prune. ARE-33 l’étend à
Clair, Sombre, Plus sombre, Abysse, Performance et Odyssey. Changer de thème
ne change plus les familles de polices ni la hiérarchie des titres.
Les palettes et préférences sont conservées. Les surfaces, contrôles et états
interactifs utilisent désormais les mêmes règles sur toutes les pages.

## Hiérarchie

| Rôle | Police | Traitement |
| --- | --- | --- |
| Signature ARETE | Cormorant Garamond SemiBold | 32 px, graisse 600, interligne 1, espacement 1,1 px ; laurier existant |
| Titre principal de page | Cormorant Garamond SemiBold | `clamp(30px, 3vw, 42px)`, graisse 600, interligne 1,1, sans espacement ajouté |
| Titre du coach | Cormorant Garamond SemiBold | 24 px, graisse 600, interligne 1,1 |
| Navigation, boutons, formulaires, titres de panneaux | Inter | Tailles et graisses existantes ; une même famille pour tous les thèmes |
| Texte courant, réponses du coach | Inter | Taille et interligne propres au contenu, conservés |
| Mesures, tableaux et graphiques | Inter | Conserver `tabular-nums` là où les valeurs doivent s’aligner |
| Code, paramètres et résultats techniques des outils | JetBrains Mono | Monospace dans chaque thème, y compris Pierre et Prune |

Le choix typographique dépend du rôle du texte. Un grand titre n’impose pas une
police serif aux titres de panneaux, aux labels ou aux données. Les titres de page sont en casse naturelle. Les petits labels de
métadonnées peuvent rester en capitales ; ils ne deviennent pas des titres serif.

## Maquette

La planche reprend le spécimen produit de la référence Figma (`6:155`) :
signature, navigation, titre « Réglages », texte courant, mesure et bouton.
Les huit variantes utilisent les mêmes familles et dimensions ; seules leurs
couleurs diffèrent. Les valeurs affichées sont fictives. Cette planche définit
la typographie, pas une refonte de la disposition de la page Réglages.

| Thème | Fond produit | Texte principal | Typographie |
| --- | --- | --- | --- |
| Pierre | `#F6F3ED` | `#1C2927` | Hiérarchie commune |
| Prune | `#291E29` | `#F2E8DA` | Hiérarchie commune |
| Clair | `#F4F7FA` | `#172B3A` | Hiérarchie commune |
| Sombre | `#0A0A0F` | `#E8E8E8` | Hiérarchie commune |
| Plus sombre | `#050508` | `#E8E8E8` | Hiérarchie commune |
| Abysse | `#000000` | `#E8E8E8` | Hiérarchie commune |
| Performance | `#F4F5EF` | `#17281E` | Hiérarchie commune |
| Odyssey | `#F5EBDD` | `#3B3432` | Hiérarchie commune |

## Propriétaire dans le code

[`frontend/src/index.css`](frontend/src/index.css) possède les règles communes :

- `--font-sans` : Inter pour le texte courant et les composants existants.
- `--font-display` : Cormorant Garamond pour la signature, `.page-title` et `.coach-title`.
- `--font-mono` : JetBrains Mono pour `code`, `kbd`, `samp`, `pre` et le code Markdown.
- Les anciennes classes `font-mono` des labels, mesures et contrôles sont remplacées
  par `font-sans`. Le nom monospace retrouve son sens, sans alias détourné.

## Composants et états communs

| Élément | Règle | Propriétaire |
| --- | --- | --- |
| Carte, panneau, dialogue | Surface opaque, bordure neutre, rayon 16 px ; pas de halo ni de grossissement au survol | `.glass-panel`, `.rpg-surface`, `--radius-panel` |
| Surface imbriquée | Fond de page, bordure neutre, rayon 9 px | `.ui-inset` |
| Contrôle, bouton, onglet | Rayon 9 px, Inter ; états désactivés conservés | `--radius-control`, composants `ui/` |
| Action principale | Fond plein selon sa sémantique ; texte contrasté, y compris violet et Strava | `.ui-button[data-strong]`, tokens `--color-on-*` |
| Action secondaire | Fond légèrement teinté, texte sémantique | `Button` existant |
| Navigation active | Fond de sélection, état courant accessible | `--color-selection`, `aria-current` |
| Focus clavier | Contour de 2 px, décalé de 3 px, couleur d’accent | `:focus-visible` |
| Mesure de santé | Valeur Inter, chiffres tabulaires ; statut porté par le badge et son texte | `MetricCard` |
| Connexion et accès refusé | Même signature au laurier ; widget Clerk relié aux tokens | `AreteWordmark`, `ClerkGate` |
| Sélecteur de thème | Huit aperçus de même taille avec signature, titre et donnée fictive ; sélection cochée et `aria-pressed` | `AppearanceTab`, `THEMES` |
| Mouvement | Apparition courte, sans cascade retardant la lecture ; respect du mouvement réduit | `index.css` |

La refonte conserve les routes, formulaires, requêtes, permissions, outils du coach
et mécanismes de sauvegarde. Elle couvre le tableau de bord, planning, analyses,
bilan annuel, journal, détail de séance, profil, réglages, coach et accès au compte.
Les aperçus de thèmes montrent leur propre palette, indépendamment du thème actif.
Leurs couleurs proviennent des métadonnées de `THEMES`; les couleurs de l’application
restent dans les tokens CSS. Les contrôles navigateur comparent les deux.

Les familles ne sont plus redéfinies dans les sélecteurs de thème. Les fichiers
de police restent locaux. Aucun appel réseau ni changement de préférence
enregistrée n’est ajouté.

## Critères de vérification

1. Passer par les huit thèmes dans Réglages : navigation, labels et boutons restent en Inter.
2. Comparer Planning, Analyses et Bilan annuel : tous les titres principaux utilisent Cormorant Garamond, graisse 600.
3. Ouvrir le coach : son titre suit la même règle ; son texte courant reste en Inter.
4. Vérifier le code Markdown et les aperçus techniques : JetBrains Mono dans les huit thèmes.
5. Vérifier à 390 px et sur bureau : aucun débordement horizontal dû aux titres ; la navigation reste utilisable.
6. Prévisualiser, abandonner puis enregistrer un thème : conserver les comportements existants.
7. Exécuter `make check` et les contrôles navigateur pertinents.

## Validation de l’identité

Les huit spécimens de la planche Figma ont été inspectés : signature et titre en
Cormorant Garamond SemiBold, texte d’interface en Inter, deux instances de marque
par spécimen (signature et symbole). Les références approuvées restent intactes.
Les rayons et traitements de contrôles généralisent les composants Pierre/Prune
existants ; ils constituent l’adaptation produit de cette identité, et non une
copie de la disposition de la planche de marque.

La vérification locale comprend `make check`, les scénarios Playwright existants,
et `frontend/browser-tests/design-system.spec.ts` pour les huit thèmes à 390, 430,
768 et 1440 px : polices calculées, couleurs des aperçus, focus clavier, absence de
débordement horizontal et retour à la préférence enregistrée après rechargement.

## Chiron : chat compact optionnel

La [maquette compacte approuvée](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=62-143)
et ses [états de croissance et de changement de mode](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=82-324)
prolongent la même identité. Le chat flottant devient le mode par défaut.
Dans « Options du coach », le mode choisi est une préférence locale au navigateur ;
« Panneau latéral classique » permet de revenir au mode précédent, même pendant une réponse.
Si le stockage est indisponible, le choix fonctionne pour la session avec une explication visible.

- Chat flottant de 360 px, à 24 px du bas et du bord droit sur bureau. Sur mobile,
  marges latérales de 12 px, dégagement de la navigation, prise en compte du clavier visuel.
- Hauteur naturelle : la réponse fait grandir la fenêtre jusqu’à 560 px, plafonnée à
  65 % de la hauteur mobile et à l’espace visible. Ensuite, seul le fil défile.
  Lire les anciens messages suspend le suivi ; « Derniers messages » le rétablit.
- Surface à 90 % d’opacité et flou de 18 px ; texte opaque, bordure fine et rayon de 16 px.
  Cette transparence est réservée au chat flottant, les autres surfaces restent opaques.
- En-tête réduit au laurier, à Chiron en Cormorant, au contexte et aux commandes.
  Deux amorces fixes liées à la page ; aucun appel de suggestion supplémentaire.
- Champ de saisie, ajout de fichier et envoi sur une ligne ; croissance du brouillon
  plafonnée à 144 px. Le contour de focus appartient au composite, sans rectangle imbriqué.
- Un même propriétaire de conversation et les mêmes composants de saisie et de documents
  servent les deux modes. Le changement de mode ne relance pas de requête et conserve
  le brouillon, les pièces jointes et la réponse en cours.

Propriétaires : `useCoachDisplay` pour la préférence locale, `App` pour l’espace réservé
et le lanceur, `AgentSidePanel` pour la présentation, `index.css` pour les surfaces et limites.
Les contrôles Playwright de `chiron.spec.ts` utilisent un flux SSE local contrôlé pour
vérifier la croissance, le plafond, le défilement manuel et le changement de mode en cours
de réponse, puis le retour au choix sauvegardé après rechargement.

## Chiron — cartes de graphiques

Les graphiques de Chiron prolongent la référence compacte `62:143` : carte opaque
`Panel`, bordure neutre, rayon partagé de 16 px, titre et données en Inter. Le SVG
est statique et responsive ; le titre et le résumé restent des éléments React
accessibles. Les couleurs et les classes de séries viennent de `chartTheme.ts` et
suivent les huit thèmes, y compris après réception ou rechargement d’une carte.
L’iframe isolée reçoit les polices Inter locales embarquées et les tokens du thème.
Le modèle ne choisit ni CSS, ni police, ni couleur littérale. Une carte invalide
conserve son résumé et signale l’échec. Les cartes suivent le fil et son ordre de
réception dans les modes flottant et latéral ; aucun téléchargement n’est proposé.

`chart-cards.spec.ts` vérifie courbes et barres à 390 et 1440 px, les huit thèmes,
le rechargement, le changement de fil pendant une réponse et l’isolation du rendu.

## Chiron — jauge de contexte

La [planche de la jauge et de la compaction](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=151-575)
prolonge le chat compact avec quatre variantes éditables : normal, élevé,
saturé et compaction. La jauge reste sous le champ, alignée à droite, pour
préserver la largeur du brouillon et des commandes. Anneau de 16 px, texte
Inter de 11 px, couleurs sémantiques succès/avertissement/danger des thèmes.
La cible passe à 44 px sur écran tactile ; la pulsation respecte le mouvement réduit.

Sans compteurs, rien ne s’affiche. Sous 85 %, la jauge apparaît seulement si
`contextGaugeAlways` est présent dans l’URL. La compaction reste visible avec
des compteurs, même sous ce seuil. Le pourcentage affiché est plafonné à 100 %.
L’infobulle au survol, au clavier et au toucher conserve les valeurs réelles et
indique que la mesure précède la compaction. `ContextWindowGauge` n’effectue
aucun comptage ni appel réseau : il lit les événements du fil courant.

`context-gauge.spec.ts` vérifie le flux SSE, l’arrêt, le rechargement sans
compaction bloquée, les brouillons et les thèmes Pierre/Prune à 390 px.

## Planning — proposition A

[Référence Figma retenue](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=110-81).
La semaine affiche sept colonnes sur grand écran ; sous 1050 px de largeur
**disponible** (coach compris), un sélecteur de jours donne accès au même contenu.
Sur mobile, les compteurs deviennent une ligne pour laisser la priorité aux séances.
La proposition A ne concerne que le contenu de la page : la navigation, la marge de page
et l’en-tête (`page-title` « Planning » et sous-titre discret) sont ceux des autres pages.
Les cartes utilisent les tokens communs aux huit thèmes.
Inter Regular, Medium et SemiBold sont chargés localement avec leurs vraies graisses
(version 4.0, licence OFL fournie), sans dépendre du gras simulé par le navigateur.

La [référence mobile](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=111-175)
conserve les jours, les compteurs et le bouton « Ouvrir la séance » sous la carte.
Les options de filtre, sélection et rafraîchissement sont regroupées dans le menu
de la barre de semaine. Les cibles tactiles font au moins 44 px :
le titre d’une carte étend sa cible à la carte entière. Le focus de cette cible
fusionne avec la bordure de sélection pour éviter deux rectangles imbriqués.
Les données et les statuts restent ceux du serveur ; aucun retrait Garmin fictif
n’est ajouté pour reproduire les données d’exemple de Figma.

Le détail donne accès à la modification, au déplacement, à la duplication et à la
suppression. L’éditeur conserve son brouillon en cas d’erreur et signale les
modifications non enregistrées. Les écritures utilisent la version lue pour
refuser un écran périmé. Le statut sportif et le statut Garmin restent distincts ;
un retrait Garmin incomplet reste accessible après suppression de la séance.


## Mobile first — navigation, Journal et fenêtres

La proposition A mobile (`111:175`) reste la référence du contenu Planning.
La navigation commune comporte six entrées, dans cet ordre : Accueil, Planning,
Analyses, Journal, Profil, Réglages. Profil reste accessible sans gamification
et explique alors comment l’activer. Chiron n’est plus un onglet mobile :
« Demander à Chiron » est un lanceur flottant actionnable au toucher et au clavier.
Les liens contextuels vers une discussion restent disponibles.

Les maquettes Figma A et B réutilisent désormais les mêmes composants de navigation :
[mobile](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=126-382),
[bureau](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=126-429)
et [lanceur Chiron](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=126-481).
Le menu à quatre liens textuels des premières propositions est remplacé.
Planning ne possède aucune variante de navigation propre à sa page.

- Sur mobile : barre de 64 px, hors zone de sécurité, icônes Lucide de 20 px,
  libellés Inter de 10 px et cibles d’au moins 44 × 44 px. L’onglet actif utilise
  la couleur de sélection, l’accent et l’indicateur supérieur du menu commun.
- Sur bureau : barre de 56 px, signature au laurier, liens Tableau de bord,
  Planning, Analyses, Journal et Réglages, puis accès au coach. Profil s’insère
  avant Réglages lorsque la gamification est activée ; les six entrées mobiles
  restent présentes dans les deux cas.
- Les couleurs et rayons suivent les tokens communs. Les textes et les icônes
  des maquettes restent éditables ; les quatre écrans utilisent des instances
  des composants partagés. Le code de référence reste `Navigation.tsx` et
  `index.css` pour les huit thèmes et les zones de sécurité.

- `App` réserve les zones de sécurité système et l’espace de la navigation et du
  lanceur. Les tokens `--safe-*`, `--mobile-nav-space` et `--launcher-space` dans
  `index.css` en sont les propriétaires communs, y compris en mode installé.
- Le document défile pour les pages. Une navigation vers une autre page repart
  en haut ; le retour navigateur restaure les 100 dernières positions en mémoire.
  La restauration attend au plus deux secondes l’arrivée du contenu différé et
  cède immédiatement à un geste utilisateur. Les paramètres de la page et la
  fermeture d’un dialogue ne ramènent pas arbitrairement en haut.
- Le Journal présente « Saisir une séance » sous son titre. Cette action reste
  visible en haut pendant le défilement mobile et ouvre le formulaire de l’onglet
  Force ou Cardio. `/log?new=1` ouvre directement la saisie force depuis l’accueil ;
  `/log?tab=cardio&new=1` ouvre la saisie cardio manuelle. Fermer retire `new` sans
  ajouter une entrée d’historique.
- `useVisualViewport` fournit une seule mesure de l’espace visible aux dialogues
  et à Chiron. Le clavier ne doit masquer ni les champs ni les commandes ; les
  champs mobiles font au moins 16 px et les commandes tactiles au moins 44 px.
  Les dialogues bloquent le défilement de fond et restaurent le focus sans
  déplacer la page. Les formulaires longs défilent dans leur panneau.
- Le Planning commence par le sélecteur de jours, les compteurs et les séances.
  Sept colonnes apparaissent au-delà de 1050 px disponibles. Sur les plus petites
  largeurs (moins de 308 px de contenu), les sept jours passent sur deux lignes
  pour conserver des cibles de 44 px sans masquer le dimanche.
- La préférence locale Chiron passe à `arete.coach-display.v2` : les anciens choix
  sont réinitialisés une seule fois vers le flottant ; les choix explicites
  suivants sont conservés. Le lanceur mobile reste présent en mode latéral.
  Ouvrir, fermer ou déplacer le chat ne crée aucun appel modèle.
- Les invitations d’installation restent au-dessus du lanceur et s’effacent
  temporairement devant un dialogue ou le coach. Les zones musculaires peuvent
  être consultées au toucher, sans nécessiter un survol.

Validation : `mobile-ux.spec.ts` utilise Chromium et WebKit en mode tactile à
320, 390 et 430 px, avec zones de sécurité et clavier simulés. Les scénarios
existants vérifient les huit thèmes à 390, 430, 768 et 1440 px, les flux SSE et
les écritures Planning sur une base jetable. Les captures sont enregistrées
sous `.context/`. L’émulation ne remplace pas une recette sur iPhone et Android
réels, notamment pour le clavier système, les barres du navigateur et le mode installé.

## Suivi et automatisations — même identité, mêmes interactions

La [page Figma Suivi et automatisations](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=168-81)
utilise les navigations bureau/mobile de la page `109:81` et les états Chiron
compacts de la page `5:81`. Les huit écrans déclinent Suivi et Automatisations,
bureau et mobile, Pierre et Prune. Les composants de référence restent inchangés.

La boîte est une liste à séparateurs discrets, sans empilement de cartes.
La cloche ouvre cette même boîte ; les actions de lecture et d’archivage sont
regroupées dans le menu de chaque ligne. Répondre ou examiner une proposition
ouvre `AgentSidePanel`, avec son mode, ses dimensions et son focus existants.
`AutomationReview` fournit seulement le contenu : question et saisie courte,
ou changements avant/après et actions Approuver, Modifier, Refuser.
Aucun second dialogue de validation n’est créé. « En parler à Chiron » retrouve
le brouillon et transmet une référence serveur, sans envoyer de message.

`FollowUp.tsx` et `followUp.css` utilisent les tokens communs et `ui/Button`.
Le formulaire de programmation remplace temporairement la liste ; les champs
suivent le déclencheur sélectionné. La séance se choisit dans le planning,
sans demander un identifiant technique à l’athlète. L’accueil et la boîte lisent
les mêmes notifications et partagent leur cache de requêtes.

`automations.spec.ts` vérifie les deux thèmes à 390 et 1440 px : menus communs,
réponse, approbation, conservation du brouillon, création, focus et absence de
débordement. Consulter ou décider n’effectue aucun appel modèle depuis le navigateur.

## Briefing → conversation Chiron

[Proposition UX éditable : aperçu, nouveau fil, échange](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=166-632).

Le briefing est une entrée vers le coach. Le tableau de bord montre un titre
Inter actionnable, un aperçu limité à trois lignes et l’heure d’écriture.
« Briefing du jour » et « En parler avec Chiron » ouvrent une **nouvelle
conversation**, avec le briefing complet visible avant les échanges. Les anciens
briefings utilisent le même parcours. Le texte complet n’est jamais tronqué dans
la conversation ni dans le contexte envoyé au modèle.

- L’ouverture ne lance aucun appel modèle et ne remplit pas la saisie. Le brouillon,
  les pièces jointes et une réponse en cours restent dans leur fil d’origine.
- La référence appartient à `CoachThread`, pas à `App` ni à la page. Elle est
  sauvegardée avec le fil, restaurée au rechargement et incluse dans chaque demande
  de ce fil. Le serveur relit le briefing par son identifiant, dans le périmètre
  de l’athlète. Une autre conversation ne reçoit pas cette référence.
- Le briefing est présenté comme un document de contexte, sans inventer un message
  assistant ni un reçu de trace. Sa lecture HTTP ne charge pas la pile agent.
- Les avis sont dans la conversation. `FeedbackRating` possède les deux icônes
  Lucide et leurs états ; `MessageFeedback` et `BriefingDiscussion` le réutilisent.
  `index.css` possède `.coach-feedback-action` : rayon de contrôle commun,
  couleurs du thème, cible tactile de 44 px. Pas de boutons 👍/👎 autonomes,
  de cercles décoratifs ni de formulaire de commentaire parallèle au chat.
- Les commentaires déjà enregistrés restent lisibles. Pour préciser son avis,
  l’athlète écrit à Chiron dans la saisie commune. Les avis du briefing restent
  enregistrés sur le briefing ; ceux d’une réponse tracée utilisent son reçu.
- Une erreur de lecture reste visible, avec nouvelle tentative explicite. Un avis
  non confirmé bloque les autres votes jusqu’à vérification par lecture.
- La limite de 30 conversations échoue explicitement, sans effacer un brouillon.
  Les modes flottant et latéral réutilisent la même conversation et le même contexte.

Garde-fous : tests de restauration et d’isolation dans `agentThreads.test.ts` et
`useCoachThreads.test.tsx`, lectures privées dans `test_briefing_reactions.py`,
avis partagés dans `BriefingDiscussion.test.tsx`, parcours clavier et captures
mobile/bureau Pierre/Prune dans `briefing.spec.ts`. Toute évolution de ce parcours
met à jour ces contrats et conserve la référence de marque `5:81` et le chat `70:201`.

## Conversations sauvegardées

La [proposition éditable](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=271-3203)
ajoute « Conversations » à Suivi et Automatisations. `ThreadHistory` partage la
recherche explicite, la liste à séparateurs, le renommage et la pagination entre
cette page et le panneau Chiron. Les huit thèmes utilisent les tokens existants.
Ouvrir un résultat reprend le fil sans appel modèle ni remplissage du brouillon.
La saisie reste celle de `AgentSidePanel` ; les réponses en cours et les brouillons
restent dans leur fil d’origine. Une erreur de sauvegarde est visible et conserve
la copie locale. La limite de 30 devient une taille de page, pas une rétention.
