import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minus, Plus, Workflow } from 'lucide-react';
import { onMessageActivity } from '@/store/store';
import { loadIcons } from './unsIcons';
import { buildUnsTheme } from './unsTheme';
import { useCanvasTokens } from './canvasTokens';
import { IconButton } from '@/components/ui';
import { DEFAULT_LEVELS } from './unsLevels';
import { recordActivity, rollRates, liveMeta } from './unsLive';
import { nodeKey, seedExpansion, layoutForest, fitTransform, pickNode, onToggleAffordance } from './unsLayout';
import { drawTopology } from './unsDraw';
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
import { MIN_K } from './unsLayout';

const MAX_K = 3;

/**
 * UNS topology renderer: the Unified-Namespace lens on the data fabric.
 *
 * Renders the namespace as a horizontal tidy tree of badge nodes with a level
 * ring + glyph, name and LEVEL caption beneath, "+ / -" expand affordances, and
 * edges that animate (dashed, in the good colour) while data flows through the
 * branch. Colours follow the app theme: unsTheme.js derives them from the design
 * tokens, and a theme switch repaints in place (camera, expansion, selection kept).
 *
 * The code is split by concern: unsLevels (level naming), unsLive (liveness
 * state), unsTree (tree build), unsLayout (layout/fit/hit-test), unsDraw
 * (canvas drawing). This file is the React shell + pointer interaction.
 * Names other modules and tests import are re-exported below.
 */
export { DEFAULT_LEVELS, levelName, levelColor, nodeLevel } from './unsLevels';
export { buildUnsTree } from './unsTree';
export { unsLiveMap, unsValueMap, unsRateMap, lastActive, nodeValue, nodeRate, staleness, expectedInterval } from './unsLive';

