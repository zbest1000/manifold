import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import {
  placeholders, substitute, resolveParams, expandProfileTags, previewInstance, undeclaredPlaceholders, unusedParams, expandForValidation, cleanParams, paramDeclErrors, paramDefaults
} from '@/lib/deviceProfiles';
import { placeholderRowErrors, splitProfileErrors, mergeGroups, profileFromDevice, toProfilePayload, blankProfile } from '@/pages/devices/profileModel';

const profile = {
  id: 'p1',
  name: 'Meter',
  protocol: 'modbus-tcp',
  params: [{ name: 'base', default: 100 }, { name: 'phase' }],
  tags: [
    { key: 'v_{phase}', address: 'holding:{base}', type: 'float32', property: 'voltage{phase}' },
    { key: 'freq', address: 'holding:{base}', type: 'uint16' }
  ]
};

describe('placeholders and substitution', () => {
  it('finds names in order', () => {
    expect([...placeholders('{a}.{b}{a}')]).toEqual(['a', 'b']);
    expect([...placeholders('no braces {1x} {}')]).toEqual([]);
    expect(placeholders(undefined).size).toBe(0);
  });
  it('replaces and throws on a missing value like the server', () => {
    expect(substitute('holding:{base}', { base: 5 })).toBe('holding:5');
    expect(substitute('x{b}y{b}', { b: 'Q' })).toBe('xQyQ');
    expect(() => substitute('{nope}', {})).toThrow('no value for parameter {nope}');
    expect(substitute(7, {})).toBe(7);
  });
});

describe('resolveParams', () => {
  it('applies defaults and requires params without one', () => {
    expect(resolveParams(profile, { phase: 'A' })).toEqual({ values: { base: 100, phase: 'A' }, errors: [] });
    expect(resolveParams(profile, {}).errors).toEqual(['parameter "phase" is required']);
    expect(resolveParams(profile, { phase: '' }).errors).toEqual(['parameter "phase" is required']);
  });
  it('flags unknown parameters and bad types', () => {
    expect(resolveParams(profile, { phase: 'A', zzz: 1 }).errors[0]).toContain('unknown parameter "zzz"');
    expect(resolveParams(profile, { phase: { x: 1 } }).errors[0]).toContain('must be a string or number');
  });
});

describe('expansion and preview', () => {
  it('substitutes key, address and property and marks the origin', () => {
    const { tags, errors } = expandProfileTags(profile, { base: 200, phase: 'B' });
    expect(errors).toEqual([]);
    expect(tags[0]).toMatchObject({ key: 'v_B', address: 'holding:200', property: 'voltageB', origin: 'profile', _from: 'v_{phase}' });
    expect(tags[1].key).toBe('freq');
  });
  it('previews with defaults and reports a missing parameter without expanding', () => {
    expect(previewInstance(profile, { phase: 'C' }).tags.map((t) => t.address)).toEqual(['holding:100', 'holding:100']);
    const bad = previewInstance(profile, {});
    expect(bad.tags).toEqual([]);
    expect(bad.errors[0].error).toContain('"phase" is required');
  });
  it('reports duplicate effective keys and clashes with own tags', () => {
    const dup = { ...profile, params: [{ name: 'p', default: 'x' }], tags: [{ key: 'a{p}', address: '1' }, { key: 'a{p}', address: '2' }] };
    expect(previewInstance(dup, {}).errors.some((e) => /duplicate key/.test(e.error))).toBe(true);
    expect(previewInstance(profile, { phase: 'A' }, [{ key: 'freq' }]).errors[0].error).toContain('conflicts');
  });
  it('lists undeclared and unused placeholders', () => {
    expect(undeclaredPlaceholders([{ key: 'a{x}', address: '{y}' }, { key: 'ok', address: '1' }], [{ name: 'y' }])).toEqual([{ key: 'a{x}', names: ['x'] }]);
    expect(unusedParams(profile.tags, [{ name: 'base' }, { name: 'extra' }])).toEqual(['extra']);
    expect(placeholderRowErrors([{ key: 'ok' }, { key: 'a{x}', address: '1' }], [])).toEqual({ 1: expect.stringContaining('{x}') });
  });
});

