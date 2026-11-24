/**
 * Pure layout / camera / hit-testing helpers for the UNS topology canvas.
 * No DOM, no React: everything takes plain data so it can be unit-tested
 * (src/test/unsHelpers.test.js, canvasKit.test.js, unsCamera.test.js).
 */
import { isMountNode } from './unsTree';

export const ROW_H = 108; // covers the badge PLUS its three-line label block
export const COL_W = 224;
export const R = 21; // node radius
export const MIN_K = 0.2;
export const MAX_FIT_K = 1.4;
// Smallest zoom a reveal may leave the camera at: 13 px names stay >= 10 px
// and 11 px captions >= 8.8 px. Below this a reveal pans instead of zooming.
export const MIN_READ_K = 0.8;
// A branch with more child rows than this puts its node next to its FIRST
// children instead of the middle of the block, so opening a long list shows
// the node together with the start of the list.
export const LONG_BRANCH = 12;
// Children shown per page when a branch is opened; a "N more" row pages on.
export const PAGE_SIZE = 50;
// Fallback insets (CSS px) when the overlays could not be measured.
export const FIT_INSET = { top: 52, bottom: 72, side: 56 };
// The world-space box a node occupies on screen: badge plus its label block.
const LABEL_HALF = (COL_W - 40) / 2;
export const NODE_BOX = { left: LABEL_HALF, right: LABEL_HALF, top: R + 8, bottom: R + 58 };

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

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Sibling order: by name (natural: line2 before line10). Deliberately NOT by
 * live topic count, which changes on every data flush and used to reorder a
 * branch while the user was reading it.
 */
export const compareSiblings = (a, b) => collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Placeholder row for the children of `parent` beyond the shown page. */
function moreNode(parent, hidden) {
  return {
    id: `${parent.id}#more`,
    name: `${hidden.toLocaleString()} more`,
    path: `${parent.path ? `${parent.path}/` : ''}…more`,
    brokerId: parent.brokerId,
    depth: parent.depth + 1,
    children: new Map(),
    topicCount: 0,
    isMore: true,
    parentKey: nodeKey(parent),
    hidden
  };
}

/**
 * Tidy horizontal tree over the EXPANDED portion of the forest. An open node
 * shows its first `limits.get(key) ?? PAGE_SIZE` children (by name) and, if
 * there are more, one "N more" placeholder row that pages on when activated.
 */
