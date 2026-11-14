# Liste de courses partagée

Une web app 100 % statique (déployable sur GitHub Pages) pour :

- organiser la liste de courses **par rayon**, chaque rayon décrivant les produits qu'il contient ;
- ajouter des produits à la main ou **en masse à la voix** grâce à Gemini, qui les classe dans le bon rayon ;
- partager la liste **en temps réel en WebRTC** avec n personnes : chacun peut ajouter et cocher. Les ajouts apparaissent sans notification ; un produit coché passe dans le panier et tout le monde reçoit une notification « Marie a pris : Lait ».

Pas de serveur, pas de compte, pas d'étape de build.

## Déploiement sur GitHub Pages

1. Pousser le dépôt sur GitHub.
2. *Settings → Pages → Build and deployment* : source **Deploy from a branch**, branche `main`, dossier `/ (root)`.
3. Ouvrir `https://<utilisateur>.github.io/<dépôt>/`.

HTTPS est obligatoire pour le micro : GitHub Pages le fournit. En local, `localhost` suffit :

```bash
python3 -m http.server 8000   # puis http://localhost:8000
```

### Tests en local sans le serveur public

Le serveur public PeerJS bloque temporairement (HTTP 429) une adresse IP qui ouvre trop de connexions, ce qui arrive vite en testant. Pour tester avec plusieurs navigateurs, lancer un serveur de mise en relation local :

```bash
npm run signaling              # serveur PeerJS local sur le port 9000
python3 -m http.server 8000    # dans un autre terminal
```

Ouvrir `http://localhost:8000/?signal=http://localhost:9000` : le choix est mémorisé par le navigateur et transmis dans le lien de partage. `?signal=default` revient au serveur public. Le panneau de partage indique quand un serveur de test est utilisé.