describe('editor helpers', () => {
  it('validates tags with defaults and skips those needing a value', () => {
    const r = expandForValidation(profile.tags, profile.params);
    expect(r.list.map((t) => t.key)).toEqual(['freq']); // only needs {base}, which has a default
    expect(r.skipped).toEqual(['v_{phase}']); // {phase} has no default
    const ok = expandForValidation(profile.tags, [{ name: 'base', default: 7 }, { name: 'phase', default: 'A' }]);
    expect(ok.list.map((t) => t.key)).toEqual(['v_A', 'freq']);
    expect(ok.keyMap).toEqual({ v_A: 'v_{phase}', freq: 'freq' });
    expect(paramDefaults([{ name: 'a', default: '' }, { name: 'b', default: 0 }])).toEqual({ b: 0 });
  });
  it('cleans and checks param declarations', () => {
    expect(cleanParams([{ name: ' base ', default: '', description: ' d ' }, { name: '' }])).toEqual([{ name: 'base', description: 'd' }]);
    expect(paramDeclErrors([{ name: 'a' }, { name: 'a' }, { name: '1x' }])).toEqual({ 1: 'Duplicate parameter name', 2: expect.stringContaining('letters') });
  });
  it('splits profile save errors into per-instance and per-tag', () => {
    const d = [{ deviceId: 'd1', name: 'M1', error: 'x', details: [{ key: 'k', error: 'bad' }] }, { key: 'k', error: 'bad' }];
    expect(splitProfileErrors(d).instances).toHaveLength(1);
    expect(splitProfileErrors(d).tags).toHaveLength(1);
    expect(splitProfileErrors(undefined)).toEqual({ instances: [], tags: [] });
  });
  it('merges poll groups by id like the server', () => {
    expect(mergeGroups([{ id: 'a', intervalMs: 1000 }, { id: 'b', intervalMs: 500 }], [{ id: 'a', intervalMs: 250 }, { id: 'c', intervalMs: 5 }])).toEqual([{ id: 'a', intervalMs: 250 }, { id: 'b', intervalMs: 500 }, { id: 'c', intervalMs: 5 }]);
  });
  it('builds a profile draft from the device own tags only', () => {
    const d = { name: 'Boiler', protocol: 's7', options: { a: 1 }, pollGroups: [{ id: 'default', intervalMs: 1000 }], tags: [{ key: 'p', origin: 'profile' }, { key: 'o' }], ownTags: [{ key: 'o', address: 'DB1.DBD0', type: 'REAL' }] };
    const p = profileFromDevice(d);
    expect(p.tags).toEqual([{ key: 'o', address: 'DB1.DBD0', type: 'REAL' }]);
    expect(p.name).toBe('Boiler profile');
    const payload = toProfilePayload({ ...blankProfile({ id: 's7' }), name: ' N ', params: [{ name: 'x', default: '1' }], tags: [{ _id: 'q', key: 'k', address: 'a', type: 'REAL' }] }, { optionFields: [] });
    expect(payload).toMatchObject({ name: 'N', protocol: 's7', params: [{ name: 'x', default: '1' }], tags: [{ key: 'k', address: 'a', type: 'REAL' }] });
  });
});

// The preview must mirror the server's rules exactly: run both on the same inputs.
describe('parity with server/services/deviceProfiles.js', () => {
  const server = createRequire(import.meta.url)('../../../server/services/deviceProfiles.js');
  const cases = [
    { phase: 'A' },
    { phase: 'A', base: 5 },
    { base: '', phase: 'B' },
    {},
    { phase: 'A', extra: 1 },
    { phase: 'x'.repeat(300) },
    { phase: true },
    { phase: { a: 1 } }
  ];
  it.each(cases)('resolveParams %o', (given) => {
    expect(resolveParams(profile, given)).toEqual(server.resolveParams(profile, given));
  });
  it('expandProfileTags and placeholders agree', () => {
    for (const values of [{ base: 1, phase: 'A' }, { base: 1 }, {}]) {
      const a = expandProfileTags(profile, values);
      const b = server.expandProfileTags(profile, values);
      expect(a.errors).toEqual(b.errors);
      expect(a.tags.map(({ _from, ...t }) => t)).toEqual(b.tags);
    }
    for (const s of ['{a}{b}', 'x{9}', '{_ok1}', '{a-b}', '']) expect([...placeholders(s)]).toEqual([...server.placeholders(s)]);
  });
  it('param name rule agrees', () => {
    for (const name of ['a', '_a1', '1a', 'a-b', 'x'.repeat(64), 'x'.repeat(65)]) {
      expect(paramDeclErrors([{ name }])[0] === undefined).toBe(server.validateParamDecls([{ name }]) === null);
    }
  });
});
