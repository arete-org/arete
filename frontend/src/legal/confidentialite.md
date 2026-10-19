> **BROUILLON — à valider** : ce texte n'a pas encore été relu par un juriste. Les mentions `[À COMPLÉTER]` restent à renseigner avant toute ouverture au public.

# Politique de confidentialité d'Arete

Version : `2026-10-draft-1`

## 1. Responsable du traitement

**[NOM DU RESPONSABLE DU TRAITEMENT], personne physique**, éditeur d'Arete.

- Contact pour toute question ou demande sur tes données : [EMAIL DE CONTACT]
- Adresse : [ADRESSE POSTALE]

## 2. Les données traitées

Selon ce que tu connectes et utilises :

- **Compte** : adresse e-mail et sa vérification, nom, identifiant Clerk, rôle, dates de connexion.
- **Données de santé** (article 9 du RGPD) importées de Garmin : variabilité de la fréquence cardiaque (VFC), sommeil (durée, phases, score), fréquence cardiaque au repos, stress, Body Battery, disponibilité à l'entraînement, VO2max, prédictions de course, pas et minutes d'intensité ; ton seuil et tes zones de fréquence cardiaque.
- **Ressenti quotidien** : sommeil, jambes, motivation et note que tu saisis le matin.
- **Activités** : séances Garmin, Strava ou fichiers FIT, avec leurs mesures (fréquence cardiaque, allure, puissance, cadence, altitude) et leur trace GPS ; la météo à leur départ.
- **Musculation, plans, objectifs** : séances de force, plan d'entraînement, objectifs de course, bilans et décisions du coach.
- **Mémoire du coach** : journal, faits que tu lui confies, notes de séance, conversations enregistrées, documents que tu importes (PDF, images) et leur texte extrait.
- **Dictée vocale** : l'enregistrement que tu envoies pour être transcrit.
- **Connexions** : session Garmin (ton mot de passe n'est jamais conservé), jetons Strava, connexion Google Agenda et événements concernés, lien entre ton compte Slack et ton compte Arete, abonnements aux notifications de tes appareils.
- **Réglages** : fuseau horaire, préférences de notification, thème et préférences d'entraînement.
- **Consentement** : versions des textes acceptées, date du consentement et de son retrait éventuel.

## 3. Pourquoi, et sur quelle base

| Finalité | Base légale |
|---|---|
| Fournir le service : compte, synchronisations, analyses, plan, coach, notifications | Exécution des conditions d'utilisation (article 6.1.b du RGPD) |
| Traiter tes données de santé, y compris les transmettre au coach (modèles d'IA) | Ton consentement explicite (article 9.2.a du RGPD), que tu peux retirer à tout moment |
| Sécurité du service, administration des comptes, journaux techniques | [À COMPLÉTER : intérêt légitime de l'éditeur ?] |

Arete ne vend pas tes données, ne s'en sert pas pour de la publicité et ne prend aucune décision produisant des effets juridiques à ton égard.

## 4. Qui y a accès

**Administrateurs.** L'éditeur et les administrateurs qu'il désigne voient la liste des comptes, leur dernière activité et l'état de leur synchronisation. Un administrateur vérifié peut aussi consulter, dans une conversation Slack privée, les réglages, entraînements, données de santé, faits, journal et documents d'un athlète qui a consenti ; chaque consultation est journalisée.

**Sous-traitants et services utilisés** :

| Service | Rôle | Données | Localisation |
|---|---|---|---|
| Vercel | Hébergement de l'application et de ses fonctions | Toutes, en transit ; journaux techniques | [À COMPLÉTER : région ; société américaine] |
| MotherDuck | Base de données | Toutes les données stockées | [À COMPLÉTER : région] |
| Clerk | Connexion au compte | E-mail, nom, sessions | [À COMPLÉTER ; société américaine] |
| OpenRouter | Routage des requêtes vers les modèles d'IA, transcription vocale | Messages, données d'entraînement et de santé utiles à la réponse, enregistrements vocaux | États-Unis [À COMPLÉTER : garanties] |
| Fournisseurs de modèles choisis par OpenRouter | Production des réponses du coach, des briefings et des messages | Idem | Variable selon le fournisseur retenu ; par défaut des modèles gratuits (NVIDIA Nemotron, Google Gemma), sur décision d'un administrateur le modèle GLM de Z.ai [À COMPLÉTER : liste et pays des fournisseurs, conservation et éventuel entraînement sur les requêtes gratuites] |
| LangSmith (LangChain), seulement si le traçage est activé | Suivi technique des requêtes du coach | Contenu des échanges avec le coach, avis 👍/👎 | [À COMPLÉTER : région ; société américaine] |
| Garmin | Source des activités et des données de santé ; envoi des séances planifiées | Identifiants le temps de la connexion, session, séances | Selon les conditions de Garmin |
| Strava | Source d'activités, si connecté | Jetons, activités | Selon les conditions de Strava |
| Google | Agenda, si connecté | Événements d'entraînement | Selon les conditions de Google |
| Slack | Coach dans Slack, si utilisé | Messages échangés, e-mail du profil Slack | Selon les conditions de Slack |
| Services de notification des navigateurs (Google, Mozilla, Apple) | Acheminement des notifications | Contenu chiffré des notifications | Selon le navigateur |
| Open-Meteo | Météo au départ d'une activité | Position et heure de départ | [À COMPLÉTER] |

Certains de ces services sont situés hors de l'Union européenne, notamment aux États-Unis. [À COMPLÉTER : garanties encadrant ces transferts (cadre de protection des données UE–États-Unis, clauses contractuelles types).]

## 5. Combien de temps

- Tes données sont conservées tant que ton compte existe. Retirer ton consentement arrête leur traitement mais ne les supprime pas.
- La suppression de ton compte efface tes données immédiatement de la base, sauf l'historique de tes consentements (dates et versions des textes acceptés, sans autre donnée), conservé comme preuve. Les copies de sauvegarde de la base (clones `_bak_` créés avant chaque mise à jour du schéma) les conservent jusqu'à leur remplacement par des sauvegardes plus récentes : deux sont gardées. [À COMPLÉTER : durée maximale, et durée de rétention des instantanés MotherDuck et des journaux Vercel.]
- Une connexion Garmin en attente de code de vérification expire au bout de 10 minutes.

## 6. Tes droits

- **Accès et portabilité** : exporte tes données à tout moment dans **Réglages → Données** (ZIP de fichiers CSV ou JSON).
- **Rectification** : la plupart des données se corrigent dans l'application ; sinon écris à [EMAIL DE CONTACT].
- **Effacement** : supprime ton compte ou demande-le à [EMAIL DE CONTACT].
- **Retrait du consentement** : dans **Réglages → À propos**, à tout moment, sans remettre en cause les traitements faits auparavant.
- **Opposition et limitation** : écris à [EMAIL DE CONTACT].
- **Réclamation** : tu peux saisir la CNIL (www.cnil.fr).

## 7. Sécurité

Les échanges sont chiffrés (HTTPS). Chaque athlète ne voit que ses propres données ; l'isolation est assurée par l'application. Les identifiants des services tiers ne sont jamais exportés. [À COMPLÉTER : mesures complémentaires.]

## 8. Évolution de cette politique

Toute nouvelle version porte un nouveau numéro ; Arete te demande alors ton accord à nouveau avant de reprendre le moindre traitement.
