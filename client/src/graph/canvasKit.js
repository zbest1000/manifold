/**
 * Shared plumbing for every canvas / WebGL renderer in the app, so sizing, DPR,
 * camera math, hit-testing, frame scheduling, label fitting and layout guards
 * behave identically everywhere (and are unit-tested once, in
 * src/test/canvasKit.test.js).
 *
 *   - backingSize / applyCanvasSize / watchCanvasSize: integer backing store =
 *     round(CSS size x devicePixelRatio), kept in sync by a ResizeObserver AND a
 *     `(resolution: Ndppx)` media-query listener (DPR changes when a window moves
 *     to another monitor or the user browser-zooms, without any resize event).
 *   - screenToWorld / worldToScreen / clientToLocal / zoomAround / wheelFactor:
 *     ONE camera transform (screen = world * k + t) used by drawing AND picking.
 *   - createFrameScheduler: requestAnimationFrame coalescing that never runs
 *     while the tab is hidden or the canvas is scrolled out of view, and an
 *     optional "animate while active" mode with a slow idle cadence.
 *   - ellipsize: measured truncation with an ellipsis (not a character count,
 *     which overflows for wide/CJK glyphs).
 *   - sanitizePositions: no NaN / Infinity / coincident nodes ever reach a draw.
 *   - attachPinchZoom: two-pointer pinch zoom for renderers that do their own
 *     pointer handling (d3-zoom covers ForceGraph).
 */

// ---- sizing -------------------------------------------------------------------

export function currentDpr() {
  const d = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
  return Number.isFinite(d) && d > 0 ? d : 1;
}

/** Integer backing-store size for a CSS box at a device pixel ratio. */
export function backingSize(cssW, cssH, dpr = 1) {
  const w = Math.max(0, Number.isFinite(cssW) ? cssW : 0);
  const h = Math.max(0, Number.isFinite(cssH) ? cssH : 0);
  const r = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return { width: Math.max(1, Math.round(w * r)), height: Math.max(1, Math.round(h * r)) };
}

/**
 * Size a canvas to a CSS box. Returns { w, h, dpr, sx, sy } where w/h are CSS px
 * and sx/sy the exact backing/CSS ratios to use with ctx.setTransform (they differ
 * from dpr by the integer rounding, which is what keeps 1px lines crisp).
 */
export function applyCanvasSize(canvas, cssW, cssH, dpr = currentDpr()) {
  const { width, height } = backingSize(cssW, cssH, dpr);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const sw = `${cssW}px`;
  const sh = `${cssH}px`;
  if (canvas.style.width !== sw) canvas.style.width = sw;
  if (canvas.style.height !== sh) canvas.style.height = sh;
  return { w: cssW, h: cssH, dpr, sx: cssW > 0 ? width / cssW : dpr, sy: cssH > 0 ? height / cssH : dpr };
}

/**
 * Call `onSize({ w, h, dpr })` now and whenever `el`'s content box or the device
 * pixel ratio changes. Returns a disposer.
 */
export function watchCanvasSize(el, onSize) {
  let disposed = false;
  let mql = null;
  let last = '';
  const emit = () => {
    if (disposed) return;
    const rect = el.getBoundingClientRect();
    const dpr = currentDpr();
    const key = `${rect.width}x${rect.height}@${dpr}`;
    if (key === last) return;
    last = key;
    onSize({ w: rect.width, h: rect.height, dpr });
  };
  const onDpr = () => {
    listenDpr(); // the query is for ONE ratio: re-arm for the new one
    emit();
  };
  const listenDpr = () => {
    if (mql) mql.removeEventListener?.('change', onDpr);
    mql = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(`(resolution: ${currentDpr()}dppx)`) : null;
    mql?.addEventListener?.('change', onDpr);
  };
  listenDpr();
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(emit) : null;
  ro?.observe(el);
  emit();
  return () => {
    disposed = true;
    ro?.disconnect();
    mql?.removeEventListener?.('change', onDpr);
  };
}

