import { describe, it, expect } from 'vitest';
import {
  canaryAttention,
  canaryConfigFromForm,
  canaryFormFromBroker,
  canaryLine,
  canaryTone,
  canaryWord,
  defaultCanaryTopic,
  ms,
  postureText,
  postureTone,
  presetToForm,
  severityTone,
  sinceWord
} from '@/lib/brokerHealth';

describe('canary display', () => {
  it('names every state in words and maps it to a tone', () => {
    expect(['ok', 'slow', 'failing', 'not-permitted', 'pending', 'unknown', 'off'].map(canaryWord)).toEqual(['OK', 'Slow', 'Failing', 'Not permitted', 'Waiting', 'Not running', 'Off']);
    expect(canaryTone('ok')).toBe('good');
    expect(canaryTone('failing')).toBe('bad');
    expect(canaryTone('slow')).toBe('warn');
    expect(canaryTone('not-permitted')).toBe('warn');
    expect(canaryTone('anything-new')).toBe('neutral');
  });

  it('formats latency and age', () => {
    expect(ms(12.34)).toBe('12.3 ms');
    expect(ms(1400)).toBe('1.4 s');
    expect(ms(null)).toBe('n/a');
    expect(sinceWord(null)).toBe('never');
    expect(sinceWord(42_000)).toBe('42 s ago');
    expect(sinceWord(10 * 60_000)).toBe('10 min ago');
    expect(sinceWord(3 * 3600_000)).toBe('3 h ago');
  });

  it('one list line, and nothing while the canary is off', () => {
    expect(canaryLine(null)).toBeNull();
    expect(canaryLine({ state: 'off' })).toBeNull();
    expect(canaryLine({ state: 'ok', p95Ms: 31 })).toBe('OK, p95 31 ms');
    expect(canaryLine({ state: 'not-permitted', refused: 'publish' })).toBe('Not permitted (publish)');
    expect(canaryLine({ state: 'not-permitted', refused: 'subscribe' })).toBe('Not permitted (subscribe)');
    expect(canaryLine({ state: 'failing' })).toBe('Failing');
  });
});

describe('Overview needs attention: canary', () => {
  const b = (over) => ({ id: 'b1', name: 'Plant', status: 'connected', ...over });
  it('lists a failing canary as bad and a refused one as a warning', () => {
    const failing = canaryAttention([b({ canaryState: { state: 'failing', detail: 'no delivery within 4 s' } })]);
    expect(failing).toEqual([{ key: 'canary-b1', tone: 'bad', what: 'Broker canary Plant', detail: 'no delivery within 4 s', to: '/brokers' }]);
    const refused = canaryAttention([b({ canaryState: { state: 'not-permitted', refused: 'subscribe', detail: 'Allow it.' } })]);
    expect(refused[0].tone).toBe('warn');
    expect(refused[0].detail).toMatch(/refused the canary subscribe/);
  });

  it('is quiet when ok, slow, off, pending, or when the broker itself is not connected', () => {
    for (const state of ['ok', 'slow', 'pending', 'unknown']) expect(canaryAttention([b({ canaryState: { state } })])).toEqual([]);
    expect(canaryAttention([b({ canaryState: null })])).toEqual([]);
    expect(canaryAttention([b({ status: 'offline', canaryState: { state: 'failing' } })])).toEqual([]);
  });
});

describe('security summary', () => {
  it('compact text: counts worst first, none, or info only', () => {
    expect(postureText({ high: 1, medium: 2, low: 0, info: 1 })).toBe('1 high, 2 medium');
    expect(postureText({ high: 0, medium: 0, low: 3, info: 0 })).toBe('3 low');
    expect(postureText({ high: 0, medium: 0, low: 0, info: 2 })).toBe('Info only');
    expect(postureText({ high: 0, medium: 0, low: 0, info: 0 })).toBe('No findings');
    expect(postureText(null)).toBeNull();
  });
  it('tone follows the worst finding that matters', () => {
    expect(postureTone({ high: 1, medium: 0, low: 0, info: 0 })).toBe('bad');
    expect(postureTone({ high: 0, medium: 1, low: 0, info: 0 })).toBe('warn');
    expect(postureTone({ high: 0, medium: 0, low: 2, info: 0 })).toBe('neutral');
    expect(severityTone('high')).toBe('bad');
    expect(severityTone('medium')).toBe('warn');
    expect(severityTone('low')).toBe('info');
  });
});

describe('connect form helpers', () => {
  const BLANK = { name: '', host: 'localhost', port: 1883, protocol: 'mqtt', mqttVersion: 4, subscribeFilter: '#', subscribeQos: 1, username: 'x', password: 'y', clientId: 'keep' };
  it('a preset fills the connection fields, starts narrow and never carries credentials', () => {
    const preset = { name: 'EMQX public (test)', host: 'broker.emqx.io', port: 8883, protocol: 'mqtts', mqttVersion: 4, subscribeFilter: 'testtopic/#', subscribeQos: 0, rejectUnauthorized: true };
    const form = presetToForm(preset, BLANK);
    expect(form).toMatchObject({ name: 'EMQX public (test)', host: 'broker.emqx.io', port: 8883, protocol: 'mqtts', subscribeFilter: 'testtopic/#', subscribeQos: 0, username: '', password: '', rejectUnauthorized: true, clientId: 'keep' });
    expect(form.subscribeFilter).not.toBe('#');
  });

  it('the canary config sent to the server: off by default, a topic only when it differs from the default', () => {
    expect(canaryConfigFromForm({ canaryEnabled: false })).toEqual({ enabled: false, qos: 0, intervalSec: 30, slowMs: 1000 });
    expect(canaryConfigFromForm({ canaryEnabled: true, canaryTopic: '  ', canaryQos: '1', canaryIntervalSec: '10', canarySlowMs: '250' })).toEqual({ enabled: true, qos: 1, intervalSec: 10, slowMs: 250 });
    expect(canaryConfigFromForm({ canaryEnabled: true, canaryTopic: 'plant/canary/m' }).topic).toBe('plant/canary/m');
    expect(canaryConfigFromForm({ canaryEnabled: true, canaryTopic: defaultCanaryTopic('abcdef123') }, 'abcdef123').topic).toBeUndefined();
  });

  it('editing a broker restores its canary settings, treating the default topic as unset', () => {
    expect(canaryFormFromBroker({ id: 'abcdef123', canary: { enabled: true, topic: defaultCanaryTopic('abcdef123'), qos: 1, intervalSec: 15, slowMs: 500 } })).toEqual({
      canaryEnabled: true,
      canaryTopic: '',
      canaryQos: 1,
      canaryIntervalSec: 15,
      canarySlowMs: 500
    });
    expect(canaryFormFromBroker({ id: 'x', canary: { enabled: true, topic: 'plant/canary/x' } }).canaryTopic).toBe('plant/canary/x');
    expect(canaryFormFromBroker({ id: 'x' }).canaryEnabled).toBe(false);
  });
});
