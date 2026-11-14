// Thème : couleur dominante + mode sombre. Script classique (non-module) chargé dans <head>
// pour appliquer le thème avant le premier affichage, sans flash de la couleur par défaut.
//
// Chaque couleur est décrite en OKLCH (teinte h, chroma c, luminosité l en mode clair) ;
// css/style.css en dérive les variantes (foncée, pâle) et les ajuste au mode sombre.
// `dark: true` = couleur claire : texte sombre sur les boutons au lieu de blanc.
(function () {
  const THEMES = [
    { id: 'vert', name: 'Vert', h: 149, c: 0.17, l: 0.63 },
    { id: 'emeraude', name: 'Émeraude', h: 165, c: 0.14, l: 0.58 },
    { id: 'sauge', name: 'Sauge', h: 135, c: 0.08, l: 0.56 },
    { id: 'sarcelle', name: 'Sarcelle', h: 192, c: 0.11, l: 0.56 },
    { id: 'lagon', name: 'Lagon', h: 215, c: 0.13, l: 0.62 },
    { id: 'petrole', name: 'Pétrole', h: 222, c: 0.09, l: 0.44 },
    { id: 'bleu', name: 'Bleu', h: 260, c: 0.19, l: 0.55 },
    { id: 'ciel', name: 'Ciel', h: 240, c: 0.13, l: 0.62 },
    { id: 'marine', name: 'Marine', h: 266, c: 0.14, l: 0.4 },
    { id: 'violet', name: 'Violet', h: 293, c: 0.2, l: 0.54 },
    { id: 'lavande', name: 'Lavande', h: 300, c: 0.12, l: 0.6 },
    { id: 'aubergine', name: 'Aubergine', h: 322, c: 0.12, l: 0.4 },
    { id: 'fuchsia', name: 'Fuchsia', h: 338, c: 0.22, l: 0.58 },
    { id: 'rose', name: 'Rose', h: 0, c: 0.15, l: 0.62 },
    { id: 'framboise', name: 'Framboise', h: 8, c: 0.19, l: 0.5 },
    { id: 'rouge', name: 'Rouge', h: 27, c: 0.2, l: 0.55 },
    { id: 'corail', name: 'Corail', h: 36, c: 0.16, l: 0.64 },
    { id: 'orange', name: 'Orange', h: 58, c: 0.17, l: 0.72, dark: true },
    { id: 'moutarde', name: 'Moutarde', h: 88, c: 0.14, l: 0.74, dark: true },
    { id: 'terracotta', name: 'Terracotta', h: 40, c: 0.12, l: 0.52 },
    { id: 'chocolat', name: 'Chocolat', h: 50, c: 0.07, l: 0.4 },
    { id: 'ardoise', name: 'Ardoise', h: 255, c: 0.03, l: 0.46 },
    { id: 'graphite', name: 'Graphite', h: 0, c: 0, l: 0.33 },
  ];
  const byId = (id) => THEMES.find((t) => t.id === id) || THEMES[0];

  /** @param {{accent?: string, darkMode?: boolean|null}} s réglages de l'appareil */
  function apply(s) {
    const t = byId(s?.accent);
    const root = document.documentElement;
    root.style.setProperty('--th-h', t.h);
    root.style.setProperty('--th-c', t.c);
    root.style.setProperty('--th-l', t.l);
    root.style.setProperty('--th-on', t.dark ? 'oklch(0.2 0.03 var(--th-h))' : '#fff');
    // Mode sombre : forcé par le réglage, sinon celui du système (géré en CSS).
    if (typeof s?.darkMode === 'boolean') root.dataset.theme = s.darkMode ? 'dark' : 'light';
    else delete root.dataset.theme;
    // Barre du navigateur mobile aux couleurs du thème (même calcul que --accent dans style.css).
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = `oklch(${dark ? Math.max(t.l, 0.72) : t.l} ${t.c} ${t.h})`;
  }

  window.GrosseryTheme = { THEMES, byId, apply };
  try { apply(JSON.parse(localStorage.getItem('grossery:settings')) || {}); } catch { apply({}); }
})();
