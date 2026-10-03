// The colour-vision palettes stay distinct for the forms they serve, measured
// the way they were chosen: Machado et al. (2009) simulation, OKLab ΔE ×100.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMS, FAMILY, MEANING, MODS } from '../cvd.js';

const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};
const SIM = {
  protanopia: ['protan', 1], protanomaly: ['protan', 0.6], deuteranopia: ['deutan', 1], deuteranomaly: ['deutan', 0.6],
  tritanopia: ['tritan', 1], tritanomaly: ['tritan', 0.6], achromatopsia: 'mono',
};
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (h) => [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255));
function simulate(c, form) {
  const f = SIM[form];
  if (f === 'mono') { const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; return [y, y, y]; }
  const [kind, s] = f;
  return MACHADO[kind].map((row, i) => Math.min(1, Math.max(0,
    row.reduce((t, v, j) => t + (s * v + (1 - s) * (i === j ? 1 : 0)) * c[j], 0))));
}
function oklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
const dE = (a, b, form) => {
  const A = oklab(simulate(rgb(a), form)), B = oklab(simulate(rgb(b), form));
  return 100 * Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
};
const Y = (h) => { const [r, g, b] = rgb(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [Y(a), Y(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const SURFACE = { light: '#f4efe4', dark: '#17150f' };

test('there are seven forms besides typical vision, each with colours for both themes', () => {
  const forms = FORMS.map(([k]) => k).filter((k) => k !== 'normal');
  assert.equal(forms.length, 7);
  for (const f of forms) {
    assert.ok(FAMILY[f], f);
    for (const theme of ['light', 'dark']) { assert.ok(MEANING[theme][FAMILY[f]], `${theme} ${f}`); assert.ok(MODS[theme][f], `${theme} ${f}`); }
  }
});

test('the meaning colours stay apart for every form they serve, and stand out from the page', () => {
  for (const [theme, fams] of Object.entries(MEANING)) {
    for (const [fam, m] of Object.entries(fams)) {
      for (const c of Object.values(m)) assert.ok(contrast(c, SURFACE[theme]) >= 3, `${theme} ${fam} ${c} contrast`);
      for (const form of Object.keys(FAMILY).filter((f) => FAMILY[f] === fam)) {
        for (const [a, b] of [['done', 'accent'], ['accent', 'desc'], ['done', 'desc']]) {
          const d = dE(m[a], m[b], form);
          assert.ok(d >= 10, `${theme} ${form} ${a}/${b} ΔE ${d.toFixed(1)}`);
        }
      }
    }
  }
});

test('each form\'s mod colours stay apart for that form', () => {
  for (const [theme, forms] of Object.entries(MODS)) {
    for (const [form, pal] of Object.entries(forms)) {
      let worst = Infinity;
      for (let i = 0; i < pal.length; i++) for (let j = i + 1; j < pal.length; j++) worst = Math.min(worst, dE(pal[i], pal[j], form));
      assert.ok(worst >= (form === 'achromatopsia' ? 7.5 : 9), `${theme} ${form} worst ΔE ${worst.toFixed(1)}`);
    }
  }
});
