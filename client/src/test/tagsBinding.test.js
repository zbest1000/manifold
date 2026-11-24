import { describe, it, expect } from 'vitest';
import {
  formFromBinding, buildBinding, buildRbe, buildTarget, rowsFromBinding, rowsFromSelection, rowsFromProfile, profileRowsFor, renameRow
} from '@/pages/tags/bindingForm';
import { visibleRows, validateAssetPath, validateAssetTemplate, normalizeAssetPath, bindingAssetPath, parentPath } from '@/pages/tags/assetPath';
import { instanceRows, allowedPlaceholders, substituteTemplate, cleanOverrides } from '@/pages/tags/profileModel';
import { blockingCollisions, matchEntries, sizeSummary, generalWarnings, buildItems, fmtBytes, unitTypeLabel } from '@/pages/tags/previewModel';
import { validateWizard } from '@/pages/tags/wizardModel';
import { layoutLabel, rbeLabel, instanceCount, detailFacts, historianReason } from '@/pages/tags/bindingView';

const brokers = [{ id: 'b1', name: 'Local' }];

// Build the request body the wizard would send for a stored binding, with nothing changed.
const roundTrip = (b, metaByAddress = {}, profile = null) => {
  const srcType = b.source.type;
  const form = formFromBinding(b, { brokers, srcType });
  let rows;
  let allTags = false;
  if (srcType === 'device-profile') {
    const r = profileRowsFor(profile, b);
    rows = r.rows.filter((x) => r.selected.has(x.key));
    allTags = r.selected.size === r.rows.length;
  } else rows = rowsFromBinding(b, metaByAddress);
  allTags = allTags || b.source.tags === 'all';
  return buildBinding({ name: b.name, mode: b.target.mode, form, rows, srcType, editing: b, allTags, profileId: b.source.profileId });
};

describe('asset paths', () => {
  it('mirrors the server rules', () => {
    expect(validateAssetPath('acme/dallas/line4')).toBeNull();
    expect(validateAssetPath('')).toMatch(/required/);
    expect(validateAssetPath('a//b')).toMatch(/empty segment/);
    expect(validateAssetPath('/a')).toMatch(/empty segment/);
    expect(validateAssetPath('a/+/b')).toMatch(/wildcard/);
    expect(validateAssetPath('a/#')).toMatch(/wildcard/);
    expect(validateAssetPath('$SYS/x')).toMatch(/\$/);
    expect(validateAssetPath('a/{name}')).toMatch(/placeholders/);
  });
  it('normalizes trailing slashes and whitespace', () => {
    expect(normalizeAssetPath('  acme/line4// ')).toBe('acme/line4');
    expect(parentPath('a/b/c')).toBe('a/b');
    expect(parentPath('a')).toBe('');
  });
  it('validates templates against the allowed placeholders', () => {
    const allowed = new Set(['device', 'deviceId', 'line']);
    expect(validateAssetTemplate('acme/{line}/{device}', allowed)).toBeNull();
    expect(validateAssetTemplate('acme/{nope}', allowed)).toMatch(/Unknown placeholder/);
    expect(validateAssetTemplate('', allowed)).toMatch(/Enter/);
    expect(validateAssetTemplate('acme//{device}', allowed)).toMatch(/empty segment/);
  });
  it('bindingAssetPath covers each stored shape', () => {
    expect(bindingAssetPath({ target: { mode: 'mqtt', assetPath: 'a/b' } })).toBe('a/b');
    expect(bindingAssetPath({ target: { mode: 'mqtt', assetPathTemplate: 'a/{device}' } })).toBe('a/{device}');
    expect(bindingAssetPath({ target: { mode: 'mqtt', pathTemplate: 'site/area/{name}' } })).toBe('site/area');
    expect(bindingAssetPath({ target: { mode: 'sparkplug' } })).toBe('');
  });
});

