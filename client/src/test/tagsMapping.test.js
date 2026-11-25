import { describe, it, expect } from 'vitest';
import {
  stateFromBinding, newState, buildMapping, withTagDefs, switchSelectMode, makeRow, entryOf, overrideOf, renameRow, setOv,
  matchTag, rowVerdict, publishingRows, bulkEnable, bulkSet, bulkContextKey, bulkRename, bulkCopy, bulkReset,
  camelCase, snakeCase, stripPrefix, parseGrid, applyPaste, computeTopics, diffTopics, validateMapping, rowErrors, contextErrors,
  contextRows, contextObject, contextPlaceholders, visibleErrors, focusDraft, rowKeyFromMessage, suggestionMap
} from '@/pages/tags/mappingModel';

const brokers = [{ id: 'b1', name: 'Local' }];
const DEVICE_TAGS = [
  { key: 'temp', address: 'holding:100', type: 'float32', unit: 'degC', property: 'temperature', description: 'Supply temp', range: { min: 0, max: 200 } },
  { key: 'count', address: '40103', type: 'uint16' },
  { key: 'state', address: 'holding:7', type: 'uint16', property: 'runState', states: { 0: 'Stopped', 1: 'Running' }, pollGroup: 'slow' },
  { key: 'press', address: 'holding:8', type: 'int16', property: 'pressure', unit: 'bar', displayName: 'Line pressure', limits: { lo: 1, hi: 9 }, context: { pid: 'PT-101' } }
];

const roundTrip = (b, tagDefs = DEVICE_TAGS) => buildMapping(stateFromBinding(b, { brokers, tagDefs }));

