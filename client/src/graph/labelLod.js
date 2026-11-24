/**
 * Label level-of-detail for dense node graphs. Pure functions (no canvas, no DOM).
 *
 * At a few hundred nodes, drawing every label produces an unreadable pile. We
 * instead pick which labels to draw each frame:
 *   1. leaf labels stay hidden until the view is zoomed in past `leafZoom`;
 *   2. candidates are ordered by importance (branch size, then activity);
 *   3. a label is kept only if its screen-space box doesn't collide with one
 *      already kept (greedy, most important first), up to a budget.
 * "Forced" ids (selected, hovered, search matches) always get a label.
 */

export const LOD_MIN_NODES = 60; // below this, label everything the old way
export const DEFAULT_LEAF_ZOOM = 1.15;
export const LOD_MIN_ZOOM = 0.3; // below this no label is legible at all

const endId = (e) => (e && typeof e === 'object' ? e.id : e);

/** Subtree size (self included) per node id, from parent->child links. */
export function computeBranchSizes(nodes, links) {
  const children = new Map();
  const hasParent = new Set();
  for (const l of links) {
    const s = endId(l.source);
    const t = endId(l.target);
    if (!children.has(s)) children.set(s, []);
    children.get(s).push(t);
    hasParent.add(t);
  }
  const size = new Map();
  const visit = (id, guard = 0) => {
    if (size.has(id)) return size.get(id);
    size.set(id, 1); // cycle guard
    let total = 1;
    if (guard < 200) for (const c of children.get(id) || []) total += visit(c, guard + 1);
    size.set(id, total);
    return total;
  };
  for (const n of nodes) visit(n.id);
  return size;
}

/** Node ids ordered most-important first: bigger branch, then more direct links. */
export function orderByImportance(nodes, branchSizes) {
  const score = (n) => (branchSizes.get(n.id) || 1) * 1000 + (n.degree || 0) + (n.kind === 'broker' ? 1e9 : 0);
  return nodes.slice().sort((a, b) => score(b) - score(a));
}

/** Rough label width in screen px for an 12px sans-serif label of `text`. */
export function estimateLabelWidth(text, k, fontPx = 12) {
  return Math.min(text.length, 22) * fontPx * 0.56 * k + 6;
}

/**
 * Choose the labels to draw.
 * @param ordered   nodes sorted by importance (see orderByImportance)
 * @param view      { k, tx, ty, w, h } camera: screen = world * k + t
 * @param opts      { leafZoom, maxLabels, forced:Set<id>, labelOf(node), radiusOf(node),
 *                    screenSized (labels drawn at a constant on-screen size), fontPx }
 * @returns Set of node ids whose label should be drawn
 */
export function selectLabelIds(ordered, view, opts = {}) {
  const { k, tx, ty, w, h } = view;
  const { leafZoom = DEFAULT_LEAF_ZOOM, maxLabels = 120, forced = null, labelOf = (n) => n.label || '', radiusOf = () => 6, screenSized = false, fontPx = 12 } = opts;
  const out = new Set();
  if ((k < LOD_MIN_ZOOM && !screenSized) || maxLabels <= 0) {
    if (forced) for (const id of forced) out.add(id);
    return out;
  }
  const CELL = 80;
  const grid = new Map();
  const boxes = [];
  const lineH = screenSized ? fontPx + 4 : 14 * k + 2;
  const fits = (x0, y0, x1, y1) => {
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const bucket = grid.get(`${cx},${cy}`);
        if (!bucket) continue;
        for (const i of bucket) {
          const b = boxes[i];
          if (x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]) return false;
        }
      }
    }
    return true;
  };
  const place = (x0, y0, x1, y1) => {
    const idx = boxes.length;
    boxes.push([x0, y0, x1, y1]);
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const key = `${cx},${cy}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(idx);
      }
    }
  };
  const boxFor = (n) => {
    const text = labelOf(n);
    const bw = screenSized ? estimateLabelWidth(text, 1, fontPx) : estimateLabelWidth(text, k);
    const sx = n.x * k + tx;
    const sy = n.y * k + ty + (screenSized ? radiusOf(n) * k + 2 : (radiusOf(n) + 2) * k);
    return [sx - bw / 2, sy, sx + bw / 2, sy + lineH];
  };

  // Forced labels claim their space first so nothing else overlaps them.
  if (forced) {
    for (const n of ordered) {
      if (!forced.has(n.id)) continue;
      out.add(n.id);
      place(...boxFor(n));
    }
  }
  for (const n of ordered) {
    if (out.size >= maxLabels) break;
    if (out.has(n.id)) continue;
    if (n.x == null || n.y == null) continue;
    const isLeaf = Boolean(n.meta?.isLeaf);
    if (isLeaf && k < leafZoom) continue;
    const b = boxFor(n);
    if (b[2] < -20 || b[0] > w + 20 || b[3] < -20 || b[1] > h + 20) continue; // off-screen
    if (!fits(b[0], b[1], b[2], b[3])) continue;
    place(b[0], b[1], b[2], b[3]);
    out.add(n.id);
  }
  return out;
}
