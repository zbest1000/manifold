import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsDownUp, ChevronsUpDown, Maximize2, Minus, Plus, Workflow } from 'lucide-react';
import { onMessageActivity } from '@/store/store';
import { loadIcons } from './unsIcons';
import { buildUnsTheme } from './unsTheme';
import { useCanvasTokens } from './canvasTokens';
import { IconButton } from '@/components/ui';
import { DEFAULT_LEVELS } from './unsLevels';
import { recordActivity, rollRates, liveMeta } from './unsLive';
import {
  nodeKey,
  seedExpansion,
  expandAllKeys,
  collapseAllKeys,
  layoutForest,
  fitTransform,
  pickNode,
  pickBadge,
  boxOf,
  viewportRect,
  insetsFromOverlays,
  revealTransform,
  readableFit,
  R,
  MIN_K
} from './unsLayout';
import { drawTopology, PAGER_DOM_K } from './unsDraw';
import BranchPager from './BranchPager';
import { stepPage } from './unsPaging';
import {
  applyCanvasSize,
  attachPinchZoom,
  clientToLocal,
  createFrameScheduler,
  prefersReducedMotion,
  registerTestHook,
  screenToWorld,
  watchCanvasSize,
  wheelFactor,
  zoomAround
} from './canvasKit';

const MAX_K = 3;
const GLIDE_MS = 280; // camera glide for jumps and reveals (instant with reduced motion)
const SETTLE_MS = 1500; // a jump keeps its target centred until node and canvas are this long still
const DOUBLE_TAP_MS = 350;
const SELECT_DELAY_MS = 260; // a click waits this long so a double-click does not also select

/**
 * UNS topology renderer: the Unified-Namespace lens on the data fabric.
 *
 * Renders the namespace as a horizontal tidy tree of badge nodes with a level
 * ring + glyph, name and level caption beneath, "+ / -" expand badges, and
 * edges that animate (dashed, in the good colour) while data flows through the
 * branch. Colours follow the app theme (unsTheme.js, from the design tokens).
 *
 * Camera behaviour (all through ONE motion state machine, see stepMotion):
 *   - jump:   a deep link / lint finding / event centres its node and keeps it
 *             centred while the layout or canvas settle;
 *   - reveal: after an expansion, the expanded node and its new children are
 *             brought into the visible viewport with the least pan (zooming out
 *             only as far as labels stay readable); a selection is likewise
 *             pulled out from under the overlays;
 *   - anchor: an expanded / collapsed node stays where it was on screen.
 * Any user camera input cancels a motion. "Visible viewport" is the canvas
 * minus the overlays floating on it (`[data-canvas-overlay]` in the page plus
 * the map controls), measured, and shared by Fit, jump, reveal and the tests.
 *
 * The code is split by concern: unsLevels (level naming), unsLive (liveness
 * state), unsTree (tree build), unsLayout (layout / fit / reveal / hit-test),
 * unsDraw (canvas drawing). This file is the React shell + interaction.
 */
export { DEFAULT_LEVELS, levelName, levelColor, nodeLevel } from './unsLevels';
export { buildUnsTree } from './unsTree';
export { unsLiveMap, unsValueMap, unsRateMap, lastActive, nodeValue, nodeRate, staleness, expectedInterval } from './unsLive';

const NO_PAGING = new Map();

