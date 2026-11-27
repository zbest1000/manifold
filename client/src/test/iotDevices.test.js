import { describe, it, expect } from 'vitest';
import {
  availabilityView, qualityView, formatIotValue, tagLimits, filterDevices, draftFromConfig, configFromDraft, optionProblem, mapLink, tagDefsFromIot, iotSummary, conventionLabel, enabledConventions, defaultDetectionBroker
} from '@/pages/devices/iotModel';
import { bindingSourceId, buildBoundIndex, boundFor, parseSourceParam, groupSources } from '@/pages/tags/helpers';
import { newState, buildMapping, withTagDefs, supportsRules, supportsOverrides } from '@/pages/tags/mappingModel';

const dev = (o = {}) => ({ id: 'z2m:0x01', sourceId: 'bk|z2m:0x01', brokerId: 'bk', brokerName: 'Home', name: 'living_room/climate', convention: 'zigbee2mqtt', manufacturer: 'Aqara', model: 'WSDCGQ11LM', availability: 'online', tagCount: 5, ...o });

describe('Detection panel', () => {
  const conv = [{ id: 'zigbee2mqtt', label: 'Zigbee2MQTT' }, { id: 'homeassistant', label: 'Home Assistant MQTT discovery' }];
  const plain = { id: 'plant', conventions: conv, config: { conventions: {} } };
  const suggested = { id: 'lab', conventions: conv, config: { conventions: {} }, suggestions: [{ convention: 'zigbee2mqtt', topic: 'zigbee2mqtt/bridge/devices' }] };
  const on = { id: 'fac', conventions: conv, config: { conventions: { homeassistant: { enabled: true }, zigbee2mqtt: { enabled: false } } } };
  it('lists the conventions that are on, in the server order', () => {
    expect(enabledConventions(on)).toEqual([{ id: 'homeassistant', label: 'Home Assistant MQTT discovery' }]);
    expect(enabledConventions(plain)).toEqual([]);
    expect(enabledConventions(null)).toEqual([]);
  });
  it('opens on the broker with detection on, else one with suggestions, else the first', () => {
    expect(defaultDetectionBroker([plain, suggested, on])).toBe('fac');
    expect(defaultDetectionBroker([plain, suggested])).toBe('lab');
    expect(defaultDetectionBroker([plain])).toBe('plant');
    expect(defaultDetectionBroker([])).toBe(null);
  });
});

describe('IoT device display helpers', () => {
  it('availability and quality map to tones and words', () => {
    expect(availabilityView('online')).toEqual({ tone: 'good', label: 'Online' });
    expect(availabilityView('offline').tone).toBe('bad');
    expect(availabilityView('unknown').label).toBe('Unknown');
    expect(qualityView(192).label).toBe('Good');
    expect(qualityView(64).label).toBe('Uncertain');
    expect(qualityView(0).label).toBe('Bad');
    expect(qualityView(null).label).toBe('No value');
  });
  it('values, ranges and enums render compactly', () => {
    expect(formatIotValue(21.123456789)).toBe('21.123457');
    expect(formatIotValue(true)).toBe('true');
    expect(formatIotValue(null)).toBe('—');
    expect(formatIotValue({ x: 'y'.repeat(200) }).endsWith('...')).toBe(true);
    expect(tagLimits({ range: { min: 0, max: 254 } })).toBe('0 to 254');
    expect(tagLimits({ enum: ['a', 'b', 'c', 'd', 'e', 'f'] })).toBe('a, b, c, d +2');
    expect(tagLimits({})).toBe('');
    expect(conventionLabel('homeassistant')).toBe('HA discovery');
  });
  it('filters by text, convention, broker and availability; summarises', () => {
    const list = [dev(), dev({ id: 'ha:x', sourceId: 'bk|ha:x', name: 'Garage', convention: 'homeassistant', availability: 'offline', manufacturer: null, model: null }), dev({ id: 'shelly:a', sourceId: 'b2|shelly:a', brokerId: 'b2', name: 'Plug', convention: 'shelly', manufacturer: 'Shelly', model: 'Plus' })];
    expect(filterDevices(list, { text: 'aqara' }).map((d) => d.id)).toEqual(['z2m:0x01']);
    expect(filterDevices(list, { convention: 'homeassistant' })).toHaveLength(1);
    expect(filterDevices(list, { brokerId: 'b2' }).map((d) => d.id)).toEqual(['shelly:a']);
    expect(filterDevices(list, { availability: 'offline' }).map((d) => d.id)).toEqual(['ha:x']);
    expect(iotSummary(list)).toBe('3 devices on 2 brokers, 1 offline');
    expect(iotSummary([])).toBe('No IoT devices yet');
  });
  it('detection config round trip trims options and drops empty ones', () => {
    const draft = draftFromConfig({ conventions: { zigbee2mqtt: { enabled: true, baseTopic: ' home/zb ' }, tasmota: { enabled: false, fullTopic: '', discoveryPrefix: 'tasmota/discovery' } } });
    expect(configFromDraft(draft)).toEqual({ conventions: { zigbee2mqtt: { enabled: true, baseTopic: 'home/zb' }, tasmota: { enabled: false, discoveryPrefix: 'tasmota/discovery' } } });
    expect(optionProblem('zigbee2mqtt', 'baseTopic', 'a/#')).toMatch(/wildcards/);
    expect(optionProblem('tasmota', 'fullTopic', '%prefix%/x/')).toMatch(/%topic%/);
    expect(optionProblem('shelly', 'gen1Prefix', 'a/b')).toMatch(/single/);
    expect(optionProblem('zwavejs', 'prefix', 'zwave')).toBe('');
  });
  it('links to the Tags workspace with an iot source the page understands', () => {
    const link = mapLink(dev());
    expect(link).toBe('/tags?source=iot%3Abk%7Cz2m%3A0x01');
    const param = decodeURIComponent(link.split('=')[1]);
    expect(parseSourceParam(param)).toEqual({ type: 'iot', id: 'bk|z2m:0x01' });
  });
});

