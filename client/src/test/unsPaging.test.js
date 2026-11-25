import { describe, expect, it } from 'vitest';
import { compareNames, isPaged, loadPaging, pagerControls, pageSlice, pagingForPath, rangeLabel, savePaging, SESSION_KEY, stateShowing, stepPage } from '@/graph/unsPaging';
import { layoutForest, readableFit, revealTransform, MIN_READ_K, DEFAULT_K } from '@/graph/unsLayout';
import { buildUnsTree } from '@/graph/unsTree';

const kids = (n) => Array.from({ length: n }, (_, i) => ({ name: `s${String(i).padStart(4, '0')}` }));

describe('pageSlice', () => {
  it('cuts one page and reports the range', () => {
    const sl = pageSlice(kids(2000), { page: 1 });
    expect(sl.items.map((c) => c.name).slice(0, 2)).toEqual(['s0050', 's0051']);
    expect(sl).toMatchObject({ page: 1, pages: 40, total: 2000, all: 2000, from: 51, to: 100, filter: '' });
    expect(rangeLabel(sl)).toBe('51–100 of 2,000');
  });
  it('clamps the page to what exists (the branch shrank, or a stale session state)', () => {
    expect(pageSlice(kids(120), { page: 99 })).toMatchObject({ page: 2, from: 101, to: 120 });
    expect(pageSlice(kids(120), { page: -3 })).toMatchObject({ page: 0, from: 1, to: 50 });
  });
  it('filters by name (substring, any case) before paging', () => {
    const sl = pageSlice(kids(2000), { page: 0, filter: 'S012' });
    expect(sl.total).toBe(10);
    expect(sl.items.map((c) => c.name)).toEqual(['s0120', 's0121', 's0122', 's0123', 's0124', 's0125', 's0126', 's0127', 's0128', 's0129']);
    expect(rangeLabel(sl)).toBe('1–10 of 10 matching "S012" (2,000 in all)');
  });
  it('says when nothing matches', () => {
    const sl = pageSlice(kids(80), { filter: 'zzz' });
    expect(sl).toMatchObject({ total: 0, pages: 1, from: 0, to: 0 });
    expect(rangeLabel(sl)).toBe('No match for "zzz" (80 in all)');
  });
});

describe('pager controls', () => {
  it('first / last only with more than three pages; disabled at the ends', () => {
    expect(pagerControls({ page: 0, pages: 3 })).toEqual({ first: { shown: false, enabled: false }, prev: { shown: true, enabled: false }, next: { shown: true, enabled: true }, last: { shown: false, enabled: false } });
    expect(pagerControls({ page: 39, pages: 40 })).toMatchObject({ first: { shown: true, enabled: true }, next: { enabled: false }, last: { shown: true, enabled: false } });
  });
  it('steps and clamps', () => {
    expect(stepPage({ page: 0, pages: 40 }, 'prev')).toBe(0);
    expect(stepPage({ page: 0, pages: 40 }, 'next')).toBe(1);
    expect(stepPage({ page: 5, pages: 40 }, 'last')).toBe(39);
    expect(stepPage({ page: 5, pages: 40 }, 'first')).toBe(0);
    expect(stepPage({ page: 39, pages: 40 }, 'next')).toBe(39);
  });
  it('isPaged', () => {
    expect(isPaged(50)).toBe(false);
    expect(isPaged(51)).toBe(true);
  });
});

describe('deep links land on the page that holds the node', () => {
  const topics = [...kids(2000).map((c) => ({ topic: `acme/bulk/${c.name}` })), { topic: 'acme/line1/temp' }];
  const root = buildUnsTree({ id: 'b', name: 'B' }, topics);
  it('opens the right page of every long ancestor', () => {
    const next = pagingForPath(root, 'acme/bulk/s1234', new Map());
    expect(next.get('uns:b:acme/bulk')).toEqual({ page: 24, filter: '' });
    expect(next.size).toBe(1); // short branches need nothing
  });
  it('keeps a filter that matches, clears one that would hide the node', () => {
    expect(pagingForPath(root, 'acme/bulk/s1234', new Map([['uns:b:acme/bulk', { page: 0, filter: 's12' }]])).get('uns:b:acme/bulk')).toEqual({ page: 0, filter: 's12' });
    expect(pagingForPath(root, 'acme/bulk/s1234', new Map([['uns:b:acme/bulk', { page: 0, filter: 's9' }]])).get('uns:b:acme/bulk')).toEqual({ page: 24, filter: '' });
  });
  it('returns the same Map when nothing changes (no re-render)', () => {
    const m = new Map([['uns:b:acme/bulk', { page: 24, filter: '' }]]);
    expect(pagingForPath(root, 'acme/bulk/s1234', m)).toBe(m);
    expect(pagingForPath(root, 'acme/line1/temp', m)).toBe(m);
    expect(pagingForPath(root, 'nope/x', m)).toBe(m);
  });
  it('stateShowing', () => {
    expect(stateShowing(kids(200), 's0150', null)).toEqual({ page: 3, filter: '' });
  });
  it('the layout then shows that page with the node in it', () => {
    const paging = pagingForPath(root, 'acme/bulk/s1234', new Map());
    const lay = layoutForest([root], new Set(['b:', 'b:acme', 'b:acme/bulk']), paging);
    expect(lay.nodes.some((l) => l.node.path === 'acme/bulk/s1234')).toBe(true);
    expect(lay.nodes.find((l) => l.pager).node.slice).toMatchObject({ page: 24, from: 1201, to: 1250 });
  });
});