describe('form <-> binding round trip', () => {
  const metas = { kw: { property: 'activePower', unit: 'kW', type: 'float32' }, '40012': { type: 'uint16' } };

  it('legacy pathTemplate binding keeps its template and drops no field', () => {
    const b = {
      id: 'l1', name: 'old', enabled: true,
      source: { type: 'device', deviceId: 'd1', tags: [{ address: 'kw', name: 'activePower' }] },
      target: { mode: 'mqtt', brokerId: 'b1', pathTemplate: 'site/area/{name}', format: 'envelope', retain: true, qos: 1 }
    };
    expect(formFromBinding(b, { brokers }).destKind).toBe('template');
    expect(roundTrip(b, metas)).toEqual(b);
  });
  it('assetPath binding', () => {
    const b = {
      id: 'a1', name: 'filler', enabled: true,
      source: { type: 'device', deviceId: 'd1', tags: ['kw'] },
      target: { mode: 'mqtt', brokerId: 'b1', assetPath: 'acme/dallas/line4/filler', format: 'plain', retain: false, qos: 0 }
    };
    expect(formFromBinding(b, { brokers }).destKind).toBe('asset');
    expect(roundTrip(b, metas)).toEqual(b);
  });
  it('object layout with size cap, rbe, historian and opt-outs', () => {
    const b = {
      id: 'o1', name: 'obj', enabled: true,
      source: { type: 'device', deviceId: 'd1', tags: ['kw'] },
      target: {
        mode: 'mqtt', brokerId: 'b1', assetPath: 'a/b', layout: 'object-per-asset', maxObjectBytes: 2048, format: 'envelope',
        retain: false, qos: 0, statusTopic: false, metaTopic: false, historian: { historianId: 'h1' }
      },
      rbe: { heartbeatMs: 60000, deadband: { type: 'percent', value: 2 } }
    };
    expect(roundTrip(b, metas)).toEqual(b);
  });
  it('device-profile binding with template and overrides; tags all', () => {
    const profile = { id: 'p1', params: [{ name: 'line' }], tags: [{ key: 'kw', property: 'activePower', unit: 'kW', type: 'float32' }, { key: 'pf', type: 'float32' }] };
    const b = {
      id: 'p1b', name: 'meters', enabled: true,
      source: { type: 'device-profile', profileId: 'p1', tags: 'all' },
      target: { mode: 'mqtt', brokerId: 'b1', assetPathTemplate: 'acme/{line}/{device}', assetPaths: { d9: 'special/meter' }, format: 'envelope', retain: false, qos: 0 }
    };
    expect(roundTrip(b, {}, profile)).toEqual(b);
    const subset = { ...b, source: { type: 'device-profile', profileId: 'p1', tags: ['kw'] } };
    expect(roundTrip(subset, {}, profile)).toEqual(subset);
  });
  it('keeps explicit names of profile tags and unknown target fields', () => {
    const profile = { id: 'p1', params: [], tags: [{ key: 'kw', property: 'activePower' }] };
    const b = {
      id: 'x', enabled: true, name: null,
      source: { type: 'device-profile', profileId: 'p1', tags: [{ address: 'kw', name: 'power' }] },
      target: { mode: 'mqtt', brokerId: 'b1', assetPathTemplate: 'a/{device}', format: 'plain', retain: false, qos: 0, futureField: 7 }
    };
    expect(roundTrip(b, {}, profile)).toEqual(b);
  });
  it('legacy numeric deadband becomes rbe.deadband absolute', () => {
    const b = {
      id: 'd', enabled: true, name: null,
      source: { type: 'opcua', connectionId: 'c', tags: [{ address: 'ns=2;s=A', name: 'a' }], samplingInterval: 500 },
      target: { mode: 'mqtt', brokerId: 'b1', pathTemplate: 'u/{name}', deadband: 0.5, format: 'plain', retain: false, qos: 0 }
    };
    const out = roundTrip(b);
    expect(out.rbe).toEqual({ deadband: { type: 'absolute', value: 0.5 } });
    expect(out.target.deadband).toBeUndefined();
    expect(out.source.samplingInterval).toBe(500);
  });
  it('sparkplug target', () => {
    const b = {
      id: 's', enabled: true, name: 'sp',
      source: { type: 'device', deviceId: 'd1', tags: ['kw'] },
      target: { mode: 'sparkplug', brokerId: 'b1', group: 'G', edge: 'E', device: 'D' }
    };
    expect(roundTrip(b, metas)).toEqual(b);
  });
});

describe('names: only edited names are sent', () => {
  const sel = new Map([['kw', { id: 'kw', address: 'kw', name: 'activePower', meta: { property: 'activePower', unit: 'kW', type: 'float32' } }],
    ['40012', { id: '40012', address: '40012', name: '40012', meta: { type: 'uint16' } }]]);
  const rows = rowsFromSelection(sel, 'device');
  const base = (rs) => buildBinding({ mode: 'mqtt', form: formFromBinding(null, { brokers, srcType: 'device' }), rows: rs, srcType: 'device', source: { id: 'd1' } });
  it('defaults to the property and falls back to the key', () => {
    expect(rows.map((r) => r.name)).toEqual(['activePower', '40012']);
    expect(base(rows).source.tags).toEqual(['kw', '40012']);
  });
  it('sends a name once the user edits it, and not when edited back', () => {
    const edited = rows.map((r) => (r.address === '40012' ? renameRow(r, 'speed') : r));
    expect(base(edited).source.tags).toEqual(['kw', { address: '40012', name: 'speed' }]);
    const back = edited.map((r) => renameRow(r, r.defaultName));
    expect(base(back).source.tags).toEqual(['kw', '40012']);
  });
  it('opcua always sends names', () => {
    const r = rowsFromSelection(new Map([['n', { id: 'n', address: 'ns=2;s=A', name: 'A', meta: {} }]]), 'opcua');
    const b = buildBinding({ mode: 'mqtt', form: formFromBinding(null, { brokers, srcType: 'opcua' }), rows: r, srcType: 'opcua', source: { id: 'c1' } });
    expect(b.source.tags).toEqual([{ address: 'ns=2;s=A', name: 'A' }]);
  });
});

