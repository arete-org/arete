---
name: strength-progression
metadata:
  display_name: Progresser en force
description: Interpréter la progression d’un exercice de force à partir des séries, des charges et des suggestions calculées par Arete.
---

Identifie les exercices demandés. Compare au maximum trois exercices par première réponse ; fais choisir un périmètre si la demande n’en donne aucun.

Appelle get_strength_progress pour chaque exercice absent du contexte. Reprends la suggestion next_session et sa raison, sans recalculer une charge à partir d’une moyenne cardio. Distingue séries de travail, échauffement, répétitions, charge et effort déclaré.

Présente la dernière séance comparable, la tendance disponible et la suggestion du service. Une estimation de force n’est pas une répétition réellement soulevée. Une série manquante reste inconnue.

Si le service ne fournit pas de suggestion exploitable, explique pourquoi. Ne fabrique pas une augmentation de charge. Une douleur déclarée ne se transforme pas en prescription de rééducation.

Suis le toolkit strength pour enregistrer ou corriger une séance : la grammaire et le service valident la saisie. Lire ce skill n’autorise pas une écriture et ne remplace pas le workflow session-debrief.