export default function UnsTopology({ roots, levels = DEFAULT_LEVELS, selectedId = null, onSelect, focusTarget = null, paging = NO_PAGING, onPage = null, extraControls = null }) {
  const tokens = useCanvasTokens();
  const themeTokens = buildUnsTheme(tokens);
  const hoverRef = useRef(null); // node key under the pointer
  const themeRef = useRef(themeTokens);
  useEffect(() => {
    themeRef.current = themeTokens;
  }, [themeTokens]);
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const controlsRef = useRef(null);
  const sizeRef = useRef({ w: 0, h: 0, sx: 1, sy: 1 });
  const schedRef = useRef(null); // frame scheduler (see the animation effect)
  const transformRef = useRef({ x: 130, y: 60, k: 1 });
  const visibleRef = useRef([]); // laid-out visible nodes for hit-testing
  // Absolute world positions for nodes the user has dragged, keyed
  // `${brokerId}:${path}`. Pins override the tidy layout and survive every
  // relayout; "Auto arrange" clears them.
  const manualRef = useRef(new Map());
  // Set once the user takes control of the camera (pan / zoom / drag / toggle).
  // Until then the view auto-frames the whole forest as it loads and grows.
  const userMovedRef = useRef(false);
  // Multi-select: node keys the user has box- or ctrl-selected.
  const selRef = useRef(new Set());
  const boxRef = useRef(null); // active rubber-band box, world coords {x1,y1,x2,y2}
  const [selCount, setSelCount] = useState(0);
  const interactAt = useRef(0); // last pan/zoom/hover — keeps interaction at full fps
  const kick = useCallback(() => {
    interactAt.current = Date.now();
    schedRef.current?.request();
  }, []);
  const selectedRef = useRef(selectedId);
  const reducedRef = useRef(false); // prefers-reduced-motion, kept current by the scheduler effect

  // A moved node is PINNED to an absolute world position (see manualRef).
  const posOf = useCallback((l) => {
    const pin = manualRef.current.get(`${l.node.brokerId}:${l.node.path}`);
    return pin ? { x: pin.x, y: pin.y } : { x: l.x, y: l.y };
  }, []);

  // ---- The visible viewport --------------------------------------------------
  // Overlays floating on the canvas (marked data-canvas-overlay by the page, plus
  // our own map controls), measured as canvas-relative rects.
  const overlayRects = useCallback(() => {
    const canvas = canvasRef.current;
    const host = wrapRef.current?.parentElement;
    if (!canvas || !host) return [];
    const c = canvas.getBoundingClientRect();
    const els = [...host.querySelectorAll('[data-canvas-overlay]')];
    if (controlsRef.current) els.push(controlsRef.current);
    return els
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ left: r.left - c.left, top: r.top - c.top, right: r.right - c.left, bottom: r.bottom - c.top, width: r.width, height: r.height }));
  }, []);
  const viewport = useCallback(() => {
    const size = sizeRef.current;
    return viewportRect(size, insetsFromOverlays(size, overlayRects()));
  }, [overlayRects]);
  const insets = useCallback(() => insetsFromOverlays(sizeRef.current, overlayRects()), [overlayRects]);

  // Fit (the F key / button): frame the whole visible arrangement, as asked
  // (mounted sources don't count), even below the reading floor.
  const fitAll = useCallback(() => {
    const f = fitTransform(visibleRef.current, posOf, sizeRef.current, { insets: insets() });
    if (!f) return;
    // Mutate in place: other closures (zoom/pan, the e2e hook) hold this object.
    Object.assign(transformRef.current, f);
    schedRef.current?.request();
  }, [posOf, insets]);
  // The automatic first view (and re-framing while the map loads): readable
  // first, so a phone shows the root and its first level at a zoom whose labels
  // can be read instead of the whole forest as dust (readableFit).
  const fitScopeRef = useRef(null);
  const autoFit = useCallback(() => {
    const f = readableFit(visibleRef.current, posOf, sizeRef.current, { insets: insets() });
    if (!f) return;
    Object.assign(transformRef.current, f.t);
    fitScopeRef.current = f.scope;
    schedRef.current?.request();
  }, [posOf, insets]);

  // ---- Camera motion: jump / reveal --------------------------------------------
  //   jump:   { kind:'jump', brokerId, path }  pending until laid out and sized,
  //           then glides to centre and FOLLOWS the node while layout or canvas
  //           change, done after SETTLE_MS of stillness;
  //   reveal: { kind:'reveal', keys, anchorKey } pending until those nodes are
  //           laid out, then ONE minimal move (computed once, so live data does
  //           not re-run it), glide, done.
  // Any user camera input cancels (cancelMotion).
  const motionRef = useRef(null);
  const [revealNote, setRevealNote] = useState(null); // { shown, total, box } when a reveal had to leave nodes off-screen
  const cancelMotion = useCallback(() => {
    motionRef.current = null;
    setRevealNote(null);
  }, []);
  // Move the camera toward `goal`: a GLIDE_MS ease-out the first time (instant
  // with reduced motion); once arrived (m.anim === false) later goals apply at once.
  const glideTo = (m, goal, now) => {
    const t = transformRef.current;
    if (m.anim === undefined) m.anim = reducedRef.current ? false : { from: { ...t }, start: now };
    if (m.anim) {
      const f = Math.min(1, (now - m.anim.start) / GLIDE_MS);
      const e = 1 - (1 - f) ** 3;
      t.k = m.anim.from.k + (goal.k - m.anim.from.k) * e;
      t.x = m.anim.from.x + (goal.x - m.anim.from.x) * e;
      t.y = m.anim.from.y + (goal.y - m.anim.from.y) * e;
      if (f >= 1) m.anim = false;
    } else Object.assign(t, goal);
    return m.anim === false; // arrived
  };
  const stepMotion = useCallback(
    (now) => {
      const m = motionRef.current;
      if (!m) return;
      const { w, h } = sizeRef.current;
      if (!w || !h) return;
      const byKey = new Map(visibleRef.current.map((l) => [nodeKey(l.node), l]));
      if (m.kind === 'jump') {
        const target = byKey.get(`${m.brokerId}:${m.path}`);
        if (!target) return; // pending
        const v = viewport();
        const p = posOf(target);
        const t = transformRef.current;
        m.k ??= Math.min(1.15, Math.max(t.k, 0.85)); // a readable zoom, never focus while zoomed way out
        const goal = { k: m.k, x: v.x0 + v.w / 2 - m.k * p.x, y: v.y0 + v.h / 2 - m.k * p.y };
        // A new goal (the node or the canvas moved) restarts the stillness clock.
        const key = `${Math.round(goal.x)},${Math.round(goal.y)}`;
        if (key !== m.lastKey) {
          m.lastKey = key;
          m.stillSince = now;
        }
        glideTo(m, goal, now);
        m.phase = 'following';
        if (m.anim === false && now - m.stillSince >= SETTLE_MS) motionRef.current = null;
        return;
      }
      // reveal
      if (!m.goal) {
        const laid = m.keys.map((k) => byKey.get(k)).filter(Boolean);
        if (!laid.length) return; // pending (layout not there yet)
        const box = boxOf(laid, posOf);
        const anchor = m.anchorKey && byKey.get(m.anchorKey) ? posOf(byKey.get(m.anchorKey)) : null;
        const v = viewport();
        const { t, clipped } = revealTransform(transformRef.current, box, v, { anchor });
        m.goal = t;
        m.phase = 'moving';
        if (clipped && laid.length > 1) {
          const shown = laid.filter((l) => {
            const p = posOf(l);
            const sx = p.x * t.k + t.x;
            const sy = p.y * t.k + t.y;
            return sx >= v.x0 && sx <= v.x1 && sy >= v.y0 && sy <= v.y1;
          }).length;
          setRevealNote({ shown, total: laid.length, box });
        }
      }
      if (glideTo(m, m.goal, now)) motionRef.current = null;
    },
    [posOf, viewport]
  );
  const stepMotionRef = useRef(stepMotion);
  useEffect(() => {
    stepMotionRef.current = stepMotion;
  }, [stepMotion]);
  const startReveal = useCallback((keys, anchorKey = null) => {
    if (motionRef.current?.kind === 'jump') return; // a deep-link jump owns the camera until it settles
    motionRef.current = { kind: 'reveal', keys, anchorKey, phase: 'pending' };
    setRevealNote(null);
    schedRef.current?.request();
  }, []);

  // Selection: keep the selected node out from under the overlays.
  useEffect(() => {
    selectedRef.current = selectedId;
    if (!selectedId) return;
    const l = visibleRef.current.find((x) => x.node.id === selectedId);
    if (l) startReveal([nodeKey(l.node)]);
  }, [selectedId, startReveal]);

  // ---- Expansion -------------------------------------------------------------
  const [expanded, setExpanded] = useState(() => new Set());
  // The node whose expansion changed: it is kept at the same screen position
  // across the relayout, then (on expand) the new children are revealed.
  const anchorRef = useRef(null); // { key, sx, sy, reveal: 'children' | 'page' | null }
  const screenOf = (key) => {
    const l = visibleRef.current.find((x) => nodeKey(x.node) === key);
    if (!l) return null;
    const p = posOf(l);
    const t = transformRef.current;
    return { sx: p.x * t.k + t.x, sy: p.y * t.k + t.y };
  };
  const toggle = useCallback((node) => {
    userMovedRef.current = true; // user is exploring — stop re-framing the camera under them
    motionRef.current = null;
    setRevealNote(null);
    const key = `${node.brokerId}:${node.path}`;
    const s = screenOf(key);
    // Collapsing also collapses everything beneath, so re-expanding is tidy.
    const descendantPrefix = node.path === '' ? `${node.brokerId}:` : `${node.brokerId}:${node.path}/`;
    setExpanded((prev) => {
      const next = new Set(prev);
      const opening = !next.has(key);
      anchorRef.current = s ? { key, ...s, reveal: opening ? 'children' : null } : null;
      if (!opening) {
        next.delete(key);
        for (const k of [...next]) if (k !== key && k.startsWith(descendantPrefix)) next.delete(k);
      } else next.add(key);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- screenOf reads refs only
  }, []);
  // Pager of a long branch: another page or filter. The branch's node stays where
  // it is on screen; the pager and the first children of the new page are revealed.
  const onPageRef = useRef(onPage);
  useEffect(() => {
    onPageRef.current = onPage;
  }, [onPage]);
  const changePage = useCallback((pagerNodeData, state) => {
    userMovedRef.current = true;
    motionRef.current = null;
    setRevealNote(null);
    const s = screenOf(pagerNodeData.parentKey);
    anchorRef.current = s ? { key: pagerNodeData.parentKey, ...s, reveal: 'page' } : null;
    onPageRef.current?.(pagerNodeData.parentId, state);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- screenOf reads refs only
  }, []);
  const activate = useCallback((l) => (l.pager ? null : l.hasKids ? toggle(l.node) : null), [toggle]);

  // Expanded paths per broker. Default: namespace + first level open. Seeding is
  // per-broker (not one-shot): a broker whose topics stream in AFTER first paint
  // still gets auto-expanded. User collapses of already-seeded brokers are kept.
  const [seeded, setSeeded] = useState(() => new Set());
  // A broker counts as seeded only once it has children: a root that shows up
  // empty (topics still loading) would otherwise stay collapsed for good.
  const freshRoots = roots.filter((r) => !seeded.has(r.brokerId) && r.children.size > 0);
  if (freshRoots.length) {
    setSeeded((prev) => new Set([...prev, ...freshRoots.map((r) => r.brokerId)]));
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const k of seedExpansion(freshRoots)) next.add(k);
      return next;
    });
  }

  // Expand all / Collapse all. Expand opens every branch breadth first up to EXPAND_ALL_CAP laid-out
  // nodes, one page per long branch (expandAllKeys); collapse leaves each namespace open one level. The
  // camera goes back to the automatic readable framing, and the result is announced.
  const [bulkNote, setBulkNote] = useState('');
  const expandAll = useCallback(() => {
    const r = expandAllKeys(roots, paging);
    cancelMotion();
    setRevealNote(null);
    anchorRef.current = null;
    userMovedRef.current = false;
    setExpanded(new Set(r.keys));
    setBulkNote(
      r.complete
        ? `Expanded all ${r.opened.toLocaleString()} branches (${r.laid.toLocaleString()} nodes on the map).`
        : `Expanded ${r.opened.toLocaleString()} of ${r.total.toLocaleString()} branches: the map stops at ${r.laid.toLocaleString()} nodes, and long branches show one page. Open the rest one by one.`
    );
  }, [roots, paging, cancelMotion]);
  const collapseAll = useCallback(() => {
    cancelMotion();
    setRevealNote(null);
    anchorRef.current = null;
    userMovedRef.current = false;
    setExpanded(new Set(collapseAllKeys(roots)));
    setBulkNote('Collapsed every branch; each namespace shows its first level.');
  }, [roots, cancelMotion]);

  // Warm the icon set (lazy chunk) so badges upgrade from glyphs to icons.
  useEffect(() => {
    loadIcons();
  }, []);

  // Focus request (deep link / lint finding / event): open every ancestor (in
  // render, when the request changes), then a jump centres the node.
  const [focusSeen, setFocusSeen] = useState(null);
  if (focusSeen !== focusTarget) {
    setFocusSeen(focusTarget);
    if (focusTarget?.brokerId && focusTarget.path != null) {
      const { brokerId, path } = focusTarget;
      setExpanded((prev) => {
        const next = new Set(prev);
        next.add(`${brokerId}:`);
        const segs = String(path).split('/').filter(Boolean);
        let acc = '';
        for (let i = 0; i < segs.length - 1; i++) {
          acc = i === 0 ? segs[i] : `${acc}/${segs[i]}`;
          next.add(`${brokerId}:${acc}`);
        }
        return next;
      });
    }
  }
  useEffect(() => {
    if (!focusTarget?.brokerId || focusTarget.path == null) return;
    motionRef.current = { kind: 'jump', brokerId: focusTarget.brokerId, path: String(focusTarget.path), phase: 'pending' };
    userMovedRef.current = true; // a deliberate jump — auto-fit must not override it
    schedRef.current?.request();
  }, [focusTarget]);

  // Live activity: stamp ancestors, count per-branch rates, record leaf values.
  useEffect(() => {
    const off = onMessageActivity((msg) => {
      recordActivity(msg);
      schedRef.current?.request(); // coalesced: at most one paint per frame
    });
    const roller = setInterval(rollRates, 1000);
    return () => {
      off?.();
      clearInterval(roller);
    };
  }, []);

  // ---- Tidy tree layout over the EXPANDED portion of the forest ----
  const layout = useMemo(() => layoutForest(roots, expanded, paging), [roots, expanded, paging]);
  const pagers = useMemo(() => layout.nodes.filter((l) => l.pager), [layout]);
  // Last child row of each paged branch: while the branch's rows fill the
  // viewport, its pager sticks to the top edge instead of scrolling away with
  // the first row (a deep link into page 25 lands far below the pager slot).
  const pagerLast = useMemo(() => {
    const out = new Map();
    for (const e of layout.edges) {
      const pager = e.to.pager ? e.to : null;
      if (pager) continue;
      const key = `${e.from.node.id}#pager`;
      const cur = out.get(key);
      if (!cur || e.to.y > cur.y) out.set(key, e.to);
    }
    return out;
  }, [layout]);
  const pagerEls = useRef(new Map()); // pager node id -> DOM element, positioned each paint
  const [pagerFocus, setPagerFocus] = useState({ id: null, n: 0 }); // "/" on the canvas focuses a branch filter

  useEffect(() => {
    visibleRef.current = layout.nodes;
    // Anchor: the node whose expansion changed stays where it was on screen.
    const a = anchorRef.current;
    if (a) {
      anchorRef.current = null;
      const now = screenOf(a.key);
      if (now) {
        transformRef.current.x += a.sx - now.sx;
        transformRef.current.y += a.sy - now.sy;
      }
      if (a.reveal) {
        const parent = layout.nodes.find((l) => nodeKey(l.node) === a.key);
        const kids = layout.edges.filter((e) => e.from === parent).map((e) => nodeKey(e.to.node));
        if (a.reveal === 'children' && kids.length) startReveal([a.key, ...kids], a.key);
        // A page: the pager row (first) and the start of the new page.
        if (a.reveal === 'page' && kids.length) startReveal(kids.slice(0, 6), kids[0]);
      }
    }
    // Auto-frame the forest as it loads and grows, until the user takes the camera.
    if (!userMovedRef.current && layout.nodes.length > 0 && sizeRef.current.w > 0) autoFit();
    schedRef.current?.request();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- screenOf reads refs only
  }, [layout, autoFit, posOf, startReveal]);

  // ---- Drawing ----
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w, h, sx, sy } = sizeRef.current;
    if (!w || !h) return;
    drawTopology(canvas.getContext('2d'), {
      w,
      h,
      dpr: sx,
      dprY: sy,
      t: transformRef.current,
      layout,
      posOf,
      theme: themeTokens,
      tokens,
      levels,
      selectedId: selectedRef.current,
      hoverKey: hoverRef.current,
      selKeys: selRef.current,
      box: boxRef.current,
      now: Date.now(),
      reducedMotion: reducedRef.current
    });
    // Lay each pager's DOM controls over its slot (screen space, fixed size), or
    // hide them when zoomed out past PAGER_DOM_K (the canvas draws a pill) or off-screen.
    const t = transformRef.current;
    for (const l of pagers) {
      const el = pagerEls.current.get(l.node.id);
      if (!el) continue;
      const p = posOf(l);
      let sx = (p.x - R) * t.k + t.x;
      // Keep the whole control on the canvas when its slot is near the right edge (phones).
      const pw = el.offsetWidth || 0;
      if (pw && sx > 8 && sx + pw > w - 8) sx = Math.max(8, w - 8 - pw);
      let sy = p.y * t.k + t.y;
      const last = pagerLast.get(l.node.id);
      if (last && sy < 40) {
        const top = Math.max(insetsFromOverlays(sizeRef.current, overlayRects()).top, 8) + 20;
        const lastY = posOf(last).y * t.k + t.y;
        if (sy < top && lastY > top + 40) sy = Math.min(top, lastY - 40); // sticky
      }
      const show = t.k >= PAGER_DOM_K && sx < w && sx + 40 > 0 && sy > -20 && sy < h + 20;
      el.dataset.sx = String(Math.round(sx));
      el.dataset.sy = String(Math.round(sy));
      el.style.transform = `translate(${Math.round(sx)}px, ${Math.round(sy)}px) translateY(-50%)`;
      if (el.dataset.shown !== String(show)) {
        el.dataset.shown = String(show);
        el.style.visibility = show ? 'visible' : 'hidden';
      }
    }
  }, [layout, levels, posOf, themeTokens, tokens, pagers, pagerLast, overlayRects]);
  const drawRef = useRef(draw);
  useEffect(() => {
    drawRef.current = draw;
    schedRef.current?.request();
  }, [draw]);

  // Read-only hook for e2e tests (enabled by ?e2e=1 only).
  useEffect(
    () =>
      registerTestHook('uns', {
        get transform() {
          return { ...transformRef.current };
        },
        get size() {
          return { ...sizeRef.current };
        },
        /** The usable canvas rect (canvas minus floating overlays), CSS px. */
        get viewport() {
          return viewport();
        },
        get overlays() {
          return overlayRects();
        },
        get frames() {
          return schedRef.current?.stats.frames ?? 0;
        },
        get selectedId() {
          return selectedRef.current;
        },
        get theme() {
          return { mode: themeRef.current.mode, bg: themeRef.current.bg };
        },
        /** Visible nodes with world and screen (canvas-relative CSS px) positions. */
        get nodes() {
          const t = transformRef.current;
          return visibleRef.current.map((l) => {
            const p = posOf(l);
            const n = l.node;
            return {
              name: n.name,
              path: n.path,
              id: n.id,
              key: nodeKey(n),
              x: p.x,
              y: p.y,
              sx: p.x * t.k + t.x,
              sy: p.y * t.k + t.y,
              r: R * t.k,
              open: l.open,
              expanded: l.open,
              hasKids: l.hasKids,
              hasChildren: l.hasKids,
              childCount: n.children.size,
              more: false,
              pager: l.pager,
              depth: n.depth
            };
          });
        },
        /** The motion in progress: 'jump' | 'reveal' | null. */
        get motion() {
          return motionRef.current?.kind || null;
        },
        get jumping() {
          return motionRef.current?.kind === 'jump' ? motionRef.current.phase : null;
        },
        /** What the automatic first view framed: 'all' | 'first-level' | 'start' (null once the user moved). */
        get fitScope() {
          return userMovedRef.current ? null : fitScopeRef.current;
        },
        /** Pagers of long branches: their page, range and on-screen slot (canvas-relative CSS px). */
        get pagers() {
          const t = transformRef.current;
          return visibleRef.current
            .filter((l) => l.pager)
            .map((l) => {
              const p = posOf(l);
              const el = pagerEls.current.get(l.node.id);
              return { parentPath: l.node.parentKey.slice(l.node.parentKey.indexOf(':') + 1), parentId: l.node.parentId, ...l.node.slice, sx: el?.dataset.sx != null ? Number(el.dataset.sx) : (p.x - R) * t.k + t.x, sy: el?.dataset.sy != null ? Number(el.dataset.sy) : p.y * t.k + t.y, shown: el?.dataset.shown === 'true' };
            });
        },
        fit: () => fitAll(),
        setTransform: (t) => {
          cancelMotion();
          userMovedRef.current = true;
          Object.assign(transformRef.current, t);
          schedRef.current?.request();
        }
      }),
    [posOf, fitAll, cancelMotion, viewport, overlayRects]
  );
  // The pager slots move with the camera: repaint (and so re-position) when the set changes.
  useEffect(() => {
    schedRef.current?.request();
  }, [pagers]);

  // Frame scheduling: full frame rate only while something moves (a camera
  // motion, live traffic animating the dashes/pulses, or the user interacting);
  // otherwise one paint a second. Nothing runs while hidden / off-screen.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    reducedRef.current = prefersReducedMotion();
    const onMq = () => {
      reducedRef.current = prefersReducedMotion();
      schedRef.current?.request();
    };
    mq?.addEventListener?.('change', onMq);
    const sched = createFrameScheduler(
      () => {
        stepMotionRef.current(Date.now());
        drawRef.current();
      },
      {
        el: wrapRef.current,
        idleMs: 1000,
        isActive: () => {
          const now = Date.now();
          return Boolean(motionRef.current) || now - interactAt.current < 1000 || (!reducedRef.current && now - liveMeta.lastDataAt < 3000);
        }
      }
    );
    schedRef.current = sched;
    sched.request();
    document.fonts?.ready?.then(() => schedRef.current?.request());
    return () => {
      mq?.removeEventListener?.('change', onMq);
      sched.dispose();
      schedRef.current = null;
    };
  }, []);

  // Sizing + pointer interactions.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const unwatch = watchCanvasSize(wrap, ({ w, h, dpr }) => {
      const prev = sizeRef.current;
      // Once the user (or a jump) owns the camera, a resize keeps the point at
      // the centre of the view in the centre.
      if (userMovedRef.current && prev.w > 0 && prev.h > 0) {
        transformRef.current.x += (w - prev.w) / 2;
        transformRef.current.y += (h - prev.h) / 2;
      }
      sizeRef.current = applyCanvasSize(canvas, w, h, dpr);
      if (motionRef.current) stepMotionRef.current(Date.now());
      else if (userMovedRef.current && selectedRef.current) {
        // The details panel opening narrows the canvas: keep the selection visible.
        const l = visibleRef.current.find((x) => x.node.id === selectedRef.current);
        if (l) {
          motionRef.current = { kind: 'reveal', keys: [nodeKey(l.node)], phase: 'pending' };
          schedRef.current?.request();
        }
      }
      if (!userMovedRef.current && visibleRef.current.length) autoFit();
      drawRef.current(); // paint synchronously: a resized canvas is cleared
    });

    const toWorld = (e) => {
      const p = clientToLocal(canvas, e.clientX, e.clientY);
      return screenToWorld(transformRef.current, p.x, p.y);
    };
    const pick = (pt) => pickNode(visibleRef.current, posOf, pt);
    // Badge hit radius: 12 px (a 24 px target) for a mouse, 22 px (44 px) for touch.
    const pickBadgeAt = (pt, touch) => pickBadge(visibleRef.current, posOf, pt, (touch ? 22 : 12) / transformRef.current.k);

    // Drag on a node moves THAT node (manual rearrangement); drag on empty
    // canvas pans. Click = select; click on the badge, double-click, or
    // double-tap = expand / collapse.
    let mode = null; // 'pan' | 'node' | 'box' | 'badge'
    let grabbed = null;
    let moved = 0;
    let last = { x: 0, y: 0 };
    let ctrlToggled = false;
    let pinching = false;
    let lastTap = { key: null, at: 0 };
    let touchToggledAt = 0; // a double-tap toggled: ignore the dblclick the browser may synthesize
    const unpinch = attachPinchZoom(
      canvas,
      (factor, cx, cy) => {
        userMovedRef.current = true;
        cancelMotion();
        Object.assign(transformRef.current, zoomAround(transformRef.current, cx, cy, factor, MIN_K, MAX_K));
        kick();
      },
      (on) => {
        pinching = on;
        if (on) {
          mode = null;
          grabbed = null;
          boxRef.current = null;
        }
      }
    );
    const keyOf = (l) => nodeKey(l.node);
    const onDown = (e) => {
      if (e.button > 0 || pinching) return; // primary button / first finger only
      // No text selection, no page scroll/zoom gesture, keep keyboard focus here
      // (without a keyboard-style focus ring for a pointer click).
      e.preventDefault();
      canvas.focus({ preventScroll: true, focusVisible: false });
      kick();
      userMovedRef.current = true;
      cancelMotion();
      moved = 0;
      ctrlToggled = false;
      last = { x: e.clientX, y: e.clientY };
      const pt = toWorld(e);
      // The node body wins over a neighbouring badge's enlarged hit area: when
      // zoomed out, a 44 px touch target around the badge would cover the node.
      const body = pick(pt);
      const onBody = body && Math.hypot(pt.x - posOf(body).x, pt.y - posOf(body).y) < R * 0.8;
      const badge = onBody ? null : pickBadgeAt(pt, e.pointerType === 'touch');
      grabbed = badge || body;
      if (badge) {
        mode = 'badge';
        return;
      }
      if (grabbed && (e.ctrlKey || e.metaKey)) {
        const key = keyOf(grabbed);
        if (selRef.current.has(key)) selRef.current.delete(key);
        else selRef.current.add(key);
        setSelCount(selRef.current.size);
        ctrlToggled = true;
        grabbed = null;
        mode = null;
        return;
      }
      if (grabbed) mode = 'node';
      else if (e.shiftKey) {
        const p = toWorld(e);
        boxRef.current = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
        mode = 'box';
      } else mode = 'pan';
    };
    const onMove = (e) => {
      if (pinching) return;
      if (!mode) {
        if (e.target !== canvas) return;
        const pt = toWorld(e);
        const over = pickBadgeAt(pt, false) || pick(pt);
        canvas.style.cursor = over ? 'pointer' : 'default';
        const hk = over ? keyOf(over) : null;
        if (hk !== hoverRef.current) {
          hoverRef.current = hk;
          schedRef.current?.request();
        }
        return;
      }
      kick();
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      moved += Math.abs(dx) + Math.abs(dy);
      last = { x: e.clientX, y: e.clientY };
      if (mode === 'badge') return; // the badge is a button: no drag
      if (mode === 'pan') {
        transformRef.current.x += dx;
        transformRef.current.y += dy;
      } else if (mode === 'box' && boxRef.current) {
        const p = toWorld(e);
        boxRef.current.x2 = p.x;
        boxRef.current.y2 = p.y;
      } else if (grabbed && !grabbed.pager) {
        const k = transformRef.current.k;
        const gkey = keyOf(grabbed);
        const keys = selRef.current.has(gkey) && selRef.current.size > 1 ? [...selRef.current] : [gkey];
        for (const key of keys) {
          let cur = manualRef.current.get(key);
          if (!cur) {
            const laid = visibleRef.current.find((l) => keyOf(l) === key);
            if (!laid) continue;
            cur = { x: laid.x, y: laid.y };
          }
          manualRef.current.set(key, { x: cur.x + dx / k, y: cur.y + dy / k });
        }
        canvas.style.cursor = 'grabbing';
      }
    };
    let pendingSelect = 0;
    const onUp = (e) => {
      if (!mode && !ctrlToggled) return;
      kick();
      const wasDrag = moved >= 6;
      const hit = grabbed;
      const was = mode;
      const box = boxRef.current;
      mode = null;
      grabbed = null;
      boxRef.current = null;
      canvas.style.cursor = 'default';
      if (ctrlToggled) return;
      if (was === 'box') {
        const minX = Math.min(box.x1, box.x2);
        const maxX = Math.max(box.x1, box.x2);
        const minY = Math.min(box.y1, box.y2);
        const maxY = Math.max(box.y1, box.y2);
        const next = new Set(e.shiftKey ? selRef.current : []);
        for (const l of visibleRef.current) {
          const P = posOf(l);
          if (P.x >= minX && P.x <= maxX && P.y >= minY && P.y <= maxY) next.add(keyOf(l));
        }
        selRef.current = next;
        setSelCount(next.size);
        return;
      }
      if (wasDrag) return;
      if (was === 'badge' && hit) {
        // The +/- badge is a button: toggles, never selects.
        clearTimeout(pendingSelect);
        activate(hit);
        return;
      }
      if (!hit) {
        if (selRef.current.size) {
          selRef.current = new Set();
          setSelCount(0);
        }
        return;
      }
      const key = keyOf(hit);
      const touch = e.pointerType === 'touch';
      if (touch) {
        // Double-tap toggles (browsers do not reliably fire dblclick for touch). Timed with the
        // events' own timestamps, so a busy main thread that handles the taps late does not
        // stretch the gap between them.
        const at = e.timeStamp || performance.now();
        if (lastTap.key === key && at - lastTap.at < DOUBLE_TAP_MS) {
          lastTap = { key: null, at: 0 };
          touchToggledAt = Date.now();
          clearTimeout(pendingSelect);
          activate(hit);
          return;
        }
        lastTap = { key, at };
      }
      // Defer selection so a double-click/double-tap (expand) doesn't also select (not even the
      // selection ring). A touch waits out the whole double-tap window: selecting inside it would
      // open the details panel and move the node under the finger before the second tap lands.
      clearTimeout(pendingSelect);
      pendingSelect = setTimeout(() => {
        selRef.current = new Set([key]);
        setSelCount(1);
        onSelect?.(hit.node);
        kick();
      }, touch ? DOUBLE_TAP_MS : SELECT_DELAY_MS);
    };
    const onDbl = (e) => {
      e.preventDefault();
      clearTimeout(pendingSelect);
      if (Date.now() - touchToggledAt < 800) return;
      const pt = toWorld(e);
      const body = pick(pt);
      const onBody = body && Math.hypot(pt.x - posOf(body).x, pt.y - posOf(body).y) < R * 0.8;
      const hit = !onBody && pickBadgeAt(pt, false) ? null : body; // a badge click already toggled
      if (hit && hit.hasKids) activate(hit);
    };
    const onWheel = (e) => {
      userMovedRef.current = true;
      cancelMotion();
      e.preventDefault();
      const p = clientToLocal(canvas, e.clientX, e.clientY);
      Object.assign(transformRef.current, zoomAround(transformRef.current, p.x, p.y, wheelFactor(e), MIN_K, MAX_K));
      kick();
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && selRef.current.size) {
        selRef.current = new Set();
        setSelCount(0);
        kick();
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    canvas.addEventListener('dblclick', onDbl);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(pendingSelect);
      unwatch();
      unpinch();
      window.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('dblclick', onDbl);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
  }, [onSelect, posOf, activate, autoFit, kick, cancelMotion]);

  const keyboardHint =
    'Arrow down selects the first node. With a node selected: up and down move between siblings, right expands or enters, left collapses or goes to the parent, Enter or Space expands or collapses. In a long branch, Page down and Page up show the next and previous page, Home and End the first and last, and slash filters it by name. Shift and arrow keys pan, plus and minus zoom, F fits the view.';
  const summary = useMemo(() => {
    const total = layout.nodes.length;
    const sel = selectedId ? layout.nodes.find((l) => l.node.id === selectedId)?.node : null;
    return (
      `Unified namespace topology with ${total.toLocaleString()} visible nodes across ${roots.length} namespace${roots.length === 1 ? '' : 's'}.` +
      (sel ? ` Selected: ${sel.path || sel.name}.` : ' Nothing selected.') +
      ' The Tree view lists the same namespace as an accessible, keyboard-navigable list.'
    );
  }, [layout, roots, selectedId]);

  // Keyboard: a tree on the canvas. The selected node is the keyboard focus.
  const onCanvasKey = (e) => {
    const t = transformRef.current;
    const { w, h } = sizeRef.current;
    const nodes = layout.nodes;
    const cur = selectedId ? nodes.find((l) => l.node.id === selectedId) : null;
    const parentOf = (l) => layout.edges.find((ed) => ed.to === l)?.from || null;
    const kidsOf = (l) => layout.edges.filter((ed) => ed.from === l).map((ed) => ed.to);
    const choose = (l) => {
      if (!l) return;
      if (l.pager) return;
      selRef.current = new Set([nodeKey(l.node)]);
      setSelCount(1);
      onSelect?.(l.node); // the selection effect reveals it
    };
    let handled = true;
    const arrow = e.key.startsWith('Arrow');
    if (arrow && (e.shiftKey || !cur)) {
      if (!cur && e.key === 'ArrowDown' && !e.shiftKey) choose(nodes[0]);
      else {
        const step = 60;
        if (e.key === 'ArrowLeft') t.x += step;
        else if (e.key === 'ArrowRight') t.x -= step;
        else if (e.key === 'ArrowUp') t.y += step;
        else t.y -= step;
        cancelMotion();
      }
    } else if (cur && (e.key === 'PageDown' || e.key === 'PageUp' || e.key === 'Home' || e.key === 'End' || e.key === '/')) {
      // Paging the long branch the selected node sits in (or the one it opens).
      const p = parentOf(cur);
      const pager = (p && kidsOf(p).find((l) => l.pager)) || (cur.open && kidsOf(cur).find((l) => l.pager)) || null;
      if (!pager) handled = false;
      else if (e.key === '/') setPagerFocus((f) => ({ id: pager.node.id, n: f.n + 1 }));
      else {
        const action = e.key === 'PageDown' ? 'next' : e.key === 'PageUp' ? 'prev' : e.key === 'Home' ? 'first' : 'last';
        const sl = pager.node.slice;
        changePage(pager.node, { page: stepPage(sl, action), filter: sl.filter || '' });
      }
    } else if (cur && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const p = parentOf(cur);
      const sibs = (p ? kidsOf(p) : nodes.filter((l) => !parentOf(l))).filter((l) => !l.pager);
      const i = sibs.indexOf(cur);
      choose(sibs[i + (e.key === 'ArrowDown' ? 1 : -1)]);
    } else if (cur && e.key === 'ArrowRight') {
      if (cur.hasKids && !cur.open) activate(cur);
      else if (cur.open) choose(kidsOf(cur)[0]);
    } else if (cur && e.key === 'ArrowLeft') {
      if (cur.open) activate(cur);
      else choose(parentOf(cur));
    } else if (cur && (e.key === 'Enter' || e.key === ' ')) {
      activate(cur);
    } else if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
      cancelMotion();
      Object.assign(t, zoomAround(t, w / 2, h / 2, e.key === '-' || e.key === '_' ? 0.9 : 1.1, MIN_K, MAX_K));
    } else if (e.key === 'f' || e.key === 'F') {
      cancelMotion();
      fitAll();
    } else handled = false;
    if (handled) {
      e.preventDefault();
      userMovedRef.current = true;
      kick();
    }
  };

  const zoomBy = (f) => {
    cancelMotion();
    const { w, h } = sizeRef.current;
    userMovedRef.current = true;
    Object.assign(transformRef.current, zoomAround(transformRef.current, w / 2, h / 2, f, MIN_K, MAX_K));
    kick();
  };
  const fitBox = (box) => {
    // "Show all": frame the whole revealed set, zooming below the reading floor.
    const v = viewport();
    const { t } = revealTransform(transformRef.current, box, v, { minK: MIN_K });
    cancelMotion();
    Object.assign(transformRef.current, t);
    kick();
  };
  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-app">
      <canvas
        ref={canvasRef}
        style={{ touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none' }}
        className="absolute left-0 top-0 block h-full w-full focus:outline-hidden focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[rgb(var(--focus))]"
        role="img"
        aria-label={summary}
        aria-describedby="uns-canvas-help"
        tabIndex={0}
        onKeyDown={onCanvasKey}
      />
      <span id="uns-canvas-help" className="sr-only">
        {keyboardHint}
      </span>
      <span role="status" className="sr-only" data-testid="uns-bulk-note">
        {bulkNote}
      </span>
      {pagers.map((l) => (
        <div
          key={l.node.id}
          ref={(el) => {
            if (el) pagerEls.current.set(l.node.id, el);
            else pagerEls.current.delete(l.node.id);
          }}
          className="absolute left-0 top-0 z-[5]"
          style={{ visibility: 'hidden' }}
          data-uns-pager={l.node.parentKey}
        >
          <BranchPager slice={l.node.slice} parentName={l.node.parentName} compact onChange={(st) => changePage(l.node, st)} focusFilterSignal={pagerFocus.id === l.node.id ? pagerFocus.n : 0} />
        </div>
      ))}
      {(selCount > 1 || revealNote) && (
        <div role="status" className="absolute bottom-16 left-1/2 z-10 flex max-w-[calc(100%-6rem)] -translate-x-1/2 items-center gap-2 rounded-md border border-line bg-panel py-1 pl-3 pr-1 text-xs text-fg shadow-overlay">
          {selCount > 1 ? (
            <>
              <span className="truncate tabular-nums">{selCount} selected · drag one to move them together</span>
              <button
                type="button"
                onClick={() => {
                  selRef.current = new Set();
                  setSelCount(0);
                  kick();
                }}
                className="h-7 shrink-0 rounded px-2 font-medium text-muted transition-colors hover:bg-raised hover:text-fg"
              >
                Clear <span className="text-subtle">Esc</span>
              </button>
            </>
          ) : (
            <>
              <span className="truncate tabular-nums">
                {(revealNote.total - revealNote.shown).toLocaleString()} more off-screen
              </span>
              <button type="button" onClick={() => fitBox(revealNote.box)} className="h-7 shrink-0 rounded px-2 font-medium text-muted transition-colors hover:bg-raised hover:text-fg">
                Show all
              </button>
            </>
          )}
        </div>
      )}
      <div
        ref={controlsRef}
        role="toolbar"
        aria-label="Map controls"
        aria-orientation="vertical"
        className="absolute bottom-4 right-4 z-10 flex max-h-[calc(100%-2rem)] flex-col overflow-y-auto rounded-md border border-line bg-panel p-0.5 shadow-overlay"
      >
        {extraControls}
        <IconButton icon={Plus} label="Zoom in" side="left" onClick={() => zoomBy(1.25)} />
        <IconButton icon={Minus} label="Zoom out" side="left" onClick={() => zoomBy(0.8)} />
        <span aria-hidden="true" className="mx-1.5 my-0.5 h-px bg-line" />
        <IconButton icon={ChevronsUpDown} label="Expand all" side="left" onClick={expandAll} data-testid="uns-expand-all" />
        <IconButton icon={ChevronsDownUp} label="Collapse all" side="left" onClick={collapseAll} data-testid="uns-collapse-all" />
        <span aria-hidden="true" className="mx-1.5 my-0.5 h-px bg-line" />
        <IconButton
          icon={Maximize2}
          label="Fit to view (F)"
          side="left"
          onClick={() => {
            cancelMotion();
            fitAll();
          }}
        />
        <IconButton
          icon={Workflow}
          label="Auto arrange: reset moved nodes and fit"
          side="left"
          onClick={() => {
            cancelMotion();
            manualRef.current.clear();
            fitAll();
          }}
        />
      </div>
    </div>
  );
}
