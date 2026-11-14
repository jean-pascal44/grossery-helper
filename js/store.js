// État de la liste + persistance locale + fusion CRDT simple (Last-Write-Wins par enregistrement).
//
// Chaque rayon / produit est un enregistrement indépendant portant `updatedAt` et `by`.
// Une suppression est une "pierre tombale" (`deleted: true`) pour qu'elle se propage aux pairs.
// La fusion garde, pour chaque id, la version la plus récente : elle est commutative et
// idempotente, donc on peut ré-échanger des états complets sans risque (reconnexion, hors-ligne…).
// `updatedAt` est une horloge hybride (max(Date.now(), dernière valeur vue + 1)) pour limiter
// les effets d'un téléphone dont l'heure est décalée.

import { uid, norm } from './util.js';

const SETTINGS_KEY = 'grossery:settings';
const LIST_PREFIX = 'grossery:list:';
const TOMBSTONE_TTL = 30 * 24 * 3600 * 1000; // purge des suppressions après 30 jours
const MAX_FUTURE = 7 * 24 * 3600 * 1000; // rejette les dates absurdes venant d'un pair
export const DEFAULT_MODEL = 'gemini-flash-lite-latest';

// ---------- Paramètres (propres à l'appareil, jamais synchronisés) ----------

export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { /* stockage indisponible */ }
  return { name: '', userId: uid(), avatar: null, notifyAddVoice: false, notifyAddManual: false, apiKey: '', model: DEFAULT_MODEL, room: null, rooms: [], ...saved };
}

export function saveSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* quota / navigation privée */ }
}

export function forgetList(room) {
  try { localStorage.removeItem(LIST_PREFIX + room); } catch { /* ignore */ }
}

/** Nombre de produits restants d'une liste stockée (pour l'écran "Mes listes"). */
export function peekList(room) {
  try {
    const data = JSON.parse(localStorage.getItem(LIST_PREFIX + room));
    return (data?.items || []).filter((i) => !i.deleted && !i.checked).length;
  } catch { return 0; }
}

// ---------- Validation des enregistrements (données venant potentiellement d'un pair) ----------

const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);

function baseFields(r) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || r.id.length > 64) return null;
  const updatedAt = Number(r.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0 || updatedAt > Date.now() + MAX_FUTURE) return null;
  return { id: r.id, deleted: !!r.deleted, updatedAt, by: str(r.by, 64) };
}

function cleanAisle(r) {
  const base = baseFields(r);
  if (!base) return null;
  return { ...base, name: str(r.name, 80), description: str(r.description, 500), order: Number.isFinite(+r.order) ? +r.order : 0 };
}

function cleanItem(r) {
  const base = baseFields(r);
  if (!base) return null;
  const checked = !!r.checked;
  return {
    ...base,
    name: str(r.name, 200),
    aisleId: typeof r.aisleId === 'string' && r.aisleId ? r.aisleId.slice(0, 64) : null,
    checked,
    checkedBy: checked ? str(r.checkedBy, 60) : null,
    checkedAt: checked ? Number(r.checkedAt) || base.updatedAt : null,
    addedBy: str(r.addedBy, 60),
    addedById: str(r.addedById, 64),
    // Jeton d'annonce : change à chaque ajout que l'auteur a choisi de notifier ('voice:…' ou 'manual:…').
    announce: str(r.announce, 40) || null,
    checkedById: checked ? str(r.checkedById, 64) : null,
    createdAt: Number(r.createdAt) || base.updatedAt,
  };
}

// Réglages partagés de la liste. Seul l'enregistrement 'gemini' existe : clé API partagée volontairement.
function cleanMeta(r) {
  const base = baseFields(r);
  if (!base || base.id !== 'gemini') return null;
  return { ...base, apiKey: base.deleted ? '' : str(r.apiKey, 200), model: str(r.model, 80), sharedBy: str(r.sharedBy, 60) };
}

