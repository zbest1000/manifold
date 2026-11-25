/**
 * Colour math for the canvas themes (pure, unit-tested in src/test/canvasTheme.test.js):
 * hex / rgb parsing, WCAG relative luminance and contrast, colour-vision
 * deficiency simulation and a perceptual distance (CIEDE2000), so the data
 * palette can be VALIDATED numerically instead of eyeballed.
 */

/** '#rgb' | '#rrggbb' | 'r g b' | 'rgb(r,g,b)' | 'rgba(...)' -> [r, g, b] (0..255) or null. */
export function parseColor(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (s[0] === '#') {
    const h = s.slice(1);
    const full = h.length === 3 ? h.replace(/./g, (x) => x + x) : h.slice(0, 6);
    if (!/^[0-9a-f]{6}$/i.test(full)) return null;
    const n = parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s) || /^([\d.]+)\s+([\d.]+)\s+([\d.]+)$/.exec(s);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])].map((v) => Math.max(0, Math.min(255, Math.round(v))));
}

export function toHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

/** rgba() string for a colour at an alpha. */
export function withAlpha(color, a) {
  const c = parseColor(color) || [0, 0, 0];
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

/** Linear interpolation between two colours (0 = a, 1 = b) as hex. */
export function mix(a, b, t) {
  const ca = parseColor(a) || [0, 0, 0];
  const cb = parseColor(b) || [0, 0, 0];
  return toHex(ca.map((v, i) => v + (cb[i] - v) * t));
}

const toLin = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLin = (c) => {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, v * 255));
};

export function luminance(color) {
  const c = parseColor(color) || [0, 0, 0];
  const [r, g, b] = c.map(toLin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio of two colours (1..21). */
export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Machado, Oliveira & Fernandes (2009) full-severity matrices, applied in linear RGB.
const CVD = {
  protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritan: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039]
};
export const VISION_MODES = ['normal', 'protan', 'deutan', 'tritan'];

/** The colour as seen with a colour-vision deficiency ('normal' returns it unchanged). */
export function simulateCvd(color, mode) {
  const c = parseColor(color) || [0, 0, 0];
  const m = CVD[mode];
  if (!m) return toHex(c);
  const [r, g, b] = c.map(toLin);
  return toHex([m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b].map((v) => fromLin(Math.max(0, Math.min(1, v)))));
}

function toLab(color) {
  const [r, g, b] = (parseColor(color) || [0, 0, 0]).map(toLin);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 colour difference (about 2.3 = just noticeable; above 10 = clearly different). */
export function deltaE(a, b) {
  const [L1, a1, b1] = toLab(a);
  const [L2, a2, b2] = toLab(b);
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const ap1 = (1 + G) * a1;
  const ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1);
  const Cp2 = Math.hypot(ap2, b2);
  const hp = (x, y) => {
    if (x === 0 && y === 0) return 0;
    const h = Math.atan2(y, x) / rad;
    return h < 0 ? h + 360 : h;
  };
  const hp1 = hp(ap1, b1);
  const hp2 = hp(ap2, b2);
  const dL = L2 - L1;
  const dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh * rad) / 2);
  const Lm = (L1 + L2) / 2;
  const Cpm = (Cp1 + Cp2) / 2;
  let hm = hp1 + hp2;
  if (Cp1 * Cp2 !== 0) {
    if (Math.abs(hp1 - hp2) > 180) hm = hp1 + hp2 < 360 ? (hp1 + hp2 + 360) / 2 : (hp1 + hp2 - 360) / 2;
    else hm = (hp1 + hp2) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const Sc = 1 + 0.045 * Cpm;
  const Sh = 1 + 0.015 * Cpm * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

/**
 * Palette report: per vision mode, the smallest CIEDE2000 distance between
 * ADJACENT slots (i, i+1) and between ANY two slots, plus each colour's WCAG
 * contrast against `bg`.
 */
export function paletteReport(colors, bg) {
  const out = { contrast: colors.map((c) => contrastRatio(c, bg)), adjacent: {}, any: {} };
  for (const mode of VISION_MODES) {
    const sim = colors.map((c) => simulateCvd(c, mode));
    let adj = Infinity;
    let any = Infinity;
    for (let i = 0; i < sim.length; i++) {
      if (i + 1 < sim.length) adj = Math.min(adj, deltaE(sim[i], sim[i + 1]));
      for (let j = i + 1; j < sim.length; j++) any = Math.min(any, deltaE(sim[i], sim[j]));
    }
    out.adjacent[mode] = adj;
    out.any[mode] = any;
  }
  return out;
}