describe('mapping round trip: every stored field survives an untouched edit', () => {
  it('list entries with overrides, disabled entries and unknown keys', () => {
    const b = {
      id: 'b1', name: 'filler', enabled: true, createdBy: 'ops', // unknown top-level key
      source: {
        type: 'device', deviceId: 'd1', note: 'kept',
        tags: [
          'temp',
          { address: 'count', name: 'pieces', enabled: false, unit: 'pcs', futureKey: { a: 1 } },
          { address: 'state', statesMode: 'replace', states: { 0: 'Off', 1: 'On' } },
          { address: 'press', name: 'pressure', scale: 0.1, offset: 2, precision: 1, dataType: 'number', limits: { lolo: 0, hihi: 12 }, deadband: { type: 'percent', value: 1 }, context: { loop: 'L1' }, range: { min: 0, max: 10 }, displayName: 'P', description: 'd' },
          { address: 'gone', enabled: false }
        ],
        overrides: { temp: { unit: 'K' } }
      },
      target: {
        mode: 'mqtt', brokerId: 'b1', assetPath: 'acme/l4/filler', format: 'envelope', retain: false, qos: 1,
        context: { site: 'dallas', equipmentId: '{deviceId}', serial: 42, critical: true }, contextMode: 'payload',
        fields: ['v', 'q', 'u', 'ctx'], metaFields: ['type', 'unit', 'context'], futureTarget: 'x'
      },
      rbe: { heartbeatMs: 60000 }
    };
    expect(roundTrip(b)).toEqual(b);
  });

  it('rules mode with select, overrides, an orphan override and unknown select keys', () => {
    const b = {
      id: 'r1', name: 'by rule', enabled: false,
      source: {
        type: 'device', deviceId: 'd1', tags: 'all',
        select: { include: ['*e*'], exclude: ['run*'], pollGroups: ['default', 'slow'], types: ['float32'], withProperty: true },
        overrides: { press: { name: 'linePressure', enabled: true }, temp: { enabled: false }, future: { unit: 'x' } }
      },
      target: { mode: 'mqtt', brokerId: 'b1', assetPath: 'a/b', format: 'envelope', retain: false, qos: 0 }
    };
    expect(roundTrip(b)).toEqual(b);
    const s = stateFromBinding(b, { brokers, tagDefs: DEVICE_TAGS });
    expect(s.selectMode).toBe('rules');
    expect(s.orphans).toEqual({ future: { unit: 'x' } });
  });

  it('tags "all" without select stays exactly that; empty select is kept', () => {
    const plain = { id: 'x', name: null, enabled: true, source: { type: 'device', deviceId: 'd1', tags: 'all' }, target: { mode: 'mqtt', brokerId: 'b1', assetPath: 'a', format: 'plain', retain: false, qos: 0 } };
    expect(roundTrip(plain)).toEqual(plain);
    const empty = { ...plain, source: { ...plain.source, select: {} } };
    expect(roundTrip(empty)).toEqual(empty);
  });

  it('device-profile rules + per-instance paths; OPC UA with names and samplingInterval; sparkplug source', () => {
    const profileTags = [{ key: 'kw', property: 'activePower', unit: 'kW' }, { key: 'pf', type: 'float32' }];
    const p = {
      id: 'p', name: 'meters', enabled: true,
      source: { type: 'device-profile', profileId: 'p1', tags: 'all', select: { exclude: ['pf'] }, overrides: { kw: { unit: 'W', scale: 1000 } } },
      target: { mode: 'mqtt', brokerId: 'b1', assetPathTemplate: 'acme/{line}/{device}', assetPaths: { d9: 'special/m' }, layout: 'object-per-asset', format: 'envelope', retain: false, qos: 0, context: { line: '{param:line}' } }
    };
    expect(roundTrip(p, profileTags)).toEqual(p);
    const o = {
      id: 'o', name: 'ua', enabled: true,
      source: { type: 'opcua', connectionId: 'c1', tags: [{ address: 'ns=2;s=A.B', name: 'b', unit: 'm' }], samplingInterval: 250 },
      target: { mode: 'sparkplug', brokerId: 'b1', group: 'G', edge: 'E', device: 'D' }
    };
    expect(roundTrip(o, null)).toEqual(o);
    const sp = { id: 's', name: 'sp', enabled: true, source: { type: 'sparkplug', brokerId: 'b1', group: 'G', edge: 'E', device: null, metrics: ['m1', 'm2'] }, target: { mode: 'mqtt', brokerId: 'b1', pathTemplate: 'u/{name}', format: 'plain', retain: false, qos: 0 } };
    expect(roundTrip(sp, null)).toEqual(sp);
  });

  it('a list binding edited before the device tags load keeps its entries, and after they load too', () => {
    const b = { id: 'l', name: 'l', enabled: true, source: { type: 'device', deviceId: 'd1', tags: [{ address: 'temp', name: 'temperature' }, 'count'] }, target: { mode: 'mqtt', brokerId: 'b1', assetPath: 'a', format: 'envelope', retain: false, qos: 0 } };
    const early = stateFromBinding(b, { brokers, tagDefs: null });
    expect(buildMapping(early)).toEqual(b);
    expect(buildMapping(withTagDefs(early, DEVICE_TAGS))).toEqual(b);
  });
});

