import { Radar } from 'lucide-react';
import clsx from 'clsx';
import { Banner, Button, Checkbox, Dialog, Field, Input, Select, Mono } from '@/components/ui';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import CertificatesSection from './CertificatesSection';
import { SECURITY_MODES, SECURITY_POLICIES, problemField, withCurrent } from './helpers';

/**
 * The connect / edit dialog for an OPC UA server: endpoint with discovery, security, credentials and
 * the certificate trust flow. `problem` is a validation message shown only after the first submit;
 * `submitError` is what the server answered; `secretError` (400 secret-required) is shown on the password field.
 */
export default function ConnectionForm({ form, setForm, editing, endpoints, discovering, busy, problem, submitError, secretError = null, duplicate = null, onEditExisting = null, failedAttempts = 0, onDiscover, onSubmit, onCancel }) {
  const readOnly = useReadOnly();
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const field = problem ? problemField(problem) : null;
  const secure = form.securityMode !== 'None';
  return (
    <Dialog
      title={editing ? 'Edit OPC UA connection' : 'New OPC UA connection'}
      description={editing ? 'Saving reconnects with the new settings. Leave the password blank to keep the stored one.' : 'Manifold opens a session, browses the address space and can monitor values live.'}
      size="lg"
      onClose={onCancel}
      onSubmit={onSubmit}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
            {editing ? 'Save changes' : 'Connect'}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        {duplicate && (
          <Banner variant="error" title="This server is already connected">
            <span data-testid="opcua-duplicate">
              &ldquo;{duplicate.name}&rdquo; uses the same endpoint URL, security mode and policy, and user. A second identical connection would open a second session
              reading the same data. Edit &ldquo;{duplicate.name}&rdquo; instead, or change the security or the user here.
            </span>
            {onEditExisting && (
              <Button size="sm" variant="secondary" className="mt-2" onClick={onEditExisting}>
                Edit &ldquo;{duplicate.name}&rdquo;
              </Button>
            )}
          </Banner>
        )}
        {submitError && (
          <Banner variant="error" title={editing ? 'Could not save the connection' : 'Could not connect'}>
            {submitError}
          </Banner>
        )}

        <fieldset className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-medium text-fg">Server</legend>
          <Field label="Name" className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="PLC gateway" data-autofocus />
          </Field>
          <div className="flex items-start gap-2 sm:col-span-2">
            <Field label="Endpoint URL" error={field === 'url' ? problem : undefined} className="min-w-0 flex-1">
              <Input className="mono" aria-invalid={field === 'url' ? 'true' : undefined} value={form.endpointUrl} onChange={(e) => set({ endpointUrl: e.target.value })} placeholder="opc.tcp://host:4840" />
            </Field>
            <Button type="button" variant="secondary" className="mt-[22px]" onClick={onDiscover} loading={discovering} disabled={!form.endpointUrl} title="List the server's endpoints and their security settings">
              {!discovering && <Radar size={14} aria-hidden="true" />} Discover
            </Button>
          </div>
        </fieldset>

        {endpoints && (
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-fg">Endpoints the server offers</legend>
            <p className="mb-2 text-xs text-subtle">Pick one to fill in the security mode and policy. A higher level is stronger.</p>
            {endpoints.length === 0 ? (
              <p className="text-sm text-muted">The server reported no endpoints.</p>
            ) : (
              <ul className="divide-y divide-line rounded-md border border-line" aria-label="Discovered endpoints">
                {endpoints.map((ep, i) => {
                  const active = form.securityMode === ep.securityMode && form.securityPolicy === ep.securityPolicy;
                  return (
                    <li key={`${ep.securityMode}-${ep.securityPolicy}-${i}`}>
                      <button
                        type="button"
                        aria-pressed={active}
                        onClick={() => set({ securityMode: ep.securityMode, securityPolicy: ep.securityPolicy })}
                        className={clsx(
                          'flex w-full items-center justify-between gap-3 border-l-2 px-3 py-2 text-left text-sm transition-colors hover:bg-raised',
                          active ? 'border-accent bg-accent/[0.07]' : 'border-transparent'
                        )}
                      >
                        <Mono className="truncate">
                          {ep.securityMode} · {ep.securityPolicy}
                        </Mono>
                        <span className="flex shrink-0 items-center gap-3 text-xs text-muted">
                          {ep.serverCertificate?.thumbprint && <Mono className="hidden text-subtle sm:inline">{ep.serverCertificate.thumbprint.slice(0, 12)}…</Mono>}
                          <span className="tabular-nums">level {ep.securityLevel}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>
        )}

        <fieldset className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-medium text-fg">Security</legend>
          <Select label="Security mode" value={form.securityMode} onChange={(e) => set({ securityMode: e.target.value })} options={withCurrent(SECURITY_MODES, form.securityMode)} />
          <Select
            label="Security policy"
            value={form.securityPolicy}
            error={field === 'security' ? problem : undefined}
            aria-invalid={field === 'security' ? 'true' : undefined}
            onChange={(e) => set({ securityPolicy: e.target.value })}
            options={withCurrent(SECURITY_POLICIES, form.securityPolicy)}
          />
          {!secure && (
            <div className="sm:col-span-2">
              <Banner variant="info">Mode None sends everything unencrypted and unsigned. Use it only on a trusted plant network; choose Sign or SignAndEncrypt with a policy otherwise.</Banner>
            </div>
          )}
          {secure && <Checkbox className="sm:col-span-2" label="Trust server certificate on first connect" checked={form.trustServer} onChange={(v) => set({ trustServer: v })} />}
        </fieldset>

        <fieldset className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-medium text-fg">Authentication</legend>
          <Field label="Username (optional)">
            <Input value={form.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" placeholder="Anonymous" />
          </Field>
          <Field label="Password" error={secretError || undefined}>
            <Input type="password" aria-invalid={secretError ? 'true' : undefined} value={form.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" placeholder={editing ? 'Unchanged' : ''} />
          </Field>
        </fieldset>

        <CertificatesSection key={secure ? 'secure' : 'plain'} defaultOpen={secure} refreshKey={failedAttempts} />
      </div>
    </Dialog>
  );
}
