// Synchronisation temps réel en WebRTC via PeerJS, topologie en étoile avec hôte élu.
//
// Il n'y a pas de "propriétaire" de la liste : chaque appareil garde l'état complet.
// L'hôte est simplement le premier pair qui réussit à réserver l'identifiant PeerJS de la liste
// (`grossery-helper-v1-<code>`) auprès du serveur de signalisation public. Les autres s'y connectent.
//
//   1. On tente de réserver l'id de la liste → succès : on devient hôte.
//   2. Id déjà pris → on se connecte à l'hôte en tant que client.
//   3. L'hôte disparaît → les clients recommencent en 1 (avec un délai aléatoire) :
//      l'un d'eux devient le nouvel hôte, les autres le rejoignent.
//
// À la connexion, synchro par différence : le client envoie un résumé [id, date, auteur] de son
// état, l'hôte renvoie seulement les enregistrements qui manquent au client et demande ceux qui
// lui manquent (modifications faites hors-ligne). Ensuite seules les modifications circulent ;
// l'hôte relaie celles d'un client vers tous les autres. La fusion est LWW par enregistrement.
//
// Robustesse :
// - sérialisation 'binary' : PeerJS découpe les gros messages (l'état complet dépasse vite 16 Ko,
//   limite stricte de la sérialisation 'json') ;
// - attente exponentielle entre les tentatives pour ne pas se faire limiter (HTTP 429) par le
//   serveur public de signalisation ;
// - l'hôte vérifie régulièrement qu'il est joignable (sonde) et se ré-enregistre sinon ;
// - la cause du dernier échec est conservée (`lastError`) et affichée dans l'interface.

import { COLLECTIONS } from './store.js';

const PREFIX = 'grossery-helper-v1-';
const PING_MS = 4000;
const TIMEOUT_MS = 13000;
const CONNECT_TIMEOUT_MS = 12000;
const PROBE_EVERY_MS = 5 * 60000; // sonde peu fréquente : le serveur public limite les connexions
const PROBE_MIN_GAP_MS = 30000;
const PROBE_TIMEOUT_MS = 10000;
const MAX_BACKOFF_MS = 30000;
const SIGNALING_ERRORS = new Set(['network', 'socket-error', 'socket-closed', 'server-error', 'disconnected']);

// Serveur de mise en relation : public (0.peerjs.com) par défaut, ou serveur de test choisi
// avec ?signal=http://localhost:9000 (mémorisé dans le navigateur, ?signal=default pour revenir).
const SIGNAL_KEY = 'grossery:signal';

export function getSignalServer() {
  try { return localStorage.getItem(SIGNAL_KEY) || null; } catch { return null; }
}

/** @param {string|null} value URL du serveur, ou 'default' / null pour le serveur public. */
export function setSignalServer(value) {
  try {
    if (!value || value === 'default') { localStorage.removeItem(SIGNAL_KEY); return null; }
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol)) return getSignalServer();
    localStorage.setItem(SIGNAL_KEY, u.origin + u.pathname);
    return u.origin + u.pathname;
  } catch { return getSignalServer(); }
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * URL effective du serveur de test. « localhost » y désigne la machine qui sert la page :
 * sur un téléphone ouvert sur http://192.168.1.6:8000, il devient 192.168.1.6.
 */
export function effectiveSignalServer() {
  const s = getSignalServer();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (LOCAL_HOSTS.includes(u.hostname) && !LOCAL_HOSTS.includes(location.hostname)) u.hostname = location.hostname;
    return u.origin + u.pathname;
  } catch { return null; }
}

function peerOptions() {
  const s = effectiveSignalServer();
  if (!s) return PEER_OPTIONS;
  const u = new URL(s);
  const secure = u.protocol === 'https:';
  return { ...PEER_OPTIONS, host: u.hostname, port: Number(u.port) || (secure ? 443 : 80), path: u.pathname || '/', secure, key: 'peerjs' };
}

