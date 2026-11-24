import { useSyncExternalStore } from 'react';

/**
 * Colour theme: 'system' | 'light' | 'dark', persisted in localStorage
 * ('tc.theme'), applied as <html data-theme="light|dark">. public/theme-init.js
 * does the same before the first paint; this module keeps it current at runtime
 * (preference changes, and OS changes while on 'system').
 */
export const THEME_KEY = 'tc.theme';
export const THEME_PREFS = ['system', 'light', 'dark'];

const listeners = new Set();
const lightQuery = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null);

function readPref() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return THEME_PREFS.includes(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

let pref = typeof window === 'undefined' ? 'system' : readPref();

export function resolveTheme(p = pref) {
  if (p === 'light' || p === 'dark') return p;
  return lightQuery()?.matches ? 'light' : 'dark';
}

function apply() {
  if (typeof document === 'undefined') return;
  const theme = resolveTheme();
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

function emit() {
  apply();
  for (const l of listeners) l();
}

export function setThemePreference(next) {
  if (!THEME_PREFS.includes(next)) return;
  pref = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* not persisted: still applied for this session */
  }
  emit();
}

let mqBound = false;
function subscribe(cb) {
  listeners.add(cb);
  if (!mqBound) {
    mqBound = true;
    lightQuery()?.addEventListener?.('change', () => pref === 'system' && emit());
    window.addEventListener('storage', (e) => {
      if (e.key === THEME_KEY) {
        pref = readPref();
        emit();
      }
    });
  }
  return () => listeners.delete(cb);
}

const snapshot = () => `${pref}:${resolveTheme()}`;

/** [{ preference, theme }, setPreference] */
export function useTheme() {
  const snap = useSyncExternalStore(subscribe, snapshot, () => 'system:dark');
  const [preference, theme] = snap.split(':');
  return [{ preference, theme }, setThemePreference];
}
