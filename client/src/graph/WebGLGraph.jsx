import { useEffect, useRef, useCallback } from 'react';
import { GRAPH_STYLES } from './graphStyles';
import { groupColor, PROTOCOL_COLORS } from './buildGraph';

/**
 * WebGL2 renderer for very large ("show all") graphs. Nodes are drawn as GL
 * points and links as GL lines in a couple of draw calls, so hundreds of
 * thousands — into the millions — of nodes stay smooth to pan and zoom, where a
 * per-node 2D canvas loop would stall. Layout is a deterministic radial tree;
 * pan/zoom update a transform uniform (one draw call), and picking uses a CPU
 * spatial grid.
 *
 * The feature-rich 2D ForceGraph remains the default for normal-sized graphs
 * (labels, glow, curved links, live message-flow animation).
 */
export default function WebGLGraph({ data, styleId = 'constellation', selectedId = null, onSelect, colorByProtocol = false }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const glRef = useRef(null);
  const progRef = useRef({});
  const buffersRef = useRef({});
  const countsRef = useRef({ nodes: 0, lineVerts: 0 });
  const nodesRef = useRef([]);
  const gridRef = useRef(null);
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const sizeRef = useRef({ w: 0, h: 0 });
  const selectedRef = useRef(null);

  const style = GRAPH_STYLES[styleId] || GRAPH_STYLES.constellation;
  const colorFor = useCallback(
    (n) => (colorByProtocol && n.protocol ? PROTOCOL_COLORS[n.protocol] || style.palette[0] : groupColor(n.group, style.palette)),
    [colorByProtocol, style]
  );

  const draw = useCallback(() => {
    const gl = glRef.current;
    if (!gl) return;
    const { w, h } = sizeRef.current;
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
      gl.uniform4f(lp.u_color, lc[0], lc[1], lc[2], 0.22);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.linePos);
      gl.enableVertexAttribArray(lp.a_pos);
      gl.vertexAttribPointer(lp.a_pos, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.LINES, 0, lineVerts);
    }

    // Nodes
    if (nodes > 0) {
      const pp = progRef.current.point;
      gl.useProgram(pp.program);
      gl.uniform2f(pp.u_translate, t.x, t.y);
      gl.uniform1f(pp.u_scale, t.k);
      gl.uniform2f(pp.u_resolution, w, h);
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
  }, [style]);

  // Build GL programs + upload geometry when data changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) return;
    glRef.current = gl;

    if (!progRef.current.point) {
      progRef.current.point = buildProgram(gl, POINT_VS, POINT_FS, ['a_pos', 'a_color', 'a_size'], ['u_translate', 'u_scale', 'u_resolution']);
      progRef.current.line = buildProgram(gl, LINE_VS, LINE_FS, ['a_pos'], ['u_translate', 'u_scale', 'u_resolution', 'u_color']);
      buffersRef.current = { pos: gl.createBuffer(), color: gl.createBuffer(), size: gl.createBuffer(), linePos: gl.createBuffer() };
    }

    // Deterministic radial layout, then pack into typed arrays.
    const nodes = data.nodes.map((n) => ({ ...n }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links = data.links.filter((l) => byId.has(l.source) && byId.has(l.target));
    radialLayout(nodes, links);
    nodesRef.current = nodes;

    const pos = new Float32Array(nodes.length * 2);
    const color = new Float32Array(nodes.length * 3);
    const size = new Float32Array(nodes.length);
    nodes.forEach((n, i) => {
      pos[i * 2] = n.x;
      pos[i * 2 + 1] = n.y;
      const c = hexToRgb(colorFor(n));
      color[i * 3] = c[0];
      color[i * 3 + 1] = c[1];
      color[i * 3 + 2] = c[2];
      size[i] = n.kind === 'broker' || n.kind === 'opcua-server' || n.kind === 'i3x-server' ? 12 : 4 + Math.sqrt(n.degree || 0) * 1.5;
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

    const b = buffersRef.current;
    gl.bindBuffer(gl.ARRAY_BUFFER, b.pos);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.color);
    gl.bufferData(gl.ARRAY_BUFFER, color, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.size);
    gl.bufferData(gl.ARRAY_BUFFER, size, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.linePos);
    gl.bufferData(gl.ARRAY_BUFFER, linePos, gl.STATIC_DRAW);
    countsRef.current = { nodes: nodes.length, lineVerts: links.length * 2 };

    buildGrid(nodes, gridRef);
    draw();
  }, [data, colorFor, draw]);

  useEffect(() => {
    selectedRef.current = selectedId;
    draw();
  }, [selectedId, draw]);

  // Sizing + interaction (once).
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    let centered = false;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = wrap.getBoundingClientRect();
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      sizeRef.current = { w: canvas.width, h: canvas.height };
      if (!centered && width > 0) {
        centered = true;
        fitAll();
      }
      draw();
    };

    const fitAll = () => {
      const nodes = nodesRef.current;
      if (!nodes.length) return;
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
      const { w, h } = sizeRef.current;
      const pad = 60;
      const k = Math.min((w - pad) / Math.max(maxX - minX, 1), (h - pad) / Math.max(maxY - minY, 1));
      transformRef.current = { k, x: w / 2 - k * (minX + maxX) / 2, y: h / 2 - k * (minY + maxY) / 2 };
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const toGraph = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const t = transformRef.current;
      const px = (clientX - rect.left) * dpr;
      const py = (clientY - rect.top) * dpr;
      return { x: (px - t.x) / t.k, y: (py - t.y) / t.k };
    };

    let dragging = false;
    let moved = 0;
    let lastX = 0;
    let lastY = 0;
    const onDown = (e) => {
      dragging = true;
      moved = 0;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onMove = (e) => {
      if (!dragging) return;
      const dpr = window.devicePixelRatio || 1;
      const dx = (e.clientX - lastX) * dpr;
      const dy = (e.clientY - lastY) * dpr;
      lastX = e.clientX;
      lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      transformRef.current.x += dx;
      transformRef.current.y += dy;
      draw();
    };
    const onUp = (e) => {
      if (dragging && moved < 6) {
        const { x, y } = toGraph(e.clientX, e.clientY);
        const hit = pickFromGrid(x, y, gridRef.current);
        if (hit && onSelect) onSelect(hit);
      }
      dragging = false;
    };
    const onWheel = (e) => {
      e.preventDefault();
      const dpr = window.devicePixelRatio || 1;
      const t = transformRef.current;
      const rect = canvas.getBoundingClientRect();
      const px = (e.clientX - rect.left) * dpr;
      const py = (e.clientY - rect.top) * dpr;
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      const nk = Math.max(0.02, Math.min(20, t.k * factor));
      // zoom toward cursor
      t.x = px - (px - t.x) * (nk / t.k);
      t.y = py - (py - t.y) * (nk / t.k);
      t.k = nk;
      draw();
    };

    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="graph-canvas" />
    </div>
  );
}