describe('request details', () => {
  it('buildRbe', () => {
    const f = (o) => ({ ...formFromBinding(null, { brokers }), ...o });
    expect(buildRbe(f({}))).toBeUndefined();
    expect(buildRbe(f({ dbType: 'percent', dbValue: '2', heartbeatMs: '5000' }))).toEqual({ heartbeatMs: 5000, deadband: { type: 'percent', value: 2 } });
    expect(buildRbe(f({ dbValue: '0' }))).toBeUndefined();
  });
  it('new bindings default to asset path + envelope; topic-per-tag sends no layout', () => {
    const f = formFromBinding(null, { brokers, srcType: 'device' });
    expect(f.destKind).toBe('asset');
    const t = buildTarget({ mode: 'mqtt', form: { ...f, assetPath: ' acme/line4/ ' }, srcType: 'device' });
    expect(t).toMatchObject({ assetPath: 'acme/line4', format: 'envelope' });
    expect(t.layout).toBeUndefined();
  });
  it('profile overrides: empty and unknown instances are dropped when instances are known', () => {
    expect(cleanOverrides({ a: ' x/y/ ', b: '', zz: 'q' }, [{ id: 'a' }, { id: 'b' }])).toEqual({ a: 'x/y' });
    expect(cleanOverrides({ zz: 'q' }, null)).toEqual({ zz: 'q' });
  });
  it('rowsFromProfile names tags by property', () => {
    const r = rowsFromProfile({ tags: [{ key: 'kw', property: 'activePower', unit: 'kW' }, { key: 'x' }] });
    expect(r.map((x) => x.name)).toEqual(['activePower', 'x']);
    expect(unitTypeLabel(r[0].meta)).toBe('kW');
  });
});

describe('profile instances', () => {
  const profile = { id: 'p', params: [{ name: 'line' }, { name: 'zone', default: 'z1' }] };
  const devices = [
    { id: 'd2', name: 'Meter B', profileId: 'p', params: { line: 'l 2' } },
    { id: 'd1', name: 'Meter A', profileId: 'p', params: { line: 'l1', zone: 'z9' } },
    { id: 'other', name: 'X', profileId: 'q' }
  ];
  it('lists placeholders and substitutes with slugging, defaults and sorted ids', () => {
    expect([...allowedPlaceholders(profile)]).toEqual(['device', 'deviceId', 'line', 'zone']);
    const rows = instanceRows({ profile, devices, template: 'acme/{line}/{zone}/{device}' });
    expect(rows.map((r) => [r.deviceId, r.path])).toEqual([['d1', 'acme/l1/z9/Meter_A'], ['d2', 'acme/l_2/z1/Meter_B']]);
    expect(rows.every((r) => !r.error)).toBe(true);
  });
  it('overrides win, and bad paths report an error', () => {
    const rows = instanceRows({ profile, devices, template: 'a/{device}', overrides: { d1: 'special/one' } });
    expect(rows[0]).toMatchObject({ path: 'special/one', overridden: true });
    expect(instanceRows({ profile, devices, template: 'a/{nope}' })[0].error).toMatch(/no value for \{nope\}/);
    expect(instanceRows({ profile, devices, template: 'a//{device}' })[0].error).toMatch(/empty segment/);
    expect(substituteTemplate('{deviceId}', { deviceId: 'a b' })).toBe('a_b');
  });
});

