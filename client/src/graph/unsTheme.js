/**
 * UNS topology themes. Every colour the canvas draws comes from one of these
 * token sets, so there are no hard-coded colours in the draw path. The dark
 * theme is the default (it matches the rest of the app); light is a toggle.
 */

export const THEME_KEY = 'tc.unsTheme';

export const UNS_THEMES = {
  dark: {
    mode: 'dark',
    bg: '#0b1220',
    dot: '#1e293b',
    badgeFill: '#131c30',
    badgeShadow: 'rgba(0,0,0,0.45)',
    halo: '#0b1220',
    edge: 'rgba(148,163,184,0.38)',
    edgeLive: 'rgba(74,222,128,0.85)',
    pulse: [74, 222, 128],
    name: '#f1f5f9',
    sub: '#a8b3c5', // level caption
    count: '#a8b3c5',
    rate: '#4ade80',
    value: '#5eead4',
    valueOverdue: '#fbbf24',
    valueDead: '#f87171',
    selected: '#fbbf24',
    multiSel: '56,189,248',
    toggleFill: '#131c30',
    toggleStroke: '#64748b',
    toggleInk: '#cbd5e1',
    statusLive: '#4ade80',
    statusOverdue: '#fbbf24',
    statusDead: '#f87171',
    statusRing: '#0b1220',
    // DOM chrome that floats over the canvas
    chip: 'border-white/10 bg-surface-900/85 text-slate-200 backdrop-blur',
    chipLive: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 backdrop-blur',
    toolbar: 'border-white/10 bg-surface-900/85 text-slate-200 hover:border-white/25 hover:text-white backdrop-blur',
    legend: 'border-white/10 bg-surface-900/85 text-slate-300 backdrop-blur',
    legendFill: 'bg-surface-900',
    legendMuted: 'text-slate-400',
    sel: 'border-sky-400/50 bg-sky-500/15 text-sky-200'
  },
  light: {
    mode: 'light',
    bg: '#f6f7f9',
    dot: '#dce1e8',
    badgeFill: '#ffffff',
    badgeShadow: 'rgba(15,23,42,0.10)',
    halo: '#f6f7f9',
    edge: 'rgba(100,116,139,0.5)',
    edgeLive: 'rgba(22,163,74,0.85)',
    pulse: [34, 197, 94],
    name: '#0f172a',
    sub: '#475569',
    count: '#4b5a70',
    rate: '#15803d',
    value: '#0f766e',
    valueOverdue: '#92400e',
    valueDead: '#b91c1c',
    selected: '#d97706',
    multiSel: '14,116,144',
    toggleFill: '#ffffff',
    toggleStroke: '#94a3b8',
    toggleInk: '#475569',
    statusLive: '#16a34a',
    statusOverdue: '#d97706',
    statusDead: '#dc2626',
    statusRing: '#ffffff',
    chip: 'border-slate-300 bg-white/90 text-slate-700 backdrop-blur',
    chipLive: 'border-emerald-300 bg-emerald-50 text-emerald-800 backdrop-blur',
    toolbar: 'border-slate-300/70 bg-white/90 text-slate-700 hover:border-slate-400 hover:text-slate-900 backdrop-blur',
    legend: 'border-slate-300/60 bg-white/90 text-slate-700 backdrop-blur',
    legendFill: 'bg-white',
    legendMuted: 'text-slate-600',
    sel: 'border-sky-500/50 bg-sky-50 text-sky-800'
  }
};

export function loadUnsTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function saveUnsTheme(mode) {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // persistence is best-effort
  }
}

// ---- WCAG contrast (used by tests and to guard theme edits) -------------------

function channel(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, (x) => x + x) : h, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
