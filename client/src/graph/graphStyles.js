/**
 * Visual styles for the node graphs: THE theme object for the 2D canvas graph
 * (ForceGraph), the WebGL big-graph renderer and the three.js 3D view. Every
 * colour those renderers draw comes from the resolved style (no literals in
 * draw paths).
 *
 * Styles are derived at runtime from the design tokens (canvasTokens.js) and
 * the data palette (dataPalette.js), so they follow the app theme: the canvas
 * background is the page surface, labels are the text tokens, selection is the
 * accent, message flow is the good state colour. A style only changes the
 * drawing language (shape, grid, how much colour), never the theme:
 *
 *   standard    filled discs coloured by node group
 *   schematic   square nodes on a fine grid, for structure-first reading
 *   mono        neutral nodes: colour is left to selection, search and flow
 *
 * Older preset ids (constellation, blueprint, aurora, neon, circuit, slate),
 * still stored in users' settings, resolve to the closest new style.
 */
import { FALLBACK_TOKENS, FONT, getCanvasTokens } from './canvasTokens';
import { SERIES } from './dataPalette';
import { mix, withAlpha } from './colorMath';

const PRESETS = {
  standard: { id: 'standard', name: 'Standard', description: 'Discs coloured by node group on the page surface.' },
  schematic: { id: 'schematic', name: 'Schematic', description: 'Square nodes on a fine grid, for reading structure.' },
  mono: { id: 'mono', name: 'Monochrome', description: 'Neutral nodes; colour only for selection, search and flow.' }
};

export const LEGACY_STYLE_IDS = { constellation: 'standard', aurora: 'standard', neon: 'standard', blueprint: 'schematic', circuit: 'schematic', slate: 'mono' };
export const DEFAULT_STYLE = 'standard';

/** A stored style id (current or legacy) -> a current preset id. */
export function resolveStyleId(id) {
  if (PRESETS[id]) return id;
  return LEGACY_STYLE_IDS[id] || DEFAULT_STYLE;
}

const cache = new WeakMap();

/** The full style object for a preset id and a token snapshot (memoised). */
export function resolveGraphStyle(styleId, tokens = getCanvasTokens()) {
  const id = resolveStyleId(styleId);
  let per = cache.get(tokens);
  if (!per) {
    per = {};
    cache.set(tokens, per);
  }
  if (per[id]) return per[id];
  const dark = tokens.mode !== 'light';
  const s = SERIES[dark ? 'dark' : 'light'];
  const mono = id === 'mono';
  // Node group colours, in buildGraph's GROUP_ORDER:
  // broker, server, topic (branch), telemetry, data, command, config, alarm, sparkplug.
  // Structure (hubs, branches) and plain data leaves stay neutral; only the
  // categories that mean something (telemetry, command, config, alarm,
  // Sparkplug) take a data-palette hue, and state keeps its own colours.
  const palette = mono
    ? [tokens.text, tokens.text, tokens.textSubtle, tokens.textMuted, tokens.textMuted, tokens.textMuted, tokens.textMuted, tokens.textMuted, tokens.textMuted]
    : [tokens.text, tokens.text, tokens.textFaint, s[0], tokens.textMuted, s[1], s[2], s[5], s[7]];
  const style = {
    ...PRESETS[id],
    linkWidth: 1,
    nodeMinRadius: 4,
    nodeMaxRadius: 20,
    labelFont: `400 12px ${FONT}`,
    showLabelsAtZoom: 0.75,
    background: tokens.bg,
    grid: id === 'schematic' ? { color: withAlpha(tokens.borderStrong, dark ? 0.55 : 0.6), size: 28 } : null,
    link: { color: dark ? mix(tokens.bg, tokens.borderStronger, 0.9) : mix(tokens.bg, tokens.borderStronger, 0.85), width: 1 },
    linkHighlight: tokens.accent,
    flow: tokens.good,
    node: { glow: 0, stroke: tokens.bg, strokeWidth: 1.25, square: id === 'schematic' },
    palette,
    protocol: { mqtt: s[0], opcua: s[2], i3x: s[4] },
    label: { color: tokens.textMuted, halo: tokens.bg, strong: tokens.text },
    value: tokens.text,
    selectedRing: tokens.accent,
    badgeFill: tokens.raised,
    badgeInk: tokens.text,
    badgeBorder: tokens.borderStrong,
    // Minimap: a floating panel like the rest of the chrome (solid, hairline).
    minimap: { bg: tokens.panel, border: tokens.borderStrong },
    // three.js: lights and the neutral base the per-instance colours multiply.
    scene3d: { ambient: '#ffffff', directional: '#ffffff', nodeBase: '#ffffff', ambientIntensity: dark ? 0.9 : 1.0, directionalIntensity: dark ? 1.1 : 0.6 },
    mode: tokens.mode
  };
  per[id] = style;
  return style;
}

/**
 * Live preset views for code that reads a style outside a renderer (the Settings
 * picker, the legend): each property resolves against the CURRENT tokens.
 */
function liveStyle(id) {
  const o = {};
  for (const key of Object.keys(resolveGraphStyle(id, FALLBACK_TOKENS.dark))) {
    Object.defineProperty(o, key, { enumerable: true, get: () => resolveGraphStyle(id)[key] });
  }
  return o;
}

export const GRAPH_STYLES = {};
for (const id of Object.keys(PRESETS)) GRAPH_STYLES[id] = liveStyle(id);
for (const [legacy, id] of Object.entries(LEGACY_STYLE_IDS)) GRAPH_STYLES[legacy] = GRAPH_STYLES[id];

export const STYLE_LIST = Object.keys(PRESETS).map((id) => GRAPH_STYLES[id]);

// Layout presets. `mode` selects the positioning strategy; the force fields
// (charge/linkDistance/gravity) tune the three free-form force layouts.
export const LAYOUTS = {
  organic: { id: 'organic', name: 'Organic', mode: 'force', charge: -220, linkDistance: 55, gravity: 0.05 },
  spacious: { id: 'spacious', name: 'Spacious', mode: 'force', charge: -520, linkDistance: 110, gravity: 0.03 },
  tight: { id: 'tight', name: 'Tight', mode: 'force', charge: -120, linkDistance: 34, gravity: 0.09 },
  radial: { id: 'radial', name: 'Radial', mode: 'radial', charge: -160, linkDistance: 50, ringGap: 120 },
  tree: { id: 'tree', name: 'Tree', mode: 'tree', rowGap: 96, colGap: 76 },
  cluster: { id: 'cluster', name: 'Cluster', mode: 'cluster', charge: -90, linkDistance: 40, clusterRadius: 260 }
};

export const LAYOUT_LIST = Object.values(LAYOUTS);
export const DEFAULT_LAYOUT = 'organic';
