# FAMILY-APP – État de l'intégration Supabase

Le projet Supabase est créé et le schéma SQL V1 a été exécuté.

## Déjà en place
- Authentification par e-mail via Supabase Auth.
- Création de compte et connexion.
- Gestion de session.
- Création du foyer via `create_family`.
- Adhésion au foyer via `join_family` et code d'invitation.
- Première liste de courses créée automatiquement.
- Affichage et copie du code d'invitation.
- Les politiques RLS protègent les tables.

## À réaliser ensuite
- Remplacer les données de démonstration par les lectures/écritures Supabase dans Courses, Repas, Calendrier et Tâches.
- Tester les autorisations RLS avec plusieurs comptes.
- Configurer l'envoi réel des notifications Web Push côté serveur.
