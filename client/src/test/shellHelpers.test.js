import { describe, it, expect } from 'vitest';
import { sortRows, nextSort, ariaSort } from '@/lib/sortRows';
import { withCurrent, formatValue, nodeValueMap, formFromConnection, pickConnectionId, connectionLabel, BLANK_FORM } from '@/pages/opcua/helpers';
import {
  parseCsv, parseRenameMap, formatRenameMap, parseJsonObject, blankRoute, cloneRoute, cleanModel, routeSaveable, modelSaveable,
  routeTargetLabel, historianPayload, historianSaveDisabled, historianSummary, historianFormFrom, BLANK_HISTORIAN, outboxSummary,
  recordingBody, recordingStatusLabel, brokerName
} from '@/pages/pipelines/helpers';
import { importSummary } from '@/pages/settings/helpers';
import { valueRuleSummary, ruleScope, formFromRule, ruleBody, EMPTY_RULE_FORM } from '@/pages/alerts/helpers';

describe('sortRows / nextSort', () => {
  const rows = [{ n: 'pump10', v: 3 }, { n: 'pump2', v: null }, { n: 'pump1', v: 1 }, { n: 'Pump3', v: 2 }];
  it('sorts strings naturally and case-insensitively', () => {
    expect(sortRows(rows, { key: 'n', dir: 'asc' }).map((r) => r.n)).toEqual(['pump1', 'pump2', 'Pump3', 'pump10']);
    expect(sortRows(rows, { key: 'n', dir: 'desc' }).map((r) => r.n)).toEqual(['pump10', 'Pump3', 'pump2', 'pump1']);
  });
  it('sorts numbers numerically with empty values always last', () => {
    expect(sortRows(rows, { key: 'v', dir: 'asc' }).map((r) => r.v)).toEqual([1, 2, 3, null]);
    expect(sortRows(rows, { key: 'v', dir: 'desc' }).map((r) => r.v)).toEqual([3, 2, 1, null]);
  });
  it('is stable, does not mutate, and supports accessors', () => {
    const same = [{ k: 1, id: 'a' }, { k: 1, id: 'b' }, { k: 0, id: 'c' }];
    expect(sortRows(same, { key: 'k', dir: 'asc' }).map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(same[0].id).toBe('a');
    expect(sortRows(same, { key: 'x', dir: 'desc' }, { x: (r) => r.id }).map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });
  it('returns the input untouched without a sort key', () => {
    expect(sortRows(rows, null)).toBe(rows);
  });
  it('cycles direction and reports aria-sort', () => {
    expect(nextSort(null, 'a')).toEqual({ key: 'a', dir: 'asc' });
    expect(nextSort({ key: 'a', dir: 'asc' }, 'a')).toEqual({ key: 'a', dir: 'desc' });
    expect(nextSort({ key: 'a', dir: 'desc' }, 'a')).toEqual({ key: 'a', dir: 'asc' });
    expect(nextSort({ key: 'a', dir: 'desc' }, 'b')).toEqual({ key: 'b', dir: 'asc' });
    expect(ariaSort({ key: 'a', dir: 'asc' }, 'a')).toBe('ascending');
    expect(ariaSort({ key: 'a', dir: 'desc' }, 'a')).toBe('descending');
    expect(ariaSort({ key: 'a', dir: 'desc' }, 'b')).toBe('none');
  });
});

describe('opcua helpers', () => {
  it('withCurrent keeps an unknown value selectable', () => {
    expect(withCurrent(['None', 'Sign'], 'Sign')).toEqual(['None', 'Sign']);
    expect(withCurrent(['None', 'Sign'], 'Weird')).toEqual(['None', 'Sign', 'Weird']);
  });
  it('formatValue stringifies objects and tolerates null', () => {
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
    expect(formatValue(42)).toBe('42');
    expect(formatValue(null)).toBe('');
  });
  it('nodeValueMap keys values the way the graph does', () => {
    expect(nodeValueMap('c1', { 'ns=2;i=5': { value: 7 }, 'ns=2;i=6': { value: [1, 2] } })).toEqual({
      'opcua:c1:ns=2;i=5': { text: '7' },
      'opcua:c1:ns=2;i=6': { text: '[1,2]' }
    });
    expect(nodeValueMap('c1', undefined)).toEqual({});
  });
  it('formFromConnection never carries a password', () => {
    const f = formFromConnection({ id: 'x', name: 'PLC', endpointUrl: 'opc.tcp://h:4840', securityMode: 'Sign', securityPolicy: 'Basic256Sha256', username: 'u', password: 'secret' });
    expect(f).toMatchObject({ name: 'PLC', endpointUrl: 'opc.tcp://h:4840', securityMode: 'Sign', username: 'u', password: '' });
    expect(formFromConnection({ id: 'y', endpointUrl: 'e' })).toMatchObject({ securityMode: 'None', securityPolicy: 'None', name: '' });
    expect(BLANK_FORM.password).toBe('');
  });
  it('pickConnectionId keeps a valid choice, else the first connected server', () => {
    const list = [{ id: 'a', status: 'error' }, { id: 'b', status: 'connected' }, { id: 'c', status: 'connected' }];
    expect(pickConnectionId(list, 'a')).toBe('a');
    expect(pickConnectionId(list, null)).toBe('b');
    expect(pickConnectionId(list, 'gone')).toBe('b');
    expect(pickConnectionId([{ id: 'a', status: 'error' }], null)).toBe(null);
    expect(connectionLabel({ id: 'i', endpointUrl: 'opc.tcp://x' })).toBe('opc.tcp://x');
  });
});

describe('pipelines helpers', () => {
  it('parses comma lists and rename maps', () => {
    expect(parseCsv(' a, b ,,c ')).toEqual(['a', 'b', 'c']);
    expect(parseCsv(undefined)).toEqual([]);
    expect(parseRenameMap('old:new, x : y,bad,:z')).toEqual({ old: 'new', x: 'y' });
    expect(formatRenameMap({ a: 'b', c: 'd' })).toBe('a:b,c:d');
  });
  it('parseJsonObject only accepts objects', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject('')).toEqual({});
    expect(parseJsonObject('{"a":')).toBe(null);
    expect(parseJsonObject('[1]')).toBe(null);
    expect(parseJsonObject('3')).toBe(null);
  });
  it('blank/clone route', () => {
    const r = blankRoute([{ id: 'b1' }]);
    expect(r.source.brokerId).toBe('b1');
    expect(r.transforms[0].type).toBe('repath');
    const c = cloneRoute(r);
    c.transforms[0].to = 'changed';
    c.source.filter = 'x';
    expect(r.transforms[0].to).toBe('uns/{1-}');
    expect(r.source.filter).toBe('');
  });
  it('saveability rules', () => {
    const r = blankRoute([{ id: 'b1' }]);
    expect(routeSaveable(r)).toBe(false);
    r.source.filter = 'a/#';
    expect(routeSaveable(r)).toBe(true);
    r.target = { type: 'historian', historianId: '' };
    expect(routeSaveable(r)).toBe(false);
    expect(modelSaveable({ target: { topic: '' }, attributes: [] })).toBe(false);
    expect(modelSaveable({ target: { topic: 't' }, attributes: [{ name: 'a', source: { topic: '' } }] })).toBe(false);
    expect(modelSaveable({ target: { topic: 't' }, attributes: [{ name: 'a', source: { topic: 'x' } }] })).toBe(true);
  });
  it('cleanModel drops empty attributes and empty fields', () => {
    const out = cleanModel({
      name: 'm',
      attributes: [
        { name: 'rpm', source: { brokerId: 'b', topic: 'raw/rpm', field: '' } },
        { name: '', source: { brokerId: 'b', topic: 'x', field: '' } },
        { name: 'temp', source: { brokerId: 'b', topic: 'raw/t', field: 'v' } }
      ]
    });
    expect(out.attributes).toEqual([
      { name: 'rpm', source: { brokerId: 'b', topic: 'raw/rpm' } },
      { name: 'temp', source: { brokerId: 'b', topic: 'raw/t', field: 'v' } }
    ]);
  });
  it('describes route targets', () => {
    const brokers = [{ id: 'b1', name: 'Plant' }];
    expect(brokerName(brokers, 'b1')).toBe('Plant');
    expect(brokerName(brokers, '1234567890abcdef')).toBe('12345678…');
    expect(routeTargetLabel({ target: { type: 'mqtt', brokerId: 'b1', retain: true } }, brokers, [])).toBe('Plant (mqtt, retained)');
    expect(routeTargetLabel({ target: { type: 'historian', historianId: 'h1' } }, brokers, [{ id: 'h1', name: 'Influx' }])).toBe('historian:Influx');
  });
  it('historian payload keeps stored secrets by omitting blank ones when editing', () => {
    const form = { ...BLANK_HISTORIAN, name: 'h', url: 'http://x', org: 'o', bucket: 'b', token: '', password: '', apiKey: '' };
    const edited = historianPayload(form, 'id1');
    expect(edited.id).toBe('id1');
    expect('token' in edited).toBe(false);
    expect('password' in edited).toBe(false);
    expect('apiKey' in edited).toBe(false);
    const created = historianPayload({ ...form, token: 't' }, null);
    expect(created.token).toBe('t');
    expect('id' in created).toBe(false);
    expect(historianPayload({ ...form, token: 'new' }, 'id1').token).toBe('new');
  });
  it('historian form validity per type', () => {
    expect(historianSaveDisabled({ ...BLANK_HISTORIAN, type: 'influxdb', url: 'u', org: 'o', bucket: '' })).toBe(true);
    expect(historianSaveDisabled({ ...BLANK_HISTORIAN, type: 'influxdb', url: 'u', org: 'o', bucket: 'b' })).toBe(false);
    expect(historianSaveDisabled({ ...BLANK_HISTORIAN, type: 'timebase', url: 'u', dataset: '' })).toBe(true);
    expect(historianSaveDisabled({ ...BLANK_HISTORIAN, type: 'timescaledb', host: 'h', database: 'd', user: '' })).toBe(true);
    expect(historianSaveDisabled({ ...BLANK_HISTORIAN, type: 'timescaledb', host: 'h', database: 'd', user: 'u' })).toBe(false);
    expect(historianSaveDisabled({ ...BLANK_HISTORIAN, type: 'influxdb', url: '' })).toBe(true);
  });
  it('historian summary + form round-trip', () => {
    expect(historianSummary({ type: 'timescaledb', host: 'h', database: 'd' })).toBe('h:5432/d · table=manifold_samples');
    expect(historianSummary({ type: 'influxdb', url: 'http://i', org: 'o', bucket: 'b' })).toBe('http://i · org=o bucket=b');
    expect(historianSummary({ type: 'timebase', url: 'http://t', dataset: 'ds' })).toBe('http://t · dataset=ds');
    const f = historianFormFrom({ type: 'influxdb', name: 'n', url: 'u', token: 'leak' });
    expect(f.token).toBe('');
    expect(f.dropPolicy).toBe('newest');
  });
  it('outbox summary and recording helpers', () => {
    expect(outboxSummary(null)).toBe(null);
    expect(outboxSummary({ written: 1500, queued: 2, spillBytes: 2048, dropped: 0 })).toMatchObject({ queued: 2, spilledKb: '2.0', dropped: null, lastError: null });
    expect(recordingBody({ name: '', brokerId: '', filter: 'a/#', targetType: 'file' }, [{ id: 'b1' }])).toEqual({ name: null, brokerId: 'b1', filter: 'a/#', target: { type: 'file' } });
    expect(recordingBody({ name: 'n', brokerId: 'b2', filter: 'f', targetType: 'historian', historianId: 'h' }, [])).toMatchObject({ target: { type: 'historian', historianId: 'h' } });
    expect(recordingStatusLabel({ enabled: true, status: { full: false } })).toBe('recording');
    expect(recordingStatusLabel({ enabled: false, status: { full: false } })).toBe('paused');
    expect(recordingStatusLabel({ enabled: true, status: { full: true } })).toBe('full');
  });
});

