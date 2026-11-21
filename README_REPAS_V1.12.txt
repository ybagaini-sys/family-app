FAMILY-APP — V1.12 MODULE REPAS

Ordre d'installation :
1. Dans Supabase > SQL Editor, exécuter REPAS_SUPABASE.sql.
2. Vérifier que la requête de contrôle affiche is_planned dans meal_entries
   et les colonnes de meal_attendance.
3. Remplacer les fichiers du dépôt GitHub par le contenu de cette archive.
4. Attendre le déploiement GitHub Pages, puis ouvrir l'application et appuyer
   sur Actualiser.

Fonctions incluses :
- Planning prévisionnel du lundi au dimanche, midi et soir.
- Navigation semaine précédente / suivante.
- Ajouter, modifier et supprimer un repas.
- Marquer un créneau comme « Aucun repas prévu » et le replanifier ensuite.
- Signaler un membre absent d'un repas, sans demander ni enregistrer de motif.
- Les membres sont présents par défaut ; seuls les cas d'absence sont stockés.
- Synchronisation Supabase Realtime avec actualisation périodique de secours.
- Les modules Tâches, Courses et l'authentification sont conservés.

Important : les notifications push ne sont pas activées dans cette version.
Elles restent une étape transversale à développer après validation du module Repas.