// ---- camera ------------------------------------------------------------------

export const screenToWorld = (t, sx, sy) => ({ x: (sx - t.x) / t.k, y: (sy - t.y) / t.k });
export const worldToScreen = (t, wx, wy) => ({ x: wx * t.k + t.x, y: wy * t.k + t.y });

/** Pointer position relative to an element's top-left, in CSS px. */
export function clientToLocal(el, clientX, clientY) {
  const r = el.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}

/** Zoom the camera by `factor` keeping the screen point (px, py) fixed; returns a new transform. */
export function zoomAround(t, px, py, factor, minK, maxK) {
  const nk = Math.max(minK, Math.min(maxK, t.k * factor));
  if (!Number.isFinite(nk) || nk === t.k) return { ...t };
  return { k: nk, x: px - ((px - t.x) * nk) / t.k, y: py - ((py - t.y) * nk) / t.k };
}

/**
 * Zoom factor for a wheel event, proportional to the scroll distance so a
 * trackpad (many tiny deltas) and a mouse wheel (few big ones) zoom at the same
 * speed. deltaMode 1 = lines, 2 = pages.
 */
export function wheelFactor(e) {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const dy = Math.max(-300, Math.min(300, (e.deltaY || 0) * unit));
  return Math.exp(-dy * 0.0016);
}

/**
 * Camera that frames a world bbox in a viewport, leaving `inset` CSS px clear on
 * each side for the overlays that float above the canvas. Never NaN.
 */
export function fitBounds(bounds, { w, h }, { inset = {}, minK = 0.01, maxK = 4 } = {}) {
  const top = inset.top ?? 40;
  const right = inset.right ?? 40;
  const bottom = inset.bottom ?? 40;
  const left = inset.left ?? 40;
  if (!bounds || !(w > 0) || !(h > 0)) return null;
  const { minX, minY, maxX, maxY } = bounds;
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  const aw = Math.max(w - left - right, Math.min(w, 40));
  const ah = Math.max(h - top - bottom, Math.min(h, 40));
  const k = Math.max(minK, Math.min(maxK, aw / Math.max(maxX - minX, 1), ah / Math.max(maxY - minY, 1)));
  return { k, x: left + aw / 2 - (k * (minX + maxX)) / 2, y: top + ah / 2 - (k * (minY + maxY)) / 2 };
}

/** Bounding box of finite x/y in a node list (loop, no spread: safe at any size). */
export function boundsOf(nodes, pad = 0) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  if (minX === Infinity) return null;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/**
 * Least screen-space move (CSS px) that brings a circle at (sx, sy) with radius
 * r inside the usable rect of a {w, h} canvas minus `inset` (the floating
 * overlays, a docked panel's edge). A circle bigger than the rect is centred.
 * Returns { dx, dy } (0, 0 when it is already inside).
 */
export function keepInView(sx, sy, r, { w, h }, inset = {}) {
  const l = inset.left ?? 0;
  const t = inset.top ?? 0;
  const rr = w - (inset.right ?? 0);
  const b = h - (inset.bottom ?? 0);
  const axis = (p, lo, hi) => {
    if (hi - lo < 2 * r) return (lo + hi) / 2 - p;
    if (p - r < lo) return lo - (p - r);
    if (p + r > hi) return hi - (p + r);
    return 0;
  };
  if (!(w > 0 && h > 0) || ![sx, sy, r].every(Number.isFinite)) return { dx: 0, dy: 0 };
  return { dx: axis(sx, l, rr), dy: axis(sy, t, b) };
}

/**
 * A camera glide: an ease-out move of a few numeric fields from `from` to `to`
 * over `ms` (instant with reduced motion). `step(now)` returns the values for
 * that moment and whether it is done. Renderers cancel it on user input.
 */
export function createGlide(from, to, { ms = 280, now = performance.now(), reduced = prefersReducedMotion() } = {}) {
  const keys = Object.keys(to);
  return {
    to,
    step(at) {
      const f = reduced || ms <= 0 ? 1 : Math.min(1, Math.max(0, (at - now) / ms));
      const e = 1 - (1 - f) ** 3;
      const out = {};
      for (const k of keys) out[k] = from[k] + (to[k] - from[k]) * e;
      return { values: out, done: f >= 1 };
    }
  };
}

