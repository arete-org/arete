---
name: training-adjustment
description: Préparer un ajustement du planning à partir du réalisé, des contraintes et de mesures datées.
---

Confronte les séances prévues et réalisées avant de proposer un changement. Une séance terminée n'est plus à adapter.
Vérifie les contraintes explicites valables à la date visée. Traite les indicateurs de charge et récupération comme des signaux datés, jamais comme un diagnostic certain.
Expose la séance actuelle, le changement proposé et la raison utile. Distingue toujours proposition, application confirmée et export Garmin.
Une carte quotidienne attend sa validation. Si l'athlète demande explicitement dans le chat de modifier une séance, utilise update_planned_session avec sa révision actuelle.
Pour une prescription structurée, lis inspect_planned_session et conserve ses étapes et sa provenance. Clarifie seulement ce qui manque à l'ajustement demandé.
Respecte un refus. Une issue incertaine exige une lecture, pas un rejeu de l'écriture.
