// Point d'entrée : interface, liaison Store <-> Sync <-> Gemini.

import { Store, loadSettings, saveSettings, forgetList, peekList, DEFAULT_MODEL } from './store.js';
import { Sync } from './sync.js';
import { extractItems, UNCLASSIFIED } from './gemini.js';
import { Recorder, toGeminiAudio } from './audio.js';
import { PRESET_AISLES } from './presets.js';
import { esc, norm, roomCode, parseRoom, formatRoom, capitalize, plural } from './util.js';
import { icon, hydrateIcons } from './icons.js';

const $ = (sel, root = document) => root.querySelector(sel);
const MAX_REC_SECONDS = 90;
const LAST_AISLE_KEY = 'grossery:lastAisle';

const settings = loadSettings();
/** @type {Store} */ let store;
/** @type {Sync} */ let sync;
let cartOpen = false;
let renderQueued = false;

const getUser = () => ({ userId: settings.userId, name: settings.name || 'Anonyme' });

/** Config Gemini à utiliser : sa propre clé en priorité, sinon celle partagée dans la liste. */
function ai() {
  if (settings.apiKey) return { apiKey: settings.apiKey, model: settings.model, shared: false };
  const s = store.sharedAi();
  return s ? { apiKey: s.apiKey, model: s.model || DEFAULT_MODEL, shared: true, sharedBy: s.sharedBy } : null;
}

const aiErrorMessage = (err, cfg) => (cfg?.shared ? `${err.message} (clé partagée par ${cfg.sharedBy})` : err.message);
const shareLink = () => `${location.origin}${location.pathname}?room=${settings.room}`;

// =====================================================================
// Liste courante (room)
// =====================================================================

function openRoom(code, { copyAisles = null, copyAi = null } = {}) {
  sync?.stop();
  store?.dispose();
  store = new Store(code, getUser);
  if (copyAisles?.length) store.addAisles(copyAisles);
  if (copyAi) store.setSharedAi(copyAi);
  store.addEventListener('change', onStoreChange);

  settings.room = code;
  settings.rooms = [code, ...settings.rooms.filter((r) => r !== code)].slice(0, 12);
  saveSettings(settings);

  sync = new Sync(store, getUser);
  sync.addEventListener('status', renderStatus);
  if (settings.name) sync.start(code);
  renderStatus();
  render();
}

function onStoreChange(e) {
  const { source, events } = e.detail;
  if (source === 'remote' && events.length) notifyRemote(events);
  scheduleRender();
}

function notifyRemote(events) {
  const checked = events.filter((e) => e.type === 'checked');
  for (const ev of checked.slice(0, 3)) {
    toast(`<b>${esc(ev.item.checkedBy || 'Quelqu’un')}</b> a pris : ${esc(ev.item.name)}`, { kind: 'check' });
  }
  if (checked.length > 3) toast(`… et ${checked.length - 3} autres produits pris`, { kind: 'check' });
  if (checked.length) navigator.vibrate?.(60);
}

// =====================================================================
// Rendu
// =====================================================================

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  renderAisleSelect($('#qa-aisle'), { withAuto: !!ai(), remember: true });
  renderList();
  renderAisles();
}

function renderAisleSelect(select, { withAuto = false, remember = false, value } = {}) {
  const current = value ?? (select.value || (remember ? localStorage.getItem(LAST_AISLE_KEY) : '') || '');
  const opts = [];
  if (withAuto) opts.push(`<option value="auto">✨ Auto (IA)</option>`);
  for (const a of store.aisleList()) opts.push(`<option value="${esc(a.id)}">${esc(a.name)}</option>`);
  opts.push(`<option value="">Non classé</option>`);
  select.innerHTML = opts.join('');
  const values = [...select.options].map((o) => o.value);
  select.value = values.includes(current) ? current : withAuto ? 'auto' : values[0];
}

