// Petites fonctions utilitaires partagées.

const BASE36 = 'abcdefghijklmnopqrstuvwxyz0123456789';
// Alphabet sans caractères ambigus (0/o, 1/l/i) pour les codes de liste tapés à la main.
const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function randomString(len, alphabet) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** Identifiant aléatoire pour les rayons, produits et utilisateurs. */
export const uid = () => randomString(14, BASE36);

/** Code de liste de 8 caractères (≈ 850 milliards de combinaisons). */
export const roomCode = () => randomString(8, ROOM_ALPHABET);

/** Affichage lisible : "k7m2qp4x" -> "k7m2-qp4x". */
export const formatRoom = (code) => (code && code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code || '');

/** Accepte un code brut ("k7m2-qp4x") ou un lien de partage complet. */
export function parseRoom(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (/^https?:\/\//i.test(s)) {
    try { s = new URL(s).searchParams.get('room') || ''; } catch { s = ''; }
  }
  s = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return s.length >= 4 && s.length <= 32 ? s : null;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Échappe une chaîne pour l'injecter dans du HTML (texte ou attribut). */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Normalise un nom pour détecter les doublons ("Lait " == "lait", "Pâtes" == "pates"). */
export const norm = (s) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export function capitalize(s) {
  s = String(s ?? '').trim().replace(/\s+/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function plural(n, one, many) {
  return `${n} ${n > 1 ? many : one}`;
}
