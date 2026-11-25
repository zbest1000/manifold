import { describe, it, expect } from 'vitest';
import {
  stateFromBinding, newState, buildMapping, withTagDefs, switchSelectMode, renameRow, setOv, computeTopics, validateMapping, mqttNames, defaultFilter, tagDefsFromSuggest, nameSlug, rowVerdict, focusDraft
} from '@/pages/tags/mappingModel';
import { shortLabels, pathLevels } from '@/pages/tags/tagPath';
import { orderedOptions, moveField, placeField } from '@/pages/tags/editor/FieldOrder';
import { healthFallback } from '@/pages/tags/bindingHealthView';

const brokers = [{ id: 'b1', name: 'Local' }];
const picked = (addrs) => addrs.map((a) => ({ id: a, address: a, name: a.split('/').pop(), meta: {} }));

describe('MQTT-topic sources are mappings', () => {
  it('picked topics: names below the common prefix, an asset path, the mqtt source shape', () => {
    const s = newState({ srcType: 'mqtt', ref: { brokerId: 'src' }, picked: picked(['raw/p1/l1/temp', 'raw/p1/l2/temp']), brokers });
    expect(s.rows.map((r) => r.name)).toEqual(['l1/temp', 'l2/temp']);
    const b = buildMapping({ ...s, form: { ...s.form, assetPath: 'acme/p1' } });
    expect(b.source).toEqual({ type: 'mqtt', brokerId: 'src', tags: [{ address: 'raw/p1/l1/temp', name: 'l1/temp' }, { address: 'raw/p1/l2/temp', name: 'l2/temp' }] });
    expect(b.target).toMatchObject({ mode: 'mqtt', brokerId: 'b1', assetPath: 'acme/p1', format: 'envelope' });
    // Names keep their levels: the topics nest under the asset path like the server's.
    expect(computeTopics({ ...s, form: { ...s.form, assetPath: 'acme/p1' } }).map((t) => t.topic)).toEqual(['acme/p1/l1/temp', 'acme/p1/l2/temp']);
  });

  it('mqttNames and defaultFilter', () => {
    expect([...mqttNames(['a/b/c']).values()]).toEqual(['c']);
    expect([...mqttNames(['a/x/t', 'b/y/t']).values()]).toEqual(['a/x/t', 'b/y/t']);
    expect(defaultFilter(['raw/p1/l1/temp', 'raw/p1/l2/temp'])).toBe('raw/p1/#');
    expect(defaultFilter(['a/b/c'])).toBe('a/b/#');
    expect(defaultFilter([])).toBe('#');
    expect(nameSlug('mqtt', 'l1 a/ temp ')).toBe('l1_a/temp');
    expect(nameSlug('device', 'l1/temp')).toBe('l1_temp');
  });

  it('round trip: field, staleAfterMs, per-tag overrides and unknown keys survive an untouched edit', () => {
    const stored = {
      id: 'm1', name: 'plant', enabled: true, extraKey: 1,
      source: { type: 'mqtt', brokerId: 'src', field: 'data.v', staleAfterMs: 30000, tags: [{ address: 'raw/a', name: 'a', field: 'x.y', staleAfterMs: 5000, unit: 'kW' }, { address: 'raw/b', name: 'b', enabled: false }] },
      target: { mode: 'mqtt', brokerId: 'b1', assetPath: 'uns/p', format: 'envelope', retain: false, qos: 0 },
      rbe: { heartbeatMs: 5000 }
    };
    expect(buildMapping(stateFromBinding(stored, { brokers }))).toEqual(stored);
  });

  it('filter mode: tags "all" + filter + include/exclude; topics from the server fold in; rules test topic and name', () => {
    const stored = { id: 'm2', name: 'f', enabled: true, source: { type: 'mqtt', brokerId: 'src', tags: 'all', filter: 'raw/#', select: { exclude: ['*spare*'] }, overrides: { 'raw/l1/temp': { name: 'temperature' } } }, target: { mode: 'mqtt', brokerId: 'b1', assetPath: 'uns/p', format: 'plain', retain: false, qos: 0 } };
    const s0 = stateFromBinding(stored, { brokers });
    expect(s0.tagsLoaded).toBe(false);
    const defs = tagDefsFromSuggest({ tags: [{ address: 'raw/l1/temp', suggestedName: 'l1/temp' }, { address: 'raw/l1/spare', suggestedName: 'l1/spare' }] });
    const s = withTagDefs(s0, defs);
    expect(s.rows.map((r) => [r.address, r.name])).toEqual([['raw/l1/temp', 'temperature'], ['raw/l1/spare', 'l1/spare']]);
    expect(rowVerdict(s, s.rows[1])).toMatchObject({ matched: false, rule: 'exclude' });
    expect(buildMapping(s)).toEqual(stored);
  });

  it('switching to a filter proposes one from the picked topics; back to a list keeps the matched rows', () => {
    const s = newState({ srcType: 'mqtt', ref: { brokerId: 'src' }, picked: picked(['raw/p1/a', 'raw/p1/b']), brokers });
    const r = switchSelectMode(s, 'rules', null);
    expect(r.ref.filter).toBe('raw/p1/#');
    expect(r.tagsLoaded).toBe(false);
    const filled = withTagDefs(r, [{ key: 'raw/p1/a', browseName: 'a' }, { key: 'raw/p1/c', browseName: 'c' }]);
    expect(buildMapping(filled).source).toMatchObject({ tags: 'all', filter: 'raw/p1/#' });
    const back = switchSelectMode(filled, 'list');
    expect(buildMapping(back).source.filter).toBeUndefined();
  });

  it('validation: filter required in filter mode, field paths, staleness bounds; renaming works', () => {
    let s = newState({ srcType: 'mqtt', ref: { brokerId: 'src' }, picked: picked(['raw/a']), brokers });
    s = { ...s, form: { ...s.form, assetPath: 'uns/p', srcField: 'a..b', staleAfterMs: '10' } };
    s = { ...s, rows: [setOv(renameRow(s.rows[0], 'alpha'), 'field', '.x')] };
    const msgs = validateMapping(s, { brokers }).map((e) => e.message).join(' | ');
    expect(msgs).toMatch(/Value field must be a dot path/);
    expect(msgs).toMatch(/Mark stale after/);
    expect(msgs).toMatch(/alpha: value field/);
    const rules = { ...switchSelectMode(s, 'rules', []), ref: { brokerId: 'src', filter: '' } };
    expect(validateMapping(rules, { brokers }).some((e) => e.field === 'filter')).toBe(true);
    expect(focusDraft(s, s.rows[0]).source.tags).toEqual([{ address: 'raw/a', name: 'alpha', field: '.x' }]);
  });
});