describe('new mappings', () => {
  const picked = [
    { id: 'temp', address: 'temp', name: 'temperature', meta: { property: 'temperature', unit: 'degC', type: 'float32' } },
    { id: 'DB10_spare', address: 'DB10_spare', name: 'DB10_spare', meta: { type: 'int16' } }
  ];
  const suggestions = suggestionMap([
    { address: 'temp', suggestedName: 'temperature', basis: 'property' },
    { address: 'DB10_spare', suggestedName: 'spare', basis: 'key' }
  ]);
  it('pre-fills suggested names; only names that differ from the server default are sent', () => {
    const s = newState({ srcType: 'device', ref: { deviceId: 'd1' }, picked, suggestions, brokers });
    expect(s.rows.map((r) => [r.name, r.explicit, r.fromSuggestion])).toEqual([['temperature', false, false], ['spare', true, true]]);
    s.form.assetPath = 'acme/l1';
    const b = buildMapping(s);
    expect(b.source).toEqual({ type: 'device', deviceId: 'd1', tags: ['temp', { address: 'DB10_spare', name: 'spare' }] });
    expect(b.target).toMatchObject({ mode: 'mqtt', brokerId: 'b1', assetPath: 'acme/l1', format: 'envelope', retain: false });
    expect(b.target.contextMode).toBeUndefined();
    expect(b.target.fields).toBeUndefined();
  });
  it('rules mode starts with every tag and no rules (tags "all")', () => {
    const s = newState({ srcType: 'device', ref: { deviceId: 'd1' }, tagDefs: DEVICE_TAGS, brokers, selectMode: 'rules' });
    expect(s.rows).toHaveLength(4);
    expect(buildMapping(s).source).toEqual({ type: 'device', deviceId: 'd1', tags: 'all' });
  });
  it('switching list -> rules -> list keeps edits and drops rule-excluded rows', () => {
    let s = newState({ srcType: 'device', ref: { deviceId: 'd1' }, picked: [picked[0]], brokers });
    s = { ...s, rows: s.rows.map((r) => setOv(r, 'unit', 'K')) };
    s = switchSelectMode(s, 'rules', DEVICE_TAGS);
    expect(s.rows.find((r) => r.key === 'temp').ov.unit).toBe('K');
    s = { ...s, rules: { ...s.rules, exclude: ['count'] } };
    expect(buildMapping(s).source.overrides).toEqual({ temp: { unit: 'K' } });
    s = switchSelectMode(s, 'list');
    expect(s.rows.map((r) => r.key)).toEqual(['temp', 'state', 'press']);
  });
  it('OPC UA always sends names', () => {
    const s = newState({ srcType: 'opcua', ref: { connectionId: 'c' }, picked: [{ id: 'n', address: 'ns=2;s=A', name: 'A', meta: {} }], brokers });
    expect(buildMapping(s).source.tags).toEqual([{ address: 'ns=2;s=A', name: 'A' }]);
  });
});

describe('rows', () => {
  const row = makeRow({ srcType: 'device', address: 'press', def: DEVICE_TAGS[3] });
  it('entries: bare string when nothing is set; disabling and renaming produce an object', () => {
    expect(entryOf(row)).toBe('press');
    expect(entryOf({ ...row, enabled: false })).toEqual({ address: 'press', enabled: false });
    expect(entryOf(renameRow(row, 'p2'))).toEqual({ address: 'press', name: 'p2' });
    expect(entryOf(renameRow(renameRow(row, 'p2'), 'pressure'))).toBe('press');
    expect(overrideOf(row)).toBeNull();
    expect(overrideOf(setOv(row, 'unit', 'psi'))).toEqual({ unit: 'psi' });
  });
  it('validates overrides like the server', () => {
    const errs = (ov) => rowErrors({ ...row, ov }).map((e) => e.field);
    expect(errs({ range: { min: 5, max: 1 } })).toEqual(['range']);
    expect(errs({ scale: 0 })).toEqual(['scale']);
    expect(errs({ precision: 11 })).toEqual(['precision']);
    expect(errs({ limits: { lo: 5, hi: 1 } })).toEqual(['limits']);
    expect(errs({ states: { 1: '' } })).toEqual(['states']);
    expect(errs({ deadband: { type: 'percent', value: 120 } })).toEqual(['deadband']);
    expect(errs({ context: { '1bad': 'x' } })).toEqual(['context']);
    expect(errs({ range: { min: 0, max: 1 }, limits: { lo: 0, hi: 1 }, precision: 2, scale: 2 })).toEqual([]);
    expect(rowErrors({ ...row, name: ' ' })[0]).toMatchObject({ field: 'name', required: true });
  });
});