describe('server preview model', () => {
  const data = {
    valid: true, layout: 'topic-per-tag', units: 2, totalTags: 4, truncated: false, unitErrors: [],
    tags: [
      { name: 'activePower', address: 'kw', unitId: 'u#1', hasValue: true, topic: 'a/m1/activePower', payload: { v: 1, t: 2, q: 192 } },
      { name: 'DB10.DBD4', address: 'pf', unitId: 'u#1', hasValue: false, topic: 'a/m1/DB10.DBD4', payload: { v: null, t: 2, q: 0 }, collisions: [{ id: 'x', name: 'other' }] },
      { name: 'activePower', address: 'kw', unitId: 'u#2', hasValue: true, topic: 'a/m2/activePower', payload: 1 }
    ],
    objects: [], meta: [], status: ['a/m1/_status'],
    warnings: [
      { type: 'raw-address', topic: 'a/m1/DB10.DBD4', name: 'DB10.DBD4', message: 'raw' },
      { type: 'collision', topic: 'a/m1/DB10.DBD4', bindings: [{ id: 'x', name: 'other' }], message: 'c' },
      { type: 'collision', topic: 'a/m9/beyond-first-50', bindings: [{ id: 'y' }], message: 'c2' },
      { type: 'asset-path', topic: null, message: 'bad asset' }
    ]
  };
  it('collects blocking collisions from warnings (beyond the first 50 tags) and entries, deduplicated', () => {
    expect(blockingCollisions(data).map((c) => c.topic)).toEqual(['a/m1/DB10.DBD4', 'a/m9/beyond-first-50']);
    expect(blockingCollisions(null)).toEqual([]);
  });
  it('matches rows by address, and by position for profile bindings (first unit)', () => {
    const rows = [{ key: 'r1', address: 'kw' }, { key: 'r2', address: 'pf' }];
    expect(matchEntries(rows, data, false).get('r2').entry.topic).toBe('a/m1/DB10.DBD4');
    expect(matchEntries(rows, data, false).get('r2').rawAddress.message).toBe('raw');
    const m = matchEntries([{ key: 'p1', address: 'kw{x}' }, { key: 'p2', address: 'pf{x}' }], data, true);
    expect(m.get('p1').entry.topic).toBe('a/m1/activePower');
    expect(m.get('p2').entry.topic).toBe('a/m1/DB10.DBD4');
  });
  it('buildItems flags the raw name and clash on the right row', () => {
    const rows = [{ key: 'r1', address: 'kw', name: 'activePower', meta: {} }, { key: 'r2', address: 'pf', name: 'DB10.DBD4', meta: {} }];
    const items = buildItems({ rows, resolved: [], data, isProfile: false, selfClash: new Set() });
    expect(items[0].rawAddress).toBeNull();
    expect(items[1].rawAddress).toBeTruthy();
    expect(items[1].clashOthers[0].name).toBe('other');
  });
  it('buildItems falls back to client-side checks when there is no server data', () => {
    const rows = [{ key: 'r1', address: 'x', name: 'DB1.DBD0', meta: {} }];
    const resolved = [{ key: 'r1', topic: 'a/DB1.DBD0', warnings: [] }];
    const [it1] = buildItems({ rows, resolved, data: null, isProfile: false, selfClash: new Set(['r1']) });
    expect(it1.rawAddress).toBeTruthy();
    expect(it1.clashSelf).toBe(true);
    expect(it1.fallbackTopic).toBe('a/DB1.DBD0');
  });
  it('general warnings and size summary', () => {
    expect(generalWarnings({ ...data, unitErrors: [{ unitId: 'b#d1', error: 'oops' }] }).map((w) => w.message)).toEqual(['bad asset', 'd1: oops']);
    const obj = { layout: 'object-per-asset', objects: [{ bytes: 100, worstCaseBytes: 1000, capBytes: 65536 }, { bytes: 90, worstCaseBytes: 3000, capBytes: 65536 }] };
    expect(sizeSummary(obj)).toMatchObject({ worstCaseBytes: 3000, units: 2 });
    expect(sizeSummary(data)).toBeNull();
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(65536)).toBe('64 KB');
  });
});

