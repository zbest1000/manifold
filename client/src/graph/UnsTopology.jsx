import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sun, Moon } from 'lucide-react';
import { onMessageActivity } from '@/store/store';
import { loadIcons } from './unsIcons';
import { UNS_THEMES } from './unsTheme';
import { DEFAULT_LEVELS } from './unsLevels';
import { recordActivity, rollRates, liveMeta } from './unsLive';
import { nodeKey, seedExpansion, layoutForest, fitTransform, pickNode, onToggleAffordance } from './unsLayout';
import { drawTopology } from './unsDraw';

/**
 * UNS topology renderer: the Unified-Namespace lens on the data fabric.
 *
 * Renders the namespace as a horizontal tidy tree of badge nodes with a level
 * ring + glyph, name and LEVEL caption beneath, "+ / -" expand affordances, and
 * edges that animate green while data flows through the branch. Theme-able
 * (dark by default, light on toggle); all colours live in unsTheme.js.
 *
 * The code is split by concern: unsLevels (level naming), unsLive (liveness
 * state), unsTree (tree build), unsLayout (layout/fit/hit-test), unsDraw
 * (canvas drawing). This file is the React shell + pointer interaction.
 * Names other modules and tests import are re-exported below.
 */
export { DEFAULT_LEVELS, levelName, levelColor, nodeLevel } from './unsLevels';
export { buildUnsTree } from './unsTree';
export { unsLiveMap, unsValueMap, unsRateMap, lastActive, nodeValue, nodeRate, staleness, expectedInterval } from './unsLive';

