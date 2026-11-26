import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCheck, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { useNow } from '@/lib/useActiveAlarms';
import { nextSort, sortRows } from '@/lib/sortRows';
import { useStore } from '@/store/store';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import { Banner, Button, Dialog, EmptyState, Field, LoadingState, Select, StatusText, Table, TableSort, Textarea, THead, Th, Tr, Td, Timestamp } from '@/components/ui';
import { ALARM_SORT, activeSummary, canAcknowledge, defaultAlarmOrder, formatDuration, matchesAlarmLink, severityView } from './helpers';

const NOTE_MAX = 500;

/** "Acknowledged by alice, 3 min ago: checking the pump" */
function AckLine({ ack }) {
  return (
    <span className="block text-xs text-subtle">
      by <span className="text-fg">{ack.by}</span> <Timestamp value={ack.at} />
      {ack.note && <span className="block max-w-[22rem] truncate" title={ack.note}>“{ack.note}”</span>}
    </span>
  );
}

/** State cell: Firing / Acknowledged / Breached (with the time left until it fires). */
function AlarmState({ a, now }) {
  if (a.state === 'breached') {
    return (
      <>
        <StatusText tone="warn">Breached</StatusText>
        <span className="block text-xs text-subtle">fires in {formatDuration(Math.max(0, (a.remainingMs ?? 0) - now))} if it holds</span>
      </>
    );
  }
  if (a.acknowledged) {
    return (
      <>
        <StatusText tone="neutral">Acknowledged</StatusText>
        <AckLine ack={a.ack} />
      </>
    );
  }
  return <StatusText tone="bad">Firing, unacknowledged</StatusText>;
}

function Severity({ value }) {
  const s = severityView(value);
  return <StatusText tone={s.tone}>{s.label}</StatusText>;
}

const SORT_OPTIONS = [
  { value: '', label: 'Needs a person first' },
  { value: 'severity:desc', label: 'Severity' },
  { value: 'since:asc', label: 'Longest active' },
  { value: 'since:desc', label: 'Newest' },
  { value: 'alarm:asc', label: 'Rule name' }
];

/**
 * Active alarms: everything firing now (one row per rule, or per topic for wildcard value rules) and value
 * rules that are breached and waiting out their sustain time. Firing alarms can be acknowledged, one at a
 * time or several at once, with an optional note; an acknowledgement holds until the alarm clears.
 * `q` is the useActiveAlarms query (shared with the page header), `highlight` an alarm id from a link.
 */