export function layoutForest(roots, expanded, limits = null) {
  const nodes = [];
  const edges = [];
  let cursorY = 0;
  const isOpen = (n) => !n.isMore && expanded.has(nodeKey(n));
  const sortedCache = new Map();
  const shownKids = (n) => {
    let kids = sortedCache.get(n);
    if (!kids) {
      const all = [...n.children.values()].sort(compareSiblings);
      const limit = Math.max(1, limits?.get(nodeKey(n)) ?? PAGE_SIZE);
      kids = all.length > limit ? [...all.slice(0, limit), moreNode(n, all.length - limit)] : all;
      sortedCache.set(n, kids);
    }
    return kids;
  };

  const rows = (n) => {
    if (!isOpen(n) || n.children.size === 0) return 1;
    let sum = 0;
    for (const c of shownKids(n)) sum += rows(c);
    return Math.max(sum, 1);
  };

  const place = (n, x, top) => {
    const span = rows(n) * ROW_H;
    const long = isOpen(n) && shownKids(n).length > LONG_BRANCH;
    const y = long ? top + ROW_H * 2.5 : top + span / 2;
    const laid = { node: n, x, y, open: isOpen(n), hasKids: n.children.size > 0, more: Boolean(n.isMore) };
    nodes.push(laid);
    if (isOpen(n)) {
      let childTop = top;
      for (const c of shownKids(n)) {
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

/** World bbox of a set of laid nodes, including each node's label block. */
export function boxOf(laidNodes, posOf) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of laidNodes) {
    const p = posOf(l);
    minX = Math.min(minX, p.x - NODE_BOX.left);
    maxX = Math.max(maxX, p.x + NODE_BOX.right);
    minY = Math.min(minY, p.y - NODE_BOX.top);
    maxY = Math.max(maxY, p.y + NODE_BOX.bottom);
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

/**
 * The usable part of the canvas (CSS px, canvas-relative): the canvas minus
 * the overlays floating on it (status line, legend, map controls). THE single
 * notion of "visible viewport" used by Fit, reveal, jump and the tests.
 */
export function viewportRect({ w, h }, insets = null) {
  const i = insets || { top: FIT_INSET.top, bottom: FIT_INSET.bottom, left: FIT_INSET.side, right: FIT_INSET.side };
  const x0 = Math.min(i.left, w / 2 - 20);
  const x1 = Math.max(w - i.right, w / 2 + 20);
  const y0 = Math.min(i.top, h / 2 - 20);
  const y1 = Math.max(h - i.bottom, h / 2 + 20);
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/**
 * Insets from overlay rectangles (canvas-relative CSS px). Wide overlays push
 * the top or bottom edge (by which half they sit in); tall ones the left or
 * right edge. A margin keeps content off their edges.
 */
export function insetsFromOverlays({ w, h }, rects, margin = 8) {
  const ins = { top: margin, bottom: margin, left: margin, right: margin };
  for (const r of rects) {
    if (!(r.width > 0 && r.height > 0)) continue;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= w || r.top >= h) continue;
    if (r.width >= r.height) {
      if (r.top + r.height / 2 < h / 2) ins.top = Math.max(ins.top, r.bottom + margin);
      else ins.bottom = Math.max(ins.bottom, h - r.top + margin);
    } else if (r.left + r.width / 2 < w / 2) ins.left = Math.max(ins.left, r.right + margin);
    else ins.right = Math.max(ins.right, w - r.left + margin);
  }
  return ins;
}

/**
 * Camera transform that frames `laidNodes` in the visible viewport. Mounted
 * sources (deep OPC UA / i3X trees) are excluded from the fit whenever any
 * other node exists, so a few hundred mount nodes can't shrink the broker
 * trees to dust.
 */
export function fitTransform(laidNodes, posOf, size, { excludeMounts = true, insets = null } = {}) {
  const { w, h } = size;
  if (!laidNodes.length || !w) return null;
  let use = laidNodes;
  if (excludeMounts) {
    const brokerOnly = laidNodes.filter((l) => !isMountNode(l.node));
    if (brokerOnly.length) use = brokerOnly;
  }
  const b = boxOf(use, posOf);
  const v = viewportRect({ w, h }, insets);
  const k = Math.max(MIN_K, Math.min(MAX_FIT_K, Math.min(v.w / Math.max(b.maxX - b.minX, 1), v.h / Math.max(b.maxY - b.minY, 1))));
  return { k, x: v.x0 + v.w / 2 - (k * (b.minX + b.maxX)) / 2, y: v.y0 + v.h / 2 - (k * (b.minY + b.maxY)) / 2 };
}

/**
 * Minimal camera move that brings world box `box` inside viewport rect `v`:
 * pan the least distance at the current zoom; only if the box cannot fit,
 * zoom out just enough, never below `minK`. If even `minK` cannot hold it, the
 * box is anchored on `anchor` (world point, the expanded node): it is kept in
 * view and the rest is centred around it as far as it fits. Returns
 * { t, clipped } where clipped says part of the box stays off-screen.
 */
export function revealTransform(t, box, v, { minK = MIN_READ_K, anchor = null } = {}) {
  const bw = box.maxX - box.minX;
  const bh = box.maxY - box.minY;
  let k = t.k;
  const fitK = Math.min(v.w / Math.max(bw, 1), v.h / Math.max(bh, 1));
  if (fitK < k) k = Math.max(Math.min(minK, k), fitK);
  const clipped = bw * k > v.w + 0.5 || bh * k > v.h + 0.5;
  // Re-anchor the camera around the viewport centre for a zoom change, keeping
  // the box's centre fixed on screen, then pan minimally.
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  let x = t.x;
  let y = t.y;
  if (k !== t.k) {
    const sx = cx * t.k + t.x;
    const sy = cy * t.k + t.y;
    x = sx - cx * k;
    y = sy - cy * k;
  }
  const axis = (lo, hi, off, vlo, vhi, a) => {
    const s0 = lo * k + off;
    const s1 = hi * k + off;
    if (s1 - s0 <= vhi - vlo) {
      if (s0 < vlo) return off + (vlo - s0);
      if (s1 > vhi) return off - (s1 - vhi);
      return off;
    }
    // Too big: show the START of the box (the first children of a long list)
    // as long as the anchor (the expanded node) stays in view; else centre on it.
    const start = vlo - lo * k;
    if (a == null) return start;
    const as = a * k + start;
    return as >= vlo && as <= vhi ? start : (vlo + vhi) / 2 - a * k;
  };
  x = axis(box.minX, box.maxX, x, v.x0, v.x1, anchor ? anchor.x : null);
  y = axis(box.minY, box.maxY, y, v.y0, v.y1, anchor ? anchor.y : null);
  return { t: { k, x, y }, clipped };
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

/**
 * The laid node whose +/- badge (drawn at P + (0, R)) is under a world point.
 * `radius` is the hit radius in WORLD units: callers pass a screen size
 * (>= 12 px, 22 px for touch: a 24 / 44 px target) divided by the zoom, so the
 * target never shrinks below finger or pointer size when zoomed out.
 */
export function pickBadge(laidNodes, posOf, pt, radius) {
  let best = null;
  let bestD = radius * radius;
  for (const l of laidNodes) {
    if (!l.hasKids) continue;
    const P = posOf(l);
    const dx = pt.x - P.x;
    const dy = pt.y - (P.y + R);
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      best = l;
      bestD = d;
    }
  }
  return best;
}

/** Is a world point on the +/- affordance below a node's badge? (kept for callers; see pickBadge) */
export function onToggleAffordance(l, P, p) {
  return l.hasKids && p.y > P.y + R - 6 && Math.abs(p.x - P.x) < 12;
}