describe('disambiguating tag paths', () => {
  it('shows as many trailing levels as it takes, shortened from the start', () => {
    const m = shortLabels(['plant/l1/motor/temp', 'plant/l2/motor/temp', 'plant/l1/rpm']);
    expect(m.get('plant/l1/motor/temp')).toMatchObject({ label: 'l1/motor/temp', parent: 'l1/motor', shortened: true });
    expect(m.get('plant/l1/rpm')).toMatchObject({ label: 'rpm', parent: '', shortened: true });
    expect(pathLevels('ns=2;s=Line1.Motor.Temp')).toEqual(['Line1', 'Motor', 'Temp']);
    expect(shortLabels(['temp']).get('temp')).toMatchObject({ label: 'temp', parent: '', shortened: false });
  });
});

describe('payload field order', () => {
  it('published first in order, moves, drops', () => {
    expect(orderedOptions(['v', 't', 'q', 'u'], ['q', 'v'])).toEqual(['q', 'v', 't', 'u']);
    expect(moveField(['v', 't', 'q'], 'q', -1)).toEqual(['v', 'q', 't']);
    expect(moveField(['v', 't'], 'v', -1)).toEqual(['v', 't']);
    expect(placeField(['v', 't', 'q'], 'q', 'v')).toEqual(['q', 'v', 't']);
  });
});

describe('mapping health', () => {
  it('uses the server diagnosis, else derives one from the status', () => {
    const b = { id: 'x', enabled: true };
    expect(healthFallback(b, {}, { x: { state: 'source-missing', reasons: [] } }).state).toBe('source-missing');
    expect(healthFallback(b, { x: { lastError: 'boom' } }, {}).state).toBe('problem');
    expect(healthFallback({ ...b, enabled: false }, {}, {}).state).toBe('disabled');
    expect(healthFallback(b, { x: { sourceState: { state: 'online' } } }, {}).state).toBe('publishing');
  });
});
