import { describe, it, expect } from 'vitest';
import {
  moveItem, routeFlow, routeState, outboxHealth, formatBytes, historianUsers, withTransformIds, newTransform, stripTransformIds, transformLabel, blankRoute
} from '@/pages/pipelines/helpers';
import { ruleStates, auditTone, alertTone } from '@/pages/settings/helpers';
import { connectionState, qualityOf, problemField, formProblem, BLANK_FORM } from '@/pages/opcua/helpers';

describe('route editor helpers', () => {
  it('moves a transform and ignores out-of-range moves', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    const list = ['a', 'b'];
    expect(moveItem(list, 0, -1)).toBe(list);
    expect(moveItem(list, 1, 2)).toBe(list);
  });

  it('keys transforms for the editor and strips the keys before saving', () => {
    const route = withTransformIds({ ...blankRoute([{ id: 'b1' }]), id: 'r1' });
    expect(route.transforms[0]._uid).toBeTruthy();
    const added = newTransform('numeric');
    expect(added._uid).toBeTruthy();
    expect(added._uid).not.toBe(route.transforms[0]._uid);
    const saved = stripTransformIds({ ...route, transforms: [...route.transforms, added] });
    expect(saved.transforms.every((t) => !('_uid' in t))).toBe(true);
    expect(saved.transforms.map((t) => t.type)).toEqual(['repath', 'numeric']);
  });

  it('names transforms in plain words and falls back to the type', () => {
    expect(transformLabel({ type: 'sparkplugFlatten' })).toBe('Flatten Sparkplug');
    expect(transformLabel({ type: 'mystery' })).toBe('mystery');
  });

  it('summarises a route as source, transforms and target', () => {
    const route = { source: { brokerId: 'b1', filter: 'raw/#' }, transforms: [{ type: 'repath' }, { type: 'numeric' }], target: { type: 'mqtt', brokerId: 'b2', retain: true } };
    expect(routeFlow(route, [{ id: 'b2', name: 'Plant' }], [])).toEqual({ source: 'raw/#', transforms: ['Re-path', 'To number'], target: 'Plant (retained)' });
  });

  it('derives a route state from enabled flag and counters', () => {
    expect(routeState({ enabled: false }, { errors: 5, lastError: 'x' }).key).toBe('paused');
    expect(routeState({ enabled: true }, { errors: 2, lastError: 'boom' })).toMatchObject({ key: 'failing', tone: 'bad' });
    expect(routeState({ enabled: true }, { loopBlocked: 3 })).toMatchObject({ key: 'blocked', tone: 'warn' });
    expect(routeState({ enabled: true }, {})).toMatchObject({ key: 'running', tone: 'good' });
  });
});

describe('historian helpers', () => {
  it('reads outbox health in plain language, worst problem first', () => {
    expect(outboxHealth(undefined).tone).toBe('neutral');
    expect(outboxHealth({ written: 5, queued: 0, spillBytes: 0 })).toMatchObject({ tone: 'good', label: 'Healthy' });
    expect(outboxHealth({ written: 5, queued: 12, spillBytes: 0 })).toMatchObject({ tone: 'warn', label: 'Buffering' });
    expect(outboxHealth({ written: 5, queued: 0, spillBytes: 2048, lastError: 'ECONNREFUSED' })).toMatchObject({ tone: 'warn', detail: 'ECONNREFUSED' });
    expect(outboxHealth({ written: 5, queued: 0, spillBytes: 0, dropped: 4 })).toMatchObject({ tone: 'bad', label: 'Dropping points' });
    const dead = outboxHealth({ written: 5, queued: 3, spillBytes: 0, dropped: 4, deadLettered: 2, deadLetterBytes: 1024 });
    expect(dead).toMatchObject({ tone: 'bad', label: 'Rejecting points' });
    expect(dead.detail).toContain('rejected by the historian');
  });

  it('formats byte counts', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('lists everything that still writes to a historian', () => {
    const users = historianUsers('h1', {
      routes: [{ name: 'to h1', target: { type: 'historian', historianId: 'h1' } }, { name: 'other', target: { type: 'historian', historianId: 'h2' } }, { name: 'mqtt', target: { type: 'mqtt' } }],
      recordings: [{ name: 'rec', target: { type: 'historian', historianId: 'h1' } }],
      bindings: [{ name: 'bind', target: { historian: { historianId: 'h1' } } }, { id: 'b2', target: {} }]
    });
    expect(users).toEqual(['Route "to h1"', 'Recording "rec"', 'Tag binding "bind"']);
    expect(historianUsers('h9', {})).toEqual([]);
  });
});

describe('settings helpers', () => {
  it('derives each alert rule state from its newest event', () => {
    const rules = [{ id: 'a' }, { id: 'b' }, { id: 'c', enabled: false }, { id: 'd' }];
    const events = [
      { ruleId: 'a', status: 'firing', ts: 30 },
      { ruleId: 'b', status: 'resolved', ts: 25 },
      { ruleId: 'b', status: 'firing', ts: 20 },
      { ruleId: 'a', status: 'resolved', ts: 10 }
    ];
    const s = ruleStates(rules, events);
    expect(s.a).toMatchObject({ key: 'firing', since: 30 });
    expect(s.b.key).toBe('ok'); // fired once, resolved since
    expect(s.c.key).toBe('disabled');
    expect(s.d).toMatchObject({ key: 'ok', label: 'Idle' });
    expect(ruleStates(undefined, undefined)).toEqual({});
  });

  it('maps statuses to tones', () => {
    expect(auditTone({ status: 403 })).toBe('bad');
    expect(auditTone({ status: 200 })).toBe('good');
    expect(alertTone('firing')).toBe('bad');
    expect(alertTone('resolved')).toBe('good');
    expect(alertTone('event')).toBe('info');
  });
});

describe('OPC UA presentation helpers', () => {
  it('explains each connection state, including the endless retry', () => {
    expect(connectionState({ status: 'connected' }).tone).toBe('good');
    const re = connectionState({ status: 'reconnecting' });
    expect(re.tone).toBe('warn');
    expect(re.note).toMatch(/keeps retrying/i);
    expect(connectionState({ status: 'error' }).tone).toBe('bad');
    expect(connectionState({ status: 'weird' }).label).toBe('weird');
  });

  it('reads OPC UA quality words', () => {
    expect(qualityOf('Good (0x00000000)').tone).toBe('good');
    expect(qualityOf(undefined).tone).toBe('good');
    expect(qualityOf('Uncertain (0x40000000)').tone).toBe('warn');
    expect(qualityOf('Bad_NoCommunication (0x80310000)').tone).toBe('bad');
  });

  it('puts a validation message on the field it belongs to', () => {
    expect(problemField(formProblem({ ...BLANK_FORM, endpointUrl: 'http://x' }))).toBe('url');
    expect(problemField(formProblem({ ...BLANK_FORM, securityMode: 'Sign' }))).toBe('security');
  });
});
