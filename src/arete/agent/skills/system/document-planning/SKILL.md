---
name: document-planning
metadata:
  display_name: Préparer un plan depuis un document
description: Consulter et interpréter un planning d’entraînement joint, notamment un tableur, pour un jour ou une semaine ; créer les séances et les envoyer vers Garmin seulement sur demande.
---

# Lire un planning joint

1. Repère le chemin du document dans le contexte et la période demandée. Pour
   une semaine relative, calcule d’abord ses dates depuis la date actuelle fournie.
2. Recherche les dates dans le document avec `grep` (texte littéral). Les dates
   calculées d’un tableur figurent parfois dans une « valeur enregistrée » ISO.
   Une recherche vide sur « octobre » ne prouve pas que la semaine manque.
3. Lis le bloc de lignes autour du résultat avec `read_file`. Son `offset` est
   indexé à zéro et son `limit` est compris entre 1 et 200. Pour poursuivre,
   avance l’offset du nombre de lignes déjà reçues. Ne demande pas tout le fichier
   par défaut et ne relis pas un bloc déjà présent dans l’échange.
4. Dans un tableur, identifie d’abord la cellule de date et conserve **la même
   colonne** pour toutes les lignes de la séance, jusqu’au prochain bloc de dates.
   Ne rassemble jamais les cellules d’une ligne comme une seule séance : B17 et
   D17 appartiennent à des jours différents. Par exemple, si B13 = 12 octobre et
   D13 = 14 octobre, « 20 x 300 r 100 » en B17 est le 12 ; « 1h15 » en D17 est
   le 14 et ne donne pas la durée du 12. Une alternative « ou » reste dans la même
   colonne. Conserve les indications d’échauffement et de récupération de la source ;
   le toolkit planning définit leur traduction en étapes et les blocs par défaut.
5. Vérifie la source avant de reprendre une affirmation de l’historique : une
   confirmation de l’athlète ne corrige pas une mauvaise lecture du tableau.
   Si plusieurs fichiers couvrent la date, utilise celui demandé, sans les mélanger.
   Cite les cellules de date et de contenu. Une cellule vide ne permet pas
   d’inventer une séance ; les aperçus partiels ne prouvent pas son absence.
6. Pour une simple question, réponds sans écrire. Pour créer les séances, suis
   le toolkit planning : vérifie les séances existantes, puis crée directement
   chaque séance avec ses étapes typées et ses références exactes. N’ajoute
   ni durée totale déduite d’un autre jour, ni deuxième séance pour une alternative.
   Si l’athlète demande aussi un export, utilise les ids réels avec le toolkit
   Garmin. Distingue ce qui est lu, enregistré, programmé et transféré.

Ce skill décrit une méthode ; il n’accorde aucun outil ni aucune permission.
