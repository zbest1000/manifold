import { Button, Table, THead, Th, Tr, Td } from '@/components/ui';
import { ORDER_CODES } from '@/lib/deviceTags';
import { formatValue } from '@/lib/deviceStatus';

const MODBUS_TYPES = ['int16', 'uint16', 'int32', 'uint32', 'float32'];

function ModbusResult({ result, selectedTag, onApply }) {
  const orders = Object.keys(result.decodings || {});
  const selLabel = selectedTag ? selectedTag.key || 'the selected row' : null;
  const offset = result.address?.offset ?? 0;
  return (
    <>
      <p className="text-sm text-muted">
        Read <span className="mono text-xs text-fg">{result.address?.table} {offset}</span> (0-based) · {result.words?.length ?? 0} register{result.words?.length === 1 ? '' : 's'}
      </p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Raw register words">
        {(result.words || []).map((w, i) => (
          <span key={i} className="mono rounded border border-line bg-raised px-2 py-1 text-xs text-fg">
            <span className="text-subtle">{offset + i}:</span> {w.toString(16).toUpperCase().padStart(4, '0')} <span className="text-subtle">({w})</span>
          </span>
        ))}
      </div>
      {orders.length > 0 && (
        <Table caption="Decodings by byte and word order" className="min-w-[36rem]">
          <THead>
            <Th>Order</Th>
            {MODBUS_TYPES.map((t) => (
              <Th key={t} align="right">{t}</Th>
            ))}
            {onApply && <Th srOnly align="right">Apply</Th>}
          </THead>
          <tbody>
            {orders.map((code) => (
              <Tr key={code}>
                <Td header className="whitespace-nowrap">
                  <span className="mono text-xs font-medium text-fg">{code}</span>
                  <span className="ml-1.5 text-xs text-subtle">{ORDER_CODES[code] ? `${ORDER_CODES[code].byteOrder}/${ORDER_CODES[code].wordOrder}` : ''}</span>
                </Td>
                {MODBUS_TYPES.map((t) => (
                  <Td key={t} align="right" className="mono whitespace-nowrap text-xs tabular-nums">{formatValue(result.decodings[code]?.[t])}</Td>
                ))}
                {onApply && (
                  <Td align="right" className="whitespace-nowrap">
                    <Button type="button" size="sm" variant="secondary" disabled={!selectedTag} onClick={() => onApply(code, 'tag')} title={selectedTag ? '' : 'Select a tag row first'}>
                      Apply order to {selLabel ? <span className="max-w-[6rem] truncate">{selLabel}</span> : 'tag'}
                    </Button>{' '}
                    <Button type="button" size="sm" variant="ghost" onClick={() => onApply(code, 'device')}>
                      Device default
                    </Button>
                  </Td>
                )}
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {onApply && !selectedTag && orders.length > 0 && <p className="helper">Click a row number in the tag table to apply an order to that tag only.</p>}
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
      <p className="text-sm text-muted">
        Read <span className="mono text-xs text-fg">{typeof result.address === 'string' ? result.address : JSON.stringify(result.address)}</span>
        {result.type ? (
          <>
            {' '}· controller type <span className="mono text-xs text-fg">{result.type}</span>
          </>
        ) : null}
      </p>
      <Table caption="The raw bytes read from the device, decoded as each data type" className="min-w-[20rem]">
        <THead>
          <Th>Decoded as</Th>
          <Th>Value</Th>
        </THead>
        <tbody>
          {entries.map(([name, v]) => (
            <Tr key={name} highlight={name === 'value'}>
              <Td header className="whitespace-nowrap text-sm text-fg">{name === 'value' ? 'value (as tag type)' : name}</Td>
              <Td className="mono break-all text-xs">{formatValue(v)}</Td>
            </Tr>
          ))}
          {!entries.length && (
            <tr>
              <td colSpan={2} className="px-3 py-3 text-sm text-muted">No decodings returned.</td>
            </tr>
          )}
        </tbody>
      </Table>
    </>
  );
}

export default function ProbeResult({ protocol, result, selectedTag, onApply }) {
  return (
    <div className="space-y-2" aria-live="polite" data-testid="probe-result">
      {protocol === 'modbus-tcp' ? <ModbusResult result={result} selectedTag={selectedTag} onApply={onApply} /> : <GenericResult result={result} />}
      {result.rawHex !== undefined && <p className="mono break-all text-xs text-subtle">raw: {result.rawHex}</p>}
    </div>
  );
}
