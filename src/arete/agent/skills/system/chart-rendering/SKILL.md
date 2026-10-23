---
name: chart-rendering
metadata:
  display_name: Visualiser tes données
description: Présenter une tendance ou une comparaison chiffrée avec un graphique HTML/SVG statique dans le chat navigateur.
---

Utilise render_chart quand un graphique aide à lire une tendance ou comparer des valeurs, ou quand l’athlète le demande. Cet outil existe seulement dans le chat navigateur ; lire cette skill ne le rend pas disponible ailleurs.

Réutilise les données de la page et les résultats déjà lus. Sinon, utilise query_training ou le calcul analytique spécialisé nécessaire. Ne dessine aucune mesure inventée. Indique la période, les unités, la source et les données manquantes ; ne remplace pas une valeur absente par zéro. Une courbe représente une évolution ordonnée ; des barres comparent des catégories, avec une base à zéro. Sépare les séries de différentes unités. Agrège explicitement un jeu trop dense, sans supprimer silencieusement des points.

## Contrat

Appelle render_chart avec title (120 caractères maximum), summary (600 caractères maximum), html et éventuellement height_px (280 par défaut, de 160 à 480). Maximum quatre cartes par réponse. summary décrit les valeurs importantes, la source et la période ; la réponse finale donne aussi une interprétation autonome, utile même sans la carte.

html est un fragment complet, sans clôture Markdown, de 16 Kio maximum, 512 éléments et 16 niveaux. Inclus au moins un svg avec viewBox. Préfère un repère 320 × 200, des labels courts de 12 px et peu de graduations pour le chat compact. Le navigateur fournit la largeur responsive, Inter et la palette du thème. Pas de JavaScript, CSS, attribut style, couleur littérale, URL, image, lien, formulaire, iframe, animation, commentaire ni document html/head/body.

Éléments HTML : div, span, p, strong, em, ul, ol, li, br, figure, figcaption, table, thead, tbody, tr, th, td.
Éléments SVG : svg, g, path, rect, circle, ellipse, line, polyline, polygon, text, tspan, title, desc. Ferme chaque élément ; le SVG ne contient pas de HTML ni de SVG imbriqué.
Attributs communs : class, role (img ou presentation), aria-label. Attributs SVG : viewBox, preserveAspectRatio, x/y/x1/y1/x2/y2/cx/cy/r/rx/ry/width/height/dx/dy, d, points, transform, text-anchor, dominant-baseline, stroke-width, stroke-dasharray, opacity/fill-opacity/stroke-opacity. Coordonnées numériques ; fill et stroke acceptent seulement none ou currentColor.

Classes : chart-grid (grille), chart-axis (axes), chart-label (graduations), chart-title (texte renforcé), chart-muted (secondaire), chart-legend (légende HTML), chart-swatch (pastille HTML), chart-line (courbe sans remplissage), chart-area (zone translucide). Couleurs de série : series-blue, series-green, series-yellow, series-orange, series-red, series-grey, series-cyan, series-gold, series-purple. Une couleur peut combiner chart-line ou chart-area. Les classes suivent le thème ; aucune autre classe n’est acceptée.

## Exemples de structure

Les valeurs ci-dessous sont fictives : remplace-les par les valeurs lues, et adapte les coordonnées à leur échelle.

Courbe :
```html
<svg viewBox="0 0 320 200" role="img" aria-label="Distance hebdomadaire en kilomètres">
  <line class="chart-axis" x1="40" y1="160" x2="300" y2="160"/>
  <line class="chart-grid" x1="40" y1="40" x2="300" y2="40"/>
  <text class="chart-label" x="8" y="44">40 km</text>
  <text class="chart-label" x="24" y="164">0</text>
  <polyline class="series-blue chart-line" points="60,100 170,70 280,40"/>
  <text class="chart-label" x="60" y="184" text-anchor="middle">S1</text>
  <text class="chart-label" x="170" y="184" text-anchor="middle">S2</text>
  <text class="chart-label" x="280" y="184" text-anchor="middle">S3</text>
</svg>
```

Barres :
```html
<svg viewBox="0 0 320 200" role="img" aria-label="Durée par sport en minutes">
  <line class="chart-axis" x1="32" y1="160" x2="300" y2="160"/>
  <text class="chart-label" x="12" y="164">0</text>
  <rect class="series-blue" x="60" y="40" width="64" height="120"/>
  <rect class="series-green" x="196" y="80" width="64" height="80"/>
  <text class="chart-label" x="92" y="28" text-anchor="middle">90 min</text>
  <text class="chart-label" x="228" y="68" text-anchor="middle">60 min</text>
  <text class="chart-label" x="92" y="184" text-anchor="middle">Course</text>
  <text class="chart-label" x="228" y="184" text-anchor="middle">Vélo</text>
</svg>
```

Après une erreur de validation, corrige sa cause avant un nouvel appel. N’affirme pas que la carte existe tant que rendered=true n’est pas revenu. Conserve les détails longs et les explications dans le texte du message plutôt que de surcharger le dessin.