function itemRow(it, { cart = false } = {}) {
  const me = settings.name;
  let meta = '';
  if (cart) {
    const time = it.checkedAt ? new Date(it.checkedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
    meta = `${esc(it.checkedBy || '')}${time ? ` · ${time}` : ''}`;
  } else if (it.addedBy && it.addedBy !== me) {
    meta = `ajouté par ${esc(it.addedBy)}`;
  }
  return `
    <li class="item" data-id="${esc(it.id)}">
      <button class="check" type="button" data-action="${cart ? 'uncheck' : 'check'}" aria-label="${cart ? 'Remettre dans la liste' : 'Cocher'} ${esc(it.name)}">${icon('check')}</button>
      <div class="item-body" data-action="${cart ? 'uncheck' : 'check'}">
        <span class="item-name">${esc(it.name)}</span>
        ${meta ? `<span class="item-meta">${meta}</span>` : ''}
      </div>
      ${cart
        ? `<button class="icon-btn small" type="button" data-action="delete-item" aria-label="Supprimer">${icon('trash')}</button>`
        : `<button class="icon-btn small" type="button" data-action="edit-item" aria-label="Modifier">${icon('pencil')}</button>`}
    </li>`;
}

function renderList() {
  const aisles = store.aisleList();
  const all = store.itemList();
  const active = all.filter((i) => !i.checked).sort((a, b) => a.createdAt - b.createdAt);
  const checked = all.filter((i) => i.checked).sort((a, b) => (b.checkedAt || 0) - (a.checkedAt || 0));

  const groups = new Map(aisles.map((a) => [a.id, []]));
  const unclassified = [];
  for (const it of active) (groups.get(it.aisleId) || unclassified).push(it);

  const section = (title, items, extra = '') => `
    <section class="section ${extra}">
      <h2><span>${esc(title)}</span><span class="count">${items.length}</span></h2>
      <ul class="card-list">${items.map((i) => itemRow(i)).join('')}</ul>
    </section>`;

  let html = aisles.filter((a) => groups.get(a.id).length).map((a) => section(a.name, groups.get(a.id))).join('');
  if (unclassified.length) html += section('Non classé', unclassified, 'unclassified');

  if (!active.length) {
    if (!aisles.length) {
      html = `
        <div class="empty">
          <div class="empty-icon">${icon('grid')}</div>
          <p><b>Commence par créer tes rayons.</b><br>Ils servent à trier la liste et à guider l'IA.</p>
          <div class="row-actions center">
            <button class="btn primary" type="button" data-action="load-presets">Charger les rayons types</button>
            <button class="btn" type="button" data-action="goto-aisles">Créer mes rayons</button>
          </div>
        </div>`;
    } else {
      html = `
        <div class="empty">
          <div class="empty-icon">${icon('cart')}</div>
          <p>${checked.length ? '<b>Tout est dans le panier 🎉</b>' : '<b>La liste est vide.</b>'}<br>
          Ajoute un produit ci-dessus ou appuie sur le micro pour dicter ta liste.</p>
        </div>`;
    }
  }
  $('#list').innerHTML = html;

  $('#cart').innerHTML = checked.length ? `
    <section class="section">
      <button class="cart-toggle" type="button" data-action="toggle-cart" aria-expanded="${cartOpen}">
        ${icon(cartOpen ? 'up' : 'down')}<span>Dans le panier</span><span class="count">${checked.length}</span>
      </button>
      ${cartOpen ? `
        <ul class="card-list">${checked.map((i) => itemRow(i, { cart: true })).join('')}</ul>
        <div class="row-actions end"><button class="btn danger-ghost" type="button" data-action="clear-cart">Vider le panier</button></div>` : ''}
    </section>` : '';

  const badge = $('#badge-count');
  badge.hidden = !active.length;
  badge.textContent = active.length;
}

function renderAisles() {
  const aisles = store.aisleList();
  const counts = new Map();
  for (const it of store.itemList()) if (!it.checked) counts.set(it.aisleId, (counts.get(it.aisleId) || 0) + 1);
  $('#aisles').innerHTML = aisles.length
    ? aisles.map((a, i) => `
      <li class="aisle" data-id="${esc(a.id)}">
        <div class="aisle-body" data-action="edit-aisle">
          <span class="aisle-name">${esc(a.name)} ${counts.get(a.id) ? `<span class="count">${counts.get(a.id)}</span>` : ''}</span>
          <span class="aisle-desc">${esc(a.description) || '<i>Aucune description</i>'}</span>
        </div>
        <div class="aisle-actions">
          <button class="icon-btn small" type="button" data-action="aisle-up" aria-label="Monter" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button>
          <button class="icon-btn small" type="button" data-action="aisle-down" aria-label="Descendre" ${i === aisles.length - 1 ? 'disabled' : ''}>${icon('down')}</button>
          <button class="icon-btn small" type="button" data-action="edit-aisle" aria-label="Modifier">${icon('pencil')}</button>
        </div>
      </li>`).join('')
    : `<li class="empty small">Aucun rayon pour l'instant.</li>`;
}

function renderStatus() {
  const pill = $('#status-pill');
  const status = settings.name ? sync?.status || 'offline' : 'offline';
  const n = sync?.members.length || 0;
  pill.dataset.status = status;
  $('.pill-text', pill).textContent =
    status === 'online' ? (n > 1 ? `${n} connectés` : 'En ligne')
      : status === 'connecting' ? 'Connexion…' : 'Hors ligne';
  if ($('#dlg-share').open) renderMembers();
}

function renderMembers() {
  const el = $('#share-members');
  const status = sync?.status;
  if (status !== 'online') {
    el.innerHTML = `<li class="muted">${status === 'connecting' ? 'Connexion en cours…' : 'Hors ligne'}</li>`;
    return;
  }
  const selfId = sync.selfId;
  el.innerHTML = sync.members.map((m) => `
    <li><span class="avatar">${esc(m.name.charAt(0).toUpperCase())}</span>
      <span>${esc(m.name)}${m.id === selfId ? ' <span class="muted">(toi)</span>' : ''}</span>
      ${m.host ? '<span class="tag">relais</span>' : ''}</li>`).join('')
    + (sync.members.length <= 1 ? '<li class="muted small">Personne d\'autre pour l\'instant : partage le lien !</li>' : '');
}

// =====================================================================
// Toasts
// =====================================================================

function toast(html, { kind = 'info', action = null, duration = 3500 } = {}) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="toast-msg">${html}</span>`;
  const dismiss = () => {
    if (!el.isConnected) return;
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  };
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.onclick = (e) => { e.stopPropagation(); action.fn(); dismiss(); };
    el.append(b);
  }
  el.addEventListener('click', dismiss);
  box.append(el);
  while (box.children.length > 4) box.firstElementChild.remove();
  setTimeout(dismiss, action ? Math.max(duration, 5000) : duration);
}

// =====================================================================
// Actions sur la liste
// =====================================================================

function checkItem(id) {
  const li = document.querySelector(`#list [data-id="${CSS.escape(id)}"]`);
  li?.classList.add('leaving');
  setTimeout(() => {
    const it = store.items.get(id);
    if (!it || it.checked || it.deleted) return;
    store.setChecked(id, true);
    toast(`${esc(it.name)} → panier`, { kind: 'check', action: { label: 'Annuler', fn: () => store.setChecked(id, false) } });
  }, 180);
}

