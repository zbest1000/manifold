import { useState } from 'react';
import { FileCheck2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { formatDistanceToNow } from 'date-fns';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Card, Button, Input, Field, Badge, Banner, Table, THead, Th, Tr, Td, useConfirm } from '@/components/ui';
import { BrokerSelect, ListState } from './shared';
import { RowActions } from '@/components/ui';
import { brokerName } from './helpers';

const PROBLEM_COLOR = { 'type-changed': 'text-amber-300', 'missing-field': 'text-rose-300' };

export default function ContractsTab({ brokers }) {
  const [form, setForm] = useState({ brokerId: '', topic: '', name: '' });
  const [inferred, setInferred] = useState(null); // { topic, schema }
  const [confirm, confirmDialog] = useConfirm();

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

  const infer = async () => {
    try {
      setInferred(await api.inferContract(form.brokerId || brokers[0]?.id, form.topic));
    } catch (e) {
      toast.error(e.message);
    }
  };

  const lock = async () => {
    try {
      await api.saveContract({ name: form.name || null, brokerId: form.brokerId || brokers[0]?.id, filter: form.topic, schema: inferred.schema });
      setInferred(null);
      setForm((f) => ({ ...f, topic: '', name: '' }));
      reload();
      toast.success('Contract locked');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const remove = async (c) => {
    const ok = await confirm({ title: `Delete the contract for "${c.filter || c.id}"?`, message: 'Drift on this topic will no longer be reported.', confirmLabel: 'Delete contract', danger: true });
    if (!ok) return;
    try {
      await api.deleteContract(c.id);
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <>
      <ListState
        loading={loading}
        error={error}
        reload={reload}
        count={contracts.length}
        label="contracts"
        empty={{
          icon: FileCheck2,
          title: 'No payload contracts yet',
          hint: 'Lock the shape of a topic’s payload and Manifold flags drift when a message stops matching. Infer a schema below to get started.'
        }}
      >
        <Table caption="Payload contracts">
          <THead>
            <Th>Contract</Th>
            <Th>Scope</Th>
            <Th srOnly align="right">Actions</Th>
          </THead>
          <tbody>
            {contracts.map((c) => {
              const k = counters[c.id] || {};
              const name = c.name || c.filter;
              return (
                <Tr key={c.id}>
                  <Td header>
                    <span className="block max-w-[14rem] truncate text-slate-100">{name}</span>
                    <Badge status={k.violations ? 'error' : 'connected'} className="mt-1">
                      {k.violations ? `${k.violations} violations` : 'conforming'}
                    </Badge>
                  </Td>
                  <Td className="max-w-[26rem]">
                    <p className="truncate font-mono text-xs text-muted">
                      {brokerName(brokers, c.brokerId)} · {c.filter} · {k.checked || 0} checked · locked {c.lockedAt ? formatDistanceToNow(new Date(c.lockedAt), { addSuffix: true }) : ''}
                    </p>
                  </Td>
                  <Td align="right">
                    <RowActions what={`contract ${name}`} onDelete={() => remove(c)} />
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </ListState>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-100">Lock a payload contract</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <BrokerSelect label="Broker" brokers={brokers} value={form.brokerId || brokers[0]?.id || ''} onChange={(v) => setForm({ ...form, brokerId: v })} />
          <Field label="Topic (or filter after inferring)" className="sm:col-span-2">
            <Input value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} placeholder="plant/line1/filler/temperature" />
          </Field>
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="filler temp shape" />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" onClick={infer} disabled={!form.topic}>
            Infer schema from latest payload
          </Button>
          {inferred && <Button onClick={lock}>Lock contract</Button>}
        </div>
        {inferred && (
          <pre tabIndex={0} role="region" aria-label="Inferred schema" className="mono mt-3 max-h-48 overflow-auto rounded-xl border border-white/10 bg-surface-950/60 p-3 text-xs text-slate-300">
            {JSON.stringify(inferred.schema, null, 2)}
          </pre>
        )}
      </Card>

      <section aria-labelledby="violations-heading">
        <h2 id="violations-heading" className="label-xs mb-2">
          Recent violations
        </h2>
        {!error && violations.length === 0 && <p className="helper">No drift detected.</p>}
        {error && violations.length === 0 && <Banner variant="warn">Violations could not be loaded.</Banner>}
        <ul className="space-y-1">
          {violations.map((v, i) => (
            <li key={i} className="rounded-lg bg-black/20 px-3 py-1.5 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-x-3">
                <span className="break-all font-mono text-slate-300">{v.topic}</span>
                <span className="text-subtle">{formatDistanceToNow(v.ts, { addSuffix: true })}</span>
              </div>
              <div className="mt-0.5 text-muted">
                {v.problems.map((p, j) => (
                  <span key={j} className="mr-2">
                    <span className={PROBLEM_COLOR[p.kind] || 'text-sky-300'}>{p.kind}</span> <span className="font-mono">{p.path}</span>
                    {p.expected && ` (expected ${p.expected}${p.got ? `, got ${p.got}` : ''})`}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </section>
      {confirmDialog}
    </>
  );
}
