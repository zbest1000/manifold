import { Cpu, Radar } from 'lucide-react';
import clsx from 'clsx';
import { Card, Button, Badge, Input, Field, Select, Checkbox } from '@/components/ui';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import CertificatesSection from './CertificatesSection';
import { SECURITY_MODES, SECURITY_POLICIES, withCurrent } from './helpers';

/** The connect / edit form for an OPC UA server, including endpoint discovery. */
export default function ConnectionForm({ form, setForm, editing, endpoints, discovering, busy, onDiscover, onSubmit, onCancel }) {
  const readOnly = useReadOnly();
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  return (
    <Card className="max-h-[70vh] overflow-y-auto p-4 sm:p-5">
      <form
        aria-label={editing ? 'Edit OPC UA connection' : 'New OPC UA connection'}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
      <h2 className="mb-4 text-sm font-semibold text-slate-100">{editing ? 'Edit OPC UA connection' : 'New OPC UA connection'}</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="PLC gateway" />
        </Field>
        <Field label="Endpoint URL">
          <div className="flex gap-2">
            <Input value={form.endpointUrl} onChange={(e) => set({ endpointUrl: e.target.value })} placeholder="opc.tcp://host:4840" />
            <Button
              type="button"
              variant="outline"
              onClick={onDiscover}
              disabled={discovering || !form.endpointUrl}
              title="List the server's endpoints and their security settings"
              className="shrink-0"
            >
              <Radar size={14} aria-hidden="true" /> {discovering ? 'Discovering…' : 'Discover'}
            </Button>
          </div>
        </Field>
        <Select label="Security mode" value={form.securityMode} onChange={(e) => set({ securityMode: e.target.value })} options={withCurrent(SECURITY_MODES, form.securityMode)} />
        <Select label="Security policy" value={form.securityPolicy} onChange={(e) => set({ securityPolicy: e.target.value })} options={withCurrent(SECURITY_POLICIES, form.securityPolicy)} />
        <Field label="Username (optional)">
          <Input value={form.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" placeholder="anonymous" />
        </Field>
        <Field label="Password">
          <Input type="password" value={form.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" placeholder={editing ? 'unchanged' : ''} />
        </Field>
      </div>

      {endpoints && (
        <div className="mt-4 space-y-1.5" role="group" aria-label="Discovered endpoints">
          <p className="label-xs">Discovered endpoints</p>
          {endpoints.length === 0 ? (
            <p className="helper">The server reported no endpoints.</p>
          ) : (
            endpoints.map((ep, i) => {
              const active = form.securityMode === ep.securityMode && form.securityPolicy === ep.securityPolicy;
              return (
                <button
                  type="button"
                  key={`${ep.securityMode}-${ep.securityPolicy}-${i}`}
                  aria-pressed={active}
                  onClick={() => set({ securityMode: ep.securityMode, securityPolicy: ep.securityPolicy })}
                  className={clsx(
                    'flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-xs transition-colors',
                    active ? 'border-accent-500/50 bg-accent-500/10 text-slate-100' : 'border-white/10 bg-surface-950/40 text-slate-300 hover:border-white/20 hover:bg-white/5'
                  )}
                >
                  <span className="mono truncate">
                    {ep.securityMode} · {ep.securityPolicy}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-muted">
                    {ep.serverCertificate?.thumbprint && <span className="mono hidden sm:inline">{ep.serverCertificate.thumbprint.slice(0, 12)}…</span>}
                    <Badge>level {ep.securityLevel}</Badge>
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}

      <Checkbox className="mt-4" label="Trust server certificate on first connect" checked={form.trustServer} onChange={(v) => set({ trustServer: v })} />

      <CertificatesSection />

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
          <Cpu size={15} aria-hidden="true" /> {busy ? (editing ? 'Saving…' : 'Connecting…') : editing ? 'Save changes' : 'Connect'}
        </Button>
      </div>
      </form>
    </Card>
  );
}
