import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Panel, Select, Toggle, Input, Field, Button, Banner, Badge, EmptyState, LoadingState } from '@/components/ui';
import { READ_ONLY_REASON } from '@/store/selectors';
import { CONVENTION_OPTIONS, conventionLabel, draftFromConfig, configFromDraft, optionProblem } from './iotModel';
import { saveIotConfig } from './iotHooks';

/**
 * Per-broker detection settings: which conventions Manifold reads on the broker (opt-in), their
 * topic options, suggestions from traffic it has seen, and per-convention counts.
 */
export default function IotDetectionPanel({ brokers, error, loading, onRetry, onSaved, readOnly }) {
  const [pick, setPick] = useState(null);
  const brokerId = pick && brokers?.some((b) => b.id === pick) ? pick : brokers?.[0]?.id || null;
  const broker = brokers?.find((b) => b.id === brokerId) || null;
  const [drafts, setDrafts] = useState({}); // brokerId -> draft (only while edited)
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const draft = useMemo(() => (broker ? drafts[broker.id] || draftFromConfig(broker.config) : {}), [broker, drafts]);
  const dirty = broker ? Boolean(drafts[broker.id]) && JSON.stringify(configFromDraft(drafts[broker.id])) !== JSON.stringify(configFromDraft(draftFromConfig(broker.config))) : false;
  const why = readOnly ? READ_ONLY_REASON : undefined;

  const edit = (id, patch) => setDrafts((d) => ({ ...d, [broker.id]: { ...draft, [id]: { ...draft[id], ...patch } } }));
  const problems = Object.entries(draft).flatMap(([id, c]) => (CONVENTION_OPTIONS[id] || []).map(([k]) => optionProblem(id, k, c[k])).filter(Boolean));

  const save = async (next = draft) => {
    setBusy(true);
    setSaveError('');
    try {
      await saveIotConfig(broker.id, configFromDraft(next));
      setDrafts((d) => {
        const n = { ...d };
        delete n[broker.id];
        return n;
      });
      toast.success(`Detection settings saved for ${broker.name}`);
      onSaved?.();
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const accept = (s) => save({ ...draft, [s.convention]: { ...draft[s.convention], ...s.options, enabled: true } });

  return (
    <Panel
      aria-label="Detection"
      title="Detection"
      description="Manifold reads what bridges and gateways already publish. It never sends anything to these devices."
      actions={
        brokers?.length > 1 ? (
          <Select label="Broker" hideLabel id="iot-broker" value={brokerId || ''} onChange={(e) => setPick(e.target.value)} fieldClassName="w-48">
            {brokers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        ) : null
      }
    >
      {error && (
        <Banner variant="error" title="Could not load detection settings" onRetry={onRetry}>
          {error}
        </Banner>
      )}
      {loading && !brokers && <LoadingState label="detection settings" rows={3} />}
      {brokers && brokers.length === 0 && <EmptyState title="No broker connected" hint="Connect the broker your bridges publish to (Brokers page), then turn on the conventions it carries." />}
      {broker && (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Broker <span className="font-medium text-fg">{broker.name}</span> · {broker.status}
            {broker.stats ? ` · ${broker.stats.devices} device${broker.stats.devices === 1 ? '' : 's'}, ${broker.stats.tags} tags` : ''}
          </p>
          {broker.suggestions?.map((s) => (
            <Banner
              key={s.convention}
              variant="info"
              title={`${conventionLabel(s.convention)} traffic seen`}
              action={
                <Button size="sm" onClick={() => accept(s)} disabled={readOnly || busy} title={why}>
                  Turn on {conventionLabel(s.convention)}
                </Button>
              }
            >
              Seen on <span className="mono">{s.topic}</span>
              {Object.keys(s.options || {}).length ? <> ({Object.entries(s.options).map(([k, v]) => `${k} ${v}`).join(', ')})</> : null}.
            </Banner>
          ))}
          {saveError && (
            <Banner variant="error" title="Could not save">
              {saveError}
            </Banner>
          )}
          {broker.stats?.lastError && <p className="mono break-words text-xs text-warn">Last parse problem: {broker.stats.lastError}</p>}
          <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Conventions">
            {broker.conventions.map((c) => {
              const d = draft[c.id] || {};
              const opts = CONVENTION_OPTIONS[c.id] || [];
              return (
                <li key={c.id} className="space-y-2 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span title={why} className="inline-flex">
                      <Toggle checked={Boolean(d.enabled)} disabled={readOnly || busy} onChange={(v) => edit(c.id, { enabled: v })} label={c.label} />
                    </span>
                    <span className="ml-auto flex items-center gap-2 text-xs text-muted">
                      {c.devices > 0 && <Badge>{c.devices} device{c.devices === 1 ? '' : 's'}</Badge>}
                      {c.errors > 0 && <Badge tone="warn">{c.errors} unreadable</Badge>}
                      {c.info?.bridgeState && <span>bridge {c.info.bridgeState}</span>}
                      {c.info?.gatewayState && <span>gateway {c.info.gatewayState}</span>}
                      {c.info?.version && <span>v{c.info.version}</span>}
                    </span>
                  </div>
                  {d.enabled && opts.length > 0 && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {opts.map(([k, label, help]) => {
                        const problem = optionProblem(c.id, k, d[k]);
                        return (
                          <Field key={k} label={label} help={problem ? undefined : help} error={problem || undefined}>
                            <Input id={`iot-${c.id}-${k}`} value={d[k] ?? ''} disabled={readOnly || busy} onChange={(e) => edit(c.id, { [k]: e.target.value })} className="mono" />
                          </Field>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => save()} disabled={!dirty || readOnly || busy || problems.length > 0} loading={busy} title={why}>
              Save detection settings
            </Button>
            {dirty && (
              <Button variant="ghost" onClick={() => setDrafts((x) => ({ ...x, [broker.id]: undefined }))} disabled={busy}>
                Discard
              </Button>
            )}
            <span className="text-xs text-subtle">Limits: {broker.limits?.maxDevicesPerBroker} devices and {broker.limits?.maxTagsPerBroker?.toLocaleString()} tags per broker.</span>
          </div>
        </div>
      )}
    </Panel>
  );
}