// ---------------------------------------------------------------------------
const POINT_VS = `#version 300 es
in vec2 a_pos; in vec3 a_color; in float a_size;
uniform vec2 u_translate; uniform float u_scale; uniform vec2 u_resolution;
out vec3 v_color;
void main() {
  vec2 screen = a_pos * u_scale + u_translate;
  vec2 clip = (screen / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = max(1.0, a_size * u_scale);
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
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  const out = { program };
  for (const a of attribs) out[a] = gl.getAttribLocation(program, a);
  for (const u of uniforms) out[u] = gl.getUniformLocation(program, u);
  return out;
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})/i.exec(hex || '#000000');
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
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
  let a = 0;
  const g = new Set();
  for (const r of roots) {
    const span = ((leaves.get(r.id) || 1) / total) * Math.PI * 2;
    place(r.id, a, a + span, 1, g);
    a += span;
  }
  for (const n of nodes) if (n.x === undefined) { n.x = 0; n.y = 0; }
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
  const cell = 30;
  const cols = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const map = new Map();
  for (const n of nodes) {
    const key = Math.floor((n.y - minY) / cell) * cols + Math.floor((n.x - minX) / cell);
    let bucket = map.get(key);
    if (!bucket) { bucket = []; map.set(key, bucket); }
    bucket.push(n);
  }
  gridRef.current = { minX, minY, cell, cols, map };
}

function pickFromGrid(gx, gy, grid) {
  if (!grid) return null;
  const { minX, minY, cell, cols, map } = grid;
  let best = null;
  let bestD = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const key = Math.floor((gy - minY) / cell + dy) * cols + Math.floor((gx - minX) / cell + dx);
      const bucket = map.get(key);
      if (!bucket) continue;
      for (const n of bucket) {
        const r = (n.kind && n.kind.endsWith('server') ? 12 : 4 + Math.sqrt(n.degree || 0) * 1.5) + 6;
        const d = (n.x - gx) ** 2 + (n.y - gy) ** 2;
        if (d <= r * r && d < bestD) { best = n; bestD = d; }
      }
    }
  }
  return best;
}
