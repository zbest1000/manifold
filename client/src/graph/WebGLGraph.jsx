import { useEffect, useMemo, useRef, useCallback } from 'react';
import { resolveGraphStyle } from './graphStyles';
import { groupColor } from './buildGraph';
import { useCanvasTokens, FONT } from './canvasTokens';
import {
  applyCanvasSize,
  attachPinchZoom,
  boundsOf,
  clientToLocal,
  createFrameScheduler,
  createLabelGrid,
  ellipsize,
  fitBounds,
  registerTestHook,
  sanitizePositions,
  screenToWorld,
  watchCanvasSize,
  createGlide,
  keepInView,
  wheelFactor,
  zoomAround
} from './canvasKit';

/**
 * WebGL2 renderer for very large ("show all") graphs. Nodes are drawn as GL
 * points and links as GL lines in a couple of draw calls, so hundreds of
 * thousands — into the millions — of nodes stay smooth to pan and zoom, where a
 * per-node 2D canvas loop would stall. Layout is a deterministic radial tree;
 * pan/zoom update a transform uniform (one draw call), and picking uses a CPU
 * spatial grid.
 *
 * Camera, picking and the label overlay all work in CSS pixels (screen = world
 * * k + t); only the GL viewport / point sizes are multiplied by the device
 * pixel ratio, so a click at a node's reported position hits it at any DPR.
 * The GL context survives `webglcontextlost` / `webglcontextrestored` (programs
 * and buffers are rebuilt from the last uploaded arrays) and is released on
 * unmount, so navigating back and forth never exhausts the browser's context
 * budget.
 *
 * The feature-rich 2D ForceGraph remains the default for normal-sized graphs
 * (labels, glow, curved links, live message-flow animation).
 */
const HUB_KINDS = new Set(['broker', 'opcua-server', 'i3x-server']);
const HUB_SIZE = 14;
const MAX_NODE_SIZE = 12; // a 2,000-child branch used to render as a 70-unit disc
const MIN_K = 0.02;
const MAX_K = 20;
const LABEL_MAX_W = 180; // CSS px
// Overlays float above the canvas (show-all controls on top, hint + legend at the bottom).
const FIT_INSET = { top: 112, right: 40, bottom: 72, left: 40 };

/** World-space DIAMETER of a node's point sprite; half of it is the radius used for labels AND picking. */
export function webglNodeSize(n) {
  if (HUB_KINDS.has(n.kind)) return HUB_SIZE;
  return Math.min(MAX_NODE_SIZE, 4 + Math.sqrt(n.degree || 0) * 1.5);
}

