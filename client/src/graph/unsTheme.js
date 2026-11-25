/**
 * UNS topology theme: THE colour source for the namespace canvas (unsDraw.js
 * draws nothing that is not in here). Derived from the design tokens at runtime
 * (canvasTokens.js) plus the data palette (dataPalette.js), so the canvas IS
 * the page: its background is the page surface, labels are the text tokens,
 * selection is the accent, and node states are exactly the good / warn / bad
 * tokens a StatusText uses.
 */
import { FALLBACK_TOKENS } from './canvasTokens';
import { levelPalette } from './dataPalette';
import { mix, parseColor } from './colorMath';

export { contrastRatio, luminance } from './colorMath';

const rgbTriplet = (hex) => (parseColor(hex) || [0, 0, 0]).join(',');

const cache = new WeakMap();

/** The UNS canvas theme for a token snapshot (memoised per snapshot). */
export function buildUnsTheme(tokens) {
  const hit = cache.get(tokens);
  if (hit) return hit;
  const dark = tokens.mode !== 'light';
  const lv = levelPalette(tokens);
  const theme = {
    mode: tokens.mode,
    bg: tokens.bg, // the page surface: the canvas is part of the page, not a slab
    // Dot grid: a hairline-strength step from the surface.
    dot: mix(tokens.bg, tokens.borderStrong, dark ? 0.55 : 0.7),
    badgeFill: tokens.panel,
    badgeShadow: dark ? 'rgba(0,0,0,0.5)' : 'rgba(23,23,26,0.10)',
    halo: tokens.bg,
    edge: tokens.borderStronger,
    edgeLive: tokens.good,
    pulse: parseColor(tokens.good),
    name: tokens.text,
    sub: tokens.textSubtle, // level caption
    count: tokens.textMuted,
    rate: tokens.good,
    value: tokens.text,
    valueOverdue: tokens.warn,
    valueDead: tokens.bad,
    selected: tokens.accent,
    selectedHalo: rgbTriplet(tokens.accent),
    multiSel: rgbTriplet(tokens.accentText),
    hover: tokens.borderStronger,
    toggleFill: tokens.panel,
    toggleStroke: tokens.borderStronger,
    toggleInk: tokens.textMuted,
    statusLive: tokens.good,
    statusOverdue: tokens.warn,
    statusDead: tokens.bad,
    statusRing: tokens.bg,
    levels: lv.levels,
    sparkplug: lv.sparkplug,
    system: lv.system
  };
  cache.set(tokens, theme);
  return theme;
}

/** Static dark / light themes from the fallback tokens (tests, first paint). */
export const UNS_THEMES = { dark: buildUnsTheme(FALLBACK_TOKENS.dark), light: buildUnsTheme(FALLBACK_TOKENS.light) };
