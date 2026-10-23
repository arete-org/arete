# Audit de l’accueil et des messages du coach — 23 octobre 2026

Ticket : [ARE-210](https://linear.app/arete-app/issue/ARE-210/audit-coaching-messages-and-design-a-clearer-briefing-led-home),
projet « Performance & engagement — audit Oct 2026 », jalon « UX 1 — quick wins ».

## Intégration ARE-210

L’application reprend la hiérarchie des maquettes : briefing complet sur surface
neutre, séances lisibles, trois repères sourcés, suivi compact, détails à la demande.
La discussion réutilise le fil, les avis et la saisie du chat. La migration 67
conserve jusqu’à trois faits datés avec chaque nouveau briefing, à partir des
faits déjà lus ; elle n’ajoute aucun appel au modèle. Les anciens briefings restent
consultables et indiquent l’absence de mesures historiques.

Le mode de coordination existant et ses préférences restent respectés. En repli,
« Tes bilans et échanges » donne accès au suivi sans annoncer un nombre d’actions
que cette source ne sait pas garantir. La cadence des notifications proposée dans
cet audit reste une décision distincte ; cette intégration ne modifie pas les
préférences de notification des comptes.

## Recommandation

L’accueil doit répondre à trois questions : **« Que faire maintenant ? »**,
**« Qu’ai-je fait aujourd’hui ? »** et **« Sur quels repères repose le conseil ? »**.
Un point du coach, les séances et trois repères sourcés restent visibles ; une
seule demande prioritaire apparaît lorsqu’elle existe. Les courbes, les autres
mesures et l’historique restent accessibles à la demande.

La simplification concerne la hiérarchie et les sollicitations, pas seulement
la longueur du briefing. Réduire le texte sans supprimer ses doublons laisserait
le problème principal intact.

Livrables :

- [Proposition Figma bureau](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=434-17218).
- [Proposition Figma mobile](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=434-17316).
- [Lecture et discussion](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=434-17573).
- [Conversation ouverte sur bureau](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=438-17772).
- [Examen d’une adaptation](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=434-17496).
- [Suivi et historique](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=434-17697).

Les nouveaux écrans sont ajoutés à droite de la proposition unifiée du 18 octobre.
Les références existantes ne sont pas modifiées. Les textes et états de la maquette
sont illustratifs ; ce ne sont pas de nouveaux conseils calculés pour le compte.

### Révision visuelle après retour utilisateur

Le grand aplat beige/orangé est remplacé par la surface neutre du chat compact
([référence](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=62-143)).
Le briefing utilise Inter 16 px avec un interligne de 26 px, une largeur de lecture
limitée sur bureau et un titre Inter 20 px. Le laurier, l’heure et la provenance
restent discrets. « En parler » devient une action compacte ; le bouton plein est
réservé à une décision. Les séances passent en liste avec séparateurs fins, et le
briefing dans la conversation reprend la lecture sans encadré des réponses du chat.
Les contrôles tactiles conservent une hauteur de 44 px. Cette révision concerne
les maquettes Figma ; le code applicatif reste inchangé.

La première simplification retirait trop d’informations et dispersait les liens
dans un espace vide. La révision suivante remet les séances et les repères dans
deux panneaux alignés, côte à côte sur bureau, empilés sur mobile. Les marges
internes communes sont de 24 px sur bureau et 16 px sur mobile. Les lignes de
séance gardent leur statut, leur durée, leur distance et le ressenti disponible,
sans couper la deuxième ligne. Le total d’activité donne un résumé immédiat.

« Tes repères » affiche la préparation Garmin, le ressenti des jambes et la
charge hebdomadaire avec leurs valeurs et leur provenance. « Détails » appartient
à ce panneau. Le suivi affiche « Aucune réponse attendue » avec un bouton adjacent
et précise qu’il contient les analyses de séance et les points précédents.
Dans la discussion, « Ce qui explique ce conseil » montre les faits du briefing ;
le lien isolé « Pourquoi ce conseil ? » disparaît. L’historique rejoint l’en-tête.
Les chiffres restent des exemples de maquette, pas une lecture du compte.

## Périmètre et niveau de preuve

Audit de la capture fournie, de la [référence unifiée](unified-experience.md),
du [design system](../design.md), des composants, des producteurs de messages,
de la coordination et du transport des notifications dans le code local.

**L’historique réel du compte n’a pas été lu par API.** Cet audit décrit tous les
mécanismes de messages identifiés et les doublons de la capture ; il ne mesure pas
combien de pushes Arthur a effectivement reçus sur une journée ou une semaine.
Le badge « 11 » ne permet pas cette déduction. Aucune base MotherDuck n’a été ouverte.

## Ce qui surcharge l’écran

| Constat | Preuve | Conséquence | Proposition |
| --- | --- | --- | --- |
| Un briefing puis une reprise du même début dans le suivi | Capture ; `BriefingCard` et `InboxPriority` | Relire deux fois le même conseil sans savoir s’il a changé | Une seule représentation du point du jour sur l’accueil |
| « Le coach aujourd’hui » subsiste même sans demande | `CoachTodayPanel` rend toujours le panneau et son bouton d’actualisation | Une carte vide présente une opération interne comme une tâche utilisateur | Aucun panneau si aucune action n’est attendue |
| Trois portes de coaching concurrentes | `HUD` → `BriefingCard` et `CoachingAttention` ; repli → `CoachTodayPanel` + `InboxPriority` | L’utilisateur doit décider quel « coach » consulter | Une carte, dont l’action principale dépend de la priorité |
| Des récapitulatifs anciens sont présentés comme prioritaires | `InboxPriority` prend les trois premiers éléments de l’inbox ; `listing('todo')` inclut les non-lus | Un ancien « tu es frais » peut côtoyer le conseil de repos du jour | Réserver les priorités aux demandes encore valides ; dater les archives |
| Fraîcheur et préparation sont répétées | Barres, cartes, courbe et panneau Préparation dans `HUD` | Beaucoup de chiffres, faible valeur décisionnelle supplémentaire | Trois repères sourcés sur l’accueil ; autres mesures à la demande, courbes dans Analyses |
| La source des scores n’est pas assez claire | `morningScore = readiness_score ?? training_readiness_score`, alors que `current_readiness` préfère Garmin | Le rond 47 et la barre 1/100 paraissent contradictoires | Afficher la préparation canonique ; nommer distinctement l’estimation Arete dans les détails |
| Le briefing et les métriques peuvent dater de moments différents | Capture : briefing 43/100 et 0,90, widgets 1/100 et 1,01 ; briefing conservé, données du dashboard relues | Perte de confiance et conseil potentiellement dépassé | Provenance et fraîcheur explicites ; état de séance actuel prioritaire |
| Le nombre de non-lus ressemble à une dette d’actions | `InboxBell` affiche `unread` | Les bilans et imports accumulés entretiennent une urgence artificielle | Compteur des demandes actives ; historique sans dette de lecture |

La divergence 47/1 n’est pas la preuve d’un mauvais calcul : le code lit deux
scores différents. L’origine précise du 43/100 et du 0,90 du briefing nécessite
ses faits enregistrés et leurs dates ; la capture seule ne prouve ni hallucination
ni erreur de calcul.

## Inventaire des messages et sollicitations

| Famille | Déclenchement et limites actuelles | Où elle apparaît | Traitement recommandé |
| --- | --- | --- | --- |
| Ressenti du matin (`checkin`) | Un push par jour non répondu ; fenêtre locale 06–12 h, heures calmes respectées | Push, carte avant briefing | Demande inline au premier passage ; pas un push distinct par défaut |
| Briefing (`briefing`) | Lecture du jour ou sync ; texte stocké, réécriture après la sync si les faits ont changé dans les conditions du scheduler | Accueil, historique, contexte d’un fil, inbox, push du scheduler | Un point du jour ; aucune deuxième carte ; mise à jour du même sujet |
| Analyse de séance (`post_session`) | Feedback des activités importées ; au plus une annonce par sync, même si plusieurs activités | Détail de séance, inbox, push avec extrait | Sur la séance et dans l’historique regroupé ; interruption seulement si un retour utile manque |
| Question de ressenti après séance | `coach_followup.prepare` crée au plus une nouvelle question quotidienne, une par activité ; expiration à 48 h | Carte de suivi, détail de séance, éventuellement rappel via le soir coordonné | Même question et même réponse partout ; aucune relance si le RPE existe |
| Bilan hebdomadaire (`weekly_review`) | Dimanche soir selon fenêtres du scheduler ; rattrapage ultérieur ; un bilan stocké par semaine | Planning / Ma semaine, entrée accueil, inbox, push | Dans Planning ; un accès discret, remplace un récapitulatif quotidien le jour de sa livraison |
| Séance manquée / adaptation (`adapted_session`) | Replanification du soir ; proposition à accepter, une annonce par jour selon le producteur | Accueil / suivi / planning, inbox, push | Priorité au-dessus des bilans ; aperçu avant/après puis accord explicite |
| Message du soir (`evening`) | Opt-in désactivé par défaut ; heure choisie 18–21 h, 20 h par défaut ; écrit seulement s’il existe un motif | Suivi, push, contexte du lendemain | Garder l’opt-in ; seulement une question nouvelle ; réutiliser la question de RPE déjà ouverte |
| Import technique (`imports`) | Alternative à l’annonce d’analyse, au plus une par sync, pas une par jour | Inbox et push | Confirmation de synchronisation dans l’application ; silencieuse par défaut |
| Routines (`automation`) | Selon les routines configurées : résultat, question ou approbation ; références persistées | Suivi, push, parfois chat | Même arbitrage par sujet ; seuls les résultats exigeant une action remontent |
| Rappel de veille (`eve_reminder`) | Catégorie déclarée comme prévue dans `settings.py` | Aucun producteur identifié dans le périmètre | Ne pas compter comme message actuellement émis |

`post_session` regroupe deux intentions qu’il faut distinguer côté présentation :
« une analyse est disponible » et « une réponse est attendue ». Le type de push
ne suffit pas pour déterminer une action ; il faut relire son objet métier.

### Pourquoi le plafonnement actuel ne suffit pas

1. La coordination exige **le flag administrateur `coaching_attention` ET la préférence
   `coordinated_coaching`**, désactivés par défaut. Le mode observation conserve
   l’ancien affichage et les anciennes politiques. La capture est compatible avec
   ce repli ; les réglages effectifs du compte n’ont pas été interrogés.
2. En mode coordonné, le plafond vaut deux tentatives par jour par défaut, réglable
   de zéro à trois. **Les imports le contournent explicitement.** Ce n’est donc pas
   un plafond de toutes les notifications.
3. `notify` enregistre l’élément dans l’inbox **avant** de vérifier si le push peut
   partir. Désactiver les pushes ou atteindre le quota ne nettoie pas les non-lus.
4. Hors identité canonique coordonnée, la clé de notification peut dépendre du type,
   du titre, du texte, de l’URL et du jour UTC. Un texte réécrit peut devenir un
   nouvel élément d’inbox ; la limite de push n’est pas une déduplication visuelle.
5. La coordination classe les actions, mais ce n’est pas un digest quotidien
   sélectionné à l’avance. Des événements déjà envoyés peuvent avoir consommé le quota
   avant qu’une décision plus importante arrive.

## Parcours proposé

### Accueil

- L’objectif sportif devient une ligne de contexte, pas une carte sur toute la largeur.
- Le point du coach : un titre court, deux phrases maximum, une provenance et une action.
- L’action principale est « Examiner la proposition » s’il faut décider,
  « Donner mon ressenti » s’il faut répondre, sinon « En parler au coach ».
- Une seule demande affichée à la fois ; les autres restent visibles via « Tout le suivi »
  et son nombre explicite de demandes restantes. Ne jamais les supprimer silencieusement.
- La séance actuelle reste visible, avec son statut réel. Une séance déjà terminée ne
  doit pas être proposée à nouveau par un ancien briefing.
- Le premier passage peut montrer le ressenti du matin. Une réponse ou « Plus tard »
  retire cette demande et rend la place au point du jour, sans multiplier les cartes.
- « Tes repères » montre trois valeurs sourcées ; « Détails » ouvre les autres mesures et les courbes restent dans Analyses.
- Douleur et poids restent accessibles depuis les détails/santé ; aucune fonction n’est supprimée.

Le cas par défaut de la maquette passe des sept panneaux encadrés visibles dans
la capture (objectif compris), plus le suivi, à **trois blocs principaux** :
un briefing neutre, les séances et leurs résultats, puis trois repères sourcés.
Le clic supplémentaire concerne les analyses détaillées ; les informations
nécessaires pour comprendre le conseil sont lisibles dès l’accueil.

### Lire et répondre

L’entrée du briefing ouvre un nouveau fil avec sa référence, sans requête modèle.
Sur bureau comme sur mobile, `/coach` est une page intégrée au contenu principal,
selon les écrans Chiron `338:434` et `340:867` de la proposition unifiée :
historique, conversation et méthodes sur bureau ; fil pleine largeur et retour sur mobile. Un seul compositeur, les contrôles de feedback existants,
aucun message envoyé automatiquement et aucun brouillon rempli à la place de l’utilisateur.
Le contexte du briefing reste dans ce fil après rechargement et ne passe pas dans un autre.
La discussion affiche les faits enregistrés avec ce briefing, leurs sources et
leurs dates. Elle ne mélange pas silencieusement ces faits historiques avec les
mesures courantes de l’accueil. La justification est visible avant toute question.

Le nom « Coach » est celui du mode classique visible dans la capture ; « Chiron »
reste celui du mode gamifié. Les maquettes reprennent les composants de marque,
navigation, boutons, mesures et saisie de la référence. Les vues répétées de briefing
et de séances disposent de variantes bureau/mobile dans Figma.

### Notifications proposées, à implémenter séparément

- **Une interruption proactive par jour par défaut**, avec la préférence existante
  zéro à trois conservée. Pas d’exception de quota pour les imports.
- Les confirmations techniques et simples disponibilités de bilans restent dans l’application.
- Priorité : décision active, puis question utile, puis récapitulatif explicitement demandé.
- Une journée/séance/sujet possède une identité stable, indépendante du texte rédigé.
  Ses versions restent consultables sans devenir autant de nouvelles tâches.
- Le bilan hebdomadaire remplace le récapitulatif quotidien dans les interruptions ;
  le soir reste opt-in et ne répète aucune question existante.
- Un message reçu, lu ou archivé n’équivaut jamais à une décision acceptée.
- Aucun rejeu automatique d’un envoi ambigu ; un quota consommé reste consommé.

La recommandation d’un push par jour est une **décision produit proposée**, pas
une réduction mesurée du volume actuel. Activer simplement les deux options
existantes améliore la coordination mais ne réalise pas toute cette proposition.

## Flèche et écarts au design system

La double flèche grise est située dans la ligne du dossier « HP », au-dessus de
la barre de navigation Arete. La recherche des composants de flèche et des
positionnements dans `App`, `AgentSidePanel`, le briefing et les styles ne fournit
pas de propriétaire évident pour ce glyphe. **Origine non confirmée** : un contrôle
du navigateur est plausible. Il faut reproduire dans le navigateur d’origine,
comparer fenêtre normale / application installée et identifier l’élément avant
de modifier le CSS. Aucune correction de cette flèche n’est revendiquée.

Les flèches du briefing, elles, ont des propriétaires identifiés : son en-tête
et son bouton répètent tous deux l’ouverture du même fil. La proposition garde
une seule action explicitement libellée.

Le briefing actuel utilise déjà Inter et le panneau commun à rayon 16 px.
L’écart est principalement **la composition** : pas de titre éditorial, icône Sunrise
au lieu du laurier de la proposition unifiée, liens et histoire au même niveau
que le conseil, plusieurs surfaces concurrentes. Il ne faut donc pas remplacer
le système de composants pour résoudre ce problème.

## Mise en œuvre et enveloppe

| Lot | Responsabilités existantes à réutiliser | Coût et garde-fous |
| --- | --- | --- |
| Hiérarchie de l’accueil | `HUD`, `BriefingCard`, `CoachingAttention`, `coach_today`, `coaching_attention` | Zéro nouvel appel modèle ; projection existante, une priorité visible avec accès au reste |
| Cohérence des mesures | `services/metrics.current_readiness`, agrégat dashboard, provenance du briefing | Pas de nouveau calcul concurrent ; distinguer source et date, erreur/absence explicite |
| Présentation du point du jour | Producteur de briefing et prompt existants | Pas de modèle chargé de résumer un modèle ; format produit par la requête déjà prévue ou titre déterministe |
| Inbox et interruptions | `notifications`, `inbox`, `coaching_attention`, scheduler | Déduplication par sujet, quota transactionnel partagé, pas de nouveau worker ni nouvelle file implicite |

Le prompt actuel impose déjà deux à trois phrases, mais demande de citer des chiffres
et de terminer par l’action : des phrases longues peuvent donc repousser l’action
hors des trois lignes affichées. Proposition : décision d’abord, une justification,
les détails sur demande. Une éventuelle nouvelle sortie structurée devra être versionnée,
validée et compatible avec les anciens briefings ; ne pas découper arbitrairement
le texte ou ajouter un appel de résumé à chaque affichage.

Ne pas rafraîchir le conseil avec un modèle à chaque visite, sync ou mouvement de métrique.
Utiliser l’état métier courant pour les séances et décisions ; afficher le conseil
daté si son contexte a changé. Toute nouvelle génération devra avoir un déclencheur,
un budget et une mesure explicites. Conserver la référence historique du fil ouvert.

## Vérification et limites

Pour cette livraison : inspection du code et de la référence ; maquettes en calques
éditables, sans capture aplatie ; composants existants et variables réutilisés ;
contrôle des polices et inspection visuelle des écrans principaux. Les interactions
Figma illustrent les transitions ; les formulaires ne constituent pas une application.
La planche comporte treize écrans/états, deux ensembles de variantes locales et
37 liens de prototype visibles dont les destinations existent. Les textes utilisent Inter
et Cormorant Garamond ; aucun fond image ne remplace une interface éditable.
La dernière révision vérifie aussi l’absence de texte débordant de son conteneur,
les marges communes et le conteneur mobile à défilement vertical. Les aperçus de
l’accueil et de la discussion ont été inspectés à 390 et 1440 px.

**Aucune modification de code applicatif ou de préférence du compte.** `make check`
n’a pas été lancé pour cet audit documentaire et Figma. Aucune correction applicative
ni livraison production n’est annoncée.

Pour la PR documentaire, `uv run python scripts/ci/check_changed.py --base origin/main --run`
sélectionne les contrôles de politique uniquement : les 56 tests du planificateur CI
passent. Ces contrôles ne constituent pas une validation du comportement applicatif.

Avant une implémentation complète : `make check`, puis scénarios navigateur pertinents,
dont `frontend/browser-tests/briefing.spec.ts`, avec vérification à 390 et 1440 px.
Cas nécessaires : données absentes/anciennes, séance terminée, proposition périmée,
deux onglets, double réponse, réseau perdu après écriture, mode observation/repli,
quota concurrent, brouillon/pièces jointes/SSE conservés et contexte isolé par fil.

Pour quantifier le problème réel : lire par HTTP un échantillon borné de sept jours
d’inbox et ses reçus de transport ; séparer événements enregistrés, tentatives de push,
appareils livrés, sujets distincts et demandes encore actives. Mesurer les doublons par
sujet, les réponses utiles et les clôtures, sans assimiler un non-lu à une action.
L’inbox étant paginée, une limite d’extraction atteinte doit être signalée comme audit
incomplet. Ne pas ouvrir directement la base du compte.

## Sources dans le dépôt

- [Accueil](../frontend/src/pages/HUD.tsx), [briefing](../frontend/src/components/BriefingCard.tsx), [discussion](../frontend/src/components/agent/BriefingDiscussion.tsx).
- [Projection UI et repli](../frontend/src/components/agent/CoachingAttention.tsx), [ancienne carte du jour](../frontend/src/components/agent/CoachToday.tsx), [badge et extraits d’inbox](../frontend/src/components/AutomationInbox.tsx).
- [Prompt du briefing](../src/arete/agent/prompts/briefing.py), [producteur](../src/arete/services/briefing.py), [scheduler et annonces](../src/arete/scheduler.py).
- [Préférences](../src/arete/services/settings.py), [coordination et quota](../src/arete/services/coaching_attention.py), [transport et persistance](../src/arete/services/notifications.py), [inbox](../src/arete/services/inbox.py).
- [Ressenti du matin](../src/arete/services/checkins.py), [suivi de séance](../src/arete/services/coach_followup.py), [feedback de séance](../src/arete/services/session_feedback.py), [message du soir](../src/arete/services/evening_message.py).
- [Préparation canonique](../src/arete/services/metrics.py), [architecture et contrats](architecture.md).