**Avec un téléphone sur le même réseau Wi-Fi** :
1. Sur l'ordinateur, ouvrir l'app avec son adresse IP et non `localhost`, par exemple `http://192.168.1.20:8000/?signal=http://localhost:9000`. Sinon, le lien de partage pointe vers `localhost`, qui sur le téléphone désigne le téléphone lui-même.
2. Scanner le QR code du panneau de partage. Dans `signal`, `localhost` est automatiquement remplacé par l'adresse de la page.
3. Les ports 8000 et 9000 doivent être accessibles depuis le réseau local (pare-feu). Vérification : `http://<ip>:9000/` doit afficher « PeerJS Server » dans le navigateur du téléphone.
4. **WSL2 en mode réseau `mirrored`** : Windows ne peut pas joindre les serveurs lancés dans WSL par sa propre adresse IP (`http://192.168.1.x:8000` dépasse le délai d'attente sur le PC), alors que les autres appareils du réseau, eux, y accèdent. Deux solutions :
   - garder `localhost` sur le PC, ouvrir `http://<ip>:8000/?signal=http://localhost:9000` sur le téléphone, puis rejoindre la liste avec son code (« Rejoindre une autre liste ») ; le QR code du PC, qui pointe vers `localhost`, est alors inutilisable ;
   - ou ajouter `hostAddressLoopback=true` dans la section `[experimental]` de `%UserProfile%\.wslconfig`, puis exécuter `wsl --shutdown`. Ça arrête tous les processus WSL, serveurs compris, qu'il faut ensuite relancer. Le PC peut alors utiliser l'adresse IP et son QR code fonctionne.
5. Le micro exige HTTPS : en `http://<ip>`, la dictée est indisponible sur le téléphone. Pour la tester, utiliser la version GitHub Pages, ou, dans Chrome Android, `chrome://flags/#unsafely-treat-insecure-origin-as-secure` avec `http://<ip>:8000`.

## Utilisation

1. **Prénom** demandé à la première ouverture : il apparaît dans les notifications des autres.
2. **Nom de la liste** : « Liste du <date> » par défaut. Toucher le nom affiché en haut de l'écran « Courses » pour le changer. Il est partagé avec tous les participants, qui sont prévenus du renommage.
3. **Rayons** : bouton « Rayons types » pour démarrer avec 12 rayons, puis ajuster nom, description et ordre (flèches) selon ton magasin.
4. **Ajout manuel** : champ en haut de la liste. Plusieurs produits d'un coup en les séparant par des virgules. Le choix **✨ Auto (IA)** fait classer le texte par Gemini.
5. **Dictée** : bouton micro, dicter « des bananes, du lait, 3 avocats et du liquide vaisselle », puis *Terminé*. Les produits déjà présents ne sont pas dupliqués, ceux du panier sont remis dans la liste. Un bouton *Annuler* permet de retirer l'ajout.
6. **Prévenir les autres de ses ajouts** (optionnel) : dans les paramètres, une case pour la dictée et une pour l'ajout manuel. Les autres reçoivent alors « Bob a dicté : … » ou « Bob a ajouté : … ».
7. **Cocher** : toucher un produit le passe dans « Dans le panier » (repliable en bas, toucher pour le remettre dans la liste).
8. **Partager** : icône de partage ou pastille d'état. Lien, QR code ou code à 8 caractères. Le panneau liste les personnes connectées.
9. **Avatar** : bouton en haut à droite (*Profil & paramètres*). Photo, emoji ou initiales. Il apparaît chez les autres sur les produits que tu ajoutes ou coches et dans les notifications.
10. **Apparence** : dans *Profil & paramètres*, une couleur parmi 23 et l'interrupteur « Mode sombre » (par défaut, celui du système). Réglage propre à l'appareil.
11. **Clé Gemini** : *Paramètres*, clé gratuite sur <https://aistudio.google.com/apikey>. Elle est stockée dans le `localStorage` de l'appareil. Sans clé, tout fonctionne sauf la dictée et « Auto (IA) ».
   - **Une seule clé pour tous** : cocher « Partager ma clé dans toutes mes listes ». Le réglage vaut pour l'appareil : la clé est publiée dans chaque liste que tu ouvres ou crées, et les autres participants peuvent y dicter sans rien configurer. Ils ne la gardent pas pour leurs autres listes : elle n'est disponible que dans les listes où tu es présent. Une clé personnelle saisie sur un appareil reste prioritaire.
   - **Clés reçues** : la liste des clés partagées par d'autres dans tes listes, avec qui, depuis quand et les 4 derniers caractères de la clé.
   - Décocher retire le partage : la clé est effacée tout de suite chez les participants de la liste ouverte, et dans tes autres listes dès que tu les ouvres.
   - « Retirer cette liste de l'appareil » retire aussi ta clé de cette liste pour tous, à condition d'être connecté. Hors connexion, un avertissement le signale.
   - Quelqu'un a pu copier la clé entre-temps : pour une révocation certaine, il faut la régénérer dans AI Studio.
   - **Recommandé** : dans Google Cloud Console (*API et services → Identifiants*), restreindre la clé aux référents HTTP de ton site (`https://<utilisateur>.github.io/*`), pour qu'elle soit inutilisable ailleurs.

## Architecture

```
index.html            Structure + dialogues
css/style.css         Styles mobile-first, thème clair/sombre automatique
js/app.js             Interface, rendu, liaison des modules
js/store.js           État, persistance localStorage, fusion LWW
js/sync.js            WebRTC (PeerJS), élection d'hôte, relais, heartbeat
js/gemini.js          Appel REST Gemini, sortie JSON structurée
js/audio.js           Enregistrement micro, conversion WAV 16 kHz mono
js/avatar.js          Avatars : rendu, recadrage photo
js/theme.js           Couleurs du thème et mode sombre (appliqués avant le premier affichage)
js/version.js         Numéro et date de publication de la version
js/presets.js         Rayons types
js/icons.js           Icônes SVG inline
sw.js, manifest       PWA : installable, utilisable hors-ligne
```

Dépendances (CDN, versions figées) : `peerjs@1.5.4` et `qrcode-generator@1.4.4`. Le CSS est écrit à la main : pas de Tailwind, pour éviter le CDN de développement de Tailwind et garder l'app légère.

### Données & fusion

Chaque rayon et chaque produit est un enregistrement indépendant avec `updatedAt` et `by`. Une suppression est une « pierre tombale » (`deleted: true`), purgée après 30 jours. Deux états se fusionnent enregistrement par enregistrement : la version la plus récente gagne (*Last-Write-Wins*). La fusion est commutative et idempotente, donc on peut ré-échanger des états complets sans risque. Les modifications faites hors-ligne se propagent ainsi à la reconnexion. `updatedAt` est une horloge hybride (`max(maintenant, dernière valeur vue + 1)`), ce qui atténue les écarts d'heure entre téléphones.

Les données d'une liste sont stockées sous `grossery:list:<code>`, les paramètres de l'appareil sous `grossery:settings`.

### Synchronisation WebRTC (étoile avec hôte élu)

- La liste `abcd1234` correspond à l'identifiant PeerJS `grossery-helper-v1-abcd1234`.
- Au démarrage, chaque appareil tente de **réserver** cet identifiant sur le serveur de signalisation public de PeerJS. S'il réussit, il devient **hôte** (relais) ; sinon il s'y connecte comme **client**.
- À la connexion, **synchronisation par différence** : le client envoie un résumé `[id, date, auteur]` de chaque enregistrement. L'hôte lui renvoie seulement ce qui lui manque ou qui est plus récent, et lui demande en retour ses modifications faites hors-ligne. Ensuite seules les modifications circulent, et l'hôte relaie celles d'un client vers tous les autres.
- **Personne n'est indispensable** : si l'hôte part (onglet fermé, téléphone en veille), les clients le détectent (événement `close` ou absence de ping pendant 13 s) et recommencent l'élection. L'un d'eux devient hôte, les autres le rejoignent, sans perte de données puisque tout le monde a l'état complet.
- Au retour au premier plan (`visibilitychange`) ou au retour du réseau (`online`), l'app se reconnecte immédiatement.

La signalisation passe par le serveur public `0.peerjs.com`. Les données passent ensuite en pair-à-pair, ou via le relais TURN public de PeerJS si les réseaux l'imposent.

### Gemini

`POST …/v1beta/models/{modèle}:generateContent` avec :

- l'audio (WAV 16 kHz mono) ou le texte ;
- la liste des rayons `{id, nom, contenu}` ;
- un `responseSchema` qui impose `{ items: [{ name, aisleId }] }`, où `aisleId` est restreint par `enum` aux identifiants de rayons existants plus `"unclassified"`.

Le modèle se règle dans les paramètres. Par défaut, c'est l'alias `gemini-flash-lite-latest`, qui suit le dernier modèle Flash-Lite (rapide et économique, suffisant pour cette tâche).

## Limites connues

- **Sécurité** : quiconque connaît le code (8 caractères aléatoires, environ 850 milliards de combinaisons) peut rejoindre la liste. Les échanges WebRTC sont chiffrés (DTLS), mais il n'y a pas d'authentification. C'est suffisant pour une liste de courses, pas pour des données sensibles.
- **Clé Gemini partagée** : elle est accessible (outils développeur) à toute personne ayant le lien d'une liste où elle est partagée. Après un retrait du partage, une liste où tu ne retournes pas garde la clé. Avec une clé gratuite, le risque se limite à l'épuisement du quota. Avec la facturation activée, restreindre la clé par domaine et fixer un plafond de dépenses.
- **Dépendance au serveur public PeerJS** pour la mise en relation. Il limite le nombre de connexions par adresse IP : trop de tentatives rapprochées (plusieurs onglets bloqués, tests automatisés) déclenchent un blocage temporaire (HTTP 429), et les appareils restent alors sur « Problème de connexion » quelques minutes. S'il est indisponible, l'app reste utilisable en local et se synchronise plus tard. Pour plus de fiabilité, on peut héberger son propre `peerjs-server` et ajouter `host`, `port` et `path` dans `PEER_OPTIONS` (`js/sync.js`).
- **Versions mélangées** : un appareil qui n'a pas rechargé la page après une mise à jour peut ne pas relayer les nouveautés (ex. le nom de liste avec un relais antérieur à 0.8.0). Le panneau de partage signale ces participants, et recharger la page suffit. À partir de 0.8.0, les champs inconnus sont conservés et relayés.
- **iOS** : un onglet Safari en arrière-plan perd sa connexion. L'app se reconnecte au retour au premier plan et la fusion rattrape les modifications.
- Ajouts concurrents du **même produit** par deux personnes au même instant : les deux entrées peuvent coexister (ids différents). Il suffit d'en supprimer une.