// Profils des participants (id = userId) : prénom + avatar, pour l'affichage même hors connexion.
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
function cleanAvatar(a) {
  if (!a || typeof a !== 'object' || typeof a.value !== 'string') return null;
  if (a.type === 'emoji' && a.value.length <= 16) return { type: 'emoji', value: a.value };
  if (a.type === 'photo' && a.value.length <= 40000 && PHOTO_RE.test(a.value)) return { type: 'photo', value: a.value };
  return null;
}
function cleanProfile(r) {
  const base = baseFields(r);
  if (!base) return null;
  return { ...base, name: str(r.name, 60), avatar: cleanAvatar(r.avatar) };
}

const CLEAN = { aisles: cleanAisle, items: cleanItem, meta: cleanMeta, profiles: cleanProfile };
export const COLLECTIONS = ['aisles', 'items', 'meta', 'profiles'];
const emptyChanges = () => ({ aisles: [], items: [], meta: [], profiles: [] });
const hasChanges = (c) => COLLECTIONS.some((k) => c[k].length);

/** `a` l'emporte-t-il sur `b` ? Égalité départagée par l'id d'auteur pour un ordre total. */
const wins = (a, b) => a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && a.by > b.by);

// ---------- Store ----------

export class Store extends EventTarget {
  /**
   * @param {string} room code de la liste
   * @param {() => {userId: string, name: string}} getUser
   */
  constructor(room, getUser) {
    super();
    this.room = room;
    this.getUser = getUser;
    this.aisles = new Map();
    this.items = new Map();
    this.meta = new Map();
    this.profiles = new Map();
    this.clock = 0;
    this._saveTimer = null;
    this._load();
    this._onPageHide = () => this.flush();
    window.addEventListener('pagehide', this._onPageHide);
  }

  /** Libère la liste (changement de liste). `discard` = ne pas réécrire l'état (liste supprimée). */
  dispose({ discard = false } = {}) {
    if (!discard) this.flush();
    clearTimeout(this._saveTimer);
    window.removeEventListener('pagehide', this._onPageHide);
    this.disposed = true;
  }