describe('IoT devices in the Tags workspace and the mapping editor', () => {
  it('bound index and source ids use broker|device', () => {
    const b = { id: 'm1', name: 'plug', source: { type: 'iot', brokerId: 'bk', deviceId: 'z2m:0x01', tags: [{ address: 'power', name: 'Power' }] }, target: { mode: 'mqtt', pathTemplate: 'uns/{name}' } };
    expect(bindingSourceId(b.source)).toBe('bk|z2m:0x01');
    const idx = buildBoundIndex([b]);
    expect(boundFor(idx, { type: 'iot', id: 'bk|z2m:0x01' }, { kind: 'tag', address: 'power' })).toHaveLength(1);
    expect(boundFor(idx, { type: 'iot', id: 'bk|z2m:0x02' }, { kind: 'tag', address: 'power' })).toEqual([]);
    const groups = groupSources([{ type: 'iot', id: 'bk|x', label: 'X' }]);
    expect(groups.find((g) => g.type === 'iot').items).toHaveLength(1);
  });
  it('a new mapping from an IoT device carries the convention metadata and builds an iot source', () => {
    expect(supportsRules('iot')).toBe(true);
    expect(supportsOverrides('iot')).toBe(true);
    const defs = tagDefsFromIot([{ key: 'temperature', name: 'Temperature', type: 'float64', unit: '°C', description: 'Measured', range: { min: -40, max: 85 } }, { key: 'x', name: 'X', type: 'unknown' }]);
    expect(defs[0]).toEqual({ key: 'temperature', property: 'Temperature', type: 'float64', unit: '°C', description: 'Measured', range: { min: -40, max: 85 } });
    expect(defs[1].type).toBeUndefined();
    let s = newState({ srcType: 'iot', ref: { brokerId: 'bk', deviceId: 'z2m:0x01' }, picked: [{ id: 'temperature', address: 'temperature', name: 'Temperature', meta: {} }], brokers: [{ id: 'bk' }] });
    s = withTagDefs(s, defs);
    s = { ...s, form: { ...s.form, assetPath: 'uns/home/climate' } };
    const body = buildMapping(s);
    expect(body.source.type).toBe('iot');
    expect(body.source.brokerId).toBe('bk');
    expect(body.source.deviceId).toBe('z2m:0x01');
    expect([body.source.tags[0]].flat().map((t) => (typeof t === 'string' ? t : t.address))).toEqual(['temperature']);
    expect(s.rows[0].def.unit).toBe('°C');
    // rules mode: every device tag, tags: "all"
    const r = withTagDefs(newState({ srcType: 'iot', ref: { brokerId: 'bk', deviceId: 'z2m:0x01' }, selectMode: 'rules', brokers: [{ id: 'bk' }] }), defs);
    expect(r.rows).toHaveLength(2);
    expect(buildMapping(r).source.tags).toBe('all');
  });
});