export default function UnsTopology({ roots, levels = DEFAULT_LEVELS, selectedId = null, onSelect, focusTarget = null, theme = 'dark', onToggleTheme }) {
  const themeTokens = UNS_THEMES[theme] || UNS_THEMES.dark;
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const sizeRef = useRef({ w: 0, h: 0 });
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
  const rafRef = useRef(0);
  const interactAt = useRef(0); // last pan/zoom/hover — keeps interaction at full fps
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

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
      if (!w) return;
      const p = posOf(l);
      const t = transformRef.current;
      t.k = Math.min(1.4, Math.max(t.k, 0.8)); // never focus while zoomed way out
      t.x = w / 2 - t.k * p.x;
      t.y = h / 2 - t.k * p.y;
    },
    [posOf]
  );
  // A pending "focus this node" request, applied once the node is laid out.
  const focusPendingRef = useRef(null);

  // Expanded paths per broker. Default: namespace + first level open. Seeding is
  // per-broker (not one-shot): a broker whose topics stream in AFTER first paint
  // still gets auto-expanded, instead of loading collapsed while its siblings
  // are open. User collapses of already-seeded brokers are preserved.
  const [expanded, setExpanded] = useState(() => new Set());
  const seededRef = useRef(new Set());
  useEffect(() => {
    const fresh = roots.filter((r) => !seededRef.current.has(r.brokerId));
    if (!fresh.length) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const r of fresh) seededRef.current.add(r.brokerId);
      for (const k of seedExpansion(fresh)) next.add(k);
      return next;
    });
  }, [roots]);

  // Warm the icon set (lazy chunk) so badges upgrade from glyphs to icons.
  useEffect(() => {
    loadIcons();
  }, []);

  // Focus request (from a lint finding / event click): open every ancestor so
  // the node is on-screen, then queue a center-on that the layout effect applies
  // once the node has a laid-out position.
  useEffect(() => {
    if (!focusTarget?.brokerId || focusTarget.path == null) return;
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
    focusPendingRef.current = { brokerId, path: String(path) };
    userMovedRef.current = true; // a deliberate jump — auto-fit must not override it
  }, [focusTarget]);

  // Live activity: stamp ancestors, count per-branch rates, record leaf values.
  useEffect(() => {
    const off = onMessageActivity((msg) => recordActivity(msg));
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
    if (focusPendingRef.current) {
      const { brokerId, path } = focusPendingRef.current;
      const target = layout.nodes.find((l) => l.node.brokerId === brokerId && l.node.path === path);
      if (target) {
        centerOn(target);
        focusPendingRef.current = null;
      }
    }
    // Read-only hook for e2e tests / screenshot tooling: world coordinates of
    // the visible nodes (manual offsets applied) plus the current view transform.
    if (typeof window !== 'undefined') {
      window.__unsLayout = {
        get transform() {
          return { ...transformRef.current };
        },
        nodes: layout.nodes.map((l) => {
          const p = posOf(l);
          return { name: l.node.name, path: l.node.path, x: p.x, y: p.y, open: l.open, hasKids: l.hasKids, depth: l.node.depth };
        })
      };
    }
  }, [layout, fitAll, posOf, centerOn]);

  // ---- Drawing ----
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w, h } = sizeRef.current;
    drawTopology(canvas.getContext('2d'), {
      w,
      h,
      dpr: window.devicePixelRatio || 1,
      t: transformRef.current,
      layout,
      posOf,
      theme: themeTokens,
      levels,
      selectedId: selectedRef.current,
      selKeys: selRef.current,
      box: boxRef.current,
      now: Date.now()
    });
  }, [layout, levels, posOf, themeTokens]);

  // Animation loop: cheap (bounded visible nodes), drives dashes + pulses + decay.
  // Idle throttle: pulses/dashes only animate around live traffic and
  // interaction; a quiet view redraws at ~8fps instead of burning 60.
  useEffect(() => {
    let running = true;
    let lastDraw = 0;
    const tick = (ts) => {
      if (!running) return;
      const now = Date.now();
      const active = now - liveMeta.lastDataAt < 3000 || now - interactAt.current < 1000;
      if (document.hidden) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      if (active || ts - lastDraw >= 125) {
        lastDraw = ts;
        draw();
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [draw]);

  // Sizing + interactions.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = wrap.getBoundingClientRect();
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      sizeRef.current = { w: width, h: height };
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const toWorld = (e) => {
      const rect = canvas.getBoundingClientRect();
      const t = transformRef.current;
      return { x: (e.clientX - rect.left - t.x) / t.k, y: (e.clientY - rect.top - t.y) / t.k };
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
    const keyOf = (l) => nodeKey(l.node);
    const onDown = (e) => {
      interactAt.current = Date.now();
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
      interactAt.current = Date.now();
      if (!mode) {
        // hover cursor feedback
        const over = pick(toWorld(e));
        canvas.style.cursor = over ? 'grab' : 'default';
        return;
      }
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
      interactAt.current = Date.now();
      userMovedRef.current = true; // zooming = user owns the camera now
      e.preventDefault();
      const t = transformRef.current;
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const nk = Math.max(0.2, Math.min(3, t.k * factor));
      t.x = px - ((px - t.x) * nk) / t.k;
      t.y = py - ((py - t.y) * nk) / t.k;
      t.k = nk;
    };

    const onKey = (e) => {
      if (e.key === 'Escape' && selRef.current.size) {
        selRef.current = new Set();
        setSelCount(0);
        interactAt.current = Date.now(); // prompt a redraw so the rings clear now
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    canvas.addEventListener('dblclick', onDbl);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(pendingSelect);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('dblclick', onDbl);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSelect, posOf]);

  const toggle = (node) => {
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
  };

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
      const nk = Math.max(0.2, Math.min(3, t.k * (e.key === '-' || e.key === '_' ? 0.9 : 1.1)));
      t.x = w / 2 - ((w / 2 - t.x) * nk) / t.k;
      t.y = h / 2 - ((h / 2 - t.y) * nk) / t.k;
      t.k = nk;
    } else if (e.key === 'f' || e.key === 'F') fitAll();
    else handled = false;
    if (handled) {
      e.preventDefault();
      userMovedRef.current = true;
      interactAt.current = Date.now();
    }
  };

  const btn = `rounded-lg border px-3 py-1.5 text-xs font-medium shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/70 ${themeTokens.toolbar}`;
  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden" style={{ background: themeTokens.bg }}>
      <canvas
        ref={canvasRef}
        className="h-full w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-400/70"
        role="img"
        aria-label={summary}
        aria-describedby="uns-canvas-help"
        tabIndex={0}
        onKeyDown={onCanvasKey}
      />
      <span id="uns-canvas-help" className="sr-only">{keyboardHint}</span>
      <div className="absolute bottom-4 right-4 z-10 flex flex-wrap items-center justify-end gap-2">
        {selCount > 0 && (
          <button
            onClick={() => {
              selRef.current = new Set();
              setSelCount(0);
            }}
            title="Clear the multi-selection (Esc)"
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium shadow-sm transition ${themeTokens.sel}`}
          >
            {selCount} selected · drag to move · Esc to clear
          </button>
        )}
        {onToggleTheme && (
          <button
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? 'Switch the topology to the light theme' : 'Switch the topology to the dark theme'}
            title={theme === 'dark' ? 'Light canvas' : 'Dark canvas'}
            className={`${btn} flex items-center gap-1.5`}
          >
            {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        )}
        <button onClick={autoArrange} title="Reset manual node positions to the tidy layout and fit to view" className={btn}>
          Auto arrange
        </button>
        <button onClick={fitAll} title="Fit the current arrangement to the viewport (keeps manual moves)" className={btn}>
          Fit
        </button>
      </div>
    </div>
  );
}
