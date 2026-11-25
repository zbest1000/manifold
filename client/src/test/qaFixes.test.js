import { describe, it, expect } from 'vitest';
import { unsLink } from '@/pages/tags/assetPath';
import { looksLikeTvq, hasTvqNumeric, outboxSummary } from '@/pages/pipelines/helpers';
import { formProblem } from '@/pages/opcua/helpers';
import { parseBulkDevices, rowToInstance } from '@/lib/bulkDevices';
import { isAlreadyConnected } from '@/lib/discoveryDevices';

describe('unsLink: the deep link from a binding to the UNS page', () => {
  const binding = (target) => ({ target: { mode: 'mqtt', brokerId: 'b1', ...target } });
  it('links a concrete asset path with broker and path', () => {
    const l = unsLink(binding({ assetPath: 'acme/dallas/line4/filler' }));
    expect(l).toEqual({ to: '/uns?broker=b1&path=acme%2Fdallas%2Fline4%2Ffiller', path: 'acme/dallas/line4/filler', partial: false });
  });
  it('cuts a template at its first placeholder and says it is partial', () => {
    const l = unsLink(binding({ assetPathTemplate: 'acme/dallas/{device}/motor' }));
    expect(l.path).toBe('acme/dallas');
    expect(l.partial).toBe(true);
  });
  it('has no link without a usable path or for Sparkplug output', () => {
    expect(unsLink(binding({ assetPathTemplate: '{device}/x' }))).toBeNull();
    expect(unsLink({ target: { mode: 'sparkplug', group: 'g', edge: 'e' } })).toBeNull();
  });
  it('omits the broker when the binding does not name one', () => {
    expect(unsLink({ target: { mode: 'mqtt', assetPath: 'a/b' } }).to).toBe('/uns?path=a%2Fb');
  });
});

describe('TVQ envelope detection for historian routes', () => {
  it('recognises { v, t|q } with a numeric value', () => {
    expect(looksLikeTvq({ v: 12.5, t: 1, q: 192 })).toBe(true);
    expect(looksLikeTvq({ v: '7', q: 192 })).toBe(true);
  });
  it('does not fire for plain payloads or non-numeric values', () => {
    expect(looksLikeTvq({ value: 3 })).toBe(false);
    expect(looksLikeTvq({ v: 'running', t: 1 })).toBe(false);
    expect(looksLikeTvq({ v: 3 })).toBe(false);
    expect(looksLikeTvq([1, 2])).toBe(false);
    expect(looksLikeTvq(7)).toBe(false);
    expect(looksLikeTvq(null)).toBe(false);
  });
  it('knows when the numeric-on-v transform is already there', () => {
    expect(hasTvqNumeric([{ type: 'repath', to: 'a' }])).toBe(false);
    expect(hasTvqNumeric([{ type: 'numeric', field: '' }])).toBe(false);
    expect(hasTvqNumeric([{ type: 'numeric', field: 'v' }])).toBe(true);
  });
});

describe('outboxSummary shows dead letters', () => {
  it('reports rejected and skipped points and the dead-letter size', () => {
    const s = outboxSummary({ written: 10, queued: 0, spillBytes: 0, dropped: 0, deadLettered: 4, deadLetterBytes: 2048, skipped: 2 });
    expect(s).toMatchObject({ deadLettered: 4, deadLetterKb: '2.0', skipped: 2 });
    expect(outboxSummary({ written: 1, queued: 0 })).toMatchObject({ deadLettered: null, deadLetterKb: null, skipped: null });
  });
});

describe('OPC UA connection form validation', () => {
  const ok = { endpointUrl: 'opc.tcp://plc:4840', securityMode: 'None', securityPolicy: 'None' };
  it('accepts a plain opc.tcp URL and a consistent secure pair', () => {
    expect(formProblem(ok)).toBe('');
    expect(formProblem({ ...ok, securityMode: 'SignAndEncrypt', securityPolicy: 'Basic256Sha256' })).toBe('');
  });
  it('explains an empty or wrongly shaped URL', () => {
    expect(formProblem({ ...ok, endpointUrl: '' })).toMatch(/required/);
    expect(formProblem({ ...ok, endpointUrl: 'http://plc:4840' })).toMatch(/opc\.tcp:\/\/host:4840/);
  });
  it('rejects a security mode without a policy and the reverse', () => {
    expect(formProblem({ ...ok, securityMode: 'Sign' })).toMatch(/needs a security policy/);
    expect(formProblem({ ...ok, securityPolicy: 'Basic256Sha256' })).toMatch(/needs a security mode/);
  });
});

describe('bulk rows map to the bulk request', () => {
  it('turns parsed rows into per-device bodies with params', () => {
    const profile = { params: [{ name: 'line' }] };
    const { rows } = parseBulkDevices('name,host,port,line\nA,10.0.0.1,502,l1\nB,10.0.0.2,,l2\n', profile);
    expect(rows.map(rowToInstance)).toEqual([
      { name: 'A', host: '10.0.0.1', port: 502, params: { line: 'l1' } },
      { name: 'B', host: '10.0.0.2', params: { line: 'l2' } }
    ]);
  });
});

describe('discovery does not offer to connect what is already connected', () => {
  const brokers = [{ host: '10.0.0.5', port: 1883 }];
  const opcua = [{ endpointUrl: 'opc.tcp://10.0.0.6:4840' }];
  it('matches MQTT brokers by host and port', () => {
    expect(isAlreadyConnected({ kind: 'mqtt', host: '10.0.0.5', port: 1883 }, { brokers })).toBe(true);
    expect(isAlreadyConnected({ kind: 'mqtt', host: '10.0.0.5', port: '1883' }, { brokers })).toBe(true);
    expect(isAlreadyConnected({ kind: 'mqtt', host: '10.0.0.5', port: 8883 }, { brokers })).toBe(false);
  });
  it('matches OPC UA servers by endpoint URL, built from host:port when the result has none', () => {
    expect(isAlreadyConnected({ kind: 'opcua', host: '10.0.0.6', port: 4840 }, { opcua })).toBe(true);
    expect(isAlreadyConnected({ kind: 'opcua', endpointUrl: 'opc.tcp://10.0.0.6:4840' }, { opcua })).toBe(true);
    expect(isAlreadyConnected({ kind: 'opcua', host: '10.0.0.7', port: 4840 }, { opcua })).toBe(false);
  });
  it('leaves i3X and devices to their own flows', () => {
    expect(isAlreadyConnected({ kind: 'i3x', host: '10.0.0.5', port: 1883 }, { brokers })).toBe(false);
  });
});
