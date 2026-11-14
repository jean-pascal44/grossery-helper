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
// À la connexion, client et hôte s'échangent leur état complet et le fusionnent (LWW), ce qui
// propage aussi les modifications faites hors-ligne. Ensuite seules les modifications circulent ;
// l'hôte relaie celles d'un client vers tous les autres.

const PREFIX = 'grossery-helper-v1-';
const PING_MS = 4000;
const TIMEOUT_MS = 13000;
const CONNECT_TIMEOUT_MS = 10000;
const SIGNALING_ERRORS = new Set(['network', 'socket-error', 'socket-closed', 'server-error', 'disconnected']);

const isEmpty = (c) => !c || !['aisles', 'items', 'meta'].some((k) => c[k]?.length);
const cleanName = (n) => String(n || '').slice(0, 60) || '…';

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
    this.members = []; // [{ id, name, host }]
    this.lastSeen = 0;

    this._onStoreChange = (e) => {
      if (e.detail.source === 'local') this._broadcastOps(e.detail.changes);
    };
    this._onWake = () => {
      if (this.stopped || document.visibilityState !== 'visible') return;
      if (this.status !== 'online') this._connect();
      else this._heartbeat();
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

  // ---------- Cycle de vie de la connexion ----------

  _teardown() {
    clearTimeout(this._retryTimer);
    clearTimeout(this._connTimer);
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

  _retry(delay = 800 + Math.random() * 2200) {
    if (this.stopped) return;
    this._teardown();
    this._setStatus('connecting');
    this._retryTimer = setTimeout(() => this._connect(), delay);
  }

  _connect() {
    if (this.stopped) return;
    this._teardown();
    if (typeof window.Peer !== 'function') {
      // Script PeerJS non chargé (hors-ligne ?) : on réessaie plus tard.
      this._setStatus('offline');
      this._retryTimer = setTimeout(() => this._connect(), 10000);
      return;
    }
    this._setStatus('connecting');
    const peer = new window.Peer(this.hostId, { debug: 0 });
    this.peer = peer;
    peer.on('open', () => {
      if (this.peer === peer) this._becomeHost(peer);
    });
    peer.on('error', (err) => {
      if (this.peer !== peer) return;
      if (err.type === 'unavailable-id') {
        if (this.role === 'host') this._retry(300); // quelqu'un a repris l'hôte pendant une coupure : on redevient client
        else this._joinAsClient();
        return;
      }
      if (SIGNALING_ERRORS.has(err.type) && this._hasLinks()) return; // les canaux WebRTC tiennent encore
      this._retry();
    });
    peer.on('disconnected', () => {
      if (this.peer === peer && !this._hasLinks()) this._retry();
    });
  }

  _hasLinks() {
    return this.role === 'host' ? this.clients.size > 0 : !!this.hostConn?.open;
  }

  // ---------- Rôle hôte ----------

  _becomeHost(peer) {
    this.role = 'host';
    peer.on('connection', (conn) => this._acceptClient(peer, conn));
    this._updatePresence();
    this._setStatus('online');
  }

  _acceptClient(peer, conn) {
    if (this.peer !== peer) { try { conn.close(); } catch { /* ignore */ } return; }
    const client = { conn, name: cleanName(conn.metadata?.name), userId: null, lastSeen: Date.now() };
    conn.on('open', () => {
      if (this.peer !== peer) return;
      this.clients.set(conn.peer, client);
      this._updatePresence();
    });
    conn.on('data', (msg) => {
      if (this.clients.get(conn.peer) !== client) return;
      client.lastSeen = Date.now();
      this._onHostData(client, msg);
    });
    const drop = () => {
      if (this.clients.get(conn.peer) === client) {
        this.clients.delete(conn.peer);
        this._updatePresence();
      }
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  _onHostData(client, msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'hello': {
        client.name = cleanName(msg.user?.name);
        client.userId = String(msg.user?.id || '').slice(0, 64);
        const { changes } = this.store.merge(msg.state, { silent: true });
        this._send(client.conn, { type: 'state', state: this.store.snapshot() });
        this._relay({ type: 'ops', changes, silent: true }, client);
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
      { id: this.selfId, name: cleanName(this.getUser().name), host: true },
      ...[...this.clients.entries()].map(([id, c]) => ({ id, name: c.name, host: false })),
    ];
    for (const c of this.clients.values()) this._send(c.conn, { type: 'presence', members: this.members });
    this._setStatus(this.status);
  }

  // ---------- Rôle client ----------

  _joinAsClient() {
    // Détacher AVANT de détruire : destroy() émet 'disconnected' de façon synchrone et
    // le gestionnaire déclencherait sinon une reconnexion qui casserait la nouvelle connexion.
    const claimPeer = this.peer;
    this.peer = null;
    try { claimPeer?.destroy(); } catch { /* ignore */ }
    const peer = new window.Peer({ debug: 0 });
    this.peer = peer;

    peer.on('open', () => {
      if (this.peer !== peer) return;
      const conn = peer.connect(this.hostId, {
        reliable: true,
        serialization: 'json',
        metadata: { name: this.getUser().name },
      });
      this.hostConn = conn;
      this._connTimer = setTimeout(() => {
        if (this.hostConn === conn && !conn.open) this._retry();
      }, CONNECT_TIMEOUT_MS);

      conn.on('open', () => {
        if (this.hostConn !== conn) return;
        clearTimeout(this._connTimer);
        this.role = 'client';
        this.lastSeen = Date.now();
        const u = this.getUser();
        this._send(conn, { type: 'hello', user: { id: u.userId, name: u.name }, state: this.store.snapshot() });
        this._setStatus('online');
      });
      conn.on('data', (msg) => {
        if (this.hostConn !== conn) return;
        this.lastSeen = Date.now();
        this._onClientData(msg);
      });
      const lost = () => { if (this.hostConn === conn) this._retry(); };
      conn.on('close', lost);
      conn.on('error', lost);
    });

    peer.on('error', (err) => {
      if (this.peer !== peer) return;
      // L'hôte n'existe plus : on retente vite pour que quelqu'un reprenne le rôle.
      if (err.type === 'peer-unavailable') { this._retry(200 + Math.random() * 1000); return; }
      if (SIGNALING_ERRORS.has(err.type) && this._hasLinks()) return;
      this._retry();
    });
    peer.on('disconnected', () => {
      if (this.peer === peer && !this._hasLinks()) this._retry();
    });
  }

  _onClientData(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'state':
        this.store.merge(msg.state, { silent: true });
        break;
      case 'ops':
        this.store.merge(msg.changes, { silent: !!msg.silent });
        break;
      case 'presence':
        if (Array.isArray(msg.members)) {
          this.members = msg.members.slice(0, 50).map((m) => ({ id: String(m.id || ''), name: cleanName(m.name), host: !!m.host }));
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
    } else if (this.role === 'client') {
      if (now - this.lastSeen > TIMEOUT_MS) this._retry(200);
      else this._send(this.hostConn, { type: 'ping' });
    }
  }

  _setStatus(status) {
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, members: this.members, role: this.role } }));
  }
}
