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

## Utilisation

1. **Prénom** demandé à la première ouverture : il apparaît dans les notifications des autres.
2. **Rayons** : bouton « Rayons types » pour démarrer avec 12 rayons, puis ajuster nom, description et ordre (flèches) selon ton magasin.
3. **Ajout manuel** : champ en haut de la liste. Plusieurs produits d'un coup en les séparant par des virgules. Le choix **✨ Auto (IA)** fait classer le texte par Gemini.
4. **Dictée** : bouton micro, dicter « des bananes, du lait, 3 avocats et du liquide vaisselle », puis *Terminé*. Les produits déjà présents ne sont pas dupliqués, ceux du panier sont remis dans la liste. Un bouton *Annuler* permet de retirer l'ajout.
5. **Cocher** : toucher un produit le passe dans « Dans le panier » (repliable en bas, toucher pour le remettre dans la liste).
6. **Partager** : icône de partage ou pastille d'état. Lien, QR code ou code à 8 caractères. Le panneau liste les personnes connectées.
7. **Clé Gemini** : *Paramètres*, clé gratuite sur <https://aistudio.google.com/apikey>. Elle reste dans le `localStorage` de l'appareil et n'est jamais envoyée aux autres participants. Chacun peut dicter avec sa propre clé ; sans clé, tout fonctionne sauf la dictée.

## Architecture

```
index.html            Structure + dialogues
css/style.css         Styles mobile-first, thème clair/sombre automatique
js/app.js             Interface, rendu, liaison des modules
js/store.js           État, persistance localStorage, fusion LWW
js/sync.js            WebRTC (PeerJS), élection d'hôte, relais, heartbeat
js/gemini.js          Appel REST Gemini, sortie JSON structurée
js/audio.js           Enregistrement micro, conversion WAV 16 kHz mono
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
- À la connexion, client et hôte échangent leur état complet et le fusionnent. Ensuite seules les modifications circulent, et l'hôte relaie celles d'un client vers tous les autres.
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
- **Dépendance au serveur public PeerJS** pour la mise en relation. S'il est indisponible, l'app reste utilisable en local et se synchronise plus tard. Pour plus de fiabilité, on peut héberger son propre `peerjs-server` et passer `{ host, port, path }` à `new Peer()` dans `js/sync.js`.
- **iOS** : un onglet Safari en arrière-plan perd sa connexion. L'app se reconnecte au retour au premier plan et la fusion rattrape les modifications.
- Ajouts concurrents du **même produit** par deux personnes au même instant : les deux entrées peuvent coexister (ids différents). Il suffit d'en supprimer une.
