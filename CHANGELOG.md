# Changelog

Toutes les évolutions notables de ce projet sont documentées ici.

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/)
et le projet respecte le [versionnage sémantique](https://semver.org/lang/fr/).

## [0.9.0] - 2026-11-14

### Added
- Notification lors d'un renommage de liste : « Alice a renommé la liste : « Apéro samedi » ».

### Changed
- « Partager ma clé » devient un réglage global de l'appareil (« Partager ma clé dans toutes mes listes ») : la clé est publiée automatiquement dans chaque liste que l'on ouvre ou crée. Les autres participants ne l'ont que dans les listes où son propriétaire est présent. Si un autre participant partage déjà sa clé dans une liste, elle n'est pas écrasée. Les appareils qui partageaient leur clé dans au moins une liste gardent le partage activé.
- Décocher le partage révoque la clé dans la liste ouverte tout de suite, et dans les autres listes de l'appareil dès qu'on les ouvre.

### Security
- « Retirer cette liste de l'appareil » révoque d'abord la clé partagée qu'on y avait publiée, pour qu'elle ne reste pas chez les autres participants. Hors connexion, la confirmation prévient que la clé resterait utilisable.

## [0.8.0] - 2026-11-14

### Added
- Nom de liste, synchronisé entre participants : « Liste du 14 novembre 2026 » par défaut (date de création), modifiable en touchant le nom affiché discrètement en haut de l'écran « Courses ». Aussi visible dans l'onglet du navigateur et le panneau de partage.
- « Mes listes » affiche le nom de chaque liste avec son code et son nombre de produits.
- Chaque appareil annonce sa version (`js/version.js`) : le panneau de partage signale un participant resté sur une autre version (« ancienne version ») et lui demande de recharger la page.

### Fixed
- Rétrocompatibilité : les champs et réglages inconnus d'une version (ajoutés par une version plus récente) sont désormais conservés et relayés, s'ils sont de type simple et de taille bornée, au lieu d'être effacés. Un relais resté sur une version antérieure à 0.8.0 efface encore le nom de la liste : il faut recharger la page sur tous les appareils.

### Changed
- Le nom par défaut n'est écrit qu'à la création d'une liste, jamais en la rejoignant, pour ne pas écraser le nom choisi par les autres. Les listes créées avant cette version s'affichent « Liste <code> » jusqu'à ce qu'on les renomme.

## [0.7.1] - 2026-11-14

### Fixed
- Un téléphone du réseau local ouvrant un lien de partage avec `signal=http://localhost:9000` cherchait le serveur de test sur lui-même (« Problème de connexion »). `localhost` y désigne désormais la machine qui sert la page : ouvert sur `http://192.168.1.x:8000`, le téléphone utilise `192.168.1.x:9000`.

### Added
- Avertissement dans le panneau de partage quand l'app est ouverte sur `localhost` : le lien et le QR code ne fonctionnent alors que sur cet ordinateur.
- README : procédure de test sur téléphone du réseau local (adresse IP, pare-feu, HTTPS pour le micro) et contournement du mode réseau `mirrored` de WSL2 (`hostAddressLoopback`).

## [0.7.0] - 2026-11-14

### Added
- Option « Prévenir les autres quand j'ajoute des produits » dans les paramètres, avec une case pour la dictée vocale (« Bob a dicté : Bananes, Lait ») et une pour l'ajout manuel, y compris « Auto (IA) » et un produit remis depuis le panier par un nouvel ajout (« Bob a ajouté : Pain »). Désactivée par défaut.
- Ces notifications sont regroupées comme celles des coches (une ligne par personne et par action, mise à jour en place, transparentes aux clics). Remettre un produit depuis le panier en le décochant ne notifie pas.

## [0.6.0] - 2026-11-14

### Changed
- Synchronisation par différence à la connexion : le client envoie un résumé `[id, date, auteur]` de son état au lieu de l'état complet. Le relais ne renvoie que les enregistrements manquants ou plus récents (photos d'avatars comprises), et demande au client ses modifications faites hors-ligne. Une reconnexion sans changement (déverrouillage du téléphone) passe d'environ 130 Ko échangés à environ 13 Ko pour une liste de 300 produits.
- Compatibilité conservée avec un appareil resté sur une version antérieure, qui échange encore l'état complet.

## [0.5.0] - 2026-11-14

### Added
- Diagnostic de connexion dans le panneau de partage (« Le relais ne répond pas », « Connexion directe impossible… », « Serveur de mise en relation injoignable ou saturé »…), numéro de tentative, et journal `[sync]` dans la console du navigateur. La pastille indique « Problème de connexion » après 3 échecs.
- Le relais vérifie qu'il est réellement joignable (sonde toutes les 5 min et au retour au premier plan) et se ré-enregistre s'il ne l'est plus, au lieu de rester « En ligne » sans recevoir personne.
- Relais TURN en TCP en plus de l'UDP, pour les réseaux et navigateurs restrictifs.
- Serveur de mise en relation de test : `npm run signaling` lance un serveur PeerJS local (port 9000), activé dans l'app par `?signal=http://localhost:9000` (mémorisé, transmis dans le lien de partage, `?signal=default` pour revenir au serveur public). Évite les blocages 429 du serveur public pendant les tests.

### Changed
- Attente progressive entre les tentatives de connexion (1 s, 2 s, 4 s… jusqu'à 30 s) au lieu de réessayer toutes les 1 à 3 s, pour ne plus être bloqué (HTTP 429) par le serveur public PeerJS.

### Fixed
- Impossible de rejoindre une liste dès que son état dépassait 16 Ko (avatars photo, nombreux produits) : la sérialisation `json` de PeerJS refuse ces messages, ce qui provoquait une boucle de reconnexion infinie (« Connexion… » permanent, listes qui divergent). Passage à la sérialisation `binary`, qui découpe les gros messages.
- Une erreur d'envoi d'un message trop volumineux n'est plus traitée comme une coupure de connexion.

## [0.4.0] - 2026-11-14

### Changed
- Les coches des autres participants sont regroupées dans une seule notification mise à jour en place (« Bob a pris : Lait, Pain, Œufs +2 », une ligne par personne), qui disparaît 4 s après la dernière coche.
- Une seule notification d'information à la fois : une nouvelle remplace la précédente au lieu de s'empiler.

### Removed
- Notification « Produit → panier · Annuler » quand on coche soi-même : l'annulation se fait en touchant le produit dans « Dans le panier ».

### Fixed
- Cocher plusieurs produits d'affilée empilait des notifications qui masquaient la liste et interceptaient les clics, au point d'annuler une coche par erreur. Les notifications laissent désormais passer les clics, sauf sur leur éventuel bouton d'action.

## [0.3.0] - 2026-11-14

### Added
- Avatar personnel : photo (recadrée et compressée à 96 px), emoji ou initiales colorées par défaut, choisi dans « Profil & paramètres ».
- Avatars affichés dans l'en-tête (son propre avatar et les participants connectés dans la pastille d'état), sur les produits (« ajouté par »), dans le panier, dans la liste des participants et dans la notification « X a pris : Y ».
- Profils (prénom + avatar) synchronisés avec la liste : visibles même quand la personne n'est pas connectée.

### Changed
- Le bouton Paramètres affiche son avatar.
- La pastille d'état affiche les avatars et le nombre de connectés au lieu de « N connectés ».

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
