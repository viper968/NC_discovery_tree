// Colour vision settings: the seven common forms of colour blindness.
//
// Each form swaps the colours that carry meaning (discovered, within reach,
// the quickest way, what it leads to) for a set that stays distinct for it,
// and gives mods colours from a palette chosen to stay apart for it too.
// "Leads to" lines are also dashed, so no meaning rests on colour alone.
//
// The colours were picked by search, not by eye: candidates (Okabe-Ito,
// Paul Tol and OKLCH steps) scored by OKLab colour difference after
// simulating each form with Machado, Oliveira & Fernandes (2009) - severity
// 1.0 for the -opias, 0.6 for the -omalies, luminance only for
// achromatopsia - keeping 3:1 contrast with the page. Every meaningful pair
// stays at least ΔE 10 apart (×100) for the forms it serves, most over 20;
// each mod palette's closest pair is ΔE 9 or more (7.9 for achromatopsia,
// where the mod name is shown anyway). Daltonization was tried for the mod
// colours and measured worse (it collapsed more pairs), so it isn't used.

export const FORMS = [
  ['normal', 'Typical colour vision'],
  ['protanopia', 'Protanopia (no red)'],
  ['protanomaly', 'Protanomaly (weak red)'],
  ['deuteranopia', 'Deuteranopia (no green)'],
  ['deuteranomaly', 'Deuteranomaly (weak green)'],
  ['tritanopia', 'Tritanopia (no blue)'],
  ['tritanomaly', 'Tritanomaly (weak blue)'],
  ['achromatopsia', 'Achromatopsia (no colour)'],
];

export const FAMILY = {
  protanopia: 'redgreen', protanomaly: 'redgreen', deuteranopia: 'redgreen', deuteranomaly: 'redgreen',
  tritanopia: 'tritan', tritanomaly: 'tritan', achromatopsia: 'mono',
};

// accent: within reach, selection, the quickest way; done: discovered; desc: leads to
export const MEANING = {
  light: {
    redgreen: { accent: '#D55E00', done: '#0077BB', desc: '#08306b' },
    tritan: { accent: '#CC3311', done: '#009988', desc: '#08306b' },
    mono: { accent: '#b2182b', done: '#009988', desc: '#08306b' },
  },
  dark: {
    redgreen: { accent: '#CC3311', done: '#F0E442', desc: '#33BBEE' },
    tritan: { accent: '#EE3377', done: '#F0E442', desc: '#0072B2' },
    mono: { accent: '#EE7733', done: '#F0E442', desc: '#2166ac' },
  },
};

export const MODS = {
  light: {
    protanopia: ["#54b66e", "#890063", "#5d7bf1", "#796006", "#b2548d", "#4fabcd", "#2b3cad", "#a27e62", "#892218", "#1c5757"],
    protanomaly: ["#54b66e", "#701c8e", "#6887ff", "#516012", "#d74c82", "#a40836", "#e86518", "#1f6a96", "#ad94b9", "#338d6b"],
    deuteranopia: ["#54b66e", "#2b3cad", "#733d00", "#a473ee", "#417882", "#c13425", "#524569", "#a496bf", "#5067bf", "#63927d"],
    deuteranomaly: ["#54b66e", "#4931a8", "#465400", "#3792fd", "#b23586", "#e969b8", "#bc5a29", "#594364", "#2196a7", "#814ec6"],
    tritanopia: ["#54b66e", "#890063", "#e969b8", "#195c2e", "#8c5ad3", "#c13425", "#ad94b9", "#17843f", "#6b4c68", "#a56b38"],
    tritanomaly: ["#54b66e", "#890063", "#f3669a", "#195c2e", "#8c5ad3", "#a97d3a", "#c13425", "#4931a8", "#2885ef", "#a890d4"],
    achromatopsia: ["#54b66e", "#7e0f7a", "#17843f", "#519c03", "#a4277a"],
  },
  dark: {
    protanopia: ["#4cd676", "#8b2186", "#3792fd", "#9d712d", "#a51105", "#6ac5e8", "#0b7a9a", "#4ea683", "#3e55c8", "#825558"],
    protanomaly: ["#4cd676", "#7c2b9b", "#d583f8", "#3c740d", "#e87a69", "#a40836", "#2286a7", "#5fc9db", "#c93f76", "#5da920"],
    deuteranopia: ["#4cd676", "#3448ba", "#6c6610", "#5fa1f3", "#2c9a88", "#1d565f", "#c26e12", "#bdafd9", "#8864c0", "#f3669a"],
    deuteranomaly: ["#4cd676", "#533eb6", "#b32517", "#c877ea", "#2c9a88", "#1c5757", "#e86518", "#a53d9f", "#ff8fb4", "#2885ef"],
    tritanopia: ["#4cd676", "#9f0c54", "#ff8fb4", "#117555", "#9b7998", "#dd503f", "#2885ef", "#a6b186", "#6b4c68", "#995f2c"],
    tritanomaly: ["#4cd676", "#9f0c54", "#f689ed", "#117555", "#6887ff", "#a77971", "#6a34ab", "#dab33a", "#f6722b", "#9eb5f8"],
    achromatopsia: ["#4cd676", "#235466", "#a57785", "#c13425", "#8fa782"],
  },
};

const soft = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

export function isDark() {
  const set = document.documentElement.getAttribute('data-theme');
  if (set) return set === 'dark';
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Point the page's meaning colours at `form`'s set (or back to the stylesheet's). */
export function applyForm(form) {
  const root = document.documentElement;
  root.setAttribute('data-cvd', form);
  const fam = FAMILY[form];
  const vars = ['--accent', '--accent-soft', '--anc', '--done', '--done-soft', '--desc'];
  if (!fam) { vars.forEach((v) => root.style.removeProperty(v)); return; }
  const m = MEANING[isDark() ? 'dark' : 'light'][fam];
  root.style.setProperty('--accent', m.accent);
  root.style.setProperty('--anc', m.accent);
  root.style.setProperty('--accent-soft', soft(m.accent, 0.16));
  root.style.setProperty('--done', m.done);
  root.style.setProperty('--done-soft', soft(m.done, 0.16));
  root.style.setProperty('--desc', m.desc);
}

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 3600007;
  return h;
}

/** The colour a mod's dots get under `form`. */
export function modColor(mod, form) {
  const pal = MODS[isDark() ? 'dark' : 'light'][form];
  if (pal) return pal[hash(String(mod)) % pal.length];
  // typical vision: the hue the page has always used for this mod
  let h = 0;
  const str = String(mod);
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return `hsl(${h}, 42%, 52%)`;
}