export default function UnsTopology({ roots, levels = DEFAULT_LEVELS, selectedId = null, onSelect, focusTarget = null }) {
  const tokens = useCanvasTokens();
  const themeTokens = buildUnsTheme(tokens);
  const hoverRef = useRef(null); // node key under the pointer
  const themeRef = useRef(themeTokens);
  useEffect(() => {
    themeRef.current = themeTokens;
  }, [themeTokens]);
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
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
  // Multi-select: node keys (`${brokerId}:${path}`) the user has box- or
  // ctrl-selected. Dragging any one moves the whole group. Kept in a ref (the
  // draw loop reads it every frame); selCount mirrors its size for the hint.
  const selRef = useRef(new Set());
  const boxRef = useRef(null); // active rubber-band box, world coords {x1,y1,x2,y2}
  const [selCount, setSelCount] = useState(0);
  const interactAt = useRef(0); // last pan/zoom/hover — keeps interaction at full fps
  // Any camera / selection change: note the interaction and ask for a frame.
  const kick = useCallback(() => {
    interactAt.current = Date.now();
    schedRef.current?.request();
  }, []);
  const selectedRef = useRef(selectedId);
  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  // A moved node is PINNED to an absolute world position, not offset from the
  // tidy layout: live sources (an OPC-UA mount, streaming topics) rebuild the
  // forest constantly, and an offset-from-base would drift every time the base
  // recomputed — the node "fighting" the drag. An absolute pin stays exactly
  // where dropped until "Auto arrange" clears it.
  const posOf = useCallback((l) => {
    const pin = manualRef.current.get(`${l.node.brokerId}:${l.node.path}`);
    return pin ? { x: pin.x, y: pin.y } : { x: l.x, y: l.y };
  }, []);

  // Fit the framing to the visible arrangement (mounted sources don't count).
  const fitAll = useCallback(() => {
    const f = fitTransform(visibleRef.current, posOf, sizeRef.current);
    if (!f) return;
    // Mutate in place: other closures (zoom/pan, the e2e hook) hold this object.
    Object.assign(transformRef.current, f);
    schedRef.current?.request();
  }, [posOf]);

  // Auto arrange: drop every manual offset and re-frame the tidy layout.
  const autoArrange = useCallback(() => {
    manualRef.current.clear();
    fitAll();
  }, [fitAll]);

  // Center the viewport on one laid node at a readable zoom — the target of a
  // "jump to this node" from the lint / events panels.
  const centerOn = useCallback(
    (l) => {
      const { w, h } = sizeRef.current;
      if (!w || !h) return false;
      const p = posOf(l);
      const t = transformRef.current;
      t.k = Math.min(1.15, Math.max(t.k, 0.85)); // a readable zoom, never focus while zoomed way out
      t.x = w / 2 - t.k * p.x;
      t.y = h / 2 - t.k * p.y;
      schedRef.current?.request();
      return true;
    },
    [posOf]
  );
  // A pending "focus this node" request, applied once the node is laid out AND
  // the canvas has a size (tried on every layout, on resize and on request).
  const focusPendingRef = useRef(null);
  const applyFocus = useCallback(() => {
    const pending = focusPendingRef.current;
    if (!pending) return;
    const target = visibleRef.current.find((l) => l.node.brokerId === pending.brokerId && l.node.path === pending.path);
    if (target && centerOn(target)) focusPendingRef.current = null;
  }, [centerOn]);
  const applyFocusRef = useRef(applyFocus);
  useEffect(() => {
    applyFocusRef.current = applyFocus;
  }, [applyFocus]);

  const [expanded, setExpanded] = useState(() => new Set());
  const toggle = useCallback((node) => {
    userMovedRef.current = true; // user is exploring — stop re-framing the camera under them
    const key = `${node.brokerId}:${node.path}`;
    // Collapsing also collapses everything beneath, so re-expanding is tidy.
    const descendantPrefix = node.path === '' ? `${node.brokerId}:` : `${node.brokerId}:${node.path}/`;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        for (const k of [...next]) {
          if (k !== key && k.startsWith(descendantPrefix)) next.delete(k);
        }
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // Expanded paths per broker. Default: namespace + first level open. Seeding is
  // per-broker (not one-shot): a broker whose topics stream in AFTER first paint
  // still gets auto-expanded, instead of loading collapsed while its siblings
  // are open. User collapses of already-seeded brokers are preserved.
  const [seeded, setSeeded] = useState(() => new Set()); // brokers already auto-expanded
  // Adjusted during render (not in an effect) when a new broker's tree shows up.
  const freshRoots = roots.filter((r) => !seeded.has(r.brokerId));
  if (freshRoots.length) {
    setSeeded((prev) => new Set([...prev, ...freshRoots.map((r) => r.brokerId)]));
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const k of seedExpansion(freshRoots)) next.add(k);
      return next;
    });
  }

  // Warm the icon set (lazy chunk) so badges upgrade from glyphs to icons.
  useEffect(() => {
    loadIcons();
  }, []);

  // Focus request (from a lint finding / event click): open every ancestor so
  // the node is on-screen (adjusted during render when the request changes),
  // then queue a center-on that the layout effect applies once the node has a
  // laid-out position.
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
        // Open ancestors only — the node itself need not be expanded to be visible.
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
    focusPendingRef.current = { brokerId: focusTarget.brokerId, path: String(focusTarget.path) };
    userMovedRef.current = true; // a deliberate jump — auto-fit must not override it
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
  const layout = useMemo(() => layoutForest(roots, expanded), [roots, expanded]);

  useEffect(() => {
    visibleRef.current = layout.nodes;
    // Auto-frame the whole forest on load AND as it grows — brokers connect,
    // topics stream in, async mount roots arrive — until the user takes control
    // of the camera. A one-shot fit locks onto the first partial forest and
    // leaves all later growth off-center (the reported "doesn't center on
    // load"); re-fitting until interaction keeps it centered without ever
    // fighting manual navigation.
    if (!userMovedRef.current && layout.nodes.length > 0 && sizeRef.current.w > 0) {
      fitAll();
    }
    // Apply a queued focus once its node has a position (it may take an extra
    // layout pass for the just-expanded ancestors to lay the node out).
    applyFocus();
    schedRef.current?.request();
    // focusTarget: a jump to a node whose ancestors are already open changes no layout.
  }, [layout, fitAll, posOf, applyFocus, focusTarget]);

  // Read-only hook for e2e tests (enabled by ?e2e=1 only): world AND screen
  // (CSS px, canvas-relative) positions of the visible nodes, the camera, the
  // canvas size, and the paint counter.
  useEffect(
    () =>
      registerTestHook('uns', {
        get transform() {
          return { ...transformRef.current };
        },
        get size() {
          return { ...sizeRef.current };
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
        get nodes() {
          const t = transformRef.current;
          return visibleRef.current.map((l) => {
            const p = posOf(l);
            return { name: l.node.name, path: l.node.path, id: l.node.id, x: p.x, y: p.y, sx: p.x * t.k + t.x, sy: p.y * t.k + t.y, open: l.open, hasKids: l.hasKids, depth: l.node.depth };
          });
        },
        fit: () => fitAll(),
        setTransform: (t) => {
          userMovedRef.current = true;
          Object.assign(transformRef.current, t);
          schedRef.current?.request();
        }
      }),
    [posOf, fitAll]
  );

  // ---- Drawing ----
  const reducedRef = useRef(false);
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
  }, [layout, levels, posOf, themeTokens, tokens]);
  const drawRef = useRef(draw);
  useEffect(() => {
    drawRef.current = draw;
    schedRef.current?.request();
  }, [draw]);

  // Frame scheduling: full frame rate only while something moves (live traffic
  // animating the dashes/pulses, or the user interacting); otherwise one paint a
  // second keeps staleness / rate captions honest. Nothing at all runs while the
  // tab is hidden or the canvas is scrolled off-screen, and with
  // prefers-reduced-motion the dashes/pulses stand still (no continuous frames).
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    reducedRef.current = prefersReducedMotion();
    const onMq = () => {
      reducedRef.current = prefersReducedMotion();
      schedRef.current?.request();
    };
    mq?.addEventListener?.('change', onMq);
    const sched = createFrameScheduler(() => drawRef.current(), {
      el: wrapRef.current,
      idleMs: 1000,
      isActive: () => {
        const now = Date.now();
        return now - interactAt.current < 1000 || (!reducedRef.current && now - liveMeta.lastDataAt < 3000);
      }
    });
    schedRef.current = sched;
    sched.request();
    // Labels are measured and drawn in the design system's faces: repaint once they load.
    document.fonts?.ready?.then(() => schedRef.current?.request());
    return () => {
      mq?.removeEventListener?.('change', onMq);
      sched.dispose();
      schedRef.current = null;
    };
  }, []);

  // Sizing + interactions.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    // Integer backing store at the current DPR, re-applied on container resize
    // (window, sidebar collapse, panels) AND on DPR change (monitor move, zoom).
    const unwatch = watchCanvasSize(wrap, ({ w, h, dpr }) => {
      const prev = sizeRef.current;
      // Once the user (or a jump) owns the camera, a resize (a side panel
      // opening, the sidebar collapsing) keeps the point at the centre of the
      // view in the centre, so the selection is never shoved out of sight.
      if (userMovedRef.current && prev.w > 0 && prev.h > 0) {
        transformRef.current.x += (w - prev.w) / 2;
        transformRef.current.y += (h - prev.h) / 2;
      }
      sizeRef.current = applyCanvasSize(canvas, w, h, dpr);
      applyFocusRef.current();
      // Until the user takes the camera, keep the forest framed in the new box.
      if (!userMovedRef.current && visibleRef.current.length) fitAll();
      drawRef.current(); // paint synchronously: a resized canvas is cleared
    });

    const toWorld = (e) => {
      const p = clientToLocal(canvas, e.clientX, e.clientY);
      return screenToWorld(transformRef.current, p.x, p.y);
    };

    const pick = (pt) => pickNode(visibleRef.current, posOf, pt);

    // Drag on a node moves THAT node (manual rearrangement); drag on empty
    // canvas pans the view. Click = select, click on ± (or double-click) =
    // expand/collapse. "Auto arrange" clears all manual moves.
    let mode = null; // 'pan' | 'node' | 'box'
    let grabbed = null; // laid node being moved
    let moved = 0;
    let last = { x: 0, y: 0 };
    let ctrlToggled = false; // a ctrl/⌘-click that toggled selection — onUp skips select
    let pinching = false;
    const unpinch = attachPinchZoom(
      canvas,
      (factor, cx, cy) => {
        userMovedRef.current = true;
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
      // No text selection, no page scroll/zoom gesture, keep keyboard focus here.
      e.preventDefault();
      canvas.focus({ preventScroll: true });
      kick();
      userMovedRef.current = true; // any canvas interaction hands the camera to the user
      moved = 0;
      ctrlToggled = false;
      last = { x: e.clientX, y: e.clientY };
      grabbed = pick(toWorld(e));
      if (grabbed && (e.ctrlKey || e.metaKey)) {
        // Ctrl/⌘-click toggles this node in the multi-selection (no move).
        const key = keyOf(grabbed);
        if (selRef.current.has(key)) selRef.current.delete(key);
        else selRef.current.add(key);
        setSelCount(selRef.current.size);
        ctrlToggled = true;
        grabbed = null;
        mode = null;
        return;
      }
      if (grabbed) {
        mode = 'node';
      } else if (e.shiftKey) {
        // Shift-drag on empty canvas draws a rubber-band selection box.
        const p = toWorld(e);
        boxRef.current = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
        mode = 'box';
      } else {
        mode = 'pan';
      }
    };
    const onMove = (e) => {
      if (pinching) return;
      if (!mode) {
        if (e.target !== canvas) return; // hover feedback only over the canvas
        // hover cursor feedback
        const over = pick(toWorld(e));
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
      userMovedRef.current = true; // panning or dragging = user owns the camera now
      if (mode === 'pan') {
        transformRef.current.x += dx;
        transformRef.current.y += dy;
      } else if (mode === 'box' && boxRef.current) {
        const p = toWorld(e);
        boxRef.current.x2 = p.x;
        boxRef.current.y2 = p.y;
      } else if (grabbed) {
        const k = transformRef.current.k;
        const gkey = keyOf(grabbed);
        // Grabbing a node that's part of the selection drags the WHOLE group;
        // otherwise just this node.
        const keys = selRef.current.has(gkey) && selRef.current.size > 1 ? [...selRef.current] : [gkey];
        for (const key of keys) {
          // Absolute pin: seed from the current tidy position on the first move,
          // then track the cursor. (See posOf — pins don't drift with re-layout.)
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
      if (!mode && !ctrlToggled) return; // not a gesture that started on this canvas
      kick();
      const wasDrag = moved >= 6;
      const hit = grabbed;
      const wasBox = mode === 'box';
      const box = boxRef.current;
      mode = null;
      grabbed = null;
      boxRef.current = null;
      canvas.style.cursor = 'default';
      if (ctrlToggled) return; // selection already toggled on pointerdown
      if (wasBox) {
        // Finalize the rubber-band: every node whose center is inside joins the
        // selection (shift keeps the existing selection, else it replaces it).
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
      if (!hit) {
        // Plain click on empty canvas clears the multi-selection.
        if (selRef.current.size) {
          selRef.current = new Set();
          setSelCount(0);
        }
        return;
      }
      // Click near the +/- affordance (below the badge) toggles expansion.
      const p = toWorld(e);
      const P = posOf(hit);
      const nearToggle = onToggleAffordance(hit, P, p);
      if (nearToggle) {
        toggle(hit.node);
        return;
      }
      // Plain click on a node makes it the sole selection and opens its detail.
      selRef.current = new Set([keyOf(hit)]);
      setSelCount(1);
      // Defer selection briefly so a double-click (expand) doesn't also select —
      // opening the detail panel mid-gesture would move the canvas under the
      // second click.
      clearTimeout(pendingSelect);
      pendingSelect = setTimeout(() => onSelect?.(hit.node), 260);
    };
    const onDbl = (e) => {
      clearTimeout(pendingSelect);
      const hit = pick(toWorld(e));
      if (hit?.hasKids) toggle(hit.node);
    };
    const onWheel = (e) => {
      userMovedRef.current = true; // zooming = user owns the camera now
      e.preventDefault();
      const p = clientToLocal(canvas, e.clientX, e.clientY);
      Object.assign(transformRef.current, zoomAround(transformRef.current, p.x, p.y, wheelFactor(e), MIN_K, MAX_K));
      kick();
    };

    const onKey = (e) => {
      if (e.key === 'Escape' && selRef.current.size) {
        selRef.current = new Set();
        setSelCount(0);
        kick(); // prompt a redraw so the rings clear now
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
  }, [onSelect, posOf, toggle, fitAll, kick]);

  const keyboardHint = 'Arrow keys pan, plus and minus zoom, F fits the view.';
  const summary = useMemo(() => {
    const total = layout.nodes.length;
    const sel = selectedId ? layout.nodes.find((l) => l.node.id === selectedId)?.node : null;
    return (
      `Unified namespace topology with ${total.toLocaleString()} visible nodes across ${roots.length} namespace${roots.length === 1 ? '' : 's'}.` +
      (sel ? ` Selected: ${sel.path || sel.name}.` : ' Nothing selected.') +
      ' The Tree view lists the same namespace as an accessible, keyboard-navigable list.'
    );
  }, [layout, roots, selectedId]);

  const onCanvasKey = (e) => {
    const t = transformRef.current;
    const step = 60;
    const { w, h } = sizeRef.current;
    let handled = true;
    if (e.key === 'ArrowLeft') t.x += step;
    else if (e.key === 'ArrowRight') t.x -= step;
    else if (e.key === 'ArrowUp') t.y += step;
    else if (e.key === 'ArrowDown') t.y -= step;
    else if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
      Object.assign(t, zoomAround(t, w / 2, h / 2, e.key === '-' || e.key === '_' ? 0.9 : 1.1, MIN_K, MAX_K));
    } else if (e.key === 'f' || e.key === 'F') fitAll();
    else handled = false;
    if (handled) {
      e.preventDefault();
      userMovedRef.current = true;
      kick();
    }
  };

  const zoomBy = (f) => {
    const { w, h } = sizeRef.current;
    userMovedRef.current = true;
    Object.assign(transformRef.current, zoomAround(transformRef.current, w / 2, h / 2, f, MIN_K, MAX_K));
    kick();
  };
  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-app">
      <canvas
        ref={canvasRef}
        style={{ touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none' }}
        className="absolute left-0 top-0 block h-full w-full focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[rgb(var(--focus))]"
        role="img"
        aria-label={summary}
        aria-describedby="uns-canvas-help"
        tabIndex={0}
        onKeyDown={onCanvasKey}
      />
      <span id="uns-canvas-help" className="sr-only">{keyboardHint}</span>
      {selCount > 1 && (
        <div role="status" className="absolute bottom-4 left-1/2 z-10 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-md border border-line bg-panel py-1 pl-3 pr-1 text-xs text-fg shadow-overlay">
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
        </div>
      )}
      <div role="toolbar" aria-label="Map controls" aria-orientation="vertical" className="absolute bottom-4 right-4 z-10 flex flex-col rounded-md border border-line bg-panel p-0.5 shadow-overlay">
        <IconButton icon={Plus} label="Zoom in" side="left" onClick={() => zoomBy(1.25)} />
        <IconButton icon={Minus} label="Zoom out" side="left" onClick={() => zoomBy(0.8)} />
        <span aria-hidden="true" className="mx-1.5 my-0.5 h-px bg-line" />
        <IconButton icon={Maximize2} label="Fit to view (F)" side="left" onClick={fitAll} />
        <IconButton icon={Workflow} label="Auto arrange: reset moved nodes and fit" side="left" onClick={autoArrange} />
      </div>
    </div>
  );
}
