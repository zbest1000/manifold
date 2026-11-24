import { useState } from 'react';
import { Microscope, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Button, Input } from '@/components/ui';
import { FormField } from './FormControls';
import { ORDER_CODES } from '@/lib/deviceTags';
import { formatValue } from '@/lib/deviceStatus';

const TYPES = ['int16', 'uint16', 'int32', 'uint32', 'float32'];

/**
 * Commissioning probe: read raw registers from the saved device and show the
 * four byte/word-order decodings side by side so the right one can be picked.
 */
export default function ProbePanel({ deviceId, defaultUnitId, selectedTag, onApply }) {
  const [address, setAddress] = useState('');
  const [count, setCount] = useState(2);
  const [unitId, setUnitId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  if (!deviceId) {
    return <p className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-3 text-xs text-slate-400">Save the device first. The probe reads from the saved configuration.</p>;
  }

  const run = async (e) => {
    e?.preventDefault?.();
    if (!address.trim()) return setError('Enter an address to read, for example holding:100');
    setBusy(true);
    setError('');
    try {
      const body = { address: address.trim(), count: Number(count) || 1 };
      if (unitId !== '') body.unitId = Number(unitId);
      setResult(await api.probeDevice(deviceId, body));
    } catch (err) {
      setResult(null);
      setError(err.message || 'Probe failed');
    } finally {
      setBusy(false);
    }
  };

  const orders = result ? Object.keys(result.decodings || {}) : [];
  const selLabel = selectedTag ? selectedTag.key || 'the selected row' : null;

  return (
    <div className="space-y-3">
      <div role="group" aria-label="Probe request" onKeyDown={(e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') run(e); }} className="grid grid-cols-2 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_6rem_7rem_auto]">
        <FormField label="Address" className="col-span-2 sm:col-span-1">
          {(a) => <Input {...a} className="mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="holding:100" />}
        </FormField>
        <FormField label="Registers">
          {(a) => <Input {...a} type="number" min={1} max={125} value={count} onChange={(e) => setCount(e.target.value)} />}
        </FormField>
        <FormField label="Unit id">
          {(a) => <Input {...a} type="number" min={0} max={255} value={unitId} onChange={(e) => setUnitId(e.target.value)} placeholder={defaultUnitId !== undefined ? String(defaultUnitId) : ''} />}
        </FormField>
        <Button type="button" onClick={run} disabled={busy} className="col-span-2 sm:col-span-1">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Microscope size={14} />} Read
        </Button>
      </div>
      <p className="text-2xs text-slate-500">Same address notation as tags, e.g. holding:100 or 40101. Reads use the saved device settings.</p>
      {selectedTag?.address && (
        <button type="button" onClick={() => setAddress(selectedTag.address)} className="text-xs text-accent-300 underline-offset-2 hover:underline">
          Use address of {selLabel}: <span className="mono">{selectedTag.address}</span>
        </button>
      )}
      {error && (
        <div role="alert" className="flex items-center justify-between gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          <span>{error}</span>
          <Button type="button" size="sm" variant="outline" onClick={run}>Retry</Button>
        </div>
      )}
      {result && (
        <div className="space-y-2" aria-live="polite">
          <p className="text-xs text-slate-400">
            Read <span className="mono text-slate-200">{result.address.table} {result.address.offset}</span> (0-based) ·{' '}
            {result.words.length} register{result.words.length === 1 ? '' : 's'}
          </p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Raw register words">
            {result.words.map((w, i) => (
              <span key={i} className="mono rounded-md bg-white/5 px-2 py-1 text-xs text-slate-200">
                <span className="text-slate-500">{(result.address.offset ?? 0) + i}:</span> {w.toString(16).toUpperCase().padStart(4, '0')} <span className="text-slate-500">({w})</span>
              </span>
            ))}
          </div>
          <p className="mono break-all text-2xs text-slate-500">raw: {result.rawHex}</p>
          <div className="max-w-full overflow-x-auto rounded-xl border border-white/10" tabIndex={0} role="region" aria-label="Decodings by byte and word order (scrolls horizontally)">
            <table className="w-full border-collapse text-left text-xs">
              <caption className="sr-only">The same registers decoded with each byte and word order</caption>
              <thead className="bg-white/[0.03] text-2xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Order</th>
                  {TYPES.map((t) => <th key={t} scope="col" className="px-3 py-2 font-medium">{t}</th>)}
                  <th scope="col" className="px-3 py-2 font-medium"><span className="sr-only">Apply</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {orders.map((code) => (
                  <tr key={code}>
                    <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-semibold text-slate-200">
                      <span className="mono">{code}</span>
                      <span className="ml-1.5 text-2xs font-normal text-slate-500">{ORDER_CODES[code] ? `${ORDER_CODES[code].byteOrder}/${ORDER_CODES[code].wordOrder}` : ''}</span>
                    </th>
                    {TYPES.map((t) => <td key={t} className="mono whitespace-nowrap px-3 py-2 text-slate-200">{formatValue(result.decodings[code]?.[t])}</td>)}
                    <td className="whitespace-nowrap px-3 py-1.5 text-right">
                      <Button type="button" size="sm" variant="subtle" disabled={!selectedTag} onClick={() => onApply(code, 'tag')} title={selectedTag ? '' : 'Select a tag row first'}>
                        Use for {selLabel ? <span className="max-w-[6rem] truncate">{selLabel}</span> : 'tag'}
                      </Button>{' '}
                      <Button type="button" size="sm" variant="ghost" onClick={() => onApply(code, 'device')}>Device default</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!selectedTag && <p className="text-2xs text-slate-500">Select a tag row with its radio button in the table to apply an order to that tag only.</p>}
        </div>
      )}
    </div>
  );
}
