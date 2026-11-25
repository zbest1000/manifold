import { describe, it, expect } from 'vitest';
import { buildLiveRows, filterLiveRows, sortLiveRows, liveCounts, visibleWindow } from '@/lib/deviceTagView';
import { deviceStateView, lastErrorInfo, pollSummary, cycleLevelText, formatReading, formatAge, fleetSummary, hostIssues } from '@/lib/deviceStatus';

const NOW = 1_000_000;
const tags = [
  { key: 'a', address: 'holding:1', type: 'uint16', unit: 'rpm', pollGroup: 'fast' },
  { key: 'b', address: 'holding:2', type: 'uint16', pollGroup: 'fast' },
  { key: 'c', address: 'holding:305', type: 'float32', pollGroup: 'slow', origin: 'profile' },
  { key: 'd', address: 'holding:4', type: 'uint16', pollGroup: 'fast' }
];
const values = {
  a: { v: 1234.56789, q: 192, tRead: NOW - 400 },
  b: { v: 0, q: 0, qReason: 'timeout', tRead: NOW - 2000 },
  c: { v: 5, q: 64, tRead: NOW - 60_000 }
};
const reasons = { d: { code: 2, message: 'illegal data address', since: NOW - 5000 } };
const rows = buildLiveRows(tags, values, reasons, { fast: 500, slow: 5000 }, NOW);

describe('buildLiveRows', () => {
  it('merges definition, sample, quality, quarantine and staleness', () => {
    const [a, b, c, d] = rows;
    expect(a).toMatchObject({ quality: 'good', stale: false, display: '1,234.568', ageMs: 400, unit: 'rpm' });
    expect(b).toMatchObject({ quality: 'bad', reason: 'timeout', stale: false });
    expect(c).toMatchObject({ quality: 'uncertain', stale: true, origin: 'profile' });
    expect(d).toMatchObject({ quality: 'none', quarantined: true, quarantineText: 'illegal data address', display: '—' });
  });
  it('does not call a Bad sample stale', () => {
    const r = buildLiveRows([{ key: 'x', pollGroup: 'fast' }], { x: { v: 0, q: 0, qReason: 'disconnected', tRead: NOW - 60_000 } }, {}, { fast: 500 }, NOW)[0];
    expect(r).toMatchObject({ quality: 'bad', stale: false });
  });
  it('says something when the device gave no reason', () => {
    const r = buildLiveRows([{ key: 'x' }], {}, { x: { code: 3 } }, {}, NOW)[0];
    expect(r.quarantineText).toBe('code 3');
  });
});

describe('filterLiveRows', () => {
  it('matches text on key, address, unit and reason', () => {
    expect(filterLiveRows(rows, 'rpm').map((r) => r.key)).toEqual(['a']);
    expect(filterLiveRows(rows, 'TIMEOUT').map((r) => r.key)).toEqual(['b']);
    expect(filterLiveRows(rows, '305').map((r) => r.key)).toEqual(['c']);
  });
  it('filters by chip', () => {
    expect(filterLiveRows(rows, '', 'bad').map((r) => r.key)).toEqual(['b']);
    expect(filterLiveRows(rows, '', 'stale').map((r) => r.key)).toEqual(['c']);
    expect(filterLiveRows(rows, '', 'quarantined').map((r) => r.key)).toEqual(['d']);
    expect(filterLiveRows(rows, '', 'problems').map((r) => r.key)).toEqual(['b', 'c', 'd']);
  });
  it('counts', () => {
    expect(liveCounts(rows)).toEqual({ all: 4, bad: 1, stale: 1, quarantined: 1, problems: 3 });
  });
});

describe('sortLiveRows', () => {
  it('sorts numbers numerically and puts missing values last in both directions', () => {
    expect(sortLiveRows(rows, { key: 'value', dir: 'asc' }).map((r) => r.key)).toEqual(['b', 'c', 'a', 'd']);
    expect(sortLiveRows(rows, { key: 'value', dir: 'desc' }).map((r) => r.key)).toEqual(['a', 'c', 'b', 'd']);
  });
  it('quality ascending lists the worst first, stale before fresh', () => {
    expect(sortLiveRows(rows, { key: 'quality', dir: 'asc' }).map((r) => r.key)).toEqual(['b', 'c', 'a', 'd']);
  });
  it('sorts by age and leaves unknown sorts alone', () => {
    expect(sortLiveRows(rows, { key: 'age', dir: 'desc' }).map((r) => r.key)).toEqual(['c', 'b', 'a', 'd']);
    expect(sortLiveRows(rows, { key: 'nope', dir: 'asc' })).toBe(rows);
  });
});