describe('selection rules mirror the server', () => {
  const tag = (key, property, pollGroup, type) => ({ key, property, pollGroup, type });
  it('include, filters, then exclude (case-insensitive globs on key and property)', () => {
    const rules = { include: ['*e*'], exclude: ['run*'], pollGroups: [], types: ['float32', 'int16', 'UINT16'], withProperty: null };
    expect(matchTag(rules, tag('count', null, null, 'uint16'))).toEqual({ matched: false, rule: 'include' });
    expect(matchTag(rules, tag('state', 'runState', 'slow', 'uint16'))).toEqual({ matched: false, rule: 'exclude', pattern: 'run*' });
    expect(matchTag(rules, tag('temp', 'temperature', null, 'float32'))).toEqual({ matched: true });
    expect(matchTag({ ...rules, include: [], exclude: [], types: [], pollGroups: ['slow'] }, tag('temp'))).toEqual({ matched: false, rule: 'pollGroups' });
    expect(matchTag({ include: ['TEMP?RATURE'] }, tag('temp', 'temperature'))).toEqual({ matched: true });
    expect(matchTag({ withProperty: false }, tag('temp', 'temperature'))).toEqual({ matched: false, rule: 'withProperty' });
  });
  it('publishing rows: enabled and matched', () => {
    let s = stateFromBinding({ id: 'x', source: { type: 'device', deviceId: 'd', tags: 'all', select: { exclude: ['count'] }, overrides: { temp: { enabled: false } } }, target: { mode: 'mqtt', brokerId: 'b1', assetPath: 'a' } }, { brokers, tagDefs: DEVICE_TAGS });
    expect(publishingRows(s).map((r) => r.key)).toEqual(['state', 'press']);
    expect(rowVerdict(s, s.rows[1])).toEqual({ matched: false, rule: 'exclude', pattern: 'count' });
    s = { ...s, rows: bulkEnable(s.rows, ['temp'], true) };
    expect(buildMapping(s).source.overrides).toEqual({ temp: { enabled: true } });
  });
});

describe('bulk edits', () => {
  const rows = DEVICE_TAGS.map((t) => makeRow({ srcType: 'device', address: t.key, def: t }));
  const keys = ['temp', 'count'];
  it('set, context key, enable, reset', () => {
    let r = bulkSet(rows, keys, 'unit', 'K');
    expect(r.filter((x) => x.ov.unit === 'K').map((x) => x.key)).toEqual(keys);
    r = bulkContextKey(r, ['temp'], 'area', 'north');
    expect(r[0].ov.context).toEqual({ area: 'north' });
    r = bulkEnable(r, keys, false);
    expect(r.filter((x) => !x.enabled).map((x) => x.key)).toEqual(keys);
    expect(bulkReset(r, ['temp'])[0].ov).toEqual({});
  });
  it('naming transforms', () => {
    expect(camelCase('Motor_Speed')).toBe('motorSpeed');
    expect(camelCase('TT101_PV')).toBe('tt101Pv');
    expect(snakeCase('motorSpeed PV')).toBe('motor_speed_pv');
    expect(stripPrefix('DB10_temp', 'db10_')).toBe('temp');
    const named = rows.map((r) => renameRow(r, `L1_${r.name}`));
    expect(bulkRename(named, ['temp'], { kind: 'strip', prefix: 'L1_' })[0].name).toBe('temperature');
    expect(bulkRename(named, ['temp', 'count'], { kind: 'replace', find: 'l1_', replace: 'line1.' }).slice(0, 2).map((r) => r.name)).toEqual(['line1.temperature', 'line1.count']);
    expect(bulkRename(named, ['temp'], { kind: 'replace', find: '^L(\\d)_', replace: 'line$1/', regex: true })[0].name).toBe('line1/temperature');
    expect(bulkRename(named, ['temp'], { kind: 'snake' })[0].name).toBe('l1_temperature');
    expect(bulkRename(named, ['temp'], { kind: 'replace', find: '(', regex: true })).toBe(named);
  });
  it('copy settings from one row (never the name)', () => {
    const src = setOv(setOv(renameRow(rows[0], 'x'), 'unit', 'K'), 'scale', 2);
    const out = bulkCopy([src, ...rows.slice(1)], 'temp', ['count', 'state']);
    expect(out[1].ov).toEqual({ unit: 'K', scale: 2 });
    expect(out[1].name).toBe('count');
  });
  it('paste a spreadsheet block into name / unit / description', () => {
    const grid = parseGrid('speed\trpm\tMotor speed\r\nflow\tm3/h\r\n');
    expect(grid).toEqual([['speed', 'rpm', 'Motor speed'], ['flow', 'm3/h']]);
    const { rows: out, count } = applyPaste(rows, rows.map((r) => r.key), 'count', 'name', grid);
    expect(count).toBe(2);
    expect([out[1].name, out[1].ov.unit, out[1].ov.description]).toEqual(['speed', 'rpm', 'Motor speed']);
    expect([out[2].name, out[2].ov.unit]).toEqual(['flow', 'm3/h']);
    expect(applyPaste(rows, rows.map((r) => r.key), 'temp', 'unit', [['K', 'desc', 'ignored']]).rows[0].ov).toEqual({ unit: 'K', description: 'desc' });
  });
});