export default function ActiveAlarms({ q, highlight, onShowRules }) {
  const readOnly = useReadOnly();
  const brokers = useStore((s) => s.brokers);
  const [sort, setSort] = useState(null); // null = defaultAlarmOrder
  const [selected, setSelected] = useState(() => new Set());
  const [ackFor, setAckFor] = useState(null); // alarms the dialog acknowledges
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const alarms = useMemo(() => q.data?.alarms || [], [q.data]);
  const counts = q.data?.counts;
  // Durations tick in the browser, anchored to the server clock.
  const tick = useNow(alarms.length > 0);
  const serverNow = tick + (q.data?.offset || 0);
  const answeredAt = q.data?.serverTime ?? serverNow;

  const rows = useMemo(() => (sort ? sortRows(alarms, sort, ALARM_SORT) : defaultAlarmOrder(alarms)), [alarms, sort]);
  const ackable = rows.filter(canAcknowledge);
  // Selection only ever holds alarms that can still be acknowledged.
  const sel = ackable.filter((a) => selected.has(a.id));
  const brokerName = (id) => brokers.find((b) => b.id === id)?.name || id;

  // A link from elsewhere (Overview) highlights one alarm and scrolls it into view once it is listed.
  const scrolled = useRef(null);
  const target = highlight ? rows.find((a) => matchesAlarmLink(a, highlight)) : null;
  useEffect(() => {
    if (!target || scrolled.current === target.id) return;
    scrolled.current = target.id;
    document.querySelector(`[data-alarm-id="${CSS.escape(target.id)}"]`)?.scrollIntoView?.({ block: 'center' });
  }, [target]);

  const toggle = (id, on) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const allOn = ackable.length > 0 && sel.length === ackable.length;

  const openAck = (list) => {
    setNote('');
    setAckFor(list);
  };

  const submitAck = async () => {
    if (busy || !ackFor?.length) return;
    setBusy(true);
    let done = 0;
    const problems = [];
    for (const a of ackFor) {
      try {
        // `since` pins the occurrence the operator is looking at: if it cleared and fired again, the server refuses.
        const r = await api.acknowledgeAlarm({ ruleId: a.ruleId, topic: a.type === 'value-threshold' ? a.topic : null, since: a.since, note: note.trim() || undefined });
        done += r.acknowledged?.length || 0;
      } catch (e) {
        problems.push(`${a.ruleName}${a.topic ? ` (${a.topic})` : ''}: ${e.message}`);
      }
    }
    setBusy(false);
    setAckFor(null);
    setSelected(new Set());
    q.reload();
    if (done) toast.success(done === 1 ? 'Alarm acknowledged' : `${done} alarms acknowledged`);
    if (problems.length) toast.error(`Not acknowledged: ${problems.join('; ')}`, { duration: 8000 });
  };

  if (q.error && !q.data) {
    return (
      <Banner variant="error" title="Could not load active alarms" onRetry={q.reload}>
        {q.error.message}
      </Banner>
    );
  }
  if (q.loading && !q.data) return <LoadingState label="active alarms" rows={3} />;

  const ackButton = (a) => (
    <Button size="sm" variant="secondary" onClick={() => openAck([a])} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined} aria-label={`Acknowledge ${a.ruleName}${a.topic ? ` on ${a.topic}` : ''}`}>
      <Check size={13} aria-hidden="true" /> Acknowledge
    </Button>
  );

  return (
    <div className="space-y-4">
      {q.error && (
        <Banner variant="warn" title="Showing the last known alarms" onRetry={q.reload}>
          Refreshing failed: {q.error.message}
        </Banner>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-sm text-muted" data-testid="alarm-summary" aria-live="polite">
          {activeSummary(counts)}
        </p>
        {rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="Sort alarms"
              value={sort ? `${sort.key}:${sort.dir}` : ''}
              onChange={(e) => {
                const [key, dir] = e.target.value.split(':');
                setSort(key ? { key, dir } : null);
              }}
              wrapperClassName="md:hidden"
              options={SORT_OPTIONS}
            />
            <Button
              variant="secondary"
              onClick={() => openAck(sel)}
              disabled={readOnly || sel.length === 0}
              title={readOnly ? READ_ONLY_REASON : sel.length === 0 ? 'Select the alarms to acknowledge first' : undefined}
            >
              <CheckCheck size={14} aria-hidden="true" /> Acknowledge selected{sel.length ? ` (${sel.length})` : ''}
            </Button>
          </div>
        )}
      </div>

      {rows.length === 0 && (
        <div className="rounded-lg border border-line bg-panel">
          <EmptyState
            title="No active alarms"
            hint="Nothing is firing. Alarms appear here as soon as a rule fires, and stay until the condition clears."
            action={
              <Button variant="secondary" onClick={onShowRules}>
                View alert rules
              </Button>
            }
          />
        </div>
      )}

      {rows.length > 0 && (
        <>
          {/* Desktop: a sortable table. */}
          <div className="hidden md:block">
            <TableSort sort={sort} onSort={(k) => setSort((s) => nextSort(s, k))}>
              <Table caption="Active alarms" className="min-w-[56rem]">
                <THead>
                  <th scope="col" className="h-8 w-10 px-3 align-middle">
                    <input
                      type="checkbox"
                      aria-label="Select every alarm that can be acknowledged"
                      className="h-4 w-4 rounded-sm accent-accent"
                      checked={allOn}
                      disabled={readOnly || ackable.length === 0}
                      onChange={(e) => setSelected(e.target.checked ? new Set(ackable.map((a) => a.id)) : new Set())}
                    />
                  </th>
                  <Th sortKey="severity">Severity</Th>
                  <Th sortKey="alarm">Alarm</Th>
                  <Th sortKey="topic">Topic</Th>
                  <Th sortKey="value" align="right">
                    Value
                  </Th>
                  <Th sortKey="since">Active for</Th>
                  <Th sortKey="state">State</Th>
                  <Th srOnly align="right">
                    Actions
                  </Th>
                </THead>
                <tbody>
                  {rows.map((a) => (
                    <Tr key={a.id} data-alarm-id={a.id} data-testid="alarm-row" highlight={target?.id === a.id}>
                      <Td className="w-10">
                        {canAcknowledge(a) && (
                          <input
                            type="checkbox"
                            aria-label={`Select ${a.ruleName}${a.topic ? ` on ${a.topic}` : ''}`}
                            className="h-4 w-4 rounded-sm accent-accent"
                            checked={selected.has(a.id)}
                            disabled={readOnly}
                            onChange={(e) => toggle(a.id, e.target.checked)}
                          />
                        )}
                      </Td>
                      <Td>
                        <Severity value={a.severity} />
                      </Td>
                      <Td header>
                        <span className="block font-medium text-fg">{a.ruleName}</span>
                        <span className="mono block text-xs text-subtle">{a.condition}</span>
                      </Td>
                      <Td className="max-w-[18rem] text-xs">
                        <span className="mono block truncate text-fg" title={a.topic || ''}>
                          {a.topic || '—'}
                        </span>
                        <span className="block text-subtle">{brokerName(a.brokerId)}</span>
                      </Td>
                      <Td align="right" className="mono tabular-nums">
                        {a.value ?? '—'}
                      </Td>
                      <Td className="whitespace-nowrap">
                        <span className="mono tabular-nums text-fg" data-testid="alarm-duration">
                          {formatDuration(serverNow - a.since)}
                        </span>
                        <span className="block text-xs text-subtle">
                          since <Timestamp value={a.since} />
                        </span>
                      </Td>
                      <Td>
                        <AlarmState a={a} now={serverNow - answeredAt} />
                      </Td>
                      <Td align="right" className="w-36">
                        {canAcknowledge(a) && ackButton(a)}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableSort>
          </div>

          {/* Phone: one card per alarm. */}
          <ul className="space-y-2 md:hidden" aria-label="Active alarms">
            {rows.map((a) => (
              <li key={a.id} data-alarm-id={a.id} className={`rounded-lg border bg-panel p-3 ${target?.id === a.id ? 'border-accent' : 'border-line'}`}>
                <div className="flex items-start gap-2.5">
                  {canAcknowledge(a) && (
                    <input
                      type="checkbox"
                      aria-label={`Select ${a.ruleName}${a.topic ? ` on ${a.topic}` : ''}`}
                      className="mt-0.5 h-4 w-4 shrink-0 rounded-sm accent-accent"
                      checked={selected.has(a.id)}
                      disabled={readOnly}
                      onChange={(e) => toggle(a.id, e.target.checked)}
                    />
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <span className="font-medium text-fg">{a.ruleName}</span>
                      <Severity value={a.severity} />
                    </div>
                    <p className="mono break-all text-xs text-muted">
                      {a.topic || '—'} · {a.condition}
                      {a.value !== null && a.value !== undefined ? ` · ${a.value}` : ''}
                    </p>
                    <p className="text-xs text-subtle">
                      Active for <span className="mono tabular-nums text-fg">{formatDuration(serverNow - a.since)}</span>
                    </p>
                    <AlarmState a={a} now={serverNow - answeredAt} />
                    {canAcknowledge(a) && <div className="pt-1">{ackButton(a)}</div>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {ackFor && (
        <Dialog
          title={ackFor.length === 1 ? 'Acknowledge alarm' : `Acknowledge ${ackFor.length} alarms`}
          description="The alarm stays active until its condition clears. If it fires again later, it needs a new acknowledgement."
          onClose={() => !busy && setAckFor(null)}
          onSubmit={submitAck}
          footer={
            <>
              <Button variant="secondary" onClick={() => setAckFor(null)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" loading={busy}>
                Acknowledge
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <ul className="space-y-1 text-sm">
              {ackFor.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-x-2">
                  <Severity value={a.severity} />
                  <span className="text-fg">{a.ruleName}</span>
                  {a.topic && <span className="mono break-all text-xs text-muted">{a.topic}</span>}
                </li>
              ))}
            </ul>
            <Field label="Note (optional)" help={`What you are doing about it. Kept in the history. ${note.length}/${NOTE_MAX}`}>
              <Textarea rows={3} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} data-autofocus placeholder="Checking the cooling loop" />
            </Field>
          </div>
        </Dialog>
      )}
      {readOnly && rows.some(canAcknowledge) && <p className="text-xs text-subtle">{READ_ONLY_REASON}</p>}
      {counts?.firing > 0 && (
        <p className="text-xs text-subtle">
          Acknowledging records who saw an alarm. It never silences it: the alarm stays listed until it clears, and fires again if the condition returns.
        </p>
      )}
    </div>
  );
}
