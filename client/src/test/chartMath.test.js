import { describe, it, expect } from 'vitest';
import { alignSeries, finiteExtent, paddedRange } from '@/components/chartMath';

describe('chart math', () => {
  it('finiteExtent ignores NaN/null/Infinity and survives 500k values', () => {
    expect(finiteExtent([3, NaN, null, -2, Infinity, 7])).toEqual([-2, 7]);
    expect(finiteExtent([NaN])).toBeNull();
    const big = Array.from({ length: 500000 }, (_, i) => i);
    expect(finiteExtent(big)).toEqual([0, 499999]);
  });

  it('paddedRange never pads across zero and handles flat / non-finite input', () => {
    expect(paddedRange(1000, 2000)[0]).toBeGreaterThanOrEqual(0);
    expect(paddedRange(-20, -10)[1]).toBeLessThanOrEqual(0);
    const [lo, hi] = paddedRange(-5, 5);
    expect(lo).toBeLessThan(-5);
    expect(hi).toBeGreaterThan(5);
    const flat = paddedRange(42, 42);
    expect(flat[0]).toBeLessThan(42);
    expect(flat[1]).toBeGreaterThan(42);
    expect(paddedRange(0, 0)).toEqual([0, 1]);
    expect(paddedRange(NaN, 1)).toEqual([0, 1]);
  });

  it('alignSeries: undefined for alignment holes, null only for real outages', () => {
    const a = { tag: 'a', points: [[1000, 1], [2000, 2], [3000, 3], [4000, 4], [30000, 5], [31000, 6]] };
    const b = { tag: 'b', points: [[1500, 10], [2500, 11]] };
    const [xs, ya, yb] = alignSeries([a, b]);
    expect(xs).toEqual([...xs].sort((p, q) => p - q));
    // b has no sample at a's timestamps: undefined (drawn across), never null
    expect(yb[xs.indexOf(1)]).toBeUndefined();
    expect(yb.includes(null)).toBe(false);
    // a's 26 s silence (cadence 1 s) is a real gap: exactly one null break inside it
    const nulls = ya.map((v, i) => (v === null ? xs[i] : null)).filter((v) => v != null);
    expect(nulls.length).toBe(1);
    expect(nulls[0]).toBeGreaterThan(4);
    expect(nulls[0]).toBeLessThan(30);
  });

  it('alignSeries drops NaN / non-numeric samples and sorts unsorted input', () => {
    const [xs, ys] = alignSeries([{ points: [[3000, 3], [1000, NaN], [2000, 'x'], [500, 1]] }]);
    expect(xs).toEqual([0.5, 3]);
    expect(ys).toEqual([1, 3]);
  });

  it('alignSeries of nothing is empty', () => {
    expect(alignSeries([])).toEqual([[]]);
  });
});
