import { describe, expect, it } from 'vitest';
import { alignSeries, describeValue, liveQuality, liveTime, normalizeSeries, pointState, shortTag, unitFrom, unitLayout } from '@/components/chartMath';

describe('pointState', () => {
  it('reads the reader point format [ts, value, quality, partial?]', () => {
    expect(pointState([1, 2])).toBe(null);
    expect(pointState([1, 2, 192])).toBe(null);
    expect(pointState([1, 2, 64])).toBe('uncertain');
    expect(pointState([1, null, 0])).toBe('bad');
    expect(pointState([1, 2, 0, 1])).toBe('partial'); // a mixed bucket: worst quality Bad, but it has a value
    expect(pointState([1, 2, 'bad'])).toBe('bad');
    expect(pointState([1, 2, false])).toBe('bad');
  });
});

describe('alignSeries with quality', () => {
  it('turns a Bad point into a gap (null) even when a number was sent, and lists it for the marker', () => {
    const d = alignSeries([{ tag: 'a', points: [[1000, 1, 192], [2000, 99, 0], [3000, 3, 192], [4000, 4, 0, 1], [5000, 5, 64]] }]);
    expect(d[0]).toEqual([1, 2, 3, 4, 5]);
    expect(d[1]).toEqual([1, null, 3, 4, 5]);
    expect(d.bad).toEqual([[1]]);
    expect(d.partial).toEqual([[3]]);
    expect([...d.state[0].entries()]).toEqual([[1, 'bad'], [3, 'partial'], [4, 'uncertain']]);
  });

  it('keeps a Bad point that has no value at all (a Bad-only bucket)', () => {
    const d = alignSeries([{ tag: 'a', points: [[1000, 1, 192], [2000, null, 0], [3000, 3, 192]] }]);
    expect(d[1]).toEqual([1, null, 3]);
    expect(d.bad).toEqual([[1]]);
  });

  it('still drops a null value of usable quality (not a sample)', () => {
    const d = alignSeries([{ tag: 'a', points: [[1000, 1, 192], [2000, null, 192], [3000, 3]] }]);
    expect(d[0]).toEqual([1, 3]);
  });
});

describe('unitLayout', () => {
  const s = (unit) => ({ tag: unit || 'x', unit, points: [] });
  it('one unit: one axis', () => {
    expect(unitLayout([s('C'), s('C')])).toMatchObject({ mode: 'single', groups: ['C'] });
  });
  it('two units: left and right axes, each series on its own unit', () => {
    const l = unitLayout([s('C'), s('kPa'), s('C')]);
    expect(l.mode).toBe('dual');
    expect(l.scaleOf).toEqual(['y', 'y2', 'y']);
  });
  it('series without a unit form their own group', () => {
    expect(unitLayout([s('C'), s(undefined)])).toMatchObject({ mode: 'dual', groups: ['C', ''] });
  });
  it('three or more units: normalised, and says it was forced', () => {
    expect(unitLayout([s('C'), s('kPa'), s('rpm')])).toMatchObject({ mode: 'normalize', forced: true });
    expect(unitLayout([s('C')], { normalize: true })).toMatchObject({ mode: 'normalize', forced: false });
  });
});

describe('normalizeSeries', () => {
  it('scales usable samples to 0..100 %, keeps the raw value for the readout, ignores Bad values for the range', () => {
    const [n] = normalizeSeries([{ tag: 'a', unit: 'C', points: [[1, 10, 192], [2, 1000, 0], [3, 20, 192], [4, 15, 0, 1]] }]);
    expect(n.range).toEqual([10, 20]);
    expect(n.unit).toBe('%');
    expect(n.rawUnit).toBe('C');
    expect(n.points[0]).toEqual([1, 0, 192, 0, 10]);
    expect(n.points[2]).toEqual([3, 100, 192, 0, 20]);
    expect(n.points[3]).toEqual([4, 50, 0, 1, 15]);
    const d = alignSeries([n]);
    expect(d[1][1]).toBe(null); // the Bad sample stays a gap
    expect(d.raw[0].get(3)).toBe(15);
  });
});

describe('describeValue', () => {
  it('states the unit and the quality', () => {
    expect(describeValue(21.5, { unit: 'C' })).toBe('21.5 C');
    expect(describeValue(null, { state: 'bad' })).toBe('Bad quality: no value');
    expect(describeValue(12, { unit: 'kPa', state: 'partial' })).toBe('12 kPa · partial (some samples Bad)');
    expect(describeValue(3, { state: 'uncertain' })).toBe('3 · uncertain');
    expect(describeValue(null)).toBe('—');
  });
});

describe('live samples follow the server rules (pipelineEngine.messageQuality / messageTime)', () => {
  it('quality', () => {
    expect(liveQuality({ payload: 5 })).toBe(192);
    expect(liveQuality({ quality: 0, payload: { v: 1, q: 0 } })).toBe(0);
    expect(liveQuality({ payload: { v: 1, q: 64, u: 'bar' } })).toBe(64); // envelope with a unit: the intake did not read it
    expect(liveQuality({ payload: { value: 1, q: 0 } })).toBe(192); // not an envelope
    expect(liveQuality({ sparkplugError: 'x', payload: 'AA' })).toBe(0);
    expect(liveQuality({ quality: 17 })).toBe(192); // only 0 / 64 / 192 are honoured, as on the server
  });
  it('time', () => {
    const now = Date.UTC(2026, 10, 25);
    expect(liveTime({ sourceTimestamp: now - 5000, timestamp: new Date(now).toISOString() }, now)).toBe(now - 5000);
    expect(liveTime({ sourceTimestamp: 12, timestamp: new Date(now).toISOString() }, now)).toBe(now); // implausible device clock
  });
  it('unit', () => {
    expect(unitFrom({ value: 1, unit: 'C' })).toBe('C');
    expect(unitFrom({ v: 1, u: 'bar' })).toBe('bar');
    expect(unitFrom({ v: 1 })).toBe('');
    expect(unitFrom('5')).toBe('');
  });
});

describe('shortTag', () => {
  it('keeps short tags and the trailing segments of long ones', () => {
    expect(shortTag('plant/line1/temp')).toBe('plant/line1/temp');
    expect(shortTag('spBv1.0/recabc/DDATA/Edge1/Dev1/Temperature', 28)).toBe('…/Edge1/Dev1/Temperature');
    expect(shortTag('x'.repeat(40), 11)).toBe('xxxxx…xxxxx');
  });
});