export default function WebGLGraph({ data, styleId = 'standard', selectedId = null, onSelect, colorByProtocol = false, labelDensity = 0.5, positions = null }) {
  const canvasRef = useRef(null);
  const labelCanvasRef = useRef(null);
  const wrapRef = useRef(null);
  const glRef = useRef(null);
  const labelDensityRef = useRef(labelDensity);
  const posRef = useRef(null);
  const progRef = useRef({});
  const buffersRef = useRef({});
  const arraysRef = useRef(null); // last uploaded geometry, re-uploaded after a context restore
  const countsRef = useRef({ nodes: 0, lineVerts: 0 });
  const nodesRef = useRef([]);
  const gridRef = useRef(null);
  const transformRef = useRef({ x: 0, y: 0, k: 1 }); // CSS px
  const sizeRef = useRef({ w: 0, h: 0, sx: 1, sy: 1 });
  const selectedRef = useRef(null);
  const glideRef = useRef(null); // keep-the-selection-in-view glide (createGlide), cancelled by user input
  const keepRef = useRef(() => {});
  const drawRef = useRef(() => {});
  const schedRef = useRef(null);
  const lostRef = useRef(false);
  // Latest onSelect for the mount-once interaction effect (see ForceGraph note).
  const cbRef = useRef({});
  useEffect(() => {
    cbRef.current = { onSelect };
  }, [onSelect]);

  // Theme-derived style (canvasTokens): a theme switch re-uploads only the
  // per-node colour buffer and repaints; positions and camera are untouched.
  const tokens = useCanvasTokens();
  const style = useMemo(() => resolveGraphStyle(styleId, tokens), [styleId, tokens]);
  const colorFor = useCallback(
    (n) => (n.state ? tokens[n.state] || style.palette[0] : colorByProtocol && n.protocol ? style.protocol[n.protocol] || style.palette[0] : groupColor(n.group, style.palette)),
    [colorByProtocol, style, tokens]
  );
  const colorForRef = useRef(colorFor);

  // Label overlay: WebGL can't cheaply draw text, so labels are painted on a 2D
  // canvas layered on top — ONLY for nodes on screen, large enough to read at
  // the current zoom, and not colliding with a label already placed (hubs and
  // the selection first). Viewport culling + a hard cap keep this to tens/low
  // hundreds of fillText calls per frame regardless of total graph size.
  const drawLabels = useCallback(
    (t) => {
      const canvas = labelCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const { w, h, sx, sy } = sizeRef.current;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(sx, 0, 0, sy, 0, 0);

      const nodes = nodesRef.current;
      const sel = selectedRef.current;
      // Density knob (0..1): higher = more labels (bigger cap, smaller nodes get
      // labelled); lower = only the largest/nearest few; 0 turns labels off.
      const d = labelDensityRef.current;
      if (d <= 0.001) return;
      const MAX = Math.round(80 + d * 1120); // ~80 → ~1200 labels
      const MIN_SCREEN_R = 9 - d * 7; // ~9px (sparse) → ~2px (dense) radius to qualify
      ctx.font = `400 11px ${FONT}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.lineJoin = 'round';
      const margin = 40;
      const grid = createLabelGrid(64);

      let drawn = 0;
      const paint = (n, px, py, r, strong) => {
        const text = ellipsize(ctx, n.label || n.id, LABEL_MAX_W);
        if (!text) return false;
        const x = px + r + 3;
        const tw = ctx.measureText(text).width;
        if (!grid.tryPlace(x - 1, py - 7, x + tw + 1, py + 7) && !strong) return false;
        ctx.lineWidth = 3;
        ctx.strokeStyle = style.label.halo;
        ctx.strokeText(text, x, py);
        ctx.fillStyle = strong ? style.label.strong : style.label.color;
        ctx.fillText(text, x, py);
        return true;
      };

      // First pass: always-on labels (servers/brokers + the selected node).
      for (const n of nodes) {
        if (!HUB_KINDS.has(n.kind) && n.id !== sel) continue;
        const px = n.x * t.k + t.x;
        const py = n.y * t.k + t.y;
        if (px < -margin || py < -margin || px > w + margin || py > h + margin) continue;
        paint(n, px, py, (n.size / 2) * t.k, true);
      }

      // Second pass: readable, on-screen, non-colliding nodes up to the cap.
      for (const n of nodes) {
        if (drawn >= MAX) break;
        if (HUB_KINDS.has(n.kind) || n.id === sel) continue;
        const r = (n.size / 2) * t.k;
        if (r < MIN_SCREEN_R / 2) continue;
        const px = n.x * t.k + t.x;
        const py = n.y * t.k + t.y;
        if (px < -margin || py < -margin || px > w + margin || py > h + margin) continue;
        if (paint(n, px, py, r, false)) drawn++;
      }
    },
    [style]
  );

  const draw = useCallback(() => {
    const gl = glRef.current;
    if (!gl || lostRef.current || gl.isContextLost()) return;
    const { w, h, sx } = sizeRef.current;
    if (!w || !h || !progRef.current.point) return;
    const t = transformRef.current;
    const bg = hexToRgb(style.background);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const { nodes, lineVerts } = countsRef.current;
    const b = buffersRef.current;

    // Links
    if (lineVerts > 0) {
      const lp = progRef.current.line;
      gl.useProgram(lp.program);
      gl.uniform2f(lp.u_translate, t.x, t.y);
      gl.uniform1f(lp.u_scale, t.k);
      gl.uniform2f(lp.u_resolution, w, h);
      const lc = hexToRgb(style.link.color);
      // Zoom-aware opacity: faint when zoomed out (tens of thousands of edges
      // would otherwise blob into a solid mass), stronger as you zoom in.
      const edgeAlpha = Math.min(0.6, 0.16 + t.k * 0.06);
      gl.uniform4f(lp.u_color, lc[0], lc[1], lc[2], edgeAlpha);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.linePos);
      gl.enableVertexAttribArray(lp.a_pos);
      gl.vertexAttribPointer(lp.a_pos, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.LINES, 0, lineVerts);
      gl.disableVertexAttribArray(lp.a_pos);
    }

    // Nodes
    if (nodes > 0) {
      const pp = progRef.current.point;
      gl.useProgram(pp.program);
      gl.uniform2f(pp.u_translate, t.x, t.y);
      gl.uniform1f(pp.u_scale, t.k);
      gl.uniform2f(pp.u_resolution, w, h);
      gl.uniform1f(pp.u_dpr, sx);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.pos);
      gl.enableVertexAttribArray(pp.a_pos);
      gl.vertexAttribPointer(pp.a_pos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.color);
      gl.enableVertexAttribArray(pp.a_color);
      gl.vertexAttribPointer(pp.a_color, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.size);
      gl.enableVertexAttribArray(pp.a_size);
      gl.vertexAttribPointer(pp.a_size, 1, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, nodes);
    }

    drawLabels(t);
  }, [style, drawLabels]);

  useEffect(() => {
    drawRef.current = draw;
    schedRef.current?.request();
  }, [draw]);

  const fitAll = useCallback(() => {
    const f = fitBounds(boundsOf(nodesRef.current, MAX_NODE_SIZE), sizeRef.current, { inset: FIT_INSET, minK: MIN_K, maxK: 4 });
    if (!f) return;
    transformRef.current = f;
    schedRef.current?.request();
  }, []);

  // Create programs + buffers on the current context and upload the last arrays.
  const initGL = useCallback(() => {
    const gl = glRef.current;
    if (!gl || gl.isContextLost()) return false;
    progRef.current = {
      point: buildProgram(gl, POINT_VS, POINT_FS, ['a_pos', 'a_color', 'a_size'], ['u_translate', 'u_scale', 'u_resolution', 'u_dpr']),
      line: buildProgram(gl, LINE_VS, LINE_FS, ['a_pos'], ['u_translate', 'u_scale', 'u_resolution', 'u_color'])
    };
    buffersRef.current = { pos: gl.createBuffer(), color: gl.createBuffer(), size: gl.createBuffer(), linePos: gl.createBuffer() };
    if (arraysRef.current) upload(gl, buffersRef.current, arraysRef.current);
    return true;
  }, []);

  // The context is created by whichever effect needs it first (the geometry
  // effect runs before the mount effect on first render).
  const ensureGL = useCallback(() => {
    if (glRef.current) return glRef.current;
    const canvas = canvasRef.current;
    const gl = canvas?.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) return null;
    glRef.current = gl;
    initGL();
    return gl;
  }, [initGL]);

  // Build geometry when data changes.
  useEffect(() => {
    const gl = ensureGL();
    if (!gl || !data) return;

    // Positions come from either the server-computed layout (organic sfdp/fcose,
    // passed in via `positions`) or the built-in deterministic radial layout.
    const nodes = data.nodes.map((n) => ({ ...n }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links = data.links.filter((l) => byId.has(l.source) && byId.has(l.target));
    if (positions) {
      for (const n of nodes) {
        const p = positions[n.id];
        n.x = p ? p.x : NaN; // missing → placed by the guard below, not stacked at 0,0
        n.y = p ? p.y : NaN;
      }
    } else {
      radialLayout(nodes, links);
    }
    sanitizePositions(nodes, { minSep: 4 });
    nodesRef.current = nodes;
    const posChanged = positions !== posRef.current;
    posRef.current = positions;

    const pos = new Float32Array(nodes.length * 2);
    const color = new Float32Array(nodes.length * 3);
    const size = new Float32Array(nodes.length);
    nodes.forEach((n, i) => {
      pos[i * 2] = n.x;
      pos[i * 2 + 1] = n.y;
      const c = hexToRgb(colorForRef.current(n));
      color[i * 3] = c[0];
      color[i * 3 + 1] = c[1];
      color[i * 3 + 2] = c[2];
      const s = webglNodeSize(n);
      n.size = s; // reused by the label overlay + picking
      size[i] = s;
    });
    const linePos = new Float32Array(links.length * 4);
    links.forEach((l, i) => {
      const a = byId.get(l.source);
      const bb = byId.get(l.target);
      linePos[i * 4] = a.x;
      linePos[i * 4 + 1] = a.y;
      linePos[i * 4 + 2] = bb.x;
      linePos[i * 4 + 3] = bb.y;
    });

    arraysRef.current = { pos, color, size, linePos };
    if (!gl.isContextLost() && progRef.current.point) upload(gl, buffersRef.current, arraysRef.current);
    countsRef.current = { nodes: nodes.length, lineVerts: links.length * 2 };

    buildGrid(nodes, gridRef);
    // Re-frame when the layout itself changes (radial ⇄ server), but not on plain
    // data updates (which would fight the user's pan/zoom).
    if (posChanged) fitAll();
    schedRef.current?.request();
  }, [data, positions, fitAll, ensureGL]);

  // Colours only (theme or style change): rewrite the colour buffer in place.
  useEffect(() => {
    if (colorForRef.current === colorFor) return;
    colorForRef.current = colorFor;
    const gl = glRef.current;
    const arrays = arraysRef.current;
    if (!arrays) return;
    const nodes = nodesRef.current;
    for (let i = 0; i < nodes.length; i++) {
      const c = hexToRgb(colorFor(nodes[i]));
      arrays.color[i * 3] = c[0];
      arrays.color[i * 3 + 1] = c[1];
      arrays.color[i * 3 + 2] = c[2];
    }
    if (gl && !gl.isContextLost() && buffersRef.current.color) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffersRef.current.color);
      gl.bufferData(gl.ARRAY_BUFFER, arrays.color, gl.STATIC_DRAW);
    }
    schedRef.current?.request();
  }, [colorFor]);

  useEffect(() => {
    selectedRef.current = selectedId;
    keepRef.current(); // a selection outside the usable area is brought back in
    schedRef.current?.request();
  }, [selectedId]);

  useEffect(() => {
    labelDensityRef.current = labelDensity;
    schedRef.current?.request();
  }, [labelDensity]);

  // Context + sizing + interaction (once).
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return undefined;
    const gl = ensureGL();
    if (!gl) return undefined;

    const sched = createFrameScheduler(
      () => {
        const g = glideRef.current;
        if (g) {
          const { values, done } = g.step(performance.now());
          Object.assign(transformRef.current, values);
          if (done) glideRef.current = null;
        }
        drawRef.current();
        if (glideRef.current) sched.request();
      },
      { el: wrap }
    );
    schedRef.current = sched;

    // Keep the selected node inside the usable area (canvas minus the overlay
    // insets): a details panel opening narrows the canvas, so after a resize
    // (or a new selection) pan the least distance, as a short glide.
    const keepSelected = () => {
      const id = selectedRef.current;
      const n = id != null ? nodesRef.current.find((x) => x.id === id) : null;
      const size = sizeRef.current;
      if (!n || !size.w || !size.h) return;
      const t = glideRef.current ? { ...transformRef.current, ...glideRef.current.to } : transformRef.current;
      const r = Math.max(4, (n.size || MAX_NODE_SIZE) / 2) + 8;
      const { dx, dy } = keepInView(n.x * t.k + t.x, n.y * t.k + t.y, r, size, FIT_INSET);
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      glideRef.current = createGlide({ x: transformRef.current.x, y: transformRef.current.y }, { x: t.x + dx, y: t.y + dy });
      sched.request();
    };
    keepRef.current = keepSelected;

    // Context loss (GPU reset, driver update, too many contexts): keep the page
    // alive, then rebuild programs/buffers from the cached arrays on restore.
    const onLost = (e) => {
      e.preventDefault();
      lostRef.current = true;
    };
    const onRestored = () => {
      lostRef.current = false;
      initGL();
      sched.request();
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    const labelCanvas = labelCanvasRef.current;
    let centered = false;
    const unwatch = watchCanvasSize(wrap, ({ w, h, dpr }) => {
      sizeRef.current = applyCanvasSize(canvas, w, h, dpr);
      if (labelCanvas) applyCanvasSize(labelCanvas, w, h, dpr);
      if (!centered && w > 0 && h > 0) {
        centered = true;
        fitAll();
      } else keepSelected();
      drawRef.current(); // a resized canvas is cleared: repaint now
    });

    const toGraph = (clientX, clientY) => {
      const p = clientToLocal(canvas, clientX, clientY);
      return screenToWorld(transformRef.current, p.x, p.y);
    };

    let dragging = false;
    let pinching = false;
    let moved = 0;
    let lastX = 0;
    let lastY = 0;
    const onDown = (e) => {
      if (e.button > 0 || pinching) return;
      e.preventDefault(); // no text selection / native touch gestures
      glideRef.current = null; // the user takes the camera
      dragging = true;
      moved = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.style.cursor = 'grabbing';
    };
    const onMove = (e) => {
      if (!dragging) {
        if (e.target === canvas) {
          const { x, y } = toGraph(e.clientX, e.clientY);
          canvas.style.cursor = pickFromGrid(x, y, gridRef.current) ? 'pointer' : 'grab';
        }
        return;
      }
      if (pinching) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      transformRef.current.x += dx;
      transformRef.current.y += dy;
      sched.request();
    };
    const onUp = (e) => {
      if (dragging && moved < 6 && !pinching) {
        const { x, y } = toGraph(e.clientX, e.clientY);
        const hit = pickFromGrid(x, y, gridRef.current);
        if (hit && cbRef.current.onSelect) cbRef.current.onSelect(hit);
      }
      if (dragging) canvas.style.cursor = 'grab';
      dragging = false;
    };
    // Right-click a node to open its properties (suppress the native menu).
    const onContext = (e) => {
      const { x, y } = toGraph(e.clientX, e.clientY);
      const hit = pickFromGrid(x, y, gridRef.current);
      if (hit) {
        e.preventDefault();
        cbRef.current.onSelect?.(hit);
      }
    };
    const onWheel = (e) => {
      e.preventDefault();
      glideRef.current = null;
      const p = clientToLocal(canvas, e.clientX, e.clientY);
      transformRef.current = zoomAround(transformRef.current, p.x, p.y, wheelFactor(e), MIN_K, MAX_K);
      sched.request();
    };
    const unpinch = attachPinchZoom(
      canvas,
      (factor, cx, cy) => {
        glideRef.current = null;
        transformRef.current = zoomAround(transformRef.current, cx, cy, factor, MIN_K, MAX_K);
        moved = Infinity; // a pinch is never a click
        sched.request();
      },
      (on) => {
        pinching = on;
      }
    );

    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContext);

    let loseExt = null;
    const unhook = registerTestHook('webgl', {
      get selectedId() {
        return selectedRef.current ?? null;
      },
      get transform() {
        return { ...transformRef.current };
      },
      get gliding() {
        return Boolean(glideRef.current);
      },
      /** The usable area (canvas minus the overlay insets), canvas-relative CSS px. */
      get viewport() {
        const { w, h } = sizeRef.current;
        return { x0: FIT_INSET.left, y0: FIT_INSET.top, x1: w - FIT_INSET.right, y1: h - FIT_INSET.bottom };
      },
      /** The selected node on screen: { id, sx, sy } or null. */
      selectedScreen() {
        const id = selectedRef.current;
        const n = id != null ? nodesRef.current.find((x) => x.id === id) : null;
        const t = transformRef.current;
        return n ? { id: n.id, sx: n.x * t.k + t.x, sy: n.y * t.k + t.y } : null;
      },
      get size() {
        return { ...sizeRef.current };
      },
      get frames() {
        return sched.stats.frames;
      },
      nodes(limit = 2000) {
        const t = transformRef.current;
        const { w, h } = sizeRef.current;
        const out = [];
        for (const n of nodesRef.current) {
          const sx = n.x * t.k + t.x;
          const sy = n.y * t.k + t.y;
          if (sx < 0 || sy < 0 || sx > w || sy > h) continue;
          out.push({ id: n.id, label: n.label, sx, sy, r: (n.size / 2) * t.k });
          if (out.length >= limit) break;
        }
        return out;
      },
      setTransform(t) {
        glideRef.current = null;
        transformRef.current = { ...t };
        sched.request();
      },
      /** Paint now and sample the GL framebuffer (it is not preserved between frames). */
      sample() {
        drawRef.current();
        const px = new Uint8Array(4 * 64);
        const out = new Set();
        for (let i = 0; i < 64; i++) {
          const x = Math.floor(((i % 8) + 0.5) * (gl.drawingBufferWidth / 8));
          const y = Math.floor((Math.floor(i / 8) + 0.5) * (gl.drawingBufferHeight / 8));
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px.subarray(i * 4, i * 4 + 4));
          out.add(`${px[i * 4]},${px[i * 4 + 1]},${px[i * 4 + 2]}`);
        }
        return { distinct: out.size, lost: gl.isContextLost() };
      },
      // getExtension() returns null on a lost context: keep the handle for restore.
      loseContext() {
        loseExt = gl.getExtension('WEBGL_lose_context');
        loseExt?.loseContext();
        return Boolean(loseExt);
      },
      restoreContext() {
        loseExt?.restoreContext();
      },
      fit: () => fitAll()
    });

    return () => {
      unhook();
      unwatch();
      unpinch();
      sched.dispose();
      schedRef.current = null;
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContext);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      // Release GPU memory and the context itself now, not at some later GC.
      if (!gl.isContextLost()) {
        for (const buf of Object.values(buffersRef.current)) gl.deleteBuffer(buf);
        for (const p of Object.values(progRef.current)) gl.deleteProgram(p.program);
        // Drop the context itself once the canvas has really left the page (a
        // StrictMode re-mount reuses the same canvas, and so the same context).
        setTimeout(() => {
          if (!canvas.isConnected && !gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext();
        }, 0);
      }
      progRef.current = {};
      buffersRef.current = {};
      glRef.current = null;
    };
  }, [initGL, ensureGL, fitAll]);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas
        ref={canvasRef}
        className="graph-canvas absolute left-0 top-0"
        data-testid="webgl-graph"
        style={{ touchAction: 'none', userSelect: 'none' }}
        role="img"
        aria-label="Large node graph. Use the Tree view for a keyboard-accessible list."
      />
      <canvas ref={labelCanvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
    </div>
  );
}

// ---------------------------------------------------------------------------
function upload(gl, b, { pos, color, size, linePos }) {
  gl.bindBuffer(gl.ARRAY_BUFFER, b.pos);
  gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, b.color);
  gl.bufferData(gl.ARRAY_BUFFER, color, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, b.size);
  gl.bufferData(gl.ARRAY_BUFFER, size, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, b.linePos);
  gl.bufferData(gl.ARRAY_BUFFER, linePos, gl.STATIC_DRAW);
}

// Screen space is CSS px; gl_PointSize is in device px, hence u_dpr. a_size is
// the sprite diameter in world units.
const POINT_VS = `#version 300 es
in vec2 a_pos; in vec3 a_color; in float a_size;
uniform vec2 u_translate; uniform float u_scale; uniform vec2 u_resolution; uniform float u_dpr;
out vec3 v_color;
void main() {
  vec2 screen = a_pos * u_scale + u_translate;
  vec2 clip = (screen / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = max(1.5, a_size * u_scale * u_dpr);
  v_color = a_color;
}`;
const POINT_FS = `#version 300 es
precision mediump float;
in vec3 v_color; out vec4 outColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25) discard;
  outColor = vec4(v_color, 1.0);
}`;
const LINE_VS = `#version 300 es
in vec2 a_pos;
uniform vec2 u_translate; uniform float u_scale; uniform vec2 u_resolution;
void main() {
  vec2 screen = a_pos * u_scale + u_translate;
  vec2 clip = (screen / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;
const LINE_FS = `#version 300 es
precision mediump float;
uniform vec4 u_color; out vec4 outColor;
void main() { outColor = u_color; }`;

function buildProgram(gl, vsSrc, fsSrc, attribs, uniforms) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const program = gl.createProgram();
  const vs = compile(gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.deleteShader(vs); // owned by the program from here on
  gl.deleteShader(fs);
  const out = { program };
  for (const a of attribs) out[a] = gl.getAttribLocation(program, a);
  for (const u of uniforms) out[u] = gl.getUniformLocation(program, u);
  return out;
}

// Parse hex (#rgb / #rrggbb) OR rgb()/rgba() into normalized [r,g,b]. Several
// style presets specify link colors as rgba() strings, so a hex-only parser
// silently returned black — making connection lines invisible on dark themes.
function hexToRgb(color) {
  const s = String(color || '#000000').trim();
  const full = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})/i.exec(s);
  if (full) return [parseInt(full[1], 16) / 255, parseInt(full[2], 16) / 255, parseInt(full[3], 16) / 255];
  const short = /^#([a-f\d])([a-f\d])([a-f\d])$/i.exec(s);
  if (short) return [parseInt(short[1] + short[1], 16) / 255, parseInt(short[2] + short[2], 16) / 255, parseInt(short[3] + short[3], 16) / 255];
  const rgb = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s);
  if (rgb) return [Math.min(1, +rgb[1] / 255), Math.min(1, +rgb[2] / 255), Math.min(1, +rgb[3] / 255)];
  return [0, 0, 0];
}

// Deterministic radial-tree layout (proportional wedges), O(n).
function radialLayout(nodes, links) {
  const childrenOf = new Map();
  const hasParent = new Set();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const l of links) {
    if (!childrenOf.has(l.source)) childrenOf.set(l.source, []);
    childrenOf.get(l.source).push(l.target);
    hasParent.add(l.target);
  }
  const leaves = new Map();
  const count = (id, g) => {
    if (leaves.has(id)) return leaves.get(id);
    if (g.has(id)) return 1;
    g.add(id);
    const k = childrenOf.get(id) || [];
    let c = k.length === 0 ? 1 : 0;
    for (const x of k) c += count(x, g);
    leaves.set(id, c || 1);
    return leaves.get(id);
  };
  const roots = nodes.filter((n) => !hasParent.has(n.id));
  for (const r of roots) count(r.id, new Set());
  const ring = 240;
  const place = (id, a0, a1, d, g) => {
    const n = byId.get(id);
    if (!n || g.has(id)) return;
    g.add(id);
    const mid = (a0 + a1) / 2;
    n.x = Math.cos(mid) * d * ring;
    n.y = Math.sin(mid) * d * ring;
    const kids = childrenOf.get(id) || [];
    const total = kids.reduce((s, k) => s + (leaves.get(k) || 1), 0) || 1;
    let a = a0;
    for (const k of kids) {
      const span = ((leaves.get(k) || 1) / total) * (a1 - a0);
      place(k, a, a + span, d + 1, g);
      a += span;
    }
  };
  const total = roots.reduce((s, r) => s + (leaves.get(r.id) || 1), 0) || 1;
  // A single root (the broker) sits at the centre; several share the first ring.
  const d0 = roots.length === 1 ? 0 : 1;
  let a = 0;
  const g = new Set();
  for (const r of roots) {
    const span = ((leaves.get(r.id) || 1) / total) * Math.PI * 2;
    place(r.id, a, a + span, d0, g);
    a += span;
  }
}

function buildGrid(nodes, gridRef) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
  }
  const cell = 2 * (HUB_SIZE / 2 + 6); // >= any pick radius, so a 3x3 scan is exhaustive
  const cols = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const map = new Map();
  for (const n of nodes) {
    const key = Math.floor((n.y - minY) / cell) * cols + Math.floor((n.x - minX) / cell);
    let bucket = map.get(key);
    if (!bucket) {
      bucket = [];
      map.set(key, bucket);
    }
    bucket.push(n);
  }
  gridRef.current = { minX, minY, cell, cols, map };
}

function pickFromGrid(gx, gy, grid) {
  if (!grid) return null;
  const { minX, minY, cell, cols, map } = grid;
  const cx = Math.floor((gx - minX) / cell);
  const cy = Math.floor((gy - minY) / cell);
  let best = null;
  let bestD = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= cols) continue; // never wrap into the neighbouring row
      const bucket = map.get((cy + dy) * cols + x);
      if (!bucket) continue;
      for (const n of bucket) {
        const r = n.size / 2 + 6; // the DRAWN radius (+ slop), same as the label offset
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