describe('session persistence', () => {
  const store = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
  };
  it('round-trips, drops default states, survives garbage and a blocked storage', () => {
    const s = store();
    savePaging(new Map([['a', { page: 3, filter: '' }], ['b', { page: 0, filter: '' }], ['c', { page: 0, filter: 'x' }]]), s);
    expect(JSON.parse(s.m.get(SESSION_KEY))).toEqual({ a: { page: 3, filter: '' }, c: { page: 0, filter: 'x' } });
    expect([...loadPaging(s).entries()]).toEqual([['a', { page: 3, filter: '' }], ['c', { page: 0, filter: 'x' }]]);
    s.setItem(SESSION_KEY, '{nope');
    expect(loadPaging(s).size).toBe(0);
    const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadPaging(blocked).size).toBe(0);
    expect(() => savePaging(new Map([['a', { page: 1 }]]), blocked)).not.toThrow();
  });
});

describe('natural sibling order', () => {
  it('line2 before line10', () => {
    expect(['line10', 'line2', 'Line1'].sort(compareNames)).toEqual(['Line1', 'line2', 'line10']);
  });
});

describe('readable first view (phones)', () => {
  // root + one first-level node + 4 second-level nodes, the shape of the e2e broker.
  const topics = ['plant/line1/a', 'plant/line2/b', 'plant/energy/c', 'plant/env/d'].map((topic) => ({ topic }));
  const root = buildUnsTree({ id: 'b', name: 'B' }, topics);
  const lay = layoutForest([root], new Set(['b:', 'b:plant']));
  const posOf = (l) => l;
  it('fits everything when that is readable (desktop)', () => {
    const f = readableFit(lay.nodes, posOf, { w: 1400, h: 800 });
    expect(f.scope).toBe('all');
    expect(f.t.k).toBeGreaterThanOrEqual(MIN_READ_K);
  });
  it('frames the root and its first level at a readable zoom on a phone instead of shrinking', () => {
    // Default insets (56 px a side): 520 px leaves room for the root and its first level at a readable zoom.
    const f = readableFit(lay.nodes, posOf, { w: 520, h: 600 });
    expect(f.scope).toBe('first-level');
    expect(f.t.k).toBeGreaterThanOrEqual(MIN_READ_K);
  });
  it('never goes below the floor even when the first level does not fit', () => {
    const wide = buildUnsTree({ id: 'b', name: 'B' }, kids(40).map((c) => ({ topic: `plant/${c.name}/x` })));
    const l2 = layoutForest([wide], new Set(['b:', 'b:plant']));
    const f = readableFit(l2.nodes, posOf, { w: 360, h: 560 });
    expect(f.t.k).toBe(MIN_READ_K);
    // The root is on screen.
    const r = l2.nodes[0];
    const sx = r.x * f.t.k + f.t.x;
    const sy = r.y * f.t.k + f.t.y;
    expect(sx).toBeGreaterThan(0);
    expect(sx).toBeLessThan(360);
    expect(sy).toBeGreaterThan(0);
    expect(sy).toBeLessThan(560);
  });
});

describe('readable first view: root with several tall first-level branches', () => {
  it('shows the root together with its nearest first-level node', () => {
    const topics = [];
    for (const a of ['a', 'b', 'c', 'd']) for (let i = 0; i < 6; i++) topics.push({ topic: `${a}/n${i}/x` });
    const root = buildUnsTree({ id: 'b', name: 'B' }, topics);
    const lay = layoutForest([root], new Set(['b:', 'b:a', 'b:b', 'b:c', 'b:d']));
    const f = readableFit(lay.nodes, (l) => l, { w: 360, h: 560 });
    expect(f.t.k).toBe(MIN_READ_K);
    const on = (l) => {
      const sy = l.y * f.t.k + f.t.y;
      return sy > 0 && sy < 560;
    };
    expect(on(lay.nodes.find((l) => l.node.depth === 0))).toBe(true);
    expect(lay.nodes.some((l) => l.node.depth === 1 && on(l))).toBe(true);
  });
});

describe('reveal zooms in from below the reading floor', () => {
  const v = { x0: 0, y0: 0, x1: 400, y1: 700, w: 400, h: 700 };
  it('zooms in to the default zoom when the revealed set fits there', () => {
    const { t } = revealTransform({ k: 0.5, x: 0, y: 0 }, { minX: 0, minY: 0, maxX: 300, maxY: 300 }, v);
    expect(t.k).toBe(DEFAULT_K);
  });
  it('zooms in only as far as the set still fits, and to the floor when it would not fit readably', () => {
    expect(revealTransform({ k: 0.5, x: 0, y: 0 }, { minX: 0, minY: 0, maxX: 450, maxY: 300 }, v).t.k).toBeCloseTo(400 / 450, 5);
    // Too big to fit readably: the floor (clipped), never staying below it.
    expect(revealTransform({ k: 0.5, x: 0, y: 0 }, { minX: 0, minY: 0, maxX: 1000, maxY: 300 }, v).t.k).toBe(MIN_READ_K);
  });
  it('zooms in to the reading floor (anchored) when the set is too big to fit readably (a phone)', () => {
    const r = revealTransform({ k: 0.3, x: 0, y: 0 }, { minX: 0, minY: 0, maxX: 650, maxY: 300 }, v, { anchor: { x: 20, y: 150 } });
    expect(r.t.k).toBe(MIN_READ_K);
    expect(r.clipped).toBe(true);
    expect(20 * r.t.k + r.t.x).toBeGreaterThanOrEqual(0); // the anchor stays on screen
  });
  it('does not zoom in when the camera is already readable', () => {
    expect(revealTransform({ k: 0.9, x: 0, y: 0 }, { minX: 0, minY: 0, maxX: 100, maxY: 100 }, v).t.k).toBe(0.9);
  });
});
