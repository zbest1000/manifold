import { describe, it, expect, vi } from 'vitest';

// unsDraw -> unsLive -> the store -> the shared socket: stub the network + toast
// side effects so importing the renderers' pure helpers stays offline.
vi.mock('@/lib/socket', () => ({
  socket: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
  reconnectSocket: vi.fn()
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

import {
  applyCanvasSize,
  backingSize,
  boundsOf,
  createLabelGrid,
  ellipsize,
  fitBounds,
  sanitizePositions,
  screenToWorld,
  wheelFactor,
  worldToScreen,
  zoomAround
} from '@/graph/canvasKit';
import { selectLabelIds } from '@/graph/labelLod';
import { webglNodeSize } from '@/graph/WebGLGraph';
import { fitDistance } from '@/graph/ForceGraph3D';
import { iconRasterSize, countLabel } from '@/graph/unsDraw';
import { fitTransform, layoutForest } from '@/graph/unsLayout';

// A fixed-pitch fake 2D context: every code point is 7px wide.
const fakeCtx = () => ({ font: '12px x', measureText: (s) => ({ width: Array.from(s).length * 7 }) });

describe('canvas sizing', () => {
  it('backing store is the integer-rounded CSS size x DPR', () => {
    expect(backingSize(1200, 815, 1)).toEqual({ width: 1200, height: 815 });
    expect(backingSize(1200, 815, 2)).toEqual({ width: 2400, height: 1630 });
    expect(backingSize(333.5, 100.25, 1.5)).toEqual({ width: 500, height: 150 });
    expect(backingSize(0, 0, 3)).toEqual({ width: 1, height: 1 });
    expect(backingSize(NaN, 10, 0)).toEqual({ width: 1, height: 10 });
  });

  it('applyCanvasSize sets attribute + CSS size and returns the exact draw scale', () => {
    const c = { width: 300, height: 150, style: {} };
    const s = applyCanvasSize(c, 401.5, 200, 2);
    expect(c.width).toBe(803);
    expect(c.height).toBe(400);
    expect(c.style.width).toBe('401.5px');
    expect(s.sx).toBeCloseTo(803 / 401.5);
    expect(s.sy).toBe(2);
  });
});

describe('camera transform', () => {
  it('screen <-> world round-trips', () => {
    const t = { x: 123.4, y: -50, k: 2.5 };
    const w = screenToWorld(t, 640, 360);
    const s = worldToScreen(t, w.x, w.y);
    expect(s.x).toBeCloseTo(640);
    expect(s.y).toBeCloseTo(360);
  });

  it('zoomAround keeps the anchor point fixed and clamps', () => {
    const t = { x: 10, y: 20, k: 1 };
    const before = screenToWorld(t, 300, 200);
    const z = zoomAround(t, 300, 200, 1.7, 0.2, 3);
    const after = screenToWorld(z, 300, 200);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(zoomAround(t, 0, 0, 100, 0.2, 3).k).toBe(3);
    expect(zoomAround(t, 0, 0, 0.0001, 0.2, 3).k).toBe(0.2);
  });

  it('wheelFactor is symmetric and scales with distance and deltaMode', () => {
    expect(wheelFactor({ deltaY: 100 }) * wheelFactor({ deltaY: -100 })).toBeCloseTo(1);
    expect(wheelFactor({ deltaY: -100 })).toBeGreaterThan(1);
    expect(wheelFactor({ deltaY: 3, deltaMode: 1 })).toBeCloseTo(wheelFactor({ deltaY: 48 }));
    expect(Number.isFinite(wheelFactor({ deltaY: 1e9 }))).toBe(true);
  });

  it('fitBounds frames inside the insets and never returns NaN', () => {
    const f = fitBounds({ minX: -100, minY: -50, maxX: 100, maxY: 50 }, { w: 1000, h: 600 }, { inset: { top: 100, bottom: 100, left: 0, right: 0 }, maxK: 10 });
    const tl = worldToScreen(f, -100, -50);
    const br = worldToScreen(f, 100, 50);
    expect(tl.y).toBeGreaterThanOrEqual(99.9);
    expect(br.y).toBeLessThanOrEqual(500.1);
    expect(tl.x).toBeGreaterThanOrEqual(-0.1);
    expect(br.x).toBeLessThanOrEqual(1000.1);
    // a single point (zero-size bounds) still yields a finite camera
    const p = fitBounds({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, { w: 300, h: 200 });
    expect([p.x, p.y, p.k].every(Number.isFinite)).toBe(true);
    expect(fitBounds({ minX: NaN, minY: 0, maxX: 1, maxY: 1 }, { w: 300, h: 200 })).toBeNull();
    expect(fitBounds(null, { w: 300, h: 200 })).toBeNull();
    expect(fitBounds({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, { w: 0, h: 200 })).toBeNull();
  });

  it('boundsOf skips non-finite nodes and handles 200k nodes without spreading', () => {
    const nodes = Array.from({ length: 200000 }, (_, i) => ({ x: i, y: -i }));
    nodes.push({ x: NaN, y: 1 }, { x: Infinity, y: 0 });
    expect(boundsOf(nodes)).toEqual({ minX: 0, minY: -199999, maxX: 199999, maxY: 0 });
    expect(boundsOf([{ x: NaN, y: NaN }])).toBeNull();
  });
});

describe('labels', () => {
  it('ellipsize fits the measured width, keeps code points whole, and passes short text through', () => {
    const ctx = fakeCtx();
    expect(ellipsize(ctx, 'short', 100)).toBe('short');
    const out = ellipsize(ctx, 'a_very_long_topic_segment_name', 70);
    expect(out.endsWith('…')).toBe(true);
    expect(ctx.measureText(out).width).toBeLessThanOrEqual(70);
    const emoji = ellipsize(ctx, '🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀', 35);
    expect(Array.from(emoji).every((c) => c === '🚀' || c === '…')).toBe(true);
    expect(ellipsize(ctx, '温度センサー温度センサー', 42)).toBe('温度センサ…');
    expect(ellipsize(ctx, 'abc', 0)).toBe('');
  });

  it('label grid rejects overlapping boxes only', () => {
    const g = createLabelGrid(64);
    expect(g.tryPlace(0, 0, 100, 14)).toBe(true);
    expect(g.tryPlace(50, 5, 150, 19)).toBe(false);
    expect(g.tryPlace(100, 0, 200, 14)).toBe(true); // touching edge, no overlap
    expect(g.tryPlace(0, 14, 100, 28)).toBe(true);
    expect(g.size).toBe(3);
  });

  it('screen-sized label LOD keeps hubs labelled when zoomed far out and drops colliding siblings', () => {
    const nodes = [
      { id: 'b', label: 'broker', kind: 'broker', x: 0, y: 0 },
      { id: 'a', label: 'Packer1', x: 1000, y: 1000 },
      { id: 'c', label: 'Palletizer1', x: 1020, y: 1010 }
    ];
    const view = { k: 0.1, tx: 400, ty: 300, w: 800, h: 600 };
    const out = selectLabelIds(nodes, view, { leafZoom: 0, screenSized: true, fontPx: 12 });
    expect(out.has('b')).toBe(true);
    expect(out.size).toBe(2); // a and c sit on the same screen pixels: only one label
  });
});

describe('layout guards', () => {
  it('sanitizePositions replaces NaN/Infinity and fans out coincident nodes', () => {
    const nodes = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: NaN, y: 3 }, { x: 10, y: Infinity }];
    const fixed = sanitizePositions(nodes, { minSep: 6 });
    expect(fixed).toBeGreaterThanOrEqual(4);
    for (const n of nodes) expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
    const keys = new Set(nodes.map((n) => `${n.x},${n.y}`));
    expect(keys.size).toBe(nodes.length);
  });

  it('sanitizePositions works in 3D', () => {
    const nodes = [{ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }, { x: 1, y: NaN, z: 1 }];
    sanitizePositions(nodes, { keys: ['x', 'y', 'z'] });
    expect(new Set(nodes.map((n) => `${n.x},${n.y},${n.z}`)).size).toBe(3);
    expect(nodes.every((n) => Number.isFinite(n.y))).toBe(true);
  });

  it('UNS tidy layout of a 2,000-child node stays finite, distinct and fits to a finite camera', () => {
    const kids = new Map();
    for (let i = 0; i < 2000; i++) kids.set(`c${i}`, { name: `c${i}`, path: `w/c${i}`, brokerId: 'b', depth: 2, children: new Map(), topicCount: 1 });
    const wide = { name: 'w', path: 'w', brokerId: 'b', depth: 1, children: kids, topicCount: 2000 };
    const root = { name: 'root', path: '', brokerId: 'b', depth: 0, children: new Map([['w', wide]]), topicCount: 2000 };
    // Paged: the first PAGE_SIZE children by name plus one "N more" row.
    const lay = layoutForest([root], new Set(['b:', 'b:w']));
    expect(lay.nodes.length).toBe(2 + 50 + 1);
    expect(lay.nodes.at(-1).more).toBe(true);
    expect(lay.nodes.at(-1).node.hidden).toBe(1950);
    const all = layoutForest([root], new Set(['b:', 'b:w']), new Map([['b:w', 2000]]));
    expect(all.nodes.length).toBe(2002);
    expect(new Set(all.nodes.map((l) => `${l.x},${l.y}`)).size).toBe(2002);
    expect(lay.nodes.every((l) => Number.isFinite(l.x) && Number.isFinite(l.y))).toBe(true);
    const f = fitTransform(lay.nodes, (l) => l, { w: 1200, h: 800 });
    expect([f.x, f.y, f.k].every(Number.isFinite)).toBe(true);
  });
});

describe('renderer sizing rules', () => {
  it('WebGL node size is capped so a huge branch is not a giant disc; hubs stay largest', () => {
    expect(webglNodeSize({ degree: 2001 })).toBeLessThanOrEqual(12);
    expect(webglNodeSize({ kind: 'broker', degree: 1 })).toBeGreaterThan(webglNodeSize({ degree: 1e6 }));
    expect(webglNodeSize({})).toBe(4);
  });

  it('3D camera distance frames the layout sphere for any aspect', () => {
    const d = fitDistance(1000, 50, 1.5);
    expect(d * Math.sin((25 * Math.PI) / 180)).toBeGreaterThanOrEqual(1000);
    expect(fitDistance(1000, 50, 0.5)).toBeGreaterThan(d); // portrait: horizontal FOV is the limit
    expect(Number.isFinite(fitDistance(NaN, 50, 0))).toBe(true);
  });

  it('UNS icon raster follows on-screen size; captions pluralize', () => {
    expect(iconRasterSize(22)).toBe(40);
    expect(iconRasterSize(66)).toBe(80);
    expect(iconRasterSize(132)).toBe(160);
    expect(iconRasterSize(1e4)).toBe(256);
    expect(countLabel(1, 'topic')).toBe('1 topic');
    expect(countLabel(4000, 'topic')).toBe(`${(4000).toLocaleString()} topics`);
  });
});
