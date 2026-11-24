import { Button } from '@/components/ui';
import { ORDER_CODES } from '@/lib/deviceTags';
import { formatValue } from '@/lib/deviceStatus';

const MODBUS_TYPES = ['int16', 'uint16', 'int32', 'uint32', 'float32'];

function ModbusResult({ result, selectedTag, onApply }) {
  const orders = Object.keys(result.decodings || {});
  const selLabel = selectedTag ? selectedTag.key || 'the selected row' : null;
  const offset = result.address?.offset ?? 0;
  return (
    <>
      <p className="text-xs text-slate-400">
        Read <span className="mono text-slate-200">{result.address?.table} {offset}</span> (0-based) · {result.words?.length ?? 0} register{result.words?.length === 1 ? '' : 's'}
      </p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Raw register words">
        {(result.words || []).map((w, i) => (
          <span key={i} className="mono rounded-md bg-white/5 px-2 py-1 text-xs text-slate-200">
            <span className="text-slate-500">{offset + i}:</span> {w.toString(16).toUpperCase().padStart(4, '0')} <span className="text-slate-500">({w})</span>
          </span>
        ))}
      </div>
      {orders.length > 0 && (
        <div className="max-w-full overflow-x-auto rounded-xl border border-white/10" tabIndex={0} role="region" aria-label="Decodings by byte and word order (scrolls horizontally)">
          <table className="w-full border-collapse text-left text-xs">
            <caption className="sr-only">The same registers decoded with each byte and word order</caption>
            <thead className="bg-white/[0.03] text-2xs uppercase tracking-wide text-slate-400">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Order</th>
                {MODBUS_TYPES.map((t) => <th key={t} scope="col" className="px-3 py-2 font-medium">{t}</th>)}
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
                  {MODBUS_TYPES.map((t) => <td key={t} className="mono whitespace-nowrap px-3 py-2 text-slate-200">{formatValue(result.decodings[code]?.[t])}</td>)}
                  <td className="whitespace-nowrap px-3 py-1.5 text-right">
                    <Button type="button" size="sm" variant="subtle" disabled={!selectedTag} onClick={() => onApply(code, 'tag')} title={selectedTag ? '' : 'Select a tag row first'}>
                      Apply order to {selLabel ? <span className="max-w-[6rem] truncate">{selLabel}</span> : 'tag'}
                    </Button>{' '}
                    <Button type="button" size="sm" variant="ghost" onClick={() => onApply(code, 'device')}>Device default</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!selectedTag && orders.length > 0 && <p className="text-2xs text-slate-500">Select a tag row with its radio button in the table to apply an order to that tag only.</p>}
    </>
  );
}

/** S7 / EtherNet/IP: the raw bytes and every way they can be read, as a name/value table. */
function GenericResult({ result }) {
  const entries = Object.entries(result.decodings || {});
  // `value` (EtherNet/IP) is the controller-typed decoding: show it first.
  entries.sort(([a], [b]) => (b === 'value') - (a === 'value'));
  return (
    <>
      <p className="text-xs text-slate-400">
        Read <span className="mono text-slate-200">{typeof result.address === 'string' ? result.address : JSON.stringify(result.address)}</span>
        {result.type ? <> · controller type <span className="mono text-slate-200">{result.type}</span></> : null}
      </p>
      <div className="max-w-full overflow-x-auto rounded-xl border border-white/10" tabIndex={0} role="region" aria-label="Decodings (scrolls horizontally)">
        <table className="w-full border-collapse text-left text-xs">
          <caption className="sr-only">The raw bytes read from the device, decoded as each data type</caption>
          <thead className="bg-white/[0.03] text-2xs uppercase tracking-wide text-slate-400">
            <tr><th scope="col" className="px-3 py-2 font-medium">Decoded as</th><th scope="col" className="px-3 py-2 font-medium">Value</th></tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {entries.map(([name, v]) => (
              <tr key={name} className={name === 'value' ? 'bg-accent-500/5' : ''}>
                <th scope="row" className="whitespace-nowrap px-3 py-1.5 text-left font-medium text-slate-300">{name === 'value' ? 'value (as tag type)' : name}</th>
                <td className="mono break-all px-3 py-1.5 text-slate-100">{formatValue(v)}</td>
              </tr>
            ))}
            {!entries.length && <tr><td colSpan={2} className="px-3 py-3 text-slate-500">No decodings returned.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function ProbeResult({ protocol, result, selectedTag, onApply }) {
  return (
    <div className="space-y-2" aria-live="polite" data-testid="probe-result">
      {protocol === 'modbus-tcp' ? <ModbusResult result={result} selectedTag={selectedTag} onApply={onApply} /> : <GenericResult result={result} />}
      <p className="mono break-all text-2xs text-slate-500">raw: {result.rawHex}</p>
    </div>
  );
}
