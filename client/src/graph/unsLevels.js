/**
 * UNS level naming. Pure (no store, no DOM) so it can be unit-tested.
 *
 * ISA-95 style levels (Enterprise, Site, Area, ...) apply to a user's own
 * topic hierarchy. Two branches are NOT part of that hierarchy and must never
 * be labelled with ISA-95 names:
 *   - `spBv1.0/...`  the Sparkplug B namespace: spBv1.0 / group / message type /
 *                    edge node / device (or spBv1.0 / STATE / host id)
 *   - `$SYS/...`     broker internals (any top-level segment starting with `$`)
 */

export const DEFAULT_LEVELS = ['Unified Namespace', 'Business Unit', 'Site', 'Area', 'Line', 'Cell', 'Node'];
// Level ring colours come from the data palette (dataPalette.js) for the
// current theme's tokens, so they follow the app theme.
import { FALLBACK_TOKENS } from './canvasTokens';
import { levelPalette } from './dataPalette';

/** A token snapshot, or 'dark' / 'light' for the static fallback tokens. */
const toTokens = (t) => (t && typeof t === 'object' ? t : FALLBACK_TOKENS[t === 'dark' ? 'dark' : 'light']);

export const SPARKPLUG_NAMESPACE = 'spBv1.0';

/** Which naming scheme a node path belongs to: 'isa95' | 'sparkplug' | 'system'. */
export function namespaceKind(path) {
  if (!path) return 'isa95';
  const first = String(path).split('/', 1)[0];
  if (first === SPARKPLUG_NAMESPACE) return 'sparkplug';
  if (first.startsWith('$')) return 'system';
  return 'isa95';
}

export function levelName(depth, levels = DEFAULT_LEVELS) {
  return levels[Math.min(depth, levels.length - 1)];
}

export function levelColor(depth, tokens = 'light') {
  const set = levelPalette(toTokens(tokens)).levels;
  return set[Math.min(depth, set.length - 1)];
}

/**
 * Sparkplug segment role by depth. `segs` are the path segments of the node.
 * spBv1.0/<group>/<NBIRTH|NDATA|DBIRTH|...>/<edge node>[/<device>][/<metric...>]
 * spBv1.0/STATE/<host application id>
 */
export function sparkplugLevelName(segs) {
  const depth = segs.length;
  if (depth <= 1) return 'Sparkplug namespace';
  if (segs[1] === 'STATE') return depth === 2 ? 'Host state' : 'Host application';
  if (depth === 2) return 'Sparkplug group';
  if (depth === 3) return 'Message type';
  if (depth === 4) return 'Edge node';
  const msgType = String(segs[2] || '');
  if (depth === 5 && msgType.startsWith('D')) return 'Device';
  return 'Metric';
}

/**
 * Level info for a UNS tree node ({ path, depth }): the caption, the kind of
 * namespace it lives in, and its ring colour (for `tokens`: a canvasTokens
 * snapshot, or 'dark' / 'light'). ISA-95 names are used only for nodes in the
 * ISA-95 part of the forest.
 */
export function nodeLevel(node, levels = DEFAULT_LEVELS, tokens = 'light') {
  const tk = toTokens(tokens);
  const kind = namespaceKind(node.path);
  if (kind === 'sparkplug') {
    return { kind, name: sparkplugLevelName(String(node.path).split('/')), color: levelPalette(tk).sparkplug };
  }
  if (kind === 'system') {
    return { kind, name: node.depth <= 1 ? 'System' : 'System topic', color: levelPalette(tk).system };
  }
  return { kind, name: levelName(node.depth, levels), color: levelColor(node.depth, tk) };
}

/** Icon name for a non-ISA-95 node, or null to fall back to the usual rules. */
export function namespaceIconName(node) {
  const kind = namespaceKind(node.path);
  if (kind === 'system') return 'settings';
  if (kind !== 'sparkplug') return null;
  const lvl = sparkplugLevelName(String(node.path).split('/'));
  switch (lvl) {
    case 'Sparkplug namespace':
      return 'radio-tower';
    case 'Sparkplug group':
      return 'boxes';
    case 'Host state':
    case 'Host application':
      return 'server';
    case 'Message type':
      return 'activity';
    case 'Edge node':
      return 'network';
    case 'Device':
      return 'cpu';
    default:
      return 'gauge';
  }
}
