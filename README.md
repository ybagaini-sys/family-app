# family-app

Application familiale progressive (PWA), conçue pour une utilisation sur iPhone et en ligne.

## V1.3 – Première connexion Supabase

Cette livraison ajoute :
- Connexion et création de compte par adresse e-mail.
- Gestion de session Supabase.
- Création d'un foyer ou adhésion par code d'invitation.
- Création automatique de la première liste de courses lors de la création du foyer.
- Déconnexion.
- Version du cache PWA `shell-v1.3`.

Les modules Courses, Repas, Calendrier et Tâches affichent encore des contenus de démonstration : leur lecture/écriture réelle dans Supabase sera branchée dans les étapes suivantes. Les notifications Web Push ne sont pas encore opérationnelles.

## Déploiement GitHub Pages

1. Décompresser l'archive.
2. Déposer le contenu du dossier `family-app-main` à la racine du dépôt GitHub `family-app` (remplacer les anciens fichiers portant le même nom et ajouter `app-core.js`).
3. Vérifier que `index.html`, `app.js`, `app-core.js`, `styles.css`, `sw.js` et `manifest.webmanifest` sont à la racine.
4. Attendre la publication GitHub Pages.
5. Ouvrir le site dans Safari sur iPhone.

## Configuration Supabase

L'URL et la clé publishable du projet sont utilisées dans `app.js`. La clé publishable est destinée au navigateur. Ne jamais ajouter de clé `sb_secret_`, `service_role`, mot de passe de base de données ou clé privée VAPID au dépôt.

L'accès aux données doit rester protégé par les politiques RLS de Supabase.

## Première utilisation

1. Créer un compte avec prénom, adresse e-mail et mot de passe.
2. Si la confirmation e-mail est activée dans Supabase, confirmer l'adresse depuis le message reçu.
3. Se connecter.
4. Le premier membre crée le foyer.
5. Les autres membres créent leur compte puis rejoignent le foyer avec le code d'invitation. Le code doit être communiqué directement par un membre du foyer.

## Limites connues de cette livraison

- Les écrans métiers sont encore en mode aperçu et ne doivent pas être considérés comme synchronisés.
- L'affichage des données réelles et les opérations CRUD seront ajoutés dans la prochaine livraison.
- Les notifications nécessitent un serveur d'envoi Web Push et des clés VAPID conservées côté serveur.


## V1.4
- Suppression des articles fictifs de la liste de courses.
- Liste de courses initialement vide avec un message d'accueil.
- Cache Service Worker incrémenté à `shell-v1.4`.


## Version 1.6
- Suppression du caractère littéral `\n` parasite dans `index.html`.
- Compteur fictif de courses sur l’accueil remis à zéro.
- Cache du service worker incrémenté à `shell-v1.6`.


## Version 1.7
- Retrait des tâches de démonstration : le module démarre vide.
- Ajout et suppression d'articles de courses et de tâches ; cases à cocher disponibles.
- Les listes sont conservées localement sur l'appareil (localStorage), mais ne sont pas encore synchronisées entre les membres via Supabase.
- Cache du service worker : `shell-v1.7`.


## Version 1.8
- Affichage discret de la version dans la barre supérieure.
- Bouton « Actualiser » : vérifie les mises à jour du service worker puis recharge l'application.
- Cache du service worker incrémenté à `shell-v1.8`.


## V1.9
- Le statut des tâches est réversible : une tâche cochée peut être décochée pour être remise « à faire ».
- Le contrôle indique son action avec un libellé accessible et affiche une confirmation après chaque changement.
- Version visible : v1.9 ; cache du service worker : shell-v1.9.


## Version 1.10
- Le module Courses utilise maintenant Supabase : ajout, coche/décoche, suppression et lecture partagée par les membres du foyer.
- Synchronisation Realtime et actualisation de secours toutes les 12 secondes.
- Migration unique des articles locaux vers la liste Supabase lorsqu'elle est vide.
- Les tâches, repas et calendrier restent à connecter dans les prochaines versions.
- Cache du service worker : `shell-v1.10`.


## Version 1.13.6 – Nouveautés familiales

- Le compte connecté détermine désormais le membre actif : aucun sélecteur de prénom n'est proposé.
- Le panneau du code/lien d'invitation est retiré de l'accueil. Le lien d'invitation reçu reste accepté lors de la connexion ou de l'inscription.
- Les nouveautés non lues sont suivies individuellement dans `family_notifications`.
- Les rubriques Courses, Repas et Tâches affichent un badge rouge avec le nombre d'éléments distincts non consultés. Le badge est effacé lorsque le membre ouvre la rubrique correspondante.
- Le compteur de la carte Tâches affiche le nombre total de tâches, terminées ou non.
- Les créations, modifications et suppressions de tâches, articles de courses et repas alimentent le suivi central.
- Le calendrier de cette version reste un aperçu non connecté : les rendez-vous ne peuvent donc pas encore produire de nouveautés.

La table `family_notifications` doit avoir été créée au préalable avec le script SQL central fourni dans la conversation. Aucune nouvelle migration SQL n'est requise pour cette version.


## V1.13.7 – Nouveautés familiales et agenda partagé
- Pastilles rouges de nouveautés pour les rubriques Courses, Repas, Agenda et Tâches.
- Chaque membre dispose de son propre état de lecture ; ouvrir une rubrique marque ses nouveautés comme consultées pour le compte connecté.
- Les nouveautés sont enregistrées dans `family_notifications` (migration centrale déjà exécutée dans Supabase).
- Agenda connecté à `calendar_events` : affichage des prochains événements, ajout, modification du titre et suppression, avec synchronisation et notifications familiales.
- Les liens de notification ouvrent directement la rubrique correspondante.
- Identité toujours liée au compte Supabase ; le sélecteur de profil reste supprimé.