describe('visibleWindow', () => {
  it('renders the viewport plus overscan and clamps to the list', () => {
    expect(visibleWindow({ total: 2000, rowHeight: 32, viewport: 320, scrollTop: 0 })).toEqual({ start: 0, end: 18 });
    expect(visibleWindow({ total: 2000, rowHeight: 32, viewport: 320, scrollTop: 3200 })).toEqual({ start: 92, end: 118 });
    expect(visibleWindow({ total: 10, rowHeight: 32, viewport: 320, scrollTop: 0 })).toEqual({ start: 0, end: 10 });
  });
});

describe('device list helpers', () => {
  it('deviceStateView words, tones and ranks', () => {
    const d = { enabled: true };
    expect(deviceStateView(d, { phase: 'online' })).toMatchObject({ label: 'Online', tone: 'good' });
    const back = deviceStateView(d, { phase: 'backoff', reason: 'ECONNREFUSED' });
    expect(back).toMatchObject({ label: 'Backoff', tone: 'warn', reason: 'ECONNREFUSED' });
    expect(deviceStateView({ enabled: false }, {})).toMatchObject({ label: 'Disabled', tone: 'neutral' });
    expect(deviceStateView(d, { phase: 'online' }, null, { state: 'parked' })).toMatchObject({ label: 'Driver parked', tone: 'bad' });
    expect(back.rank).toBeLessThan(deviceStateView(d, { phase: 'online' }).rank);
  });
  it('lastErrorInfo accepts text and objects', () => {
    expect(lastErrorInfo({})).toBeNull();
    expect(lastErrorInfo({ lastError: 'boom', lastErrorAt: 5 })).toEqual({ message: 'boom', at: 5 });
    expect(lastErrorInfo({ lastError: { message: 'obj' } }).message).toBe('obj');
  });
  it('pollSummary picks the worst group', () => {
    expect(pollSummary({})).toBeNull();
    const s = pollSummary({ groups: { fast: { intervalMs: 500, effectiveIntervalMs: 500, avgCycleMs: 10, lastCycleMs: 10 }, slow: { intervalMs: 1000, effectiveIntervalMs: 3000, avgCycleMs: 100, lastCycleMs: 90 } } });
    expect(s).toMatchObject({ groupId: 'slow', level: 'slowed', groups: 2 });
    expect(cycleLevelText(s)).toBe('Slowed to 3.0 s');
    expect(cycleLevelText({ level: 'overrun' })).toBe('Overrunning');
    expect(cycleLevelText({ level: 'ok' })).toBe('');
  });
  it('formats readings and ages', () => {
    expect(formatReading(0.123456)).toBe('0.123');
    expect(formatReading(true)).toBe('true');
    expect(formatReading(null)).toBe('—');
    expect(formatAge(400)).toBe('0.4 s');
    expect(formatAge(12_400)).toBe('12 s');
    expect(formatAge(5 * 60_000)).toBe('5 min');
    expect(formatAge(undefined)).toBe('');
  });
  it('hostIssues names at most five affected devices', () => {
    const devices = Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, name: `Pump ${i}` }));
    const [issue] = hostIssues({ h1: { state: 'parked', protocol: 'modbus-tcp', restarts: 5, deviceIds: devices.map((d) => d.id) } }, devices);
    expect(issue.text).toContain('Affects: Pump 0, Pump 1, Pump 2, Pump 3, Pump 4 and 7 more.');
    expect(issue.text).not.toContain('Pump 5');
    const [few] = hostIssues({ h2: { state: 'backoff', protocol: 's7', restarts: 2, deviceIds: ['d0'] } }, devices);
    expect(few.text).toContain('Affects: Pump 0.');
  });
  it('fleetSummary', () => {
    expect(fleetSummary([])).toBe('');
    expect(fleetSummary([{ key: 'online' }, { key: 'backoff' }, { key: 'disabled' }])).toBe('1 of 3 online · 1 with problems · 1 disabled');
  });
});
