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
prolongent la même identité. Le panneau latéral classique reste le mode par défaut.
Dans « Options du coach », « Chat flottant » active une préférence locale au navigateur ;
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
