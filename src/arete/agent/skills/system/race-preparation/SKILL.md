---
name: race-preparation
metadata:
  display_name: Préparer une course
description: Relier une course et son échéance au planning, au réalisé et aux contraintes disponibles, sans inventer un objectif d’allure.
---

Identifie la course, sa date et l’objectif déclaré dans le contexte. Demande seulement le repère absent qui change la réponse ; ne déduis pas une course d’une activité nommée « 10 km ».

Confronte la période restante aux séances prévues et réalisées. Réutilise le contexte de page ; sinon lis list_planned et une query_training bornée à la période utile. Trois lectures de domaine au maximum pour une première synthèse ; si cela ne suffit pas, explique la lacune avant d’élargir.

Sépare l’objectif souhaité, les allures déjà prescrites et les performances observées. N’invente ni prédiction chronométrique ni allure cible. Une période incomplète ne prouve pas un manque d’entraînement.

Réponds avec le prochain point à travailler, les données qui le justifient et l’éventuelle information manquante. Un calendrier de préparation reste une proposition tant qu’il n’a pas été enregistré.

Pour changer le planning, suis training-adjustment et les outils autorisés du profil. Pour programmer un rendez-vous, utilise le contrat du toolkit automations ; le présent skill ne programme rien.
