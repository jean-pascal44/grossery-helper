// Extraction de produits par Gemini (audio dicté ou texte en vrac) avec sortie JSON structurée.
// Appel REST direct depuis le navigateur avec la clé de l'utilisateur.

import { DEFAULT_MODEL } from './store.js';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
export const UNCLASSIFIED = 'unclassified';

const SYSTEM_PROMPT = `Tu es l'assistant d'une application de liste de courses.
On te donne la liste des rayons du magasin (id, nom, contenu typique) puis une demande, dictée à voix haute ou tapée, en français le plus souvent.
Ta tâche : extraire chaque produit à acheter et le ranger dans le bon rayon.

Règles :
- Un objet par produit distinct. Fusionne les doublons.
- "name" : nom court en français, première lettre en majuscule, sans article ("du lait" → "Lait").
  Garde la quantité ou la précision si elle est donnée : "3 avocats", "2 kg de pommes", "Lait demi-écrémé", "Pain de mie complet".
- "aisleId" : l'id du rayon dont le contenu correspond le mieux au produit. Utilise "${UNCLASSIFIED}" seulement si aucun rayon ne convient vraiment.
- Applique les corrections de la personne ("des tomates… non, pas de tomates" → pas de tomates).
- Ignore les hésitations, salutations et phrases qui ne sont pas des produits.
- Si tu ne comprends aucun produit, renvoie une liste vide.`;

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.model]
 * @param {{id: string, name: string, description: string}[]} opts.aisles
 * @param {{mimeType: string, base64: string}} [opts.audio]
 * @param {string} [opts.text]
 * @returns {Promise<{name: string, aisleId: string}[]>}
 */
export async function extractItems({ apiKey, model, aisles, audio, text }) {
  if (!apiKey) throw new Error('Clé API Gemini manquante (Paramètres).');
  model = (model || DEFAULT_MODEL).trim();

  const aisleCatalog = aisles.map((a) => ({ id: a.id, nom: a.name, contenu: a.description || '' }));
  const parts = [];
  if (audio) parts.push({ inlineData: { mimeType: audio.mimeType, data: audio.base64 } });
  parts.push({
    text:
      `Rayons disponibles :\n${JSON.stringify(aisleCatalog)}\n\n` +
      (audio ? "La demande est dans l'enregistrement audio ci-joint." : `Demande :\n"""${text}"""`),
  });

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          items: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                name: { type: 'STRING' },
                aisleId: { type: 'STRING', enum: [...aisles.map((a) => a.id), UNCLASSIFIED] },
              },
              required: ['name', 'aisleId'],
            },
          },
        },
        required: ['items'],
      },
    },
  };

  let res;
  try {
    res = await fetch(`${API}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Impossible de joindre Gemini (connexion internet ?).');
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(describeError(res.status, data));

  const candidate = data?.candidates?.[0];
  const raw = (candidate?.content?.parts || []).map((p) => p.text || '').join('');
  if (!raw) {
    const reason = candidate?.finishReason || data?.promptFeedback?.blockReason;
    throw new Error(`Réponse vide de Gemini${reason ? ` (${reason})` : ''}.`);
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Réponse de Gemini illisible.'); }
  const items = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(items)) return [];
  return items
    .filter((x) => x && typeof x.name === 'string' && x.name.trim())
    .map((x) => ({ name: x.name.trim().slice(0, 200), aisleId: String(x.aisleId || UNCLASSIFIED) }));
}

function describeError(status, data) {
  const msg = data?.error?.message || '';
  if (status === 400 && /api key/i.test(msg)) return 'Clé API Gemini invalide.';
  if (status === 403) return "Clé API refusée (vérifie qu'elle est active).";
  if (status === 404) return 'Modèle Gemini introuvable : vérifie son nom dans les paramètres.';
  if (status === 429) return 'Quota Gemini atteint, réessaie dans un instant.';
  if (status >= 500) return 'Gemini est momentanément indisponible, réessaie.';
  return `Erreur Gemini ${status}${msg ? ` : ${msg}` : ''}`;
}
