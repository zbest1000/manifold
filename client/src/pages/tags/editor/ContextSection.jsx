import { useRef } from 'react';
import { Plus } from 'lucide-react';
import { Button, Meter, Table, THead, Th, Tr, Td } from '@/components/ui';
import { EditorSection, KeyValueEditor, TokenChip, ErrorText } from './parts';
import { contextErrors, contextObject, contextPlaceholders } from '../mappingModel';

const enc = new TextEncoder();
const bytesOf = (o) => (o ? enc.encode(JSON.stringify(o)).length : 0);

/**
 * Asset context: key/values describing the asset (site, line, equipment id, serial...). String
 * values may use placeholders that resolve per instance; the server's resolved result per
 * instance is shown under the editor. Limits come from the schema and are shown before the
 * server would reject anything.
 */
export default function ContextSection({ state, set, schema, profile, preview, suggested, errors, readOnly }) {
  const f = set.form;
  const focused = useRef(null); // { id, el } of the value field the placeholder chips insert into
  const lim = schema?.limits || {};
  const maxKeys = lim.maxContextKeys || 32;
  const maxBytes = lim.maxContextBytes || 4096;
  const tokens = contextPlaceholders(schema, state.srcType, profile);
  const allowed = tokens;
  const errs = contextErrors(f.context, schema, { allowed });
  const obj = contextObject(f.context);
  const used = f.context.filter((r) => String(r.key).trim()).length;
  const bytes = bytesOf(obj);
  const contexts = preview?.contexts || [];
  const instances = state.srcType === 'device-profile';
  const descriptions = schema?.placeholders?.descriptions || {};
  const missingSuggested = Object.entries(suggested || {}).filter(([k]) => !f.context.some((r) => r.key === k));
  const sectionErr = errors.filter((e) => e.section === 'context' && e.field === 'context');

  const insert = (token) => {
    const target = focused.current;
    if (!target || readOnly) {
      // No value focused: add a new row holding the token.
      set.patch({ context: [...f.context, { id: `t${Date.now().toString(36)}`, key: '', value: token, type: 'string' }] });
      return;
    }
    const el = target.el;
    const row = f.context.find((r) => r.id === target.id);
    if (!row) return;
    const at = el && typeof el.selectionStart === 'number' ? el.selectionStart : row.value.length;
    const end = el && typeof el.selectionEnd === 'number' ? el.selectionEnd : at;
    const value = `${row.value.slice(0, at)}${token}${row.value.slice(end)}`;
    set.patch({ context: f.context.map((r) => (r.id === row.id ? { ...r, value } : r)) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange?.(at + token.length, at + token.length);
    });
  };

  return (
    <EditorSection
      id="map-context"
      title="Asset context"
      count={used ? `${used} / ${maxKeys}` : undefined}
      description="Describes the asset for consumers: site, line, equipment id, serial number. Where it is published is set under Payload."
    >
      <div className="grid gap-x-6 gap-y-4 xl:grid-cols-[minmax(0,1fr)_14rem]">
        <div className="min-w-0">
          <fieldset disabled={readOnly}>
            <legend className="sr-only">Asset context keys</legend>
            <KeyValueEditor
              rows={f.context}
              typed
              errors={errs.filter((e) => e.id)}
              addLabel="Add key"
              keyPlaceholder="site"
              valuePlaceholder="dallas"
              max={maxKeys}
              onValueFocus={(id, el) => (focused.current = { id, el })}
              onChange={(rows) => set.patch({ context: rows })}
            />
          </fieldset>
          {errs.filter((e) => !e.id).map((e) => (
            <ErrorText key={e.message}>{e.message}</ErrorText>
          ))}
          {sectionErr.length > 0 && errs.length === 0 && <ErrorText>{sectionErr[0].message}</ErrorText>}
          {missingSuggested.length > 0 && !readOnly && (
            <Button
              size="sm"
              variant="ghost"
              className="-ml-2 mt-1"
              onClick={() => set.patch({ context: [...f.context, ...missingSuggested.map(([key, value], i) => ({ id: `s${Date.now().toString(36)}${i}`, key, value: String(value), type: 'string' }))] })}
            >
              <Plus size={12} aria-hidden="true" /> Add suggested: {missingSuggested.map(([k, v]) => `${k} = ${v}`).join(', ')}
            </Button>
          )}
        </div>
        <div className="min-w-0 space-y-3">
          <div>
            <p className="text-xs font-medium text-muted">Placeholders</p>
            {tokens.length ? (
              <>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {tokens.map((t) => (
                    <TokenChip key={t} token={t} label={`Insert ${t}${descriptions[t] ? ` (${descriptions[t]})` : ''}`} onInsert={insert} />
                  ))}
                </div>
                <p className="helper mt-1.5">Inserted at the caret of the value you were editing. Resolved per {instances ? 'instance' : 'device'} when publishing.</p>
              </>
            ) : (
              <p className="helper mt-1">This source takes no placeholders.</p>
            )}
          </div>
          <div>
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-muted">Size</span>
              <span className="font-mono tabular-nums text-subtle">
                {bytes.toLocaleString()} / {maxBytes.toLocaleString()} B
              </span>
            </div>
            <Meter className="mt-1" value={bytes} max={maxBytes} warnAt={0.8} badAt={1} label="Asset context size" />
            <p className="helper mt-1">
              Keys: letters, digits, _ . - (start with a letter, at most {lim.maxContextKeyLength || 64}); values up to {lim.maxContextValueLength || 256} characters.
            </p>
          </div>
        </div>
      </div>

      {obj && contexts.length > 0 && (
        <div className="mt-4">
          <p className="mb-1.5 text-xs font-medium text-muted">Resolved by the server{instances ? ' per instance' : ''}</p>
          {instances ? (
            <Table caption="Resolved asset context per instance" className="min-w-[30rem]">
              <THead>
                <Th>Instance</Th>
                {Object.keys(obj).map((k) => (
                  <Th key={k}>
                    <span className="font-mono">{k}</span>
                  </Th>
                ))}
              </THead>
              <tbody>
                {contexts.map((c) => {
                  const id = c.unitId.includes('#') ? c.unitId.split('#')[1] : c.unitId;
                  const name = profile?.instances?.find((i) => i.id === id)?.name || id;
                  return (
                    <Tr key={c.unitId}>
                      <Td header className="whitespace-nowrap font-medium">
                        {name}
                      </Td>
                      {Object.keys(obj).map((k) => (
                        <Td key={k} className="max-w-[12rem]">
                          <span className="block truncate font-mono text-xs" title={String(c.context?.[k] ?? '')}>
                            {c.context?.[k] === undefined ? '—' : String(c.context[k])}
                          </span>
                        </Td>
                      ))}
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          ) : (
            <pre tabIndex={0} role="region" aria-label="Resolved asset context" className="overflow-x-auto rounded-md border border-line bg-app px-3 py-2 font-mono text-xs text-fg">
              {JSON.stringify(contexts[0]?.context ?? null, null, 2)}
            </pre>
          )}
        </div>
      )}
    </EditorSection>
  );
}
