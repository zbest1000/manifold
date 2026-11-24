import { useState } from 'react';
import { Microscope, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Button, Input } from '@/components/ui';
import { FormField } from './FormControls';
import ProbeResult from './ProbeResult';
import { probeSpec, probeBody } from './model';

/**
 * Commissioning probe: read raw data from the saved device. Inputs follow the
 * protocol (Modbus: registers + unit id, S7: byte count, EtherNet/IP: tag only);
 * the result shows the raw bytes and every decoding.
 */
export default function ProbePanel({ deviceId, protocol, defaultUnitId, selectedTag, onApply, addressHelp }) {
  const spec = probeSpec(protocol);
  const [address, setAddress] = useState('');
  const [count, setCount] = useState(spec.count?.def ?? '');
  const [unitId, setUnitId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  if (!deviceId) {
    return <p className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-3 text-xs text-slate-400">Save the device first. The probe reads from the saved configuration, and the device must be online.</p>;
  }

  const run = async (e) => {
    e?.preventDefault?.();
    if (!address.trim()) return setError(`Enter an address to read, for example ${spec.placeholder}`);
    setBusy(true);
    setError('');
    try {
      setResult(await api.probeDevice(deviceId, probeBody(protocol, { address, count, unitId })));
    } catch (err) {
      setResult(null);
      setError(err.message || 'Probe failed');
    } finally {
      setBusy(false);
    }
  };

  const layout = spec.unitId ? 'sm:grid-cols-[minmax(0,1fr)_6rem_7rem_auto]' : spec.count ? 'sm:grid-cols-[minmax(0,1fr)_6rem_auto]' : 'sm:grid-cols-[minmax(0,1fr)_auto]';
  return (
    <div className="space-y-3">
      <div role="group" aria-label="Probe request" onKeyDown={(e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') run(e); }} className={`grid grid-cols-2 items-end gap-3 ${layout}`}>
        <FormField label="Address" className="col-span-2 sm:col-span-1">
          {(a) => <Input {...a} className="mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder={spec.placeholder} />}
        </FormField>
        {spec.count && (
          <FormField label={spec.count.label}>
            {(a) => <Input {...a} type="number" min={spec.count.min} max={spec.count.max} value={count} onChange={(e) => setCount(e.target.value)} placeholder={protocol === 's7' ? 'type size' : undefined} />}
          </FormField>
        )}
        {spec.unitId && (
          <FormField label="Unit id">
            {(a) => <Input {...a} type="number" min={0} max={255} value={unitId} onChange={(e) => setUnitId(e.target.value)} placeholder={defaultUnitId !== undefined ? String(defaultUnitId) : ''} />}
          </FormField>
        )}
        <Button type="button" onClick={run} disabled={busy} className="col-span-2 sm:col-span-1">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Microscope size={14} />} Read
        </Button>
      </div>
      {addressHelp && <p className="text-2xs text-slate-500">{addressHelp}</p>}
      {selectedTag?.address && (
        <button type="button" onClick={() => setAddress(selectedTag.address)} className="text-xs text-accent-300 underline-offset-2 hover:underline">
          Use address of {selectedTag.key || 'the selected row'}: <span className="mono">{selectedTag.address}</span>
        </button>
      )}
      {error && (
        <div role="alert" className="flex items-center justify-between gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          <span>{error}</span>
          <Button type="button" size="sm" variant="outline" onClick={run}>Retry</Button>
        </div>
      )}
      {result && <ProbeResult protocol={protocol} result={result} selectedTag={selectedTag} onApply={onApply} />}
    </div>
  );
}