  _load() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(LIST_PREFIX + this.room)); } catch { /* ignore */ }
    if (!data) return;
    const cutoff = Date.now() - TOMBSTONE_TTL;
    for (const coll of COLLECTIONS) {
      for (const raw of data[coll] || []) {
        const r = CLEAN[coll](raw);
        if (!r || (r.deleted && r.updatedAt < cutoff)) continue;
        this[coll].set(r.id, r);
        this._observe(r.updatedAt);
      }
    }
  }

  _save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    clearTimeout(this._saveTimer);
    if (this.disposed) return;
    try { localStorage.setItem(LIST_PREFIX + this.room, JSON.stringify(this.snapshot())); } catch { /* ignore */ }
  }

  _observe(t) { if (t > this.clock) this.clock = t; }
  _tick() { this.clock = Math.max(Date.now(), this.clock + 1); return this.clock; }

  /** État complet, pierres tombales comprises (pour la synchro). */
  snapshot() {
    return Object.fromEntries(COLLECTIONS.map((c) => [c, [...this[c].values()]]));
  }

  // ---------- Synchronisation par différence ----------

  /** Résumé compact de l'état : [id, updatedAt, by] par enregistrement, sans le contenu. */
  digest() {
    return Object.fromEntries(COLLECTIONS.map((c) => [c, [...this[c].values()].map((r) => [r.id, r.updatedAt, r.by])]));
  }

  /**
   * Compare un résumé distant à l'état local.
   * @returns {{send: object, want: object}} send = enregistrements locaux plus récents ou absents
   *   chez le pair (à lui envoyer) ; want = ids plus récents ou absents localement (à lui demander).
   */
  diff(digest) {
    const send = emptyChanges();
    const want = {};
    for (const c of COLLECTIONS) {
      const remote = new Map();
      for (const e of Array.isArray(digest?.[c]) ? digest[c].slice(0, 20000) : []) {
        if (Array.isArray(e) && typeof e[0] === 'string') remote.set(e[0], { updatedAt: Number(e[1]) || 0, by: String(e[2] || '') });
      }
      want[c] = [];
      for (const [id, rv] of remote) {
        const mine = this[c].get(id);
        if (!mine || wins(rv, mine)) want[c].push(id);
      }
      for (const r of this[c].values()) {
        const rv = remote.get(r.id);
        if (!rv || wins(r, rv)) send[c].push(r);
      }
    }
    return { send, want };
  }

  /** Enregistrements locaux correspondant à une liste d'ids demandés par un pair. */
  pick(want) {
    const out = emptyChanges();
    for (const c of COLLECTIONS) {
      for (const id of Array.isArray(want?.[c]) ? want[c] : []) {
        const r = typeof id === 'string' ? this[c].get(id) : null;
        if (r) out[c].push(r);
      }
    }
    return out;
  }

  _emit(source, changes, events = []) {
    this.dispatchEvent(new CustomEvent('change', { detail: { source, changes, events } }));
  }

  /** Applique des modifications locales (horodatage + diffusion). */
  _commit(changes) {
    const { userId } = this.getUser();
    const out = emptyChanges();
    for (const coll of COLLECTIONS) {
      for (const rec of changes[coll] || []) {
        const r = { ...rec, updatedAt: this._tick(), by: userId };
        this[coll].set(r.id, r);
        out[coll].push(r);
      }
    }
    if (hasChanges(out)) {
      this._save();
      this._emit('local', out);
    }
    return out;
  }

  /**
   * Fusionne un état (complet ou partiel) reçu d'un pair.
   * @param {{aisles?: object[], items?: object[]}} snap
   * @param {{silent?: boolean}} opts silent = pas de notifications (synchro initiale)
   * @returns {{changes: {aisles: object[], items: object[]}, events: object[]}}
   */
  merge(snap, { silent = false } = {}) {
    const changes = emptyChanges();
    const events = [];
    for (const coll of COLLECTIONS) {
      const list = Array.isArray(snap?.[coll]) ? snap[coll] : [];
      for (const raw of list) {
        const r = CLEAN[coll](raw);
        if (!r) continue;
        const cur = this[coll].get(r.id);
        if (cur && !wins(r, cur)) continue;
        this._observe(r.updatedAt);
        this[coll].set(r.id, r);
        changes[coll].push(r);
        if (!silent && coll === 'items' && !r.deleted) {
          if (cur && !cur.checked && r.checked) events.push({ type: 'checked', item: r });
          else if (!r.checked && r.announce && r.announce !== cur?.announce) events.push({ type: 'added', item: r });
        }
      }
    }
    if (hasChanges(changes)) {
      this._save();
      this._emit('remote', changes, events);
    }
    return { changes, events };
  }

  // ---------- Lecture ----------

  aisleList() {
    return [...this.aisles.values()]
      .filter((a) => !a.deleted)
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'fr'));
  }

  itemList() {
    return [...this.items.values()].filter((i) => !i.deleted);
  }

  // ---------- Profils (prénom + avatar) ----------

  profile(userId) {
    const p = userId ? this.profiles.get(userId) : null;
    return p && !p.deleted ? p : null;
  }

  /** Repli pour les anciens produits sans id d'auteur : profil le plus récent portant ce prénom. */
  profileByName(name) {
    let best = null;
    for (const p of this.profiles.values()) {
      if (!p.deleted && name && p.name === name && (!best || p.updatedAt > best.updatedAt)) best = p;
    }
    return best;
  }

  /** Publie son propre profil dans la liste (sans écriture si rien n'a changé). */
  setProfile({ name, avatar }) {
    const { userId } = this.getUser();
    const av = avatar || null;
    const cur = this.profiles.get(userId);
    if (cur && !cur.deleted && cur.name === name && JSON.stringify(cur.avatar) === JSON.stringify(av)) return;
    this._commit({ profiles: [{ id: userId, name, avatar: av, deleted: false }] });
  }

  // ---------- Clé Gemini partagée ----------

  /** @returns {{apiKey: string, model: string, sharedBy: string, by: string} | null} */
  sharedAi() {
    const r = this.meta.get('gemini');
    return r && !r.deleted && r.apiKey ? r : null;
  }

  setSharedAi({ apiKey, model, sharedBy }) {
    this._commit({ meta: [{ id: 'gemini', apiKey, model, sharedBy, deleted: false }] });
  }

  /** Retire la clé partagée (pierre tombale sans la clé, propagée à tous). */
  clearSharedAi() {
    const cur = this.meta.get('gemini');
    if (cur && !cur.deleted) this._commit({ meta: [{ ...cur, apiKey: '', deleted: true }] });
  }

  // ---------- Rayons ----------

  addAisles(list) {
    let order = Math.max(0, ...this.aisleList().map((a) => a.order));
    const recs = list.map(({ name, description }) => ({
      id: uid(), name: name.trim(), description: (description || '').trim(), order: ++order, deleted: false,
    }));
    return this._commit({ aisles: recs }).aisles;
  }

  addAisle(aisle) { return this.addAisles([aisle])[0]; }

  updateAisle(id, patch) {
    const cur = this.aisles.get(id);
    if (cur && !cur.deleted) this._commit({ aisles: [{ ...cur, ...patch }] });
  }

  /** Supprime le rayon ; ses produits passent dans "Non classé". */
  deleteAisle(id) {
    const cur = this.aisles.get(id);
    if (!cur) return;
    const orphans = this.itemList().filter((i) => i.aisleId === id).map((i) => ({ ...i, aisleId: null }));
    this._commit({ aisles: [{ ...cur, deleted: true }], items: orphans });
  }

  moveAisle(id, dir) {
    const list = this.aisleList();
    const i = list.findIndex((a) => a.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    const changed = list.map((a, k) => ({ ...a, order: k + 1 })).filter((a) => a.order !== this.aisles.get(a.id).order);
    this._commit({ aisles: changed });
  }

  // ---------- Produits ----------

  /**
   * Ajoute des produits en évitant les doublons :
   * - déjà dans la liste active → ignoré
   * - déjà dans le panier → remis dans la liste
   * @param {{name: string, aisleId: string|null}[]} entries
   * @param {{announce?: 'voice'|'manual'|null}} opts announce = notifier les autres participants
   */
  addItems(entries, { announce = null } = {}) {
    const { name: me, userId } = this.getUser();
    const known = new Map();
    for (const it of this.itemList()) {
      const k = norm(it.name);
      if (!known.has(k) || known.get(k).checked) known.set(k, it);
    }
    const out = [];
    const result = { added: [], restored: [], skipped: [] };
    const token = announce ? `${announce}:${uid()}` : null;
    for (const e of entries) {
      const name = String(e.name || '').trim();
      if (!name) continue;
      const k = norm(name);
      const cur = known.get(k);
      if (cur && !cur.checked) { result.skipped.push(cur); continue; }
      let rec;
      if (cur) {
        rec = {
          ...cur, checked: false, checkedBy: null, checkedById: null, checkedAt: null, aisleId: e.aisleId ?? cur.aisleId,
          announce: token || cur.announce,
        };
        result.restored.push(rec);
      } else {
        rec = {
          id: uid(), name, aisleId: e.aisleId || null, checked: false, checkedBy: null, checkedAt: null,
          addedBy: me, addedById: userId, createdAt: Date.now(), deleted: false, announce: token,
        };
        result.added.push(rec);
      }
      known.set(k, rec);
      out.push(rec);
    }
    if (out.length) this._commit({ items: out });
    return result;
  }

  updateItem(id, patch) {
    const cur = this.items.get(id);
    if (cur && !cur.deleted) this._commit({ items: [{ ...cur, ...patch }] });
  }

  setChecked(id, checked) {
    const cur = this.items.get(id);
    if (!cur || cur.deleted || cur.checked === checked) return;
    const { name, userId } = this.getUser();
    this._commit({
      items: [{
        ...cur, checked, checkedBy: checked ? name : null, checkedById: checked ? userId : null, checkedAt: checked ? Date.now() : null,
      }],
    });
  }

  deleteItems(ids) {
    const recs = ids.map((id) => this.items.get(id)).filter((i) => i && !i.deleted).map((i) => ({ ...i, deleted: true }));
    this._commit({ items: recs });
  }

  /** Vide le panier (supprime les produits cochés). */
  clearCart() {
    this.deleteItems(this.itemList().filter((i) => i.checked).map((i) => i.id));
  }
}
