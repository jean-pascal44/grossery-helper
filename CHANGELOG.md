# Changelog

Toutes les évolutions notables de ce projet sont documentées ici.

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/)
et le projet respecte le [versionnage sémantique](https://semver.org/lang/fr/).

## [0.2.1] - 2026-11-14

### Fixed
- Notification de produit coché réduite à une simple coche, sans le nom du produit ni de la personne : la classe CSS du toast (`check`) entrait en conflit avec celle de la case à cocher des produits.

## [0.2.0] - 2026-11-14

### Added
- Partage optionnel de la clé API Gemini avec les participants d'une liste (case à cocher dans les Paramètres) : les autres peuvent dicter et utiliser « Auto (IA) » sans configurer de clé. La clé personnelle reste prioritaire. Le partage peut être retiré, et la clé est alors effacée chez les autres participants.
- Une nouvelle liste créée par la personne qui partage sa clé reprend ce partage.

### Security
- La clé partagée est accessible à toute personne disposant du lien de la liste : partage désactivé par défaut, avertissement affiché, et restriction de la clé par domaine recommandée.

## [0.1.0] - 2026-11-14

### Added
- Web app statique déployable sur GitHub Pages (HTML/CSS/JS en modules ES, sans build).
- Gestion des rayons : création, modification, suppression, réordonnancement, description des produits contenus, 12 rayons types prêts à l'emploi.
- Liste de courses groupée par rayon, ajout manuel (plusieurs produits séparés par des virgules), édition et suppression de produits, déduplication à l'ajout.
- Cochage : le produit passe dans un panier repliable, avec possibilité d'annuler ou de remettre dans la liste.
- Synchronisation temps réel WebRTC via PeerJS : topologie en étoile avec hôte élu automatiquement, reprise par un autre pair si l'hôte part, fusion Last-Write-Wins avec pierres tombales, heartbeat et reconnexion au retour au premier plan.
- Notification « [Prénom] a pris : [Produit] » chez tous les participants quand un produit est coché (pas de notification à l'ajout).
- Dictée vocale Gemini : enregistrement micro, conversion WAV 16 kHz, extraction des produits et classement par rayon via sortie JSON structurée (`enum` des rayons existants).
- Mode « Auto (IA) » pour classer un texte saisi en vrac.
- Partage par lien, QR code ou code à 8 caractères ; liste des participants connectés.
- Plusieurs listes par appareil (« Mes listes »), création d'une nouvelle liste avec copie des rayons.
- Paramètres locaux : prénom, clé API Gemini (jamais partagée), modèle (`gemini-flash-lite-latest` par défaut).
- PWA installable, utilisable hors-ligne (service worker réseau d'abord), thème clair/sombre automatique.