describe('settings helpers', () => {
  it('summarises value rules', () => {
    expect(valueRuleSummary({ topic: 'plant/+/temp', field: 'v', op: '>', value: 80, sustainMs: 30000, clearValue: 75 })).toBe('plant/+/temp · v > 80 for 30s, clear at 75');
    expect(valueRuleSummary({ topic: 't', op: '<=', value: 1, sustainMs: 0, clearValue: null })).toBe('t · value <= 1');
  });
  it('describes what each rule type watches', () => {
    expect(ruleScope({ type: 'branch-silent', path: '', thresholdMs: 60000 })).toBe('(whole namespace) > 60s');
    expect(ruleScope({ type: 'topic-silent', topic: 'a/b', thresholdMs: 15000 })).toBe('a/b > 15s');
    expect(ruleScope({ type: 'new-topic', prefix: 'plant/' })).toBe('under plant/');
    expect(ruleScope({ type: 'new-topic' })).toBe('anywhere');
    expect(ruleScope({ type: 'nope' })).toBe('');
  });
  it('rule form round trip builds the right request body', () => {
    const rule = { id: 'r1', type: 'value-threshold', brokerId: 'b', topic: 't', field: 'v', op: '>=', value: 5, sustainMs: 2000, clearValue: 3, thresholdMs: 60000 };
    const form = formFromRule(rule);
    expect(form).toMatchObject({ id: 'r1', sustainSec: 2, clearValue: 3, thresholdSec: 60 });
    expect(ruleBody(form, 'fallback')).toMatchObject({ id: 'r1', brokerId: 'b', op: '>=', value: 5, sustainMs: 2000, clearValue: 3 });
    const fresh = ruleBody({ ...EMPTY_RULE_FORM, path: 'plant', thresholdSec: 30 }, 'fallback');
    expect(fresh).toMatchObject({ id: undefined, brokerId: 'fallback', thresholdMs: 30000, type: 'branch-silent' });
    expect('op' in fresh).toBe(false);
    expect(ruleBody({ ...EMPTY_RULE_FORM, type: 'value-threshold', value: '7', sustainSec: '', clearValue: '' }, 'b')).toMatchObject({ value: 7, sustainMs: 0, clearValue: null });
  });
  it('import summary lists only non-empty sections', () => {
    expect(importSummary({ pipelines: [1, 2], historians: [], models: [1], other: [1] })).toBe('2 pipelines, 1 models');
    expect(importSummary({})).toBe('');
    expect(importSummary(null)).toBe('');
  });
});