// ---- frame scheduling ----------------------------------------------------------

export function prefersReducedMotion() {
  try {
    return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

/**
 * Coalesces redraw requests into at most one paint per animation frame, and
 * optionally keeps animating while `isActive()` says something moves, falling
 * back to one paint every `idleMs` (0 = no idle repaint) when nothing does.
 * Nothing runs while the document is hidden or `el` is out of the viewport;
 * becoming visible again paints once. Returns { request(), dispose(), stats }.
 */
export function createFrameScheduler(paint, { el = null, isActive = null, idleMs = 0 } = {}) {
  let raf = 0;
  let timer = 0;
  let disposed = false;
  let onScreen = true;
  const stats = { frames: 0 };
  const visible = () => !disposed && onScreen && !(typeof document !== 'undefined' && document.hidden);

  const frame = () => {
    raf = 0;
    if (!visible()) return;
    stats.frames++;
    paint();
    schedule();
  };
  const schedule = () => {
    if (!visible() || raf) return;
    if (isActive && isActive()) {
      raf = requestAnimationFrame(frame);
    } else if (idleMs > 0 && !timer) {
      timer = setTimeout(() => {
        timer = 0;
        request();
      }, idleMs);
    }
  };
  const request = () => {
    if (!visible() || raf) return;
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    raf = requestAnimationFrame(frame);
  };
  const onVis = () => {
    if (visible()) request();
    else {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      clearTimeout(timer);
      timer = 0;
    }
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
  let io = null;
  if (el && typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver((entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      onVis();
    });
    io.observe(el);
  }
  return {
    request,
    stats,
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(timer);
      raf = 0;
      timer = 0;
      io?.disconnect();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
    }
  };
}

// ---- text --------------------------------------------------------------------

const ELLIPSIS = '…';
const fitCache = new Map();

/**
 * The longest prefix of `text` (plus an ellipsis) whose measured width fits
 * `maxWidth` with the context's CURRENT font. Code points are kept whole, so a
 * surrogate pair (emoji) is never split. Results are cached per font.
 */
export function ellipsize(ctx, text, maxWidth) {
  const s = String(text ?? '');
  if (!s || !(maxWidth > 0)) return '';
  const key = `${ctx.font}|${maxWidth}|${s}`;
  const hit = fitCache.get(key);
  if (hit !== undefined) return hit;
  let out = s;
  if (ctx.measureText(s).width > maxWidth) {
    const cps = Array.from(s);
    let lo = 0;
    let hi = cps.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(cps.slice(0, mid).join('') + ELLIPSIS).width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    out = lo > 0 ? cps.slice(0, lo).join('').trimEnd() + ELLIPSIS : ctx.measureText(ELLIPSIS).width <= maxWidth ? ELLIPSIS : '';
  }
  if (fitCache.size > 4000) fitCache.clear();
  fitCache.set(key, out);
  return out;
}

/**
 * Greedy screen-space label placement: `tryPlace(x0, y0, x1, y1)` claims the box
 * and returns true unless it overlaps one already claimed. Bucketed so it stays
 * O(labels) per frame.
 */
export function createLabelGrid(cell = 64) {
  const grid = new Map();
  const boxes = [];
  const cellsOf = (x0, y0, x1, y1, fn) => {
    for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++) {
      for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy++) if (fn(`${cx},${cy}`) === false) return false;
    }
    return true;
  };
  return {
    tryPlace(x0, y0, x1, y1) {
      const free = cellsOf(x0, y0, x1, y1, (key) => {
        const b = grid.get(key);
        if (!b) return true;
        for (const i of b) {
          const o = boxes[i];
          if (x0 < o[2] && x1 > o[0] && y0 < o[3] && y1 > o[1]) return false;
        }
        return true;
      });
      if (!free) return false;
      const idx = boxes.push([x0, y0, x1, y1]) - 1;
      cellsOf(x0, y0, x1, y1, (key) => {
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(idx);
      });
      return true;
    },
    get size() {
      return boxes.length;
    }
  };
}

