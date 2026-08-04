import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  forceRadial
} from 'd3-force';
import { select } from 'd3-selection';
import { zoom, zoomIdentity } from 'd3-zoom';
import { drag } from 'd3-drag';
import { GRAPH_STYLES, LAYOUTS } from './graphStyles';
import { groupColor, PROTOCOL_COLORS } from './buildGraph';

/**
 * Canvas node graph: pan/zoom, drag, hover, selection, live message-flow
 * animation, activity-weighted sizing, value overlays, search/focus dimming,
 * collapse badges, edge-kind styling, alternate layouts and a minimap.
 *
 * Rendering is on a 2D canvas so it stays smooth with hundreds of nodes; the
 * visual language is driven by the selected style preset. An imperative handle
 * exposes fit-to / export for the surrounding page.
 */
const ForceGraph = forwardRef(function ForceGraph(
  {
    data,
    styleId = 'constellation',
    layoutId = 'organic',
    selectedId = null,
    onSelect,
    onExpand,
    flow = false,
    activitySource = null,
    activitySize = false,
    nodeValues = null,
    valueZoom = 1.1,
    matchIds = null,
    focusId = null,
    minimap = false,
    colorByProtocol = false,
    beautify = false
  },
  ref
) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const simRef = useRef(null);
  const transformRef = useRef(zoomIdentity);
  const hoverRef = useRef(null);
  const pointerRef = useRef({ x: 0, y: 0 }); // last pointer position in CSS px, for the hover card
  const nodesRef = useRef([]);
  const linksRef = useRef([]);
  const dprRef = useRef(1);
  const sizeRef = useRef({ w: 0, h: 0 });
  const centeredRef = useRef(false);
  const selRef = useRef(null);
  const zoomRef = useRef(null);
  const layoutModeRef = useRef('force');

  // Live message-flow animation state (all imperative, off the React tree)
  const nodeByIdRef = useRef(new Map());
  const parentOfRef = useRef(new Map());
  const particlesRef = useRef([]);
  const pulseRef = useRef(new Map());
  const rateRef = useRef(new Map());
  const rafRef = useRef(0);
  const lastFrameRef = useRef(0);
  const drawRef = useRef(() => {});
  const bigRef = useRef(false);
  const gridRef = useRef(null);
  const fittedRef = useRef(false); // fit-to-view once, when nodes first appear
  const fitToRef = useRef(() => {}); // latest fitTo, set below (avoids TDZ in the sim effect)

  const style = GRAPH_STYLES[styleId] || GRAPH_STYLES.constellation;
  const layout = LAYOUTS[layoutId] || LAYOUTS.organic;

  // Props the mount-once interaction effect needs at CALL time, not mount time.
  // Captured plainly, the zoom/pointer handlers keep the FIRST render's onSelect/
  // onExpand/style forever — so double-clicking a node after switching OPC UA
  // servers browsed the wrong (old) server, and style/selection changes didn't
  // repaint on interaction. Refreshed every render, read via cbRef.current.
  const cbRef = useRef({});
  cbRef.current = { onSelect, onExpand, style, minimap };

  const colorFor = useCallback(
    (n) => (colorByProtocol && n.protocol ? PROTOCOL_COLORS[n.protocol] || style.palette[0] : groupColor(n.group, style.palette)),
    [colorByProtocol, style]
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = dprRef.current;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const t = transformRef.current;
    const nodes = nodesRef.current;
    const links = linksRef.current;
    const byId = nodeByIdRef.current;
    const now = Date.now(); // once per frame — stale badges + hover card share it

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = style.background;
    ctx.fillRect(0, 0, width, height);

    if (style.grid) {
      const size = style.grid.size * t.k;
      const offX = t.x % size;
      const offY = t.y % size;
      ctx.strokeStyle = style.grid.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = offX; x < width; x += size) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
      }
      for (let y = offY; y < height; y += size) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      ctx.stroke();
    }

    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    const hover = hoverRef.current;
    const neighbors = new Set();
    if (hover) {
      for (const l of links) {
        if (l.source.id === hover.id) neighbors.add(l.target.id);
        if (l.target.id === hover.id) neighbors.add(l.source.id);
      }
    }

    // Focus mode: dim everything except the focused node and its neighbors.
    const focusSet = focusId ? new Set([focusId]) : null;
    if (focusSet) {
      for (const l of links) {
        if (l.source.id === focusId) focusSet.add(l.target.id);
        if (l.target.id === focusId) focusSet.add(l.source.id);
      }
    }
    const matching = matchIds && matchIds.size ? matchIds : null;

    const nodeAlpha = (n) => {
      if (focusSet && !focusSet.has(n.id)) return 0.08;
      if (matching && !matching.has(n.id)) return 0.12;
      if (hover && hover.id !== n.id && !neighbors.has(n.id)) return 0.35;
      if (activitySize && n.meta?.isLeaf && (rateRef.current.get(n.id) || 0) < 0.05) return 0.4;
      return 1;
    };

    // Level of detail: above ~220 nodes drop the expensive canvas glow and edge
    // curvature; above ~4000 ("big"/show-all) also cull to the viewport, render
    // sub-pixel nodes as points, and drop links when zoomed far out — so even
    // hundreds of thousands of nodes pan and zoom smoothly.
    const heavy = nodes.length > 220;
    const big = nodes.length > 4000;
    const curve = !heavy;

    // Visible graph-space rect (+margin) for culling.
    const m = 80 / t.k;
    const vx0 = -t.x / t.k - m;
    const vy0 = -t.y / t.k - m;
    const vx1 = (width - t.x) / t.k + m;
    const vy1 = (height - t.y) / t.k + m;
    const inView = (x, y) => x >= vx0 && x <= vx1 && y >= vy0 && y <= vy1;

    // Links: batch the common case into ONE stroke; draw active / faded /
    // composition edges individually. In big mode, cull to the viewport and skip
    // links entirely when zoomed far out (nodes convey structure).
    const drawLinks = !big || t.k >= 0.3;
    const baseLinkW = (beautify ? style.link.width * 1.5 : style.link.width) / t.k;
    if (drawLinks) {
      // Beautify: brighter, slightly thicker links (with a glow when not heavy)
      // so the topology reads as a lit constellation rather than grey threads.
      ctx.lineWidth = baseLinkW;
      ctx.strokeStyle = beautify ? style.linkHighlight || style.link.color : style.link.color;
      if (beautify && !heavy) {
        ctx.shadowColor = style.linkHighlight || style.link.color;
        ctx.shadowBlur = 6;
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = beautify ? 0.85 : 1;
      ctx.beginPath();
      const special = [];
      const rates = rateRef.current;
      const hasRates = rates.size > 0;
      for (const l of links) {
        if (big && !inView(l.source.x, l.source.y) && !inView(l.target.x, l.target.y)) continue;
        const active = hover && (l.source.id === hover.id || l.target.id === hover.id);
        const faded = focusSet && !(focusSet.has(l.source.id) && focusSet.has(l.target.id));
        // Rate-weighted edges: a link whose target is currently receiving
        // messages draws thicker and brighter, so busy pipes read at a glance.
        const rate = hasRates ? rates.get(l.target.id) || 0 : 0;
        if (active || faded || rate > 0 || l.kind === 'composition') {
          special.push({ l, active, faded, rate });
          continue;
        }
        addLinkPath(ctx, l, curve);
      }
      ctx.stroke();
      for (const { l, active, faded, rate } of special) {
        const rated = rate > 0 && !faded;
        ctx.lineWidth = rated ? baseLinkW * (1 + Math.min(rate, 4)) : baseLinkW;
        ctx.globalAlpha = faded ? 0.15 : rated && !active ? Math.min(0.9, 0.4 + Math.min(rate, 4) * 0.12) : 1;
        ctx.strokeStyle = active || rated ? style.linkHighlight : style.link.color;
        ctx.setLineDash(l.kind === 'composition' ? [5 / t.k, 4 / t.k] : []);
        ctx.beginPath();
        addLinkPath(ctx, l, curve);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.lineWidth = baseLinkW;
      ctx.shadowBlur = 0;
    }

    // Selection path-to-root: retrace the selected node's parent chain in the
    // highlight color (over the links, under the nodes) so where the selected
    // topic hangs in the hierarchy is readable at a glance.
    if (selectedId && parentOfRef.current.has(selectedId)) {
      const parentOf = parentOfRef.current;
      ctx.strokeStyle = style.linkHighlight;
      ctx.lineWidth = baseLinkW * 2.4;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      let cur = selectedId;
      const guard = new Set([cur]);
      while (parentOf.has(cur)) {
        const parent = parentOf.get(cur);
        if (guard.has(parent)) break;
        const a = byId.get(parent);
        const b = byId.get(cur);
        if (a && b) addLinkPath(ctx, { source: a, target: b }, curve);
        guard.add(parent);
        cur = parent;
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    const showLabels = t.k >= style.showLabelsAtZoom;
    const showValues = nodeValues && t.k >= valueZoom;

    for (const n of nodes) {
      if (big && !inView(n.x, n.y)) continue;
      const baseR = nodeRadius(n, style);
      const rate = rateRef.current.get(n.id) || 0;
      const r = activitySize ? baseR * (1 + Math.min(rate, 6) * 0.18) : baseR;
      const color = colorFor(n);
      const alpha = nodeAlpha(n);

      // Fast path for tiny on-screen nodes in big graphs: a cheap point, no
      // arc / stroke / glow / label.
      if (big && r * t.k < 1.4) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        const s = 1.6 / t.k;
        ctx.fillRect(n.x - s / 2, n.y - s / 2, s, s);
        ctx.globalAlpha = 1;
        continue;
      }

      ctx.globalAlpha = alpha;

      let glow = 0;
      if (!heavy) {
        glow = (style.node.glow || 0) + Math.min(rate, 4) * 6;
        // Beautify: a persistent bloom halo around every node, brighter on hubs.
        if (beautify) glow = Math.max(glow, 8 + Math.min(r, 14) * 0.7);
      }
      if (glow > 0) {
        ctx.shadowColor = color;
        ctx.shadowBlur = glow;
      } else if (ctx.shadowBlur) {
        ctx.shadowBlur = 0;
      }

      ctx.fillStyle = color;
      ctx.beginPath();
      if (style.node.square) {
        const s = r * 1.7;
        ctx.rect(n.x - s / 2, n.y - s / 2, s, s);
      } else {
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.shadowBlur = 0;

      if (style.node.strokeWidth) {
        ctx.lineWidth = style.node.strokeWidth / t.k;
        ctx.strokeStyle = style.node.stroke;
        ctx.stroke();
      }

      if (n.id === selectedId) {
        ctx.lineWidth = 2.5 / t.k;
        ctx.strokeStyle = style.selectedRing;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 5 / t.k, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Collapsed-subtree badge
      if (n.collapsedCount) {
        drawBadge(ctx, n.x + r, n.y - r, `+${n.collapsedCount}`, t.k, style.linkHighlight);
      }

      // Stale badge: a leaf that hasn't published in over a minute gets an
      // amber dot at its edge; over five minutes it turns rose.
      if (n.meta?.isLeaf && n.meta.lastActivity) {
        const age = now - lastActivityTs(n.meta);
        if (age > STALE_AMBER_MS) {
          ctx.globalAlpha = Math.min(alpha, 0.9);
          ctx.fillStyle = age > STALE_RED_MS ? STALE_RED : STALE_AMBER;
          ctx.beginPath();
          ctx.arc(n.x + r * 0.85, n.y - r * 0.85, 3 / t.k, 0, Math.PI * 2);
          ctx.fill();
          ctx.lineWidth = 1 / t.k;
          ctx.strokeStyle = style.background;
          ctx.stroke();
        }
      }

      ctx.globalAlpha = 1;

      if (showLabels && alpha > 0.3) {
        ctx.font = style.labelFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const label = n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label;
        ctx.lineWidth = 3 / t.k;
        ctx.strokeStyle = style.label.halo;
        ctx.strokeText(label, n.x, n.y + r + 2);
        ctx.fillStyle = style.label.color;
        ctx.fillText(label, n.x, n.y + r + 2);

        // Value overlay + sparkline for leaf nodes above the zoom threshold
        if (showValues && alpha > 0.5) {
          const v = nodeValues[n.id];
          if (v) {
            if (v.text != null) {
              ctx.font = `600 11px 'JetBrains Mono', monospace`;
              const vt = String(v.text).slice(0, 18);
              ctx.lineWidth = 3 / t.k;
              ctx.strokeStyle = style.label.halo;
              ctx.strokeText(vt, n.x, n.y + r + 16);
              ctx.fillStyle = style.linkHighlight;
              ctx.fillText(vt, n.x, n.y + r + 16);
            }
            if (v.series && v.series.length > 1) {
              drawSparkline(ctx, v.series, n.x, n.y - r - 4, 34, 12, t.k, style.linkHighlight);
            }
          }
        }
      }
    }

    // Live-flow overlay: expanding pulse rings + travelling dots.
    if (pulseRef.current.size) {
      ctx.strokeStyle = style.linkHighlight;
      for (const [id, s] of pulseRef.current) {
        const n = byId.get(id);
        if (!n) continue;
        const r = nodeRadius(n, style);
        ctx.globalAlpha = s * 0.85;
        ctx.lineWidth = 2 / t.k;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 3 + (1 - s) * 16, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    if (particlesRef.current.length) {
      ctx.fillStyle = style.linkHighlight;
      if (!heavy) {
        ctx.shadowColor = style.linkHighlight;
        ctx.shadowBlur = 8;
      }
      const dot = 3.5 / t.k;
      for (const p of particlesRef.current) {
        const pos = particlePosition(p, byId);
        if (!pos) continue;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, dot, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }

    ctx.restore();

    // Screen-space overlays, drawn last so they sit on top of everything. The
    // dpr transform is re-applied so CSS-pixel coordinates land correctly on
    // hiDPI screens — which also keeps the minimap pointer hit-test (done in
    // CSS px) aligned with what is actually drawn.
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (minimap) drawMinimap(ctx, nodes, t, sizeRef.current, style, colorFor);
    if (hover) drawHoverCard(ctx, hover, pointerRef.current, sizeRef.current, style, now);
    ctx.restore();
  }, [style, selectedId, activitySize, nodeValues, valueZoom, matchIds, focusId, minimap, colorFor, beautify]);

  useEffect(() => {
    drawRef.current = draw;
  }, [draw]);

  // Build / rebuild the simulation when data or layout changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;

    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    const nodes = data.nodes.map((n) => {
      const old = prev.get(n.id);
      return old ? { ...n, x: old.x, y: old.y, vx: old.vx, vy: old.vy } : { ...n };
    });
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const links = data.links
      .filter((l) => nodeById.has(l.source) && nodeById.has(l.target))
      .map((l) => ({ source: l.source, target: l.target, kind: l.kind }));

    const parentOf = new Map();
    for (const l of links) parentOf.set(l.target, l.source);
    nodeByIdRef.current = nodeById;
    parentOfRef.current = parentOf;
    nodesRef.current = nodes;
    linksRef.current = links;
    layoutModeRef.current = layout.mode;
    // Re-resolve the hovered node against the new node set — otherwise a node
    // removed by filtering keeps its hover card (and hover dimming) painted
    // from a stale object until the pointer moves again.
    if (hoverRef.current) hoverRef.current = nodeById.get(hoverRef.current.id) || null;

    if (simRef.current) simRef.current.stop();

    const depth = computeDepths(nodes, links);

    // Big / show-all graphs: skip physics entirely — a force sim on tens of
    // thousands of nodes is infeasible. Place nodes with a deterministic radial
    // tree (O(n)), build a spatial grid for hit-testing, and rely on viewport
    // culling in draw(). Pan/zoom stay smooth; node dragging is disabled.
    // Auto-fit the first time real nodes appear so the graph is centered and
    // fully in view on load, instead of showing a cluster at origin-scale that
    // the user has to pan/zoom to find. Guarded so it never fights later panning.
    const autoFit = () => {
      if (fittedRef.current || !nodesRef.current.length) return;
      fittedRef.current = true;
      fitToRef.current();
    };

    const big = nodes.length > 4000;
    bigRef.current = big;
    if (big) {
      radialTreeLayout(nodes, links, depth);
      buildGrid(nodes, gridRef);
      simRef.current = null;
      requestAnimationFrame(() => {
        draw();
        autoFit(); // positions are final immediately for the big radial layout
      });
      return undefined;
    }

    const sim = forceSimulation(nodes)
      .force('link', forceLink(links).id((d) => d.id).distance(layout.linkDistance || 55).strength(0.6))
      .force('collide', forceCollide().radius((d) => nodeRadius(d, style) + 4))
      .alpha(0.9)
      .alphaDecay(0.028)
      .on('tick', draw);

    if (layout.mode === 'radial') {
      sim
        .force('charge', forceManyBody().strength(layout.charge))
        .force('radial', forceRadial((d) => (depth.get(d.id) || 0) * layout.ringGap, 0, 0).strength(0.9))
        .force('center', forceCenter(0, 0).strength(0.05));
    } else if (layout.mode === 'cluster') {
      const centers = clusterCenters(nodes, layout.clusterRadius);
      sim
        .force('charge', forceManyBody().strength(layout.charge))
        .force('x', forceX((d) => centers.get(d.group)?.x || 0).strength(0.25))
        .force('y', forceY((d) => centers.get(d.group)?.y || 0).strength(0.25));
    } else if (layout.mode === 'tree') {
      const pos = treePositions(nodes, links, layout);
      for (const n of nodes) {
        const p = pos.get(n.id);
        if (p) {
          n.x = p.x;
          n.y = p.y;
          n.fx = p.x;
          n.fy = p.y;
        }
      }
      sim.alphaDecay(0.2); // settle immediately — positions are fixed
    } else {
      sim
        .force('charge', forceManyBody().strength(layout.charge))
        .force('center', forceCenter(0, 0))
        .force('x', forceX(0).strength(layout.gravity))
        .force('y', forceY(0).strength(layout.gravity));
    }

    // Fit once the force layout has settled (nodes start clustered at origin, so
    // fitting immediately would frame a dot); 'end' fires when alpha decays out.
    sim.on('end', autoFit);
    simRef.current = sim;
    return () => sim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, layout, draw]);

  useEffect(() => {
    draw();
  }, [draw]);

  // ---- Live message-flow animation ----
  const startAnimation = useCallback(() => {
    if (rafRef.current) return;
    lastFrameRef.current = 0;
    const step = (ts) => {
      const dt = lastFrameRef.current ? Math.min(ts - lastFrameRef.current, 50) : 16;
      lastFrameRef.current = ts;

      const particles = particlesRef.current;
      for (let i = particles.length - 1; i >= 0; i--) {
        particles[i].progress += dt * particles[i].speed;
        if (particles[i].progress >= 1) particles.splice(i, 1);
      }
      const pulseDecay = Math.pow(0.9, dt / 16);
      for (const [id, s] of pulseRef.current) {
        const next = s * pulseDecay;
        if (next < 0.04) pulseRef.current.delete(id);
        else pulseRef.current.set(id, next);
      }
      const rateDecay = Math.pow(0.985, dt / 16);
      for (const [id, v] of rateRef.current) {
        const next = v * rateDecay;
        if (next < 0.05) rateRef.current.delete(id);
        else rateRef.current.set(id, next);
      }

      drawRef.current();

      if (particles.length || pulseRef.current.size || rateRef.current.size) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = 0;
        lastFrameRef.current = 0;
      }
    };
    rafRef.current = requestAnimationFrame(step);
  }, []);

  // Register activity on a node: bump its rate, and (when animating) pulse it and
  // send a dot from the root down to it. `force` animates regardless of the flow
  // toggle — used by the replay scrubber.
  const emitPulse = useCallback(
    (nodeId, force) => {
      const byId = nodeByIdRef.current;
      if (!byId.has(nodeId)) return;

      const path = [nodeId];
      let cur = nodeId;
      const guard = new Set([nodeId]);
      while (parentOfRef.current.has(cur)) {
        const parent = parentOfRef.current.get(cur);
        if (guard.has(parent)) break;
        path.push(parent);
        guard.add(parent);
        cur = parent;
      }
      path.reverse();

      rateRef.current.set(nodeId, (rateRef.current.get(nodeId) || 0) + 1);
      if (flow || force) {
        pulseRef.current.set(nodeId, 1);
        if (path.length >= 2) {
          const dur = 450 + (path.length - 1) * 130;
          particlesRef.current.push({ nodeIds: path, progress: 0, speed: 1 / dur });
          if (particlesRef.current.length > 200) particlesRef.current.shift();
        }
      }
      startAnimation();
    },
    [flow, startAnimation]
  );
  const pulse = useCallback((nodeId) => emitPulse(nodeId, false), [emitPulse]);

  // Subscribe to the activity bus whenever flow OR activity-sizing needs it.
  useEffect(() => {
    if ((!flow && !activitySize) || !activitySource) return undefined;
    const unsub = activitySource(pulse);
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, [flow, activitySize, activitySource, pulse]);

  // Clear transient animation state when both live features are off.
  useEffect(() => {
    if (flow || activitySize) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    particlesRef.current = [];
    pulseRef.current.clear();
    rateRef.current.clear();
    draw();
  }, [flow, activitySize, draw]);

  useEffect(() => () => rafRef.current && cancelAnimationFrame(rafRef.current), []);

  // ---- Imperative handle: fit-to and export ----
  const fitTo = useCallback((ids) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w, h } = sizeRef.current;
    const set = ids && ids.size ? ids : null;
    const nodes = nodesRef.current.filter((n) => (set ? set.has(n.id) : true));
    if (!nodes.length || w === 0) return;
    // Plain loop, not Math.min(...xs): spreading 100k+ coordinates into one
    // call blows the engine's argument limit (RangeError) on big graphs.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
    const pad = 90;
    const cx = (minX + maxX) / 2;
    let k;
    let tx;
    let ty;
    if (layoutModeRef.current === 'tree') {
      // The indented tree grows top-to-bottom: fit to WIDTH at a readable zoom
      // and anchor the root near the top (scroll down for the rest) when the
      // tree is taller than the viewport; centre it vertically when it's short.
      k = Math.min((w - pad) / Math.max(maxX - minX, 1), 1.5);
      const treeH = (maxY - minY) * k;
      tx = w / 2 - k * cx;
      ty = treeH > h - pad ? pad / 2 - k * minY : h / 2 - k * ((minY + maxY) / 2);
    } else {
      k = Math.min((w - pad) / Math.max(maxX - minX, 1), (h - pad) / Math.max(maxY - minY, 1), 2.5);
      tx = w / 2 - k * cx;
      ty = h / 2 - k * ((minY + maxY) / 2);
    }
    const t = zoomIdentity.translate(tx, ty).scale(k);
    if (selRef.current && zoomRef.current) selRef.current.call(zoomRef.current.transform, t);
    transformRef.current = t;
    draw();
  }, [draw]);

  useEffect(() => {
    fitToRef.current = fitTo;
  }, [fitTo]);

  useImperativeHandle(
    ref,
    () => ({
      fitTo,
      pulseNode: (nodeId) => emitPulse(nodeId, true),
      exportPng: () => canvasRef.current?.toDataURL('image/png'),
      exportGraph: () => ({
        nodes: (data?.nodes || []).map(({ id, label, group, kind }) => ({ id, label, group, kind })),
        links: (data?.links || []).map((l) => ({ source: l.source, target: l.target, kind: l.kind }))
      })
    }),
    [fitTo, emitPulse, data]
  );

  // ---- Canvas sizing + interaction wiring (once) ----
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const sel = select(canvas);
    selRef.current = sel;

    // ---- Minimap navigation (shares MINIMAP_* geometry with drawMinimap) ----
    const inMinimap = (e) => {
      if (!cbRef.current.minimap || !nodesRef.current.length) return false;
      const { w, h } = sizeRef.current;
      if (!w) return false;
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const mx = w - MINIMAP_W - MINIMAP_MARGIN;
      const my = h - MINIMAP_H - MINIMAP_MARGIN;
      return px >= mx && px <= mx + MINIMAP_W && py >= my && py <= my + MINIMAP_H;
    };

    // Center the viewport on the world point under a minimap press, keeping the
    // current zoom level. Routed through the d3-zoom transform so pan/zoom
    // state stays consistent with ordinary panning.
    const navigateMinimap = (e) => {
      const m = minimapLayout(nodesRef.current, sizeRef.current);
      if (!m) return;
      const rect = canvas.getBoundingClientRect();
      const wx = (e.clientX - rect.left - m.ox) / m.s + m.minX;
      const wy = (e.clientY - rect.top - m.oy) / m.s + m.minY;
      const { w, h } = sizeRef.current;
      const k = transformRef.current.k;
      const t = zoomIdentity.translate(w / 2 - k * wx, h / 2 - k * wy).scale(k);
      if (zoomRef.current) sel.call(zoomRef.current.transform, t);
    };

    // Swallow mouse events that begin inside the minimap BEFORE d3 zoom/drag
    // see them (at-target listeners fire in registration order, and these are
    // registered ahead of sel.call(zoomBehavior)), so a minimap press never
    // starts a graph pan, a double-click zoom, or a node drag.
    const swallowMinimap = (e) => {
      if (inMinimap(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    canvas.addEventListener('mousedown', swallowMinimap);
    canvas.addEventListener('dblclick', swallowMinimap);
    canvas.addEventListener('touchstart', swallowMinimap, { passive: false });

    const zoomBehavior = zoom()
      .scaleExtent([0.05, 8])
      .on('zoom', (event) => {
        transformRef.current = event.transform;
        drawRef.current();
      });
    zoomRef.current = zoomBehavior;
    sel.call(zoomBehavior);

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      dprRef.current = dpr;
      const { width, height } = wrap.getBoundingClientRect();
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      sizeRef.current = { w: width, h: height };
      if (!centeredRef.current && width > 0 && height > 0) {
        centeredRef.current = true;
        const initial = zoomIdentity.translate(width / 2, height / 2);
        transformRef.current = initial;
        sel.call(zoomBehavior.transform, initial);
      }
      drawRef.current();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const toGraphCoords = (event) => {
      const rect = canvas.getBoundingClientRect();
      const t = transformRef.current;
      return { x: (event.clientX - rect.left - t.x) / t.k, y: (event.clientY - rect.top - t.y) / t.k };
    };

    const pick = (gx, gy) => {
      const curStyle = cbRef.current.style;
      // Big graphs use the spatial grid; smaller ones scan linearly.
      if (bigRef.current && gridRef.current) return pickFromGrid(gx, gy, gridRef.current, curStyle);
      const nodes = nodesRef.current;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const r = nodeRadius(n, curStyle) + 6;
        if ((n.x - gx) ** 2 + (n.y - gy) ** 2 <= r * r) return n;
      }
      return null;
    };

    // Press position (client px) for the current drag, so 'end' can tell a click
    // from a real drag. d3-drag owns the pointer once a node is the subject, so
    // the window pointerup below never sees a node click — selection has to
    // happen here instead.
    let dragStartClient = null;
    const dragBehavior = drag()
      .container(canvas)
      .subject((event) => {
        if (bigRef.current) return null; // pan/zoom only in big mode
        const { x, y } = toGraphCoords(event.sourceEvent);
        return pick(x, y);
      })
      .on('start', (event) => {
        if (!event.subject) return;
        dragStartClient = { x: event.sourceEvent.clientX, y: event.sourceEvent.clientY };
        if (simRef.current) simRef.current.alphaTarget(0.25).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      })
      .on('drag', (event) => {
        if (!event.subject) return;
        const t = transformRef.current;
        const rect = canvas.getBoundingClientRect();
        event.subject.fx = (event.sourceEvent.clientX - rect.left - t.x) / t.k;
        event.subject.fy = (event.sourceEvent.clientY - rect.top - t.y) / t.k;
      })
      .on('end', (event) => {
        if (!event.subject) return;
        if (simRef.current) simRef.current.alphaTarget(0);
        // A press that barely moved is a click, not a drag: select the node
        // (opens the properties panel). Without this, clicking a node in any
        // graph under the big-mode threshold never selected it, because d3-drag
        // captured the gesture and the window pointerup never fired onUp.
        const up = event.sourceEvent;
        const moved =
          dragStartClient && up ? Math.hypot(up.clientX - dragStartClient.x, up.clientY - dragStartClient.y) : Infinity;
        dragStartClient = null;
        if (moved <= 5) cbRef.current.onSelect?.(event.subject);
        // Keep nodes pinned in tree mode; release them in free-form layouts.
        if (layoutModeRef.current !== 'tree') {
          event.subject.fx = null;
          event.subject.fy = null;
        }
      });
    sel.call(dragBehavior);

    let downPos = null;
    let minimapDrag = false;
    const onDown = (e) => {
      if (inMinimap(e)) {
        // preventDefault suppresses the compatibility mousedown, keeping the
        // (mouse-event based) d3 zoom/drag behaviors out of minimap presses;
        // the capture-order swallowMinimap above is the belt to this suspender.
        e.preventDefault();
        minimapDrag = true;
        navigateMinimap(e);
        return; // no downPos → the release can't click-select a node
      }
      downPos = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e) => {
      if (minimapDrag) {
        minimapDrag = false;
        return;
      }
      if (!downPos) return;
      const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
      downPos = null;
      if (moved > 5) return;
      const { x, y } = toGraphCoords(e);
      const hit = pick(x, y);
      if (hit && cbRef.current.onSelect) cbRef.current.onSelect(hit);
    };
    const onDblClick = (e) => {
      const { x, y } = toGraphCoords(e);
      const hit = pick(x, y);
      if (hit && cbRef.current.onExpand) cbRef.current.onExpand(hit);
    };
    const onMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      pointerRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (minimapDrag) {
        navigateMinimap(e); // drag within the minimap keeps re-centering
        return;
      }
      if (inMinimap(e)) {
        canvas.style.cursor = 'pointer';
        if (hoverRef.current) {
          hoverRef.current = null;
          drawRef.current();
        }
        return;
      }
      const { x, y } = toGraphCoords(e);
      const hit = pick(x, y);
      if (hit !== hoverRef.current) {
        hoverRef.current = hit;
        canvas.style.cursor = hit ? 'pointer' : 'grab';
        drawRef.current();
      } else if (hit) {
        drawRef.current(); // keep the hover card tracking the cursor
      }
    };

    // Right-click a node to open its properties (suppress the native menu).
    const onContext = (e) => {
      if (inMinimap(e)) return;
      const { x, y } = toGraphCoords(e);
      const hit = pick(x, y);
      if (hit) {
        e.preventDefault();
        cbRef.current.onSelect?.(hit);
      }
    };

    // pointerdown stays on the canvas (so downPos is only set for presses that
    // begin on the graph). pointerup/pointermove go on WINDOW: d3-zoom and
    // d3-drag are bound to this same canvas and preempt canvas-level pointerup,
    // so a plain left-click's onUp never fired and selection silently failed.
    // The 3D renderer already uses window listeners for exactly this reason.
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    canvas.addEventListener('dblclick', onDblClick);
    window.addEventListener('pointermove', onMove);
    canvas.addEventListener('contextmenu', onContext);

    return () => {
      ro.disconnect();
      canvas.removeEventListener('mousedown', swallowMinimap);
      canvas.removeEventListener('dblclick', swallowMinimap);
      canvas.removeEventListener('touchstart', swallowMinimap);
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('dblclick', onDblClick);
      window.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('contextmenu', onContext);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="graph-canvas" />
    </div>
  );
});

export default ForceGraph;

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------
function nodeRadius(n, style) {
  const base = style.nodeMinRadius;
  const scaled = base + Math.sqrt(n.degree || 0) * 3;
  if (n.kind === 'broker' || n.kind === 'opcua-server' || n.kind === 'i3x-server') return style.nodeMaxRadius;
  return Math.min(scaled, style.nodeMaxRadius);
}

// Stale-activity thresholds for leaf badges and the hover card's "last seen".
// Deliberately NOT the group palette's amber/rose (#fbbf24/#fb7185) so the dot
// still separates from amber "data" and rose "alarm" nodes.
const STALE_AMBER_MS = 60_000;
const STALE_RED_MS = 300_000;
const STALE_AMBER = '#f59e0b';
const STALE_RED = '#f43f5e';

// Parse meta.lastActivity (epoch ms or ISO string) once and cache it on the
// meta — Date.parse per node per frame would burn ~1ms at 1000 nodes.
function lastActivityTs(meta) {
  const la = meta.lastActivity;
  if (la == null) return 0;
  if (typeof la === 'number') return la;
  if (meta._laRaw !== la) {
    meta._laRaw = la;
    meta._laTs = Date.parse(la) || 0;
  }
  return meta._laTs;
}

// Compact canvas-drawn card for the hovered node. Drawn in screen space at the
// end of the frame so it sits above everything; offset from the pointer and
// clamped (flipping sides near the edges) so it never hides under the cursor
// or leaves the canvas. Styled from the active preset so it works everywhere.
function drawHoverCard(ctx, node, pointer, size, style, now) {
  if (!size.w) return;
  const meta = node.meta || {};
  const lines = [
    { text: node.label.length > 28 ? `${node.label.slice(0, 27)}…` : node.label, font: '600 12px Inter, sans-serif', alpha: 1 }
  ];
  const topic = meta.fullTopic || meta.path || null;
  if (topic && topic !== node.label) {
    lines.push({
      text: topic.length > 40 ? `…${topic.slice(-39)}` : topic,
      font: `10px 'JetBrains Mono', monospace`,
      alpha: 0.75
    });
  }
  if (meta.messageCount != null) {
    lines.push({ text: `${Number(meta.messageCount).toLocaleString()} messages`, font: '11px Inter, sans-serif', alpha: 0.75 });
  }
  if (meta.lastActivity) {
    const age = Math.max(0, now - lastActivityTs(meta));
    const s = Math.round(age / 1000);
    const ago = s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
    lines.push({
      text: `last seen ${ago} ago`,
      font: '11px Inter, sans-serif',
      alpha: 0.85,
      color: age > STALE_RED_MS ? STALE_RED : age > STALE_AMBER_MS ? STALE_AMBER : null
    });
  }

  const padX = 10;
  const padY = 8;
  const lineH = 15;
  ctx.save();
  let w = 0;
  for (const l of lines) {
    ctx.font = l.font;
    const tw = ctx.measureText(l.text).width;
    if (tw > w) w = tw;
  }
  w += padX * 2;
  const h = lines.length * lineH + padY * 2 - 3;

  let x = pointer.x + 14;
  let y = pointer.y + 14;
  if (x + w > size.w - 8) x = pointer.x - w - 14;
  if (y + h > size.h - 8) y = pointer.y - h - 14;
  x = Math.max(8, Math.min(x, size.w - w - 8));
  y = Math.max(8, Math.min(y, size.h - h - 8));

  ctx.globalAlpha = 0.95;
  ctx.fillStyle = style.background;
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 12;
  roundRect(ctx, x, y, w, h, 8);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
  ctx.strokeStyle = style.link.color;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  let ty = y + padY;
  for (const l of lines) {
    ctx.font = l.font;
    ctx.globalAlpha = l.alpha;
    ctx.fillStyle = l.color || style.label.color;
    ctx.fillText(l.text, x + padX, ty);
    ty += lineH;
  }
  ctx.restore();
}

// Add one link's path (straight, or a gentle perpendicular-offset curve) to the
// current path so many links can be batched into a single stroke.
function addLinkPath(ctx, l, curve) {
  const x1 = l.source.x;
  const y1 = l.source.y;
  const x2 = l.target.x;
  const y2 = l.target.y;
  ctx.moveTo(x1, y1);
  if (!curve) {
    ctx.lineTo(x2, y2);
    return;
  }
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  ctx.quadraticCurveTo(mx - dy * 0.12, my + dx * 0.12, x2, y2);
}

function particlePosition(p, byId) {
  const segments = p.nodeIds.length - 1;
  if (segments < 1) return null;
  const f = Math.max(0, Math.min(p.progress, 1)) * segments;
  const i = Math.min(Math.floor(f), segments - 1);
  const local = f - i;
  const a = byId.get(p.nodeIds[i]);
  const b = byId.get(p.nodeIds[i + 1]);
  if (!a || !b) return null;
  return { x: a.x + (b.x - a.x) * local, y: a.y + (b.y - a.y) * local };
}

function drawBadge(ctx, x, y, text, k, color) {
  ctx.save();
  ctx.font = `600 ${10 / k}px Inter, sans-serif`;
  const padX = 4 / k;
  const w = ctx.measureText(text).width + padX * 2;
  const h = 13 / k;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  roundRect(ctx, x - w / 2, y - h / 2, w, h, 4 / k);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#0a0f1c';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawSparkline(ctx, series, cx, cy, w, h, k, color) {
  const vals = series.filter((v) => Number.isFinite(v));
  if (vals.length < 2) return;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const sw = w / k;
  const sh = h / k;
  const x0 = cx - sw / 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2 / k;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  vals.forEach((v, i) => {
    const px = x0 + (i / (vals.length - 1)) * sw;
    const py = cy - ((v - min) / span) * sh;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Minimap geometry is shared by drawMinimap and the pointer hit-test /
// click-to-navigate handlers in the interaction effect — keep them in lockstep.
const MINIMAP_W = 168;
const MINIMAP_H = 112;
const MINIMAP_MARGIN = 16;
const MINIMAP_PAD = 8;

// Screen rect + world→minimap mapping (null when there's nothing to draw).
function minimapLayout(nodes, size) {
  if (!nodes.length || size.w === 0) return null;
  const mx = size.w - MINIMAP_W - MINIMAP_MARGIN;
  const my = size.h - MINIMAP_H - MINIMAP_MARGIN;
  // Plain loop, not Math.min(...xs): spread over 100k+ coords throws RangeError.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  const s = Math.min(
    (MINIMAP_W - MINIMAP_PAD * 2) / Math.max(maxX - minX, 1),
    (MINIMAP_H - MINIMAP_PAD * 2) / Math.max(maxY - minY, 1)
  );
  return { mx, my, minX, minY, s, ox: mx + MINIMAP_PAD, oy: my + MINIMAP_PAD };
}

function drawMinimap(ctx, nodes, t, size, style, colorFor) {
  const m = minimapLayout(nodes, size);
  if (!m) return;
  const { mx, my, minX, minY, s, ox, oy } = m;
  const toMx = (x) => ox + (x - minX) * s;
  const toMy = (y) => oy + (y - minY) * s;

  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = 'rgba(10,15,28,0.85)';
  roundRect(ctx, mx, my, MINIMAP_W, MINIMAP_H, 10);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.clip();

  for (const n of nodes) {
    ctx.fillStyle = colorFor(n);
    ctx.beginPath();
    ctx.arc(toMx(n.x), toMy(n.y), 1.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Viewport rectangle: which graph area is currently visible
  const vx0 = (-t.x) / t.k;
  const vy0 = (-t.y) / t.k;
  const vx1 = (size.w - t.x) / t.k;
  const vy1 = (size.h - t.y) / t.k;
  ctx.strokeStyle = style.linkHighlight;
  ctx.lineWidth = 1.2;
  ctx.strokeRect(toMx(vx0), toMy(vy0), (vx1 - vx0) * s, (vy1 - vy0) * s);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------
function computeDepths(nodes, links) {
  const childrenOf = new Map();
  const hasParent = new Set();
  for (const l of links) {
    if (!childrenOf.has(l.source)) childrenOf.set(l.source, []);
    childrenOf.get(l.source).push(l.target);
    hasParent.add(l.target);
  }
  const depth = new Map();
  const roots = nodes.filter((n) => !hasParent.has(n.id));
  const queue = roots.map((n) => [n.id, 0]);
  for (const n of roots) depth.set(n.id, 0);
  while (queue.length) {
    const [id, d] = queue.shift();
    for (const c of childrenOf.get(id) || []) {
      if (!depth.has(c)) {
        depth.set(c, d + 1);
        queue.push([c, d + 1]);
      }
    }
  }
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, 0);
  return depth;
}

// Indented tree that grows top-to-bottom: every node gets its own row (DFS
// order, one below the last), and depth is shown by horizontal indent — like a
// file explorer. This keeps a large hierarchy a tall, scrollable column with no
// overlapping labels, instead of a tidy tree that fans out into a wide, flat
// horizontal line at the leaves.
function treePositions(nodes, links, layout) {
  // d3's forceLink mutates link.source/target from id strings to node objects
  // once the simulation is set up. This runs afterward, so resolve either shape.
  const endId = (e) => (e && typeof e === 'object' ? e.id : e);
  const childrenOf = new Map();
  const hasParent = new Set();
  for (const l of links) {
    const s = endId(l.source);
    const t = endId(l.target);
    if (!childrenOf.has(s)) childrenOf.set(s, []);
    childrenOf.get(s).push(t);
    hasParent.add(t);
  }
  const rowGap = layout.rowGap || 34; // vertical step: one row per node
  const indent = layout.colGap || 46; // horizontal step: per depth level
  const pos = new Map();
  const seen = new Set();
  let row = 0;

  const visit = (id, depth) => {
    if (seen.has(id)) return;
    seen.add(id);
    pos.set(id, { x: depth * indent, y: row * rowGap });
    row++;
    for (const c of childrenOf.get(id) || []) visit(c, depth + 1);
  };

  const roots = nodes.filter((n) => !hasParent.has(n.id));
  for (const r of roots) visit(r.id, 0);
  for (const n of nodes) if (!pos.has(n.id)) visit(n.id, 0); // stragglers (cycles)

  // Loop, not spread: Math.min(...arr) over huge trees throws RangeError.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pos.values()) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const cx = pos.size ? (minX + maxX) / 2 : 0;
  const cy = pos.size ? (minY + maxY) / 2 : 0;
  for (const p of pos.values()) {
    p.x -= cx;
    p.y -= cy;
  }
  return pos;
}

function clusterCenters(nodes, radius) {
  const groups = [...new Set(nodes.map((n) => n.group))];
  const centers = new Map();
  groups.forEach((g, i) => {
    const angle = (i / groups.length) * Math.PI * 2;
    centers.set(g, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  });
  return centers;
}

// Deterministic O(n) radial-tree layout for very large graphs: each node owns an
// angular wedge proportional to its leaf count, placed at radius ∝ depth. No
// physics — positions are exact, so it scales to hundreds of thousands of nodes.
function radialTreeLayout(nodes, links, depth) {
  const childrenOf = new Map();
  const hasParent = new Set();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const l of links) {
    if (!childrenOf.has(l.source)) childrenOf.set(l.source, []);
    childrenOf.get(l.source).push(l.target);
    hasParent.add(l.target);
  }
  // Loop, not spread: this runs precisely on 100k+-node graphs, where
  // Math.max(1, ...nodes.map(...)) throws RangeError (argument limit).
  let maxDepth = 1;
  for (const n of nodes) {
    const d = depth.get(n.id) || 0;
    if (d > maxDepth) maxDepth = d;
  }
  const ring = 260 + maxDepth * 10; // spread rings a bit as the tree deepens

  // Leaf counts drive angular allocation so dense branches get more room.
  const leaves = new Map();
  const countLeaves = (id, guard) => {
    if (leaves.has(id)) return leaves.get(id);
    if (guard.has(id)) return 1;
    guard.add(id);
    const kids = childrenOf.get(id) || [];
    let c = kids.length === 0 ? 1 : 0;
    for (const k of kids) c += countLeaves(k, guard);
    leaves.set(id, c || 1);
    return leaves.get(id);
  };

  const roots = nodes.filter((n) => !hasParent.has(n.id));
  for (const r of roots) countLeaves(r.id, new Set());

  const place = (id, a0, a1, d, guard) => {
    const n = byId.get(id);
    if (!n || guard.has(id)) return;
    guard.add(id);
    const mid = (a0 + a1) / 2;
    const radius = d * ring;
    n.x = Math.cos(mid) * radius;
    n.y = Math.sin(mid) * radius;
    n.fx = n.x;
    n.fy = n.y;
    const kids = childrenOf.get(id) || [];
    if (kids.length === 0) return;
    const total = kids.reduce((s, k) => s + (leaves.get(k) || 1), 0) || 1;
    let a = a0;
    for (const k of kids) {
      const span = ((leaves.get(k) || 1) / total) * (a1 - a0);
      place(k, a, a + span, d + 1, guard);
      a += span;
    }
  };

  const guard = new Set();
  const totalLeaves = roots.reduce((s, r) => s + (leaves.get(r.id) || 1), 0) || 1;
  let a = 0;
  for (const r of roots) {
    const span = ((leaves.get(r.id) || 1) / totalLeaves) * Math.PI * 2;
    place(r.id, a, a + span, 0, guard);
    a += span;
  }
}

// Uniform spatial grid over node positions for O(1)-ish hit-testing at scale.
function buildGrid(nodes, gridRef) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  const cell = 40;
  const cols = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const map = new Map();
  for (const n of nodes) {
    const key = cellKey(n.x, n.y, minX, minY, cell, cols);
    let bucket = map.get(key);
    if (!bucket) {
      bucket = [];
      map.set(key, bucket);
    }
    bucket.push(n);
  }
  gridRef.current = { minX, minY, cell, cols, map };
}

function cellKey(x, y, minX, minY, cell, cols) {
  const cx = Math.floor((x - minX) / cell);
  const cy = Math.floor((y - minY) / cell);
  return cy * cols + cx;
}

function pickFromGrid(gx, gy, grid, style) {
  const { minX, minY, cell, cols, map } = grid;
  let best = null;
  let bestD = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const key = cellKey(gx + dx * cell, gy + dy * cell, minX, minY, cell, cols);
      const bucket = map.get(key);
      if (!bucket) continue;
      for (const n of bucket) {
        const r = nodeRadius(n, style) + 6;
        const d = (n.x - gx) ** 2 + (n.y - gy) ** 2;
        if (d <= r * r && d < bestD) {
          best = n;
          bestD = d;
        }
      }
    }
  }
  return best;
}