// STUN de Google + relais TURN publics de PeerJS, en UDP et en TCP (le TCP passe mieux
// les pare-feu et réseaux restrictifs ; s'il n'est pas disponible, il est simplement ignoré).
const PEER_OPTIONS = {
  debug: 0,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: [
          'turn:eu-0.turn.peerjs.com:3478',
          'turn:us-0.turn.peerjs.com:3478',
          'turn:eu-0.turn.peerjs.com:3478?transport=tcp',
          'turn:us-0.turn.peerjs.com:3478?transport=tcp',
        ],
        username: 'peerjs',
        credential: 'peerjsp',
      },
    ],
  },
};

const ERROR_MESSAGES = {
  signaling: 'Serveur de mise en relation PeerJS injoignable ou saturé.',
  'no-peerjs': 'Bibliothèque PeerJS non chargée (pas de connexion internet ?).',
  'host-silent': 'Le relais ne répond pas : il est peut-être en veille ou déconnecté du serveur.',
  ice: 'Connexion directe impossible : le réseau ou le navigateur bloque WebRTC.',
  closed: 'Connexion avec le relais perdue.',
  timeout: 'Le relais ne donne plus signe de vie.',
  'host-deaf': "Ce relais n'était plus joignable : ré-enregistrement.",
  webrtc: 'Erreur WebRTC du navigateur.',
};

const isEmpty = (c) => !c || !COLLECTIONS.some((k) => c[k]?.length);
const count = (c) => COLLECTIONS.reduce((n, k) => n + (Array.isArray(c?.[k]) ? c[k].length : 0), 0);
const cleanName = (n) => String(n || '').slice(0, 60) || '…';
const log = (...args) => console.info('[sync]', ...args);

export class Sync extends EventTarget {
  /**
   * @param {import('./store.js').Store} store
   * @param {() => {userId: string, name: string}} getUser
   */
  constructor(store, getUser) {
    super();
    this.store = store;
    this.getUser = getUser;
    this.room = null;
    this.stopped = true;
    this.peer = null;
    this.role = null; // 'host' | 'client' | null
    this.status = 'offline'; // 'offline' | 'connecting' | 'online'
    this.hostConn = null;
    this.clients = new Map(); // peerId -> { conn, name, userId, lastSeen }
    this.members = []; // [{ id, userId, name, host }]
    this.lastSeen = 0;
    this.failures = 0; // échecs consécutifs (pour l'attente exponentielle)
    this.lastError = null; // { code, message, detail, at }
    this._probe = null;
    this._lastProbe = 0;

    this._onStoreChange = (e) => {
      if (e.detail.source === 'local') this._broadcastOps(e.detail.changes);
    };
    this._onWake = () => {
      if (this.stopped || document.visibilityState !== 'visible') return;
      if (this.status !== 'online') this._connect();
      else {
        this._heartbeat();
        if (this.role === 'host' && Date.now() - this._lastProbe > PROBE_MIN_GAP_MS) this._probeSelf();
      }
    };
  }

  get hostId() { return PREFIX + this.room; }
  get selfId() { return this.peer?.id || null; }