/** Ajoute le résultat de Gemini et affiche un résumé (avec annulation). */
function applyExtracted(list) {
  const valid = new Set(store.aisleList().map((a) => a.id));
  const entries = list.map((x) => ({
    name: capitalize(x.name),
    aisleId: x.aisleId !== UNCLASSIFIED && valid.has(x.aisleId) ? x.aisleId : null,
  }));
  if (!entries.length) {
    toast("Je n'ai reconnu aucun produit.", { kind: 'error' });
    return;
  }
  const r = store.addItems(entries);
  const parts = [];
  if (r.added.length) parts.push(`${plural(r.added.length, 'ajouté', 'ajoutés')} : ${r.added.map((i) => esc(i.name)).join(', ')}`);
  if (r.restored.length) parts.push(`${plural(r.restored.length, 'remis', 'remis')} dans la liste`);
  if (r.skipped.length) parts.push(`${plural(r.skipped.length, 'déjà présent', 'déjà présents')}`);
  const addedIds = r.added.map((i) => i.id);
  toast(parts.join(' · '), {
    kind: 'success',
    duration: 6000,
    action: addedIds.length ? { label: 'Annuler', fn: () => store.deleteItems(addedIds) } : null,
  });
}

async function quickAdd(e) {
  e.preventDefault();
  const input = $('#qa-name');
  const select = $('#qa-aisle');
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  localStorage.setItem(LAST_AISLE_KEY, select.value);

  if (select.value === 'auto') {
    const btn = $('#qa-submit');
    btn.disabled = true;
    btn.classList.add('busy');
    const cfg = ai();
    try {
      const items = await extractItems({ apiKey: cfg?.apiKey, model: cfg?.model, aisles: store.aisleList(), text });
      input.value = '';
      applyExtracted(items);
    } catch (err) {
      // Repli : on ajoute quand même, sans classement.
      const r = store.addItems(splitNames(text).map((name) => ({ name, aisleId: null })));
      input.value = '';
      toast(`${esc(aiErrorMessage(err, cfg))} Ajouté dans « Non classé » (${r.added.length}).`, { kind: 'error', duration: 6000 });
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  } else {
    const r = store.addItems(splitNames(text).map((name) => ({ name, aisleId: select.value || null })));
    input.value = '';
    if (r.skipped.length && !r.added.length && !r.restored.length) toast(`${esc(r.skipped[0].name)} est déjà dans la liste.`);
  }
  input.focus();
}

const splitNames = (text) => text.split(/[,;\n]+/).map(capitalize).filter(Boolean);

function loadPresets() {
  const existing = new Set(store.aisleList().map((a) => norm(a.name)));
  const missing = PRESET_AISLES.filter((p) => !existing.has(norm(p.name)));
  if (!missing.length) { toast('Les rayons types sont déjà là.'); return; }
  store.addAisles(missing);
  toast(`${plural(missing.length, 'rayon ajouté', 'rayons ajoutés')}. Tu peux les réordonner selon ton magasin.`, { kind: 'success' });
}

function switchTab(tab) {
  for (const b of document.querySelectorAll('.tabbar button')) b.classList.toggle('active', b.dataset.tab === tab);
  $('#view-list').hidden = tab !== 'list';
  $('#view-aisles').hidden = tab !== 'aisles';
  $('#fab-mic').hidden = tab !== 'list';
  window.scrollTo({ top: 0 });
}

// =====================================================================
// Dialogues
// =====================================================================

function setupDialog(dlg) {
  // Clic sur le fond = fermer.
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-action="close"]')) dlg.close(); });
}

