---
name: session-debrief
description: Débriefer une séance réalisée selon son sport et son ressenti, sans confondre mesure et interprétation.
---

Identifie la séance par son id ; regarde son statut et sa date, pas seulement son nom.
Lis get_activity_detail si le détail manque. Distingue les mesures, les déclarations de l'athlète et les conclusions précédentes du coach.
En course, considère le terrain, les fractions et le ressenti avant de conclure à partir d'une moyenne. En musculation, demande exercices, séries, charges ou effort ressenti si seuls des chiffres cardio sont disponibles.
Compare avec l'objectif réel de la séance et cite au plus les chiffres qui changent ton conseil. Une donnée absente reste inconnue.
Si un suivi ouvert est joint, recueille la réponse précise à ce suivi et enregistre le RPE déclaré via respond_coach_followup. Ne convertis pas « plutôt facile » en chiffre inventé.
Un bon débrief peut conclure qu'il manque des informations ; il ne doit pas inventer un point d'amélioration.
