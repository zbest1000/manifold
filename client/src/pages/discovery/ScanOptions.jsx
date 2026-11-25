import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { Input, Checkbox } from '@/components/ui';
import { SCAN_KINDS, parsePorts, portsFor } from '@/lib/discoveryDevices';

const portsText = (kind, ports) => portsFor(kind, ports[kind.id]).join(', ');

/** Problems in the advanced fields: { portField: [bad entries], numberField: 'message' }. */
export function advancedProblems({ ports, mqttWs, advanced, bounds }) {
  const out = {};
  for (const k of SCAN_KINDS) {
    const bad = parsePorts(ports[k.id]).bad;
    if (bad.length) out[k.id] = `Not a port: ${bad.join(', ')}`;
  }
  const ws = parsePorts(mqttWs).bad;
  if (ws.length) out.mqttWs = `Not a port: ${ws.join(', ')}`;
  for (const [key, [lo, hi]] of Object.entries(bounds || {})) {
    const v = String(advanced[key] ?? '').trim();
    if (v === '') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) out[key] = `A whole number from ${lo} to ${hi}`;
  }
  return out;
}

const NUMBER_FIELDS = [
  { key: 'concurrency', label: 'Connections at once', help: 'Across the whole scan. Lower is gentler.' },
  { key: 'perHost', label: 'Connections per host', help: 'To any one address. PLCs have few connection slots.' },
  { key: 'timeoutMs', label: 'Connect timeout (ms)', help: 'How long to wait for a port to answer a connect.' },
  { key: 'identifyTimeoutMs', label: 'Identify timeout (ms)', help: 'How long an open port has to answer its protocol.' }
];

/**
 * What to look for: one checkbox per protocol (MQTT, OPC UA, i3X on by default; Modbus, S7, EtherNet/IP,
 * which talk to PLCs, off), and an Advanced disclosure for ports and pacing.
 */
export default function ScanOptions({ kinds, onKinds, ports, onPorts, mqttWs, onMqttWs, advanced, onAdvanced, defaults, problems, disabled }) {
  const legend = useId();
  const advancedId = useId();
  const [open, setOpen] = useState(false);
  const group = (device) => SCAN_KINDS.filter((k) => Boolean(k.device) === device);
  const row = (k) => (
    <Checkbox
      key={k.id}
      label={k.label}
      description={`port${portsFor(k, ports[k.id]).length === 1 ? '' : 's'} ${portsText(k, ports)}`}
      checked={Boolean(kinds[k.id])}
      onChange={(on) => onKinds({ ...kinds, [k.id]: on })}
      disabled={disabled}
    />
  );
  return (
    <div className="space-y-3">
      <fieldset disabled={disabled} className="min-w-0">
        <legend className="mb-2 text-xs font-medium text-muted">Look for</legend>
        <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <div className="space-y-2.5">
            <p className="text-xs text-subtle">Brokers and servers</p>
            {group(false).map(row)}
          </div>
          <div className="space-y-2.5">
            <p className="text-xs text-subtle">PLCs and meters (off unless you tick them)</p>
            {group(true).map(row)}
          </div>
        </div>
      </fieldset>

      <div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={advancedId}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 rounded text-sm text-muted transition-colors hover:text-fg"
        >
          <ChevronRight size={14} aria-hidden="true" className={clsx('transition-transform', open && 'rotate-90')} />
          Advanced options
        </button>
        <div id={advancedId} hidden={!open} className="mt-3 space-y-4">
          <fieldset disabled={disabled} className="min-w-0">
            <legend className="mb-2 text-xs font-medium text-muted" id={`${legend}-ports`}>
              Ports to probe (blank = default)
            </legend>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {SCAN_KINDS.map((k) => (
                <label key={k.id} className="block space-y-1">
                  <span className="block text-xs text-muted">{k.label} ports</span>
                  <Input className="mono" inputMode="numeric" value={ports[k.id] ?? ''} placeholder={k.ports.join(', ')} aria-invalid={problems[k.id] ? true : undefined} onChange={(e) => onPorts({ ...ports, [k.id]: e.target.value })} />
                  {problems[k.id] && (
                    <span role="alert" className="block text-xs text-bad">
                      {problems[k.id]}
                    </span>
                  )}
                </label>
              ))}
              <label className="block space-y-1">
                <span className="block text-xs text-muted">MQTT over WebSocket ports</span>
                <Input className="mono" inputMode="numeric" value={mqttWs} placeholder="none, e.g. 9001" aria-invalid={problems.mqttWs ? true : undefined} onChange={(e) => onMqttWs(e.target.value)} />
                {problems.mqttWs && (
                  <span role="alert" className="block text-xs text-bad">
                    {problems.mqttWs}
                  </span>
                )}
              </label>
            </div>
          </fieldset>
          <fieldset disabled={disabled} className="min-w-0">
            <legend className="mb-2 text-xs font-medium text-muted">Pacing (blank = default)</legend>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {NUMBER_FIELDS.map((f) => (
                <label key={f.key} className="block space-y-1">
                  <span className="block text-xs text-muted">{f.label}</span>
                  <Input className="mono" inputMode="numeric" value={advanced[f.key] ?? ''} placeholder={String(defaults?.[f.key] ?? '')} aria-invalid={problems[f.key] ? true : undefined} onChange={(e) => onAdvanced({ ...advanced, [f.key]: e.target.value })} />
                  <span className="helper block">{problems[f.key] || f.help}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </div>
    </div>
  );
}