// --- Produit ---
let editingItemId = null;
function openItemDialog(id) {
  const it = store.items.get(id);
  if (!it) return;
  editingItemId = id;
  $('#item-name').value = it.name;
  renderAisleSelect($('#item-aisle'), { value: it.aisleId || '' });
  $('#dlg-item').showModal();
}

// --- Rayon ---
let editingAisleId = null;
function openAisleDialog(id = null) {
  const a = id ? store.aisles.get(id) : null;
  editingAisleId = a ? id : null;
  $('#aisle-title').textContent = a ? 'Modifier le rayon' : 'Nouveau rayon';
  $('#aisle-name').value = a?.name || '';
  $('#aisle-desc').value = a?.description || '';
  $('#form-aisle [data-action="delete"]').hidden = !a;
  $('#dlg-aisle').showModal();
  if (!a) $('#aisle-name').focus();
}

// --- Partage ---
function openShare() {
  const code = settings.room;
  $('#share-code').textContent = formatRoom(code);
  $('#join-code').value = '';
  const qrEl = $('#share-qr');
  if (typeof window.qrcode === 'function') {
    const qr = window.qrcode(0, 'M');
    qr.addData(shareLink());
    qr.make();
    qrEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } else {
    qrEl.innerHTML = '';
  }
  $('#btn-native-share').hidden = !navigator.share;
  renderMembers();
  $('#dlg-share').showModal();
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(shareLink());
    toast('Lien copié ✓', { kind: 'success' });
  } catch {
    prompt('Copie ce lien :', shareLink());
  }
}

function joinFromInput(e) {
  e.preventDefault();
  const code = parseRoom($('#join-code').value);
  if (!code) { toast('Code ou lien invalide.', { kind: 'error' }); return; }
  $('#dlg-share').close();
  if (code === settings.room) { toast('Tu es déjà sur cette liste.'); return; }
  openRoom(code);
  toast(`Liste ${formatRoom(code)} rejointe.`, { kind: 'success' });
}