// ---- layout guards --------------------------------------------------------------

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/**
 * Make every node drawable: non-finite coordinates are replaced by a
 * deterministic spiral around the finite nodes' centroid, and nodes sharing the
 * exact same point are fanned out around it by `minSep`. Mutates and returns
 * the count of fixed nodes. `keys` defaults to ['x','y'] (pass ['x','y','z'] for 3D).
 */
export function sanitizePositions(nodes, { minSep = 6, keys = ['x', 'y'] } = {}) {
  let fixed = 0;
  const finite = (n) => keys.every((k) => Number.isFinite(n[k]));
  const c = keys.map(() => 0);
  let count = 0;
  for (const n of nodes) {
    if (!finite(n)) continue;
    keys.forEach((k, i) => (c[i] += n[k]));
    count++;
  }
  const centre = keys.map((_, i) => (count ? c[i] / count : 0));
  let bad = 0;
  for (const n of nodes) {
    if (finite(n)) continue;
    const r = minSep * 4 * Math.sqrt(++bad);
    const a = bad * GOLDEN;
    keys.forEach((k, i) => (n[k] = centre[i] + (i === 0 ? Math.cos(a) * r : i === 1 ? Math.sin(a) * r : 0)));
    fixed++;
  }
  // Coincident points: fan duplicates out around the first occupant.
  const seen = new Map();
  for (const n of nodes) {
    const key = keys.map((k) => n[k]).join(',');
    const dupes = seen.get(key) || 0;
    seen.set(key, dupes + 1);
    if (dupes === 0) continue;
    const r = minSep * Math.sqrt(dupes);
    const a = dupes * GOLDEN;
    n[keys[0]] += Math.cos(a) * r;
    n[keys[1]] += Math.sin(a) * r;
    fixed++;
  }
  return fixed;
}

// ---- touch -------------------------------------------------------------------------

/**
 * Two-finger pinch zoom on `el` (pointer events). `onPinch(factor, cx, cy)` gets
 * the incremental scale and the midpoint in element-local CSS px; `onActive(b)`
 * reports whether a pinch is in progress so single-pointer pan can stand down.
 */
export function attachPinchZoom(el, onPinch, onActive = () => {}) {
  const pts = new Map();
  let lastDist = 0;
  const local = (e) => clientToLocal(el, e.clientX, e.clientY);
  const dist = () => {
    const [a, b] = [...pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const down = (e) => {
    if (e.pointerType !== 'touch') return;
    pts.set(e.pointerId, local(e));
    if (pts.size === 2) {
      lastDist = dist();
      onActive(true);
    }
  };
  const move = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, local(e));
    if (pts.size !== 2) return;
    const d = dist();
    if (lastDist > 0 && d > 0) {
      const [a, b] = [...pts.values()];
      onPinch(d / lastDist, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    lastDist = d;
  };
  const up = (e) => {
    if (!pts.delete(e.pointerId)) return;
    if (pts.size < 2) {
      lastDist = 0;
      onActive(false);
    }
  };
  el.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  return () => {
    el.removeEventListener('pointerdown', down);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
}

// ---- test hook ---------------------------------------------------------------------

/**
 * `window.__manifoldTest` registry, enabled only with `?e2e=1` in the URL or
 * `localStorage['manifold.e2e'] = '1'`, so production pages never expose it.
 */
export function testHookEnabled() {
  try {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).has('e2e') || window.localStorage?.getItem('manifold.e2e') === '1';
  } catch {
    return false;
  }
}

export function registerTestHook(name, api) {
  if (!testHookEnabled()) return () => {};
  const reg = (window.__manifoldTest ||= {});
  reg[name] = api;
  return () => {
    if (reg[name] === api) delete reg[name];
  };
}