describe('wizard validation', () => {
  const rows = [{ key: 'r1', address: 'kw', name: 'power', defaultName: 'power', explicit: false, meta: {} }];
  const form = (o) => ({ ...formFromBinding(null, { brokers, srcType: 'device' }), assetPath: 'acme/line4', ...o });
  const run = (o = {}) => validateWizard({ srcType: 'device', mode: 'mqtt', form: form(), rows, brokers, ...o });
  it('accepts a valid asset-path binding', () => {
    expect(run().errors).toEqual([]);
  });
  it('blocks an invalid asset path on step 0 (dest field)', () => {
    const e = run({ form: form({ assetPath: 'a//b' }) }).errors;
    expect(e[0]).toMatchObject({ step: 0, field: 'dest' });
  });
  it('blocks collisions with other bindings and the server rejection', () => {
    const clash = { status: 'ok', data: { valid: true, tags: [], objects: [], warnings: [{ type: 'collision', topic: 'acme/line4/power', bindings: [{ id: 'b0', name: 'first' }] }] } };
    const e = run({ preview: clash }).errors;
    expect(e[0].step).toBe(1);
    expect(e[0].message).toMatch(/already published by another binding \(acme\/line4\/power by first\)/);
    const rejected = run({ preview: { status: 'ok', data: { valid: false, error: 'payload could reach 99999 bytes' } } }).errors;
    expect(rejected[0].message).toMatch(/99999 bytes/);
  });
  it('detects duplicates within one binding after slugging', () => {
    const dup = [...rows, { ...rows[0], key: 'r2', address: 'pf', name: 'power' }];
    expect(run({ rows: dup }).errors[0].message).toMatch(/same topic/);
  });
  it('profile binding needs a valid template and instances resolve', () => {
    const profile = { id: 'p', params: [{ name: 'line' }] };
    const devices = [{ id: 'd1', name: 'A', profileId: 'p', params: { line: 'l1' } }];
    const f = formFromBinding(null, { brokers, srcType: 'device-profile' });
    const bad = validateWizard({ srcType: 'device-profile', mode: 'mqtt', form: { ...f, assetPathTemplate: 'a/{zzz}' }, rows, brokers, profile, devices });
    expect(bad.errors[0].message).toMatch(/Unknown placeholder/);
    const ok = validateWizard({ srcType: 'device-profile', mode: 'mqtt', form: { ...f, assetPathTemplate: 'a/{line}/{device}' }, rows, brokers, profile, devices });
    expect(ok.errors).toEqual([]);
  });
  it('checks deadband, heartbeat and object size', () => {
    expect(run({ form: form({ dbType: 'percent', dbValue: '150' }) }).errors[0].message).toMatch(/0 and 100/);
    expect(run({ form: form({ heartbeatMs: '500' }) }).errors[0].message).toMatch(/1000/);
    expect(run({ form: form({ layout: 'object-per-asset', maxObjectBytes: '10' }) }).errors[0].message).toMatch(/1024/);
    expect(run({ form: form({ layout: 'object-per-asset', maxObjectBytes: '4096' }) }).errors).toEqual([]);
  });
});

describe('binding view helpers', () => {
  const b = {
    source: { type: 'device-profile', profileId: 'p' },
    target: { mode: 'mqtt', layout: 'object-per-asset', historian: { historianId: 'h' }, format: 'envelope', maxObjectBytes: 4096 },
    rbe: { heartbeatMs: 60000, deadband: { type: 'percent', value: 2 } }
  };
  it('labels', () => {
    expect(layoutLabel(b)).toBe('Object per asset');
    expect(layoutLabel({ target: { mode: 'mqtt' } })).toBe('Topic per tag');
    expect(rbeLabel(b)).toBe('2%, hb 60 s');
    expect(rbeLabel({ target: { deadband: 1 } })).toBe('1 abs');
    expect(rbeLabel({ target: {} })).toBe('');
  });
  it('instance count and facts', () => {
    const profiles = [{ id: 'p', name: 'Meters', instances: [{ id: 'a' }, { id: 'b' }] }];
    expect(instanceCount(b, profiles)).toBe(2);
    expect(instanceCount({ source: { type: 'device' } }, profiles)).toBeNull();
    const facts = Object.fromEntries(detailFacts(b, { profiles, historians: [{ id: 'h', name: 'TS', type: 'timescaledb' }] }));
    expect(facts.History).toBe('TS (timescaledb)');
    expect(facts.Profile).toBe('Meters - 2 instance(s)');
    expect(facts['Max object size']).toBe('4096 bytes');
  });
  it('historian eligibility', () => {
    expect(historianReason({ type: 'timebase' })).toBeNull();
    expect(historianReason({ type: 'timescaledb' })).toBeNull();
    expect(historianReason({ type: 'influxdb' })).toMatch(/does not store quality/);
  });
});

describe('asset picker tree', () => {
  it('flattens only expanded branches, in order, with levels', () => {
    const kids = new Map([
      ['', [{ segment: 'acme', path: 'acme' }, { segment: 'zed', path: 'zed' }]],
      ['acme', [{ segment: 'dallas', path: 'acme/dallas' }]]
    ]);
    expect(visibleRows(kids, new Set()).map((r) => r.path)).toEqual(['acme', 'zed']);
    expect(visibleRows(kids, new Set(['acme'])).map((r) => [r.path, r.level])).toEqual([['acme', 1], ['acme/dallas', 2], ['zed', 1]]);
  });
});