// --- Paramètres ---
function openSettings(focusSel) {
  $('#set-name').value = settings.name;
  $('#set-apikey').value = settings.apiKey;
  $('#set-model').value = settings.model || DEFAULT_MODEL;
  const shared = store.sharedAi();
  const sharedByMe = !!shared && shared.by === settings.userId;
  $('#set-share-key').checked = sharedByMe;
  const info = $('#set-shared-info');
  info.hidden = !shared || sharedByMe;
  if (shared && !sharedByMe) {
    info.textContent = `🔑 ${shared.sharedBy || 'Un participant'} partage sa clé Gemini avec cette liste : tu peux dicter sans configurer de clé. Si tu saisis la tienne, elle sera utilisée en priorité.`;
  }
  renderRooms();
  $('#dlg-settings').showModal();
  if (focusSel) $(focusSel)?.focus();
}

function renderRooms() {
  $('#set-rooms').innerHTML = settings.rooms.map((code) => {
    const n = code === settings.room ? store.itemList().filter((i) => !i.checked).length : peekList(code);
    return `<li><button type="button" class="room ${code === settings.room ? 'current' : ''}" data-room="${esc(code)}">
      <span class="code">${esc(formatRoom(code))}</span>
      <span class="muted small">${plural(n, 'produit', 'produits')}</span>
      ${code === settings.room ? '<span class="tag">actuelle</span>' : ''}</button></li>`;
  }).join('');
}

function saveSettingsForm(e) {
  e.preventDefault();
  const name = $('#set-name').value.trim();
  if (!name) return;
  const nameChanged = name !== settings.name;
  settings.name = name;
  settings.apiKey = $('#set-apikey').value.trim();
  settings.model = $('#set-model').value.trim() || DEFAULT_MODEL;
  saveSettings(settings);

  // Partage (ou retrait) de la clé avec les participants de la liste.
  const shared = store.sharedAi();
  const sharedByMe = !!shared && shared.by === settings.userId;
  if ($('#set-share-key').checked) {
    if (!settings.apiKey) {
      toast('Saisis une clé pour pouvoir la partager.', { kind: 'error' });
    } else if (!sharedByMe || shared.apiKey !== settings.apiKey || shared.model !== settings.model || shared.sharedBy !== name) {
      store.setSharedAi({ apiKey: settings.apiKey, model: settings.model, sharedBy: name });
    }
  } else if (sharedByMe) {
    store.clearSharedAi();
  }

  $('#dlg-settings').close();
  if (nameChanged) sync.restart();
  render();
  toast('Paramètres enregistrés.', { kind: 'success' });
}

// --- Accueil ---
function openOnboarding(joining) {
  if (joining) $('#onboard-text').textContent = 'On t\'a partagé une liste de courses. Choisis un prénom : il sera affiché aux autres quand tu ajoutes ou prends un produit.';
  const dlg = $('#dlg-onboard');
  dlg.addEventListener('cancel', (e) => e.preventDefault()); // prénom obligatoire
  dlg.showModal();
}

// =====================================================================
// Dictée vocale
// =====================================================================

const recorder = new Recorder();
let recTimer = null;
let lastAudio = null;

function setRecState(state, message = '') {
  const body = $('#dlg-rec .rec');
  body.dataset.state = state;
  const title = { recording: "J'écoute…", processing: 'Gemini range tes courses…', error: 'Oups' }[state];
  $('#rec-title').textContent = title;
  if (state === 'error') $('#rec-sub').textContent = message;
  else if (state === 'processing') $('#rec-sub').textContent = 'Analyse de la dictée et classement par rayon.';
  else $('#rec-sub').textContent = 'Dicte tes produits en vrac, par ex. « des bananes, du lait, 3 avocats et du liquide vaisselle ».';
  $('#dlg-rec [data-action="stop"]').hidden = state !== 'recording';
  $('#dlg-rec [data-action="retry"]').hidden = !(state === 'error' && lastAudio);
  $('#dlg-rec [data-action="cancel"]').textContent = state === 'error' ? 'Fermer' : 'Annuler';
}