describe('topics and diff', () => {
  const b = { id: 'e', name: 'e', enabled: true, source: { type: 'device', deviceId: 'd1', tags: ['temp', 'count', 'press'] }, target: { mode: 'mqtt', brokerId: 'b1', assetPath: 'acme/f', format: 'envelope' } };
  it('computes value topics like the server and reports renames and removals', () => {
    const s0 = stateFromBinding(b, { brokers, tagDefs: DEVICE_TAGS });
    expect(computeTopics(s0).map((t) => t.topic)).toEqual(['acme/f/temperature', 'acme/f/count', 'acme/f/pressure']);
    let s1 = { ...s0, rows: s0.rows.map((r) => (r.key === 'count' ? renameRow(r, 'pieces') : r)) };
    s1 = { ...s1, rows: bulkEnable(s1.rows, ['press'], false) };
    const d = diffTopics(computeTopics(s0), computeTopics(s1));
    expect(d.renamed).toEqual([{ address: 'count', from: 'acme/f/count', to: 'acme/f/pieces', unitName: undefined }]);
    expect(d.removed.map((x) => x.topic)).toEqual(['acme/f/pressure']);
    const moved = { ...s0, form: { ...s0.form, assetPath: 'acme/g' } };
    expect(diffTopics(computeTopics(s0), computeTopics(moved)).renamed).toHaveLength(3);
  });
  it('profile instances and object layout', () => {
    const profile = { id: 'p1', params: [{ name: 'line' }], tags: [{ key: 'kw', property: 'power' }] };
    const devices = [{ id: 'a', name: 'A', profileId: 'p1', params: { line: 'l1' } }, { id: 'b', name: 'B', profileId: 'p1', params: { line: 'l2' } }];
    const s = stateFromBinding({ id: 'p', source: { type: 'device-profile', profileId: 'p1', tags: 'all' }, target: { mode: 'mqtt', brokerId: 'b1', assetPathTemplate: 'x/{line}/{device}' } }, { brokers, tagDefs: profile.tags });
    expect(computeTopics(s, { profile, devices }).map((t) => t.topic)).toEqual(['x/l1/A/power', 'x/l2/B/power']);
    const obj = { ...s, form: { ...s.form, layout: 'object-per-asset' } };
    expect(computeTopics(obj, { profile, devices })).toMatchObject([{ topic: 'x/l1/A', object: true, members: ['power'] }, { topic: 'x/l2/B', object: true }]);
  });
});