  start(room) {
    this.room = room;
    this.stopped = false;
    this.store.addEventListener('change', this._onStoreChange);
    document.addEventListener('visibilitychange', this._onWake);
    window.addEventListener('online', this._onWake);
    this._hb = setInterval(() => this._heartbeat(), PING_MS);
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this._hb);
    this.store.removeEventListener('change', this._onStoreChange);
    document.removeEventListener('visibilitychange', this._onWake);
    window.removeEventListener('online', this._onWake);
    this._teardown();
    this._setStatus('offline');
  }

  /** Reconnexion complète (ex. changement de prénom). */
  restart() {
    if (!this.stopped) this._connect();
  }

  // ---------- Diagnostic ----------

  _fail(code, detail = '') {
    this.lastError = { code, message: ERROR_MESSAGES[code] || code, detail, at: Date.now() };
    console.warn('[sync]', this.lastError.message, detail);
  }

  _online() {
    this.failures = 0;
    this.lastError = null;
    this._setStatus('online');
  }

  // ---------- Cycle de vie de la connexion ----------

  _teardown() {
    clearTimeout(this._retryTimer);
    clearTimeout(this._connTimer);
    this._endProbe();
    const { peer, hostConn, clients } = this;
    this.peer = null;
    this.hostConn = null;
    this.clients = new Map();
    this.role = null;
    this.members = [];
    for (const c of clients.values()) try { c.conn.close(); } catch { /* ignore */ }
    try { hostConn?.close(); } catch { /* ignore */ }
    try { peer?.destroy(); } catch { /* ignore */ }
  }

  /** Nouvelle tentative après un délai croissant (1 s, 2 s, 4 s… 30 s max, avec aléa). */
  _retry({ fast = false } = {}) {
    if (this.stopped) return;
    this._teardown();
    const base = fast ? 300 : 1000;
    const delay = Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(this.failures, 6)) * (0.6 + Math.random() * 0.8);
    this.failures++;
    this._setStatus('connecting');
    this._retryTimer = setTimeout(() => this._connect(), delay);
  }

  _connect() {
    if (this.stopped) return;
    this._teardown();
    if (typeof window.Peer !== 'function') {
      this._fail('no-peerjs');
      this._setStatus('offline');
      this._retryTimer = setTimeout(() => this._connect(), 10000);
      return;
    }
    this._setStatus('connecting');
    const peer = new window.Peer(this.hostId, peerOptions());
    this.peer = peer;
    peer.on('open', () => {
      if (this.peer === peer) this._becomeHost(peer);
    });
    peer.on('error', (err) => {
      if (this.peer !== peer) return;
      if (err.type === 'unavailable-id') {
        if (this.role === 'host') { // quelqu'un a repris l'hôte pendant une coupure : on redevient client
          log("l'identifiant de la liste a été repris par un autre appareil");
          this._retry({ fast: true });
        } else {
          this._joinAsClient();
        }
        return;
      }
      if (SIGNALING_ERRORS.has(err.type) && this._hasLinks()) return; // les canaux WebRTC tiennent encore
      this._fail(SIGNALING_ERRORS.has(err.type) ? 'signaling' : 'webrtc', err.type);
      this._retry();
    });
    peer.on('disconnected', () => {
      if (this.peer === peer && !this._hasLinks()) {
        this._fail('signaling', 'disconnected');
        this._retry();
      }
    });
  }

  _hasLinks() {
    return this.role === 'host' ? this.clients.size > 0 : !!this.hostConn?.open;
  }

  // ---------- Rôle hôte ----------

  _becomeHost(peer) {
    this.role = 'host';
    this._lastProbe = Date.now();
    log('relais de la liste (hôte)');
    peer.on('connection', (conn) => this._acceptClient(peer, conn));
    this._updatePresence();
    this._online();
  }

  _acceptClient(peer, conn) {
    if (this.peer !== peer) { try { conn.close(); } catch { /* ignore */ } return; }
    if (conn.metadata?.probe) { // sonde envoyée par nous-mêmes : on est bien joignable
      this._probe?.finish(true);
      try { conn.close(); } catch { /* ignore */ }
      return;
    }
    const client = { conn, name: cleanName(conn.metadata?.name), userId: null, lastSeen: Date.now() };
    conn.on('open', () => {
      if (this.peer !== peer) return;
      this.clients.set(conn.peer, client);
      log(`${client.name} connecté`);
      this._updatePresence();
    });
    conn.on('data', (msg) => {
      if (this.clients.get(conn.peer) !== client) return;
      client.lastSeen = Date.now();
      this._onHostData(client, msg);
    });
    const drop = (err) => {
      if (err?.type === 'message-too-big') { console.warn('[sync] message trop volumineux', err); return; }
      if (this.clients.get(conn.peer) === client) {
        this.clients.delete(conn.peer);
        log(`${client.name} déconnecté${err?.type ? ` (${err.type})` : ''}`);
        this._updatePresence();
      }
    };
    conn.on('close', () => drop());
    conn.on('error', drop);
  }

  _onHostData(client, msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'hello': {
        client.name = cleanName(msg.user?.name);
        client.userId = String(msg.user?.id || '').slice(0, 64);
        if (msg.digest) {
          // Synchro par différence : on n'envoie que ce qui manque au client, on demande ce qui nous manque.
          const { send, want } = this.store.diff(msg.digest);
          this._send(client.conn, { type: 'sync', records: send, want });
          log(`synchro avec ${client.name} : ${count(send)} envoyé(s), ${count(want)} demandé(s)`);
        } else {
          // Client d'une version antérieure : échange de l'état complet.
          const { changes } = this.store.merge(msg.state, { silent: true });
          this._send(client.conn, { type: 'state', state: this.store.snapshot() });
          this._relay({ type: 'ops', changes, silent: true }, client);
        }
        this._updatePresence();
        break;
      }
      case 'ops': {
        const silent = !!msg.silent;
        const { changes } = this.store.merge(msg.changes, { silent });
        this._relay({ type: 'ops', changes, silent }, client);
        break;
      }
      // 'ping' : seule la mise à jour de lastSeen compte.
    }
  }

  _relay(msg, except) {
    if (isEmpty(msg.changes)) return;
    for (const c of this.clients.values()) if (c !== except) this._send(c.conn, msg);
  }

  _updatePresence() {
    if (this.role !== 'host') return;
    this.members = [
      { id: this.selfId, userId: this.getUser().userId, name: cleanName(this.getUser().name), host: true },
      ...[...this.clients.entries()].map(([id, c]) => ({ id, userId: c.userId, name: c.name, host: false })),
    ];
    for (const c of this.clients.values()) this._send(c.conn, { type: 'presence', members: this.members });
    this._setStatus(this.status);
  }

  /**
   * Vérifie que le relais est réellement joignable : un pair temporaire tente de s'y connecter.
   * Si la demande n'arrive jamais alors que le serveur répond, le relais est "sourd"
   * (connexion au serveur morte sans que le navigateur s'en aperçoive) : on se ré-enregistre.
   */
  _probeSelf() {
    if (this.role !== 'host' || this._probe || typeof window.Peer !== 'function') return;
    const host = this.peer;
    this._lastProbe = Date.now();
    const probePeer = new window.Peer(peerOptions());
    let opened = false;
    const probe = {
      finish: (reachable) => {
        if (this._probe !== probe) return;
        this._endProbe();
        if (!reachable && this.peer === host && this.role === 'host') {
          this._fail('host-deaf');
          this._retry({ fast: true });
        }
      },
      destroy: () => {
        clearTimeout(probe.timer);
        try { probePeer.destroy(); } catch { /* ignore */ }
      },
    };
    this._probe = probe;
    // Sans ouverture de la sonde (serveur injoignable), on ne conclut rien.
    probe.timer = setTimeout(() => probe.finish(!opened), PROBE_TIMEOUT_MS);
    probePeer.on('open', () => {
      opened = true;
      probePeer.connect(this.hostId, { metadata: { probe: true }, serialization: 'binary' });
    });
    probePeer.on('error', (err) => probe.finish(err.type !== 'peer-unavailable'));
  }

  _endProbe() {
    this._probe?.destroy();
    this._probe = null;
  }

  // ---------- Rôle client ----------

  _joinAsClient() {
    // Détacher AVANT de détruire : destroy() émet 'disconnected' de façon synchrone et
    // le gestionnaire déclencherait sinon une reconnexion qui casserait la nouvelle connexion.
    const claimPeer = this.peer;
    this.peer = null;
    try { claimPeer?.destroy(); } catch { /* ignore */ }
    const peer = new window.Peer(peerOptions());
    this.peer = peer;

    peer.on('open', () => {
      if (this.peer !== peer) return;
      const conn = peer.connect(this.hostId, {
        reliable: true,
        serialization: 'binary',
        metadata: { name: this.getUser().name },
      });
      this.hostConn = conn;
      this._connTimer = setTimeout(() => {
        if (this.hostConn !== conn || conn.open) return;
        const pc = conn.peerConnection;
        if (!pc || pc.signalingState === 'have-local-offer') this._fail('host-silent');
        else this._fail('ice', `état ICE : ${pc.iceConnectionState}`);
        this._retry();
      }, CONNECT_TIMEOUT_MS);

      conn.on('open', () => {
        if (this.hostConn !== conn) return;
        clearTimeout(this._connTimer);
        this.role = 'client';
        this.lastSeen = Date.now();
        log('connecté au relais');
        this._online();
        const u = this.getUser();
        this._send(conn, { type: 'hello', user: { id: u.userId, name: u.name }, digest: this.store.digest() });
      });
      conn.on('data', (msg) => {
        if (this.hostConn !== conn) return;
        this.lastSeen = Date.now();
        this._onClientData(msg);
      });
      conn.on('close', () => {
        if (this.hostConn !== conn) return;
        this._fail('closed');
        this._retry({ fast: true }); // le relais est peut-être parti : réélection rapide
      });
      conn.on('error', (err) => {
        if (this.hostConn !== conn) return;
        if (err?.type === 'message-too-big') { console.warn('[sync] message trop volumineux', err); return; }
        this._fail(err?.type === 'negotiation-failed' ? 'ice' : 'closed', err?.type || '');
        this._retry();
      });
    });

    peer.on('error', (err) => {
      if (this.peer !== peer) return;
      // L'hôte n'existe plus : on retente vite pour que quelqu'un reprenne le rôle.
      if (err.type === 'peer-unavailable') {
        log('relais introuvable : nouvelle élection');
        this._retry({ fast: true });
        return;
      }
      if (SIGNALING_ERRORS.has(err.type) && this._hasLinks()) return;
      this._fail(SIGNALING_ERRORS.has(err.type) ? 'signaling' : 'webrtc', err.type);
      this._retry();
    });
    peer.on('disconnected', () => {
      if (this.peer === peer && !this._hasLinks()) {
        this._fail('signaling', 'disconnected');
        this._retry();
      }
    });
  }

  _onClientData(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'sync': {
        this.store.merge(msg.records, { silent: true });
        const mine = this.store.pick(msg.want);
        if (!isEmpty(mine)) this._send(this.hostConn, { type: 'ops', changes: mine, silent: true });
        log(`synchro : ${count(msg.records)} reçu(s), ${count(mine)} envoyé(s)`);
        break;
      }
      case 'state': // relais d'une version antérieure : il attend aussi notre état complet
        this.store.merge(msg.state, { silent: true });
        this._send(this.hostConn, { type: 'ops', changes: this.store.snapshot(), silent: true });
        break;
      case 'ops':
        this.store.merge(msg.changes, { silent: !!msg.silent });
        break;
      case 'presence':
        if (Array.isArray(msg.members)) {
          this.members = msg.members.slice(0, 50).map((m) => ({
            id: String(m.id || ''), userId: String(m.userId || '').slice(0, 64), name: cleanName(m.name), host: !!m.host,
          }));
          this._setStatus(this.status);
        }
        break;
    }
  }

  // ---------- Envoi & battement de cœur ----------

  _broadcastOps(changes) {
    if (isEmpty(changes)) return;
    const msg = { type: 'ops', changes };
    if (this.role === 'host') this._relay(msg, null);
    else if (this.role === 'client' && this.hostConn?.open) this._send(this.hostConn, msg);
    // Hors-ligne : rien à faire, l'échange d'état complet à la reconnexion rattrapera.
  }

  _send(conn, msg) {
    try { if (conn?.open) conn.send(msg); } catch (e) { console.warn('[sync] envoi impossible', e); }
  }

  _heartbeat() {
    if (this.stopped || !this.peer) return;
    const now = Date.now();
    // Signalisation perdue mais canaux WebRTC vivants : on tente de se ré-enregistrer.
    if (this.peer.disconnected && !this.peer.destroyed && now - (this._lastReconnect || 0) > 8000) {
      this._lastReconnect = now;
      try { this.peer.reconnect(); } catch { /* ignore */ }
    }
    if (this.role === 'host') {
      let changed = false;
      for (const [id, c] of this.clients) {
        if (now - c.lastSeen > TIMEOUT_MS) {
          try { c.conn.close(); } catch { /* ignore */ }
          this.clients.delete(id);
          changed = true;
        } else {
          this._send(c.conn, { type: 'ping' });
        }
      }
      if (changed) this._updatePresence();
      if (now - this._lastProbe > PROBE_EVERY_MS) this._probeSelf();
    } else if (this.role === 'client') {
      if (now - this.lastSeen > TIMEOUT_MS) {
        this._fail('timeout');
        this._retry({ fast: true });
      } else {
        this._send(this.hostConn, { type: 'ping' });
      }
    }
  }

  _setStatus(status) {
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, members: this.members, role: this.role } }));
  }
}
