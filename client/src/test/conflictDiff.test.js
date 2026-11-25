import { describe, expect, it } from 'vitest';
import { diffRows, isStale } from '@/components/ConflictDialog';
import { routeState, brokenSummary } from '@/pages/pipelines/helpers';
import { ruleStates, ruleBody, formFromRule } from '@/pages/settings/helpers';

describe('diffRows: what differs between my unsaved version and the saved one', () => {
  it('lists only differing fields, by dotted path, ignoring bookkeeping and runtime state', () => {
    const mine = { id: 'd1', rev: 1, name: 'Mine', host: '10.0.0.1', port: 502, status: { state: 'online' }, options: { byteOrder: 'AB' }, tags: [{ key: 'a' }] };
    const theirs = { id: 'd1', rev: 2, updatedAt: 'x', name: 'Theirs', host: '10.0.0.1', port: 502, status: { state: 'offline' }, options: { byteOrder: 'BA' }, tags: [{ key: 'a' }] };
    expect(diffRows(mine, theirs)).toEqual([
      { path: 'name', mine: 'Mine', theirs: 'Theirs' },
      { path: 'options.byteOrder', mine: 'AB', theirs: 'BA' }
    ]);
  });

  it('never shows credentials, and treats unset and empty as equal', () => {
    const rows = diffRows({ name: 'a', password: 'new', webhookUrl: 'https://x', apiKey: 'k', note: '' }, { name: 'a', password: null, webhookUrl: 'https://y', apiKey: null, note: null });
    expect(rows).toEqual([]);
  });

  it('shows arrays as compact JSON and a missing field as (not set)', () => {
    const rows = diffRows({ transforms: [{ type: 'repath', to: 'a/{1}' }], extra: 1 }, { transforms: [] });
    expect(rows).toEqual([
      { path: 'transforms', mine: '[{"type":"repath","to":"a/{1}"}]', theirs: '[]' },
      { path: 'extra', mine: '1', theirs: '(not set)' }
    ]);
  });

  it('only a 409 with code stale is a conflict', () => {
    expect(isStale({ status: 409, code: 'stale' })).toBe(true);
    expect(isStale({ status: 409, code: 'duplicate' })).toBe(false);
    expect(isStale({ status: 400, code: 'stale' })).toBe(false);
    expect(isStale(null)).toBe(false);
  });
});

describe('route state with the split counters', () => {
  const route = { enabled: true, source: { filter: 'a/#' } };
  it('a route whose historian refuses everything is not "Running"', () => {
    expect(routeState(route, { target: 'historian', routed: 9, delivered: 0, rejected: 4 })).toMatchObject({ key: 'rejected', tone: 'bad' });
    expect(routeState(route, { target: 'historian', routed: 9, delivered: 5, rejected: 4 }).key).toBe('running');
  });
  it('a dangling reference wins over everything else and is named', () => {
    const broken = { ...route, broken: [{ kind: 'broker', id: 'gone' }, { kind: 'historian', id: 'h2' }] };
    expect(routeState(broken, {})).toMatchObject({ key: 'broken', label: 'Broken reference' });
    expect(brokenSummary(broken)).toBe('broker "gone" is missing, historian "h2" is missing');
  });
});

describe('alert rule state comes from the engine', () => {
  const rule = (state, extra = {}) => ({ id: 'r', enabled: true, state: { state, ...extra } });
  it('maps every engine state, carrying the countdown and webhook health', () => {
    const out = ruleStates(
      [rule('idle', { value: 3 }), rule('breached', { since: 5, remainingMs: 7000, sustainMs: 10000, value: 90 }), { ...rule('firing', { since: 9 }), id: 'f' }, { ...rule('broken', { broken: [{ kind: 'broker', id: 'x' }] }), id: 'b' }],
      []
    );
    expect(out.r.key).toBe('breached'); // (same id twice: the later wins)
    expect(out.r).toMatchObject({ tone: 'warn', remainingMs: 7000, value: 90 });
    expect(out.f).toMatchObject({ key: 'firing', tone: 'bad', since: 9 });
    expect(out.b).toMatchObject({ key: 'broken', broken: [{ kind: 'broker', id: 'x' }] });
  });
  it('falls back to the event feed for a server that does not report state', () => {
    const out = ruleStates([{ id: 'r', enabled: true }], [{ ruleId: 'r', status: 'firing', ts: 5 }]);
    expect(out.r).toMatchObject({ key: 'firing', since: 5 });
  });
});

describe('the rule form carries the revision it was loaded at', () => {
  it('rev goes out with a save of an existing rule, and not with a new one', () => {
    const rule = { id: 'r1', rev: 4, type: 'topic-silent', brokerId: 'b', topic: 't', thresholdMs: 60000 };
    expect(ruleBody(formFromRule(rule), 'b').rev).toBe(4);
    expect(ruleBody({ ...formFromRule(rule), id: null }, 'b')).not.toHaveProperty('rev');
  });
});
