import { describe, it, expect } from 'vitest';
import { sortRows } from '@/lib/sortRows';
import {
  ALARM_SORT,
  EMPTY_HISTORY_FILTERS,
  EMPTY_RULE_FORM,
  activeSummary,
  alarmLink,
  alertTone,
  canAcknowledge,
  defaultAlarmOrder,
  formFromRule,
  formatBytes,
  formatDuration,
  hasHistoryFilters,
  historyQuery,
  matchesAlarmLink,
  ruleBody,
  severityView
} from '@/pages/alerts/helpers';

const alarm = (over) => ({ id: 'r|t', ruleId: 'r', ruleName: 'R', type: 'value-threshold', topic: 't', severity: 'warning', state: 'firing', acknowledged: false, since: 1000, ...over });

describe('alarm helpers', () => {
  it('formatDuration reads like a clock at every scale', () => {
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(45_900)).toBe('45 s');
    expect(formatDuration(185_000)).toBe('3 min 05 s');
    expect(formatDuration(2 * 3600_000 + 4 * 60_000)).toBe('2 h 04 min');
    expect(formatDuration(3 * 86400_000 + 2 * 3600_000)).toBe('3 d 2 h');
    expect(formatDuration(-5)).toBe('0 s');
  });

  it('default order: unacknowledged firing first, then acknowledged, then breached; severity, then oldest', () => {
    const rows = [
      alarm({ id: 'breached', state: 'breached', severity: 'critical', since: 1 }),
      alarm({ id: 'ack-crit', acknowledged: true, severity: 'critical', since: 2 }),
      alarm({ id: 'warn-old', since: 3 }),
      alarm({ id: 'crit-new', severity: 'critical', since: 50 }),
      alarm({ id: 'crit-old', severity: 'critical', since: 10 }),
      alarm({ id: 'info', severity: 'info', since: 4 })
    ];
    expect(defaultAlarmOrder(rows).map((a) => a.id)).toEqual(['crit-old', 'crit-new', 'warn-old', 'info', 'ack-crit', 'breached']);
  });

  it('table sort accessors sort severity by rank and missing values last', () => {
    const rows = [alarm({ id: 'a', severity: 'info', value: 3 }), alarm({ id: 'b', severity: 'critical', value: null }), alarm({ id: 'c', severity: 'warning', value: 9 })];
    expect(sortRows(rows, { key: 'severity', dir: 'desc' }, ALARM_SORT).map((a) => a.id)).toEqual(['b', 'c', 'a']);
    expect(sortRows(rows, { key: 'value', dir: 'asc' }, ALARM_SORT).map((a) => a.id)).toEqual(['a', 'c', 'b']);
  });

  it('only firing, unacknowledged alarms can be acknowledged', () => {
    expect(canAcknowledge(alarm())).toBe(true);
    expect(canAcknowledge(alarm({ acknowledged: true }))).toBe(false);
    expect(canAcknowledge(alarm({ state: 'breached' }))).toBe(false);
  });

  it('alarm links round-trip to the alarm they name', () => {
    expect(alarmLink('r1', 'plant/a')).toBe('/alerts?alarm=r1%7Cplant%2Fa');
    const id = new URLSearchParams(alarmLink('r1', 'plant/a').split('?')[1]).get('alarm');
    expect(matchesAlarmLink(alarm({ id: 'r1|plant/a', ruleId: 'r1' }), id)).toBe(true);
    expect(matchesAlarmLink(alarm({ id: 'r1|plant/b', ruleId: 'r1' }), id)).toBe(false);
    // a silence rule has one alarm per rule
    expect(matchesAlarmLink(alarm({ id: 's1|', ruleId: 's1', type: 'branch-silent', topic: 'plant' }), 's1|plant')).toBe(true);
    expect(matchesAlarmLink(alarm(), null)).toBe(false);
  });

  it('activeSummary says what needs attention', () => {
    expect(activeSummary(null)).toBe('No active alarms');
    expect(activeSummary({ firing: 3, breached: 1, unacknowledged: 2, unacknowledgedCritical: 1 })).toBe('3 firing (2 unacknowledged, 1 critical), 1 breached, not firing yet');
    expect(activeSummary({ firing: 2, breached: 0, unacknowledged: 0 })).toBe('2 firing, all acknowledged');
  });

  it('severity and event tones', () => {
    expect(severityView('critical')).toMatchObject({ label: 'Critical', tone: 'bad' });
    expect(severityView(undefined).label).toBe('Warning');
    expect(alertTone('acknowledged')).toBe('info');
    expect(alertTone('ended')).toBe('neutral');
    expect(alertTone('firing')).toBe('bad');
  });
});

describe('history helpers', () => {
  it('builds the history query: text, lists, local times as epoch ms, cursor, CSV', () => {
    const from = '2026-03-01T10:00';
    const q = new URLSearchParams(historyQuery({ ...EMPTY_HISTORY_FILTERS, q: '  pump ', ruleId: 'r1', state: 'firing', severity: 'critical', from, to: from }, { cursor: 42, limit: 50 }));
    expect(q.get('q')).toBe('pump');
    expect(q.get('ruleId')).toBe('r1');
    expect(q.get('state')).toBe('firing');
    expect(q.get('severity')).toBe('critical');
    expect(Number(q.get('from'))).toBe(new Date(from).getTime());
    expect(Number(q.get('to'))).toBe(new Date(from).getTime() + 59_999); // the whole "to" minute
    expect(q.get('cursor')).toBe('42');
    expect(q.get('limit')).toBe('50');
    const csv = new URLSearchParams(historyQuery(EMPTY_HISTORY_FILTERS, { format: 'csv' }));
    expect(csv.get('format')).toBe('csv');
    expect(csv.has('limit')).toBe(false);
    expect(historyQuery({ from: 'not a date' })).toBe('limit=100');
  });

  it('knows when filters are set, and formats sizes', () => {
    expect(hasHistoryFilters(EMPTY_HISTORY_FILTERS)).toBe(false);
    expect(hasHistoryFilters({ ...EMPTY_HISTORY_FILTERS, severity: 'info' })).toBe(true);
    expect(hasHistoryFilters({ ...EMPTY_HISTORY_FILTERS, q: '   ' })).toBe(false);
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(8 * 1024 * 1024)).toBe('8.0 MB');
  });
});

describe('rule form severity', () => {
  it('defaults to warning, round-trips, and ignores unknown values', () => {
    expect(EMPTY_RULE_FORM.severity).toBe('warning');
    expect(formFromRule({ id: 'r', type: 'topic-silent', severity: 'critical' }).severity).toBe('critical');
    expect(formFromRule({ id: 'r', type: 'topic-silent' }).severity).toBe('warning');
    expect(ruleBody({ ...EMPTY_RULE_FORM, severity: 'info' }, 'b').severity).toBe('info');
    expect(ruleBody({ ...EMPTY_RULE_FORM, severity: 'urgent' }, 'b').severity).toBe('warning');
  });
});
