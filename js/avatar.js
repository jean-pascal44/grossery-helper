// Avatars : photo (recadrée et compressée), emoji, ou initiales colorées par défaut.

import { esc } from './util.js';

export const AVATAR_EMOJIS = ['🍎', '🥕', '🥑', '🥐', '🧀', '🍕', '🍩', '🐱', '🐶', '🦊', '🐼', '🐸', '🦄', '🌻', '⭐', '🚀'];

const PHOTO_SIZE = 96;

/** Teinte stable dérivée d'une chaîne (id ou prénom). */
function hue(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}

const initials = (name) =>
  String(name || '').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';

/**
 * @param {{id?: string, name?: string, avatar?: {type: 'photo'|'emoji', value: string} | null}} p
 * @param {'xs'|'sm'|'md'|'lg'} size
 */
export function avatarHtml(p, size = 'sm') {
  const name = p?.name || '?';
  const av = p?.avatar;
  const title = `title="${esc(name)}"`;
  if (av?.type === 'photo') return `<span class="avatar ${size}" ${title}><img src="${esc(av.value)}" alt=""></span>`;
  const style = `style="--h:${hue(p?.id || name)}"`;
  if (av?.type === 'emoji') return `<span class="avatar ${size} emoji" ${style} ${title}>${esc(av.value)}</span>`;
  return `<span class="avatar ${size}" ${style} ${title}>${esc(initials(name))}</span>`;
}

/** Charge une image, la recadre au centre en carré 96 px et renvoie un data URL JPEG (~3-8 Ko). */
export async function photoToAvatar(file) {
  if (!file?.type?.startsWith('image/')) throw new Error('Ce fichier n’est pas une image.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Image illisible.'));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = PHOTO_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
    return { type: 'photo', value: canvas.toDataURL('image/jpeg', 0.8) };
  } finally {
    URL.revokeObjectURL(url);
  }
}
