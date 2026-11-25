import { useState } from 'react';
import { Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Button, Input, Field, Banner, Dialog, StatusText, Timestamp, Path, Panel, Table, THead, Th, Tr, Td, useConfirm } from '@/components/ui';
import { READ_ONLY_REASON } from '@/store/selectors';
import { BrokerSelect, Count, ListState, RowButtons, TabToolbar, useRo } from './shared';
import { brokenSummary, brokerName } from './helpers';

const PROBLEM_TONE = { 'type-changed': 'text-warn', 'missing-field': 'text-bad' };
const PROBLEM_LABEL = { 'type-changed': 'Type changed', 'missing-field': 'Missing field' };

/** Contracts: a locked payload shape per topic, with drift reported as violations. */
export default function ContractsTab({ brokers }) {
  const [form, setForm] = useState(null); // null = dialog closed
  const [attempted, setAttempted] = useState(false);
  const [inferError, setInferError] = useState(null);
  const [inferredFor, setInferred] = useState(null); // { forKey, schema }
  const [inferring, setInferring] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const [busy, setBusy] = useState(false);
  const ro = useRo();
  const readOnly = Boolean(ro.disabled);
  // The inferred schema belongs to the broker and topic it was inferred from; editing either hides it,
  // so "Lock contract" can never lock one topic's schema under another topic's filter.
  const brokerOf = (f) => f.brokerId || brokers[0]?.id;
  const inferred = form && inferredFor && inferredFor.forKey === `${brokerOf(form)}|${form.topic}` ? inferredFor : null;

  const { data, error, loading, reload } = usePolled(
    async () => {
      const [c, v] = await Promise.all([api.listContracts(), api.contractViolations(100)]);
      return { contracts: c.contracts || [], counters: c.counters || {}, violations: v.violations || [] };
    },
    { interval: 5000 }
  );
  const contracts = data?.contracts || [];
  const counters = data?.counters || {};
  const violations = data?.violations || [];
  const drifting = contracts.filter((c) => counters[c.id]?.violations).length;

  const openNew = () => {
    setAttempted(false);
    setInferError(null);
    setInferred(null);
    setForm({ brokerId: brokers[0]?.id || '', topic: '', name: '' });
  };

  const infer = async () => {
    setAttempted(true);
    if (!form.topic.trim()) return;
    setInferring(true);
    setInferError(null);
    try {
      const brokerId = brokerOf(form);
      setInferred({ ...(await api.inferContract(brokerId, form.topic)), forKey: `${brokerId}|${form.topic}` });
    } catch (e) {
      setInferred(null);
      setInferError(e.message);
    } finally {
      setInferring(false);
    }
  };

  const lock = async () => {
    if (busy || readOnly) return;
    if (!inferred) return infer();
    setBusy(true);
    try {
      await api.saveContract({ name: form.name || null, brokerId: brokerOf(form), filter: form.topic, schema: inferred.schema });
      setForm(null);
      setInferred(null);
      reload();
      toast.success('Contract locked');
    } catch (e) {
      setInferError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c) => {
    const ok = await confirm({
      title: `Delete the contract for "${c.filter || c.id}"?`,
      message: 'Messages on this topic are no longer checked, so drift is not reported. The data itself is not affected.',
      confirmLabel: 'Delete contract',
      danger: true
    });
    if (!ok) return;
    try {
      await api.deleteContract(c.id);
      reload();
      toast.success('Contract deleted');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const topicError = attempted && form && !form.topic.trim() ? 'Enter the topic to infer a schema from.' : undefined;

  return (
    <>
      <ListState
        loading={loading}
        error={error}
        reload={reload}
        count={contracts.length}
        label="contracts"
        empty={{
          title: 'No payload contracts yet',
          hint: 'Lock the shape of a topic’s payload and Manifold flags drift when a message stops matching it, for example after a firmware update renames a field.',
          action: (
            <Button onClick={openNew} {...ro}>
              <Plus size={14} aria-hidden="true" /> Lock a payload contract
            </Button>
          )
        }}
      >
        <TabToolbar summary={drifting ? `${contracts.length} contracts, ${drifting} drifting` : `${contracts.length} ${contracts.length === 1 ? 'contract' : 'contracts'}, all conforming`}>
          <Button onClick={openNew} {...ro}>
            <Plus size={14} aria-hidden="true" /> Lock a payload contract
          </Button>
        </TabToolbar>
        <Table caption="Payload contracts" className="min-w-[48rem]">
          <THead>
            <Th>Contract</Th>
            <Th>State</Th>
            <Th align="right">Checked</Th>
            <Th align="right">Violations</Th>
            <Th align="right">Locked</Th>
            <Th srOnly align="right">Actions</Th>
          </THead>
          <tbody>
            {contracts.map((c) => {
              const k = counters[c.id] || {};
              const name = c.name || c.filter;
              return (
                <Tr key={c.id}>
                  <Td header className="max-w-[24rem]">
                    <span className="block truncate font-medium text-fg">{name}</span>
                    <Path value={`${brokerName(brokers, c.brokerId)}: ${c.filter}`} className="text-muted" />
                  </Td>
                  <Td>
                    {c.broken?.length ? (
                      <>
                        <StatusText tone="bad">Broken reference</StatusText>
                        <span className="block text-xs text-subtle" data-testid="contract-broken">
                          {brokenSummary(c)}. Delete this contract and lock it again on an existing broker.
                        </span>
                      </>
                    ) : (
                      <StatusText tone={k.violations ? 'bad' : 'good'}>{k.violations ? 'Drifting' : 'Conforming'}</StatusText>
                    )}
                  </Td>
                  <Td align="right" className="mono">
                    <Count value={k.checked} />
                  </Td>
                  <Td align="right" className="mono">
                    <Count value={k.violations} tone="bad" />
                  </Td>
                  <Td align="right" className="text-xs text-muted">
                    {c.lockedAt ? <Timestamp value={c.lockedAt} /> : '—'}
                  </Td>
                  <Td align="right" className="w-20">
                    <RowButtons what={`contract ${name}`} onDelete={() => remove(c)} />
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </ListState>

      {(contracts.length > 0 || violations.length > 0) && (
        <Panel title="Recent violations" count={violations.length || undefined} flush>
          {error && violations.length === 0 ? (
            <div className="p-4">
              <Banner variant="warn">Violations could not be loaded.</Banner>
            </div>
          ) : violations.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted">No drift detected.</p>
          ) : (
            <Table caption="Recent contract violations" wrapperClassName="max-h-72 overflow-y-auto rounded-none border-0" className="min-w-[40rem]">
              <THead>
                <Th>Topic</Th>
                <Th>What changed</Th>
                <Th align="right">When</Th>
              </THead>
              <tbody>
                {violations.map((v, i) => (
                  <Tr key={i}>
                    <Td className="max-w-[18rem] align-top">
                      <Path value={v.topic} />
                    </Td>
                    <Td className="align-top text-xs">
                      {v.problems.map((p, j) => (
                        <span key={j} className="mr-3 inline-block">
                          <span className={PROBLEM_TONE[p.kind] || 'text-info'}>{PROBLEM_LABEL[p.kind] || p.kind}</span> <span className="mono">{p.path}</span>
                          {p.expected && <span className="text-subtle"> (expected {p.expected}{p.got ? `, got ${p.got}` : ''})</span>}
                        </span>
                      ))}
                    </Td>
                    <Td align="right" className="align-top text-xs text-muted">
                      <Timestamp value={v.ts} />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      )}

      {form && (
        <Dialog
          title="Lock a payload contract"
          description="Infers the payload shape from the latest message on a topic, then locks it."
          size="lg"
          onClose={() => setForm(null)}
          onSubmit={lock}
          footer={
            <>
              <Button variant="secondary" onClick={() => setForm(null)}>
                Cancel
              </Button>
              {inferred ? (
                <Button type="submit" loading={busy} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
                  Lock contract
                </Button>
              ) : (
                <Button type="submit" loading={inferring}>
                  Infer schema from latest payload
                </Button>
              )}
            </>
          }
        >
          <div className="space-y-4">
            {inferError && (
              <Banner variant="error" title="Could not complete that">
                {inferError}
              </Banner>
            )}
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              <BrokerSelect label="Broker" brokers={brokers} value={form.brokerId || brokers[0]?.id || ''} onChange={(v) => setForm({ ...form, brokerId: v })} />
              <Field label="Name">
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Filler temperature shape" />
              </Field>
              <Field label="Topic (or filter after inferring)" className="sm:col-span-2" error={topicError} help="Changing the topic discards the inferred schema.">
                <Input className="mono" aria-invalid={topicError ? 'true' : undefined} value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} placeholder="plant/line1/filler/temperature" data-autofocus />
              </Field>
            </div>
            {inferred && (
              <div>
                <p className="mb-1 text-sm font-medium text-fg">Inferred schema</p>
                <pre tabIndex={0} role="region" aria-label="Inferred schema" className="mono max-h-56 overflow-auto rounded-md border border-line bg-app p-3 text-xs text-muted">
                  {JSON.stringify(inferred.schema, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </Dialog>
      )}
      {confirmDialog}
    </>
  );
}
