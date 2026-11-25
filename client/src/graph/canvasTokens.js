import { useSyncExternalStore } from 'react';
import { parseColor, toHex } from './colorMath';

/**
 * Design tokens for canvas renderers.
 *
 * A canvas cannot use `rgb(var(--token))`, so the renderers read the design
 * system's custom properties (client/src/index.css) ONCE per theme change from
 * the computed style of <html>, convert them to hex and cache the result. Every
 * canvas theme object (unsTheme.js, graphStyles.js, CHART_THEME in charts.jsx)
 * is derived from this one snapshot, so a "bad" node is the same red as a
 * "bad" badge, and switching the app theme recolours every canvas.
 *
 * The snapshot changes when <html data-theme|class|style> changes (the app's
 * theme switch, lib/theme.js), when `prefers-contrast` / `prefers-color-scheme`
 * change, and on a storage event from another tab. `useCanvasTokens()` re-renders
 * its component with the new snapshot; renderers then repaint in place (no scene
 * rebuild, camera and selection kept).
 *
 * FALLBACK mirrors index.css for environments without CSS (unit tests, the very
 * first render before styles load); src/test/canvasTheme.test.js asserts the two
 * stay identical.
 */

// The design system's faces (self-hosted, see index.css), with system fallbacks.
export const FONT = "'IBM Plex Sans Variable', ui-sans-serif, system-ui, sans-serif";
export const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

export const TOKEN_NAMES = [
  'bg',
  'panel',
  'raised',
  'overlay',
  'border',
  'border-strong',
  'border-stronger',
  'text',
  'text-muted',
  'text-subtle',
  'text-faint',
  'accent',
  'accent-text',
  'accent-fg',
  'good',
  'warn',
  'bad',
  'info',
  'aux',
  'control-off'
];

export const FALLBACK = {
  dark: {
    bg: '#0f0f10',
    panel: '#161617',
    raised: '#1e1e20',
    overlay: '#232325',
    border: '#2a2a2d',
    'border-strong': '#3a3a3e',
    'border-stronger': '#4a4a4f',
    text: '#ececee',
    'text-muted': '#a3a3a9',
    'text-subtle': '#8f8f95',
    'text-faint': '#85858b',
    accent: '#2cc5cf',
    'accent-text': '#4fd2db',
    'accent-fg': '#04191b',
    good: '#3fc184',
    warn: '#e3a33a',
    bad: '#f06a63',
    info: '#6aa6f8',
    aux: '#b39af5',
    'control-off': '#6b6b72'
  },
  light: {
    bg: '#f6f6f7',
    panel: '#ffffff',
    raised: '#f0f0f2',
    overlay: '#ffffff',
    border: '#e2e2e5',
    'border-strong': '#cdcdd2',
    'border-stronger': '#a9a9b0',
    text: '#17171a',
    'text-muted': '#55555c',
    'text-subtle': '#64646b',
    'text-faint': '#6b6b72',
    accent: '#00747d',
    'accent-text': '#006d75',
    'accent-fg': '#ffffff',
    good: '#137a48',
    warn: '#975a00',
    bad: '#c4282e',
    info: '#1f5fc2',
    aux: '#6b47c9',
    'control-off': '#8e8e96'
  }
};

const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** Normalise a { 'text-muted': '#..' } map into a frozen token snapshot with camelCase keys. */
export function makeTokens(mode, raw) {
  const out = { mode };
  for (const name of TOKEN_NAMES) out[camel(name)] = raw[name] || FALLBACK[mode][name];
  return Object.freeze(out);
}

export const FALLBACK_TOKENS = { dark: makeTokens('dark', FALLBACK.dark), light: makeTokens('light', FALLBACK.light) };

function currentMode() {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function readTokens() {
  const mode = currentMode();
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return FALLBACK_TOKENS[mode];
  const cs = getComputedStyle(document.documentElement);
  const raw = {};
  for (const name of TOKEN_NAMES) {
    const c = parseColor(cs.getPropertyValue(`--${name}`));
    if (c) raw[name] = toHex(c);
  }
  return makeTokens(mode, raw);
}

let snapshot = null;
let signature = '';
const listeners = new Set();
let bound = false;

function refresh() {
  const next = readTokens();
  const sig = JSON.stringify(next);
  if (sig === signature && snapshot) return false;
  signature = sig;
  snapshot = next;
  return true;
}

function notify() {
  if (refresh()) for (const l of listeners) l();
}

function bind() {
  if (bound || typeof window === 'undefined' || typeof document === 'undefined') return;
  bound = true;
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(notify).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  }
  for (const q of ['(prefers-contrast: more)', '(prefers-color-scheme: light)']) window.matchMedia?.(q)?.addEventListener?.('change', notify);
  window.addEventListener('storage', notify);
}

/** The current token snapshot (cached; a new object only when a value changed). */
export function getCanvasTokens() {
  if (!snapshot) refresh();
  return snapshot;
}

export function subscribeCanvasTokens(cb) {
  bind();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** React hook: the token snapshot, re-rendering when the app theme changes. */
export function useCanvasTokens() {
  return useSyncExternalStore(subscribeCanvasTokens, getCanvasTokens, () => FALLBACK_TOKENS.dark);
}
