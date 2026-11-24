import { useState } from 'react';
import { api } from '@/lib/api';
import { Button, Input, Banner } from '@/components/ui';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import { FormField } from './FormControls';
import ProbeResult from './ProbeResult';
import { probeSpec, probeBody } from './model';

/**
 * Commissioning probe: read raw data from the saved device. Inputs follow the protocol (Modbus:
 * registers + unit id, S7: byte count, EtherNet/IP: tag only); the result shows the raw bytes and
 * every decoding. `onApply` (optional) lets the editor copy a byte/word order to a tag or the device.
 */
export default function ProbePanel({ deviceId, protocol, defaultUnitId, selectedTag, onApply, addressHelp }) {
  const spec = probeSpec(protocol);
  const [address, setAddress] = useState('');
  const [count, setCount] = useState(spec.count?.def ?? '');
  const [unitId, setUnitId] = useState('');
  const [busy, setBusy] = useState(false);
  const readOnly = useReadOnly();
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  if (!deviceId) {
    return <Banner variant="info">Save the device first. The probe reads from the saved configuration, and the device must be online.</Banner>;
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

  const onEnter = (e) => {
    if (e.key === 'Enter') run(e);
  };

  const layout = spec.unitId ? 'sm:grid-cols-[minmax(0,1fr)_6rem_7rem_auto]' : spec.count ? 'sm:grid-cols-[minmax(0,1fr)_6rem_auto]' : 'sm:grid-cols-[minmax(0,1fr)_auto]';
  return (
    <div className="space-y-3">
      <div role="group" aria-label="Probe request" className={`grid grid-cols-2 items-end gap-3 ${layout}`}>
        <FormField label="Address" className="col-span-2 sm:col-span-1">
          {(a) => <Input {...a} onKeyDown={onEnter} className="mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder={spec.placeholder} />}
        </FormField>
        {spec.count && (
          <FormField label={spec.count.label}>
            {(a) => <Input {...a} onKeyDown={onEnter} type="number" min={spec.count.min} max={spec.count.max} value={count} onChange={(e) => setCount(e.target.value)} placeholder={protocol === 's7' ? 'type size' : undefined} />}
          </FormField>
        )}
        {spec.unitId && (
          <FormField label="Unit id">
            {(a) => <Input {...a} onKeyDown={onEnter} type="number" min={0} max={255} value={unitId} onChange={(e) => setUnitId(e.target.value)} placeholder={defaultUnitId !== undefined ? String(defaultUnitId) : ''} />}
          </FormField>
        )}
        <span title={readOnly ? READ_ONLY_REASON : undefined} className="col-span-2 sm:col-span-1">
          <Button type="button" variant="secondary" onClick={run} loading={busy} disabled={readOnly} className="w-full">
            Read
          </Button>
        </span>
      </div>
      {addressHelp && <p className="helper">{addressHelp}</p>}
      {selectedTag?.address && (
        <button type="button" onClick={() => setAddress(selectedTag.address)} className="text-xs text-accent-text underline-offset-2 hover:underline">
          Use address of {selectedTag.key || 'the selected row'}: <span className="mono">{selectedTag.address}</span>
        </button>
      )}
      {error && (
        <Banner variant="error" title="The probe failed" onRetry={run}>
          {error}
        </Banner>
      )}
      {result && <ProbeResult protocol={protocol} result={result} selectedTag={selectedTag} onApply={onApply} />}
    </div>
  );
}