describe('validation', () => {
  const base = () => {
    const s = newState({ srcType: 'device', ref: { deviceId: 'd1' }, picked: [{ id: 'temp', address: 'temp', name: 'temperature', meta: { property: 'temperature' } }], brokers });
    return { ...s, form: { ...s.form, assetPath: 'acme/l1' } };
  };
  const run = (s, o = {}) => validateMapping(s, { brokers, ...o });
  it('a valid mapping has no problems; an empty asset path is only shown after a save attempt', () => {
    expect(run(base())).toEqual([]);
    const s = { ...base(), form: { ...base().form, assetPath: '' } };
    const e = run(s);
    expect(e[0]).toMatchObject({ section: 'where', field: 'dest', required: true });
    expect(visibleErrors(e, false)).toEqual([]);
    expect(visibleErrors(e, true)).toHaveLength(1);
    expect(run({ ...base(), form: { ...base().form, assetPath: 'a//b' } })[0].required).toBe(false);
  });
  it('duplicate names, context problems, fields, deadband and heartbeat', () => {
    const s = base();
    const dup = { ...s, rows: [...s.rows, { ...renameRow(s.rows[0], 'temperature'), key: 'x', address: 'x' }] };
    expect(run(dup).some((e) => e.rowKey === 'x' && /used by two tags/.test(e.message))).toBe(true);
    const ctx = { ...s, form: { ...s.form, context: [{ id: 'a', key: '9x', value: 'v', type: 'string' }, { id: 'b', key: 'site', value: '{nope}', type: 'string' }] } };
    const ce = run(ctx, { schema: { placeholders: { device: ['{device}', '{deviceId}'] } } }).filter((e) => e.section === 'context');
    expect(ce.map((e) => e.message)).toEqual([expect.stringMatching(/not a valid key/), expect.stringMatching(/unknown placeholder \{nope\}/)]);
    expect(run({ ...s, form: { ...s.form, fields: ['v', 'ctx'], contextMode: 'none' } })[0].section).toBe('payload');
    expect(run({ ...s, form: { ...s.form, dbType: 'percent', dbValue: '150' } })[0].message).toMatch(/0 and 100/);
    expect(run({ ...s, form: { ...s.form, heartbeatMs: '500' } })[0].message).toMatch(/1000/);
  });
  it('server rejection and collisions block, with the row to jump to', () => {
    const s = base();
    const clash = { status: 'ok', data: { valid: true, tags: [], objects: [], warnings: [{ type: 'collision', topic: 'acme/l1/temperature', bindings: [{ id: 'o', name: 'other' }] }] } };
    expect(run(s, { preview: clash })[0]).toMatchObject({ section: 'server', rowKey: 'temp', collision: true });
    const rej = { status: 'ok', data: { valid: false, error: 'tag "temp": payload context (ctx) is 2000 bytes' } };
    expect(run(s, { preview: rej })[0]).toMatchObject({ section: 'server', rowKey: 'temp' });
    expect(rowKeyFromMessage(s, 'source.overrides["temp"].scale must be')).toBe('temp');
  });
  it('context helpers', () => {
    const rows = contextRows({ a: 'x', n: 3, b: false });
    expect(rows.map((r) => r.type)).toEqual(['string', 'number', 'boolean']);
    expect(contextObject(rows)).toEqual({ a: 'x', n: 3, b: false });
    expect(contextErrors([{ id: '1', key: 'a', value: 'x'.repeat(300), type: 'string' }], { limits: { maxContextValueLength: 256 } })[0].message).toMatch(/300 characters/);
    expect(contextPlaceholders({ placeholders: { 'device-profile': ['{device}', '{param:<name>}'] } }, 'device-profile', { params: [{ name: 'line' }] })).toEqual(['{device}', '{param:line}']);
  });
});

describe('preview helpers', () => {
  it('focused draft previews one row with the same target', () => {
    const s = stateFromBinding({ id: 'f', source: { type: 'device', deviceId: 'd1', tags: 'all', select: { include: ['t*'] } }, target: { mode: 'mqtt', brokerId: 'b1', assetPath: 'a', contextMode: 'payload' } }, { brokers, tagDefs: DEVICE_TAGS });
    const d = focusDraft(s, s.rows[3]);
    expect(d.source.tags).toEqual(['press']);
    expect(d.target.contextMode).toBe('payload');
  });
});