async function startDictation() {
  if (!ai()) {
    toast('Ajoute une clé API Gemini pour dicter ta liste (ou demande à un participant de partager la sienne).', { kind: 'error' });
    openSettings('#set-apikey');
    return;
  }
  lastAudio = null;
  $('#rec-timer').textContent = '0:00';
  $('#rec-level').style.transform = 'scaleX(0)';
  setRecState('recording');
  $('#dlg-rec').showModal();
  try {
    await recorder.start((level) => { $('#rec-level').style.transform = `scaleX(${level})`; });
  } catch (err) {
    const msg = err?.name === 'NotAllowedError'
      ? "Accès au micro refusé. Autorise-le dans les réglages du navigateur."
      : err?.message || 'Micro indisponible.';
    setRecState('error', msg);
    return;
  }
  recTimer = setInterval(() => {
    const s = Math.floor(recorder.duration);
    $('#rec-timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s >= MAX_REC_SECONDS) finishDictation();
  }, 250);
}

async function finishDictation() {
  clearInterval(recTimer);
  if (!recorder.recording) return;
  const duration = recorder.duration;
  setRecState('processing');
  let blob;
  try { blob = await recorder.stop(); } catch (err) { setRecState('error', err.message); return; }
  if (duration < 0.8 || blob.size < 500) { setRecState('error', 'Enregistrement trop court, réessaie en parlant un peu plus longtemps.'); return; }
  lastAudio = await toGeminiAudio(blob);
  await processAudio();
}

async function processAudio() {
  if (!lastAudio) return;
  setRecState('processing');
  const cfg = ai();
  try {
    const items = await extractItems({ apiKey: cfg?.apiKey, model: cfg?.model, aisles: store.aisleList(), audio: lastAudio });
    if (!$('#dlg-rec').open) return; // annulé entre-temps
    $('#dlg-rec').close();
    applyExtracted(items);
  } catch (err) {
    if ($('#dlg-rec').open) setRecState('error', aiErrorMessage(err, cfg));
  }
}

function cancelDictation() {
  clearInterval(recTimer);
  recorder.cancel();
  if ($('#dlg-rec').open) $('#dlg-rec').close();
}

// =====================================================================
// Initialisation
// =====================================================================

function bindEvents() {
  for (const dlg of document.querySelectorAll('dialog')) if (dlg.id !== 'dlg-onboard' && dlg.id !== 'dlg-rec') setupDialog(dlg);

  // Navigation
  for (const b of document.querySelectorAll('.tabbar button')) b.addEventListener('click', () => switchTab(b.dataset.tab));
  $('#btn-share').addEventListener('click', openShare);
  $('#status-pill').addEventListener('click', openShare);
  $('#btn-settings').addEventListener('click', () => openSettings());

  // Liste
  $('#quick-add').addEventListener('submit', quickAdd);
  $('#qa-aisle').addEventListener('change', (e) => localStorage.setItem(LAST_AISLE_KEY, e.target.value));
  const onListClick = (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const id = el.closest('[data-id]')?.dataset.id;
    switch (el.dataset.action) {
      case 'check': checkItem(id); break;
      case 'uncheck': store.setChecked(id, false); break;
      case 'edit-item': openItemDialog(id); break;
      case 'delete-item': store.deleteItems([id]); break;
      case 'toggle-cart': cartOpen = !cartOpen; renderList(); break;
      case 'clear-cart':
        if (confirm('Vider le panier pour tout le monde ?')) store.clearCart();
        break;
      case 'load-presets': loadPresets(); break;
      case 'goto-aisles': switchTab('aisles'); openAisleDialog(); break;
    }
  };
  $('#list').addEventListener('click', onListClick);
  $('#cart').addEventListener('click', onListClick);

  // Rayons
  $('#btn-add-aisle').addEventListener('click', () => openAisleDialog());
  $('#btn-presets').addEventListener('click', loadPresets);
  $('#aisles').addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const id = el.closest('[data-id]')?.dataset.id;
    if (el.dataset.action === 'aisle-up') store.moveAisle(id, -1);
    else if (el.dataset.action === 'aisle-down') store.moveAisle(id, 1);
    else if (el.dataset.action === 'edit-aisle') openAisleDialog(id);
  });

  // Dialogue produit
  $('#form-item').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = capitalize($('#item-name').value);
    if (name) store.updateItem(editingItemId, { name, aisleId: $('#item-aisle').value || null });
    $('#dlg-item').close();
  });
  $('#form-item [data-action="delete"]').addEventListener('click', () => {
    store.deleteItems([editingItemId]);
    $('#dlg-item').close();
  });

  // Dialogue rayon
  $('#form-aisle').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#aisle-name').value.trim();
    const description = $('#aisle-desc').value.trim();
    if (!name) return;
    if (editingAisleId) store.updateAisle(editingAisleId, { name, description });
    else store.addAisle({ name, description });
    $('#dlg-aisle').close();
  });
  $('#form-aisle [data-action="delete"]').addEventListener('click', () => {
    const a = store.aisles.get(editingAisleId);
    if (a && confirm(`Supprimer le rayon « ${a.name} » ? Ses produits passeront dans « Non classé ».`)) {
      store.deleteAisle(editingAisleId);
      $('#dlg-aisle').close();
    }
  });

  // Partage
  $('#btn-copy-link').addEventListener('click', copyLink);
  $('#btn-native-share').addEventListener('click', () => {
    navigator.share({ title: 'Liste de courses', text: 'Rejoins ma liste de courses :', url: shareLink() }).catch(() => {});
  });
  $('#form-join').addEventListener('submit', joinFromInput);

  // Paramètres
  $('#form-settings').addEventListener('submit', saveSettingsForm);
  $('#set-rooms').addEventListener('click', (e) => {
    const b = e.target.closest('[data-room]');
    if (!b || b.dataset.room === settings.room) return;
    $('#dlg-settings').close();
    openRoom(b.dataset.room);
    toast(`Liste ${formatRoom(b.dataset.room)} ouverte.`);
  });
  $('#form-settings [data-action="new-list"]').addEventListener('click', () => {
    if (!confirm('Créer une nouvelle liste vide (avec une copie de tes rayons) ? La liste actuelle reste accessible dans « Mes listes ».')) return;
    const aisles = store.aisleList().map(({ name, description }) => ({ name, description }));
    const shared = store.sharedAi();
    const copyAi = shared && shared.by === settings.userId
      ? { apiKey: shared.apiKey, model: shared.model, sharedBy: shared.sharedBy } : null;
    $('#dlg-settings').close();
    openRoom(roomCode(), { copyAisles: aisles, copyAi });
    toast('Nouvelle liste créée. Partage-la avec le bouton de partage.', { kind: 'success' });
  });
  $('#form-settings [data-action="forget-list"]').addEventListener('click', () => {
    if (!confirm('Retirer cette liste de cet appareil ? Les autres participants la gardent.')) return;
    const old = settings.room;
    sync.stop();
    store.dispose({ discard: true });
    forgetList(old);
    settings.rooms = settings.rooms.filter((r) => r !== old);
    store = null;
    $('#dlg-settings').close();
    openRoom(settings.rooms[0] || roomCode());
  });

  // Accueil
  $('#form-onboard').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#onboard-name').value.trim();
    if (!name) return;
    settings.name = name;
    saveSettings(settings);
    $('#dlg-onboard').close();
    sync.start(settings.room);
    render();
  });

  // Dictée
  $('#fab-mic').addEventListener('click', startDictation);
  $('#dlg-rec [data-action="stop"]').addEventListener('click', finishDictation);
  $('#dlg-rec [data-action="retry"]').addEventListener('click', processAudio);
  $('#dlg-rec [data-action="cancel"]').addEventListener('click', cancelDictation);
  $('#dlg-rec').addEventListener('cancel', (e) => { e.preventDefault(); cancelDictation(); });
}

function boot() {
  hydrateIcons();
  bindEvents();

  // Lien de partage : ?room=CODE
  const params = new URLSearchParams(location.search);
  const urlRoom = parseRoom(params.get('room'));
  if (params.has('room')) history.replaceState(null, '', location.pathname);
  const joining = !!urlRoom && urlRoom !== settings.room;

  openRoom(urlRoom || settings.room || roomCode());
  if (!settings.name) openOnboarding(joining);
  else if (joining) toast(`Liste ${formatRoom(urlRoom)} rejointe.`, { kind: 'success' });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
