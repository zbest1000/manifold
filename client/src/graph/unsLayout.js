/**
 * Pure layout / camera / hit-testing helpers for the UNS topology canvas.
 * No DOM, no React: everything takes plain data so it can be unit-tested.
 */
import { isMountNode } from './unsTree';

export const ROW_H = 108; // covers the badge PLUS its three-line label block
export const COL_W = 224;
export const R = 21; // node radius
export const MIN_K = 0.2;
export const MAX_FIT_K = 1.4;

export const nodeKey = (n) => `${n.brokerId}:${n.path}`;

/** Initial expansion: namespace + first level for brokers; mounts stay collapsed. */
export function seedExpansion(roots) {
  const keys = [];
  for (const r of roots) {
    if (isMountNode(r)) continue; // OPC UA / i3X mounts seed collapsed (root only)
    keys.push(`${r.brokerId}:`);
    for (const child of r.children.values()) keys.push(`${child.brokerId}:${child.path}`);
  }
  return keys;
}

/** Tidy horizontal tree over the EXPANDED portion of the forest. */
export function layoutForest(roots, expanded) {
  const nodes = [];
  const edges = [];
  let cursorY = 0;
  const isOpen = (n) => expanded.has(nodeKey(n));

  const rows = (n) => {
    if (!isOpen(n) || n.children.size === 0) return 1;
    let sum = 0;
    for (const c of n.children.values()) sum += rows(c);
    return Math.max(sum, 1);
  };

  const place = (n, x, top) => {
    const span = rows(n) * ROW_H;
    const y = top + span / 2;
    const laid = { node: n, x, y, open: isOpen(n), hasKids: n.children.size > 0 };
    nodes.push(laid);
    if (isOpen(n)) {
      let childTop = top;
      // Stable, meaningful order: subtree size desc, then name.
      const kids = [...n.children.values()].sort((a, b) => b.topicCount - a.topicCount || a.name.localeCompare(b.name));
      for (const c of kids) {
        const cLaid = place(c, x + COL_W, childTop);
        edges.push({ from: laid, to: cLaid });
        childTop += rows(c) * ROW_H;
      }
    }
    return laid;
  };

  for (const r of roots) {
    place(r, 0, cursorY);
    cursorY += rows(r) * ROW_H + ROW_H; // gap between namespaces
  }
  return { nodes, edges, height: cursorY };
}

/**
 * Camera transform that frames `laidNodes` in a w x h viewport. Mounted sources
 * (deep OPC UA / i3X trees) are excluded from the fit whenever any other node
 * exists, so a few hundred mount nodes can't shrink the broker trees to dust.
 */
export function fitTransform(laidNodes, posOf, { w, h }, { excludeMounts = true } = {}) {
  if (!laidNodes.length || !w) return null;
  let use = laidNodes;
  if (excludeMounts) {
    const brokerOnly = laidNodes.filter((l) => !isMountNode(l.node));
    if (brokerOnly.length) use = brokerOnly;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of use) {
    const p = posOf(l);
    minX = Math.min(minX, p.x - 70);
    maxX = Math.max(maxX, p.x + 70);
    minY = Math.min(minY, p.y - R - 10);
    maxY = Math.max(maxY, p.y + R + 56); // label block below the badge
  }
  const k = Math.max(MIN_K, Math.min(MAX_FIT_K, Math.min((w - 60) / Math.max(maxX - minX, 1), (h - 120) / Math.max(maxY - minY, 1))));
  return { k, x: w / 2 - (k * (minX + maxX)) / 2, y: (h - 60) / 2 - (k * (minY + maxY)) / 2 } // leaves room for the legend along the bottom;
}

/** The laid node under a world-space point, or null. */
export function pickNode(laidNodes, posOf, pt) {
  const reach = (R + 10) * (R + 10);
  for (const l of laidNodes) {
    const P = posOf(l);
    const dx = pt.x - P.x;
    const dy = pt.y - P.y;
    if (dx * dx + dy * dy <= reach) return l;
  }
  return null;
}

/** Is a world point on the +/- affordance below a node's badge? */
export function onToggleAffordance(l, P, p) {
  return l.hasKids && p.y > P.y + R - 6 && Math.abs(p.x - P.x) < 12;
}
