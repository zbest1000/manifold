import { Trash2 } from 'lucide-react';
import { formatRenameMap, parseCsv, parseJsonObject, parseRenameMap } from './helpers';

function Mini({ label, className = '', ...props }) {
  return (
    <input
      aria-label={label}
      {...props}
      className={`rounded-lg border border-white/10 bg-surface-950/60 px-2 py-1 font-mono text-xs text-slate-200 placeholder:text-faint focus:border-accent-500/60 focus:outline-none ${className}`}
    />
  );
}

/** One editable step in a route's transform chain. */
export default function TransformRow({ t, index, onChange, onRemove }) {
  const n = index + 1;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-black/20 px-2 py-1.5 text-xs">
      <span className="rounded bg-accent-500/15 px-1.5 py-0.5 font-mono text-2xs text-accent-300">
        {n}. {t.type}
      </span>
      {t.type === 'repath' && (
        <Mini
          label={`Transform ${n}: new topic`}
          value={t.to}
          className="w-full sm:w-64"
          placeholder="uns/{1}/{3-}  ({n}=segment, {n-}=tail, {topic})"
          onChange={(e) => onChange({ ...t, to: e.target.value })}
        />
      )}
      {t.type === 'pick' && (
        <Mini
          label={`Transform ${n}: fields to keep`}
          value={(t.fields || []).join(',')}
          className="w-full sm:w-56"
          placeholder="field1,field2"
          onChange={(e) => onChange({ ...t, fields: parseCsv(e.target.value) })}
        />
      )}
      {t.type === 'rename' && (
        <Mini
          label={`Transform ${n}: rename map`}
          value={formatRenameMap(t.map)}
          className="w-full sm:w-56"
          placeholder="old:new,old2:new2"
          onChange={(e) => onChange({ ...t, map: parseRenameMap(e.target.value) })}
        />
      )}
      {t.type === 'set' && (
        <Mini
          label={`Transform ${n}: values to set (JSON)`}
          defaultValue={JSON.stringify(t.values || {})}
          className="w-full sm:w-56"
          placeholder='{"site":"emmeloord"}'
          onChange={(e) => {
            const v = parseJsonObject(e.target.value);
            if (v) onChange({ ...t, values: v }); // keep typing while the JSON is incomplete
          }}
        />
      )}
      {t.type === 'scale' && (
        <>
          <Mini label={`Transform ${n}: field (optional)`} value={t.field || ''} className="w-28" placeholder="field (opt)" onChange={(e) => onChange({ ...t, field: e.target.value })} />
          <span aria-hidden="true">×</span>
          <Mini label={`Transform ${n}: multiply by`} value={t.mul} className="w-16" onChange={(e) => onChange({ ...t, mul: e.target.value })} />
          <span aria-hidden="true">+</span>
          <Mini label={`Transform ${n}: add`} value={t.add} className="w-16" onChange={(e) => onChange({ ...t, add: e.target.value })} />
        </>
      )}
      {t.type === 'numeric' && (
        <Mini label={`Transform ${n}: field (optional)`} value={t.field || ''} className="w-32" placeholder="field (optional)" onChange={(e) => onChange({ ...t, field: e.target.value })} />
      )}
      {t.type === 'sparkplugFlatten' && <span className="text-muted">metrics[] → {'{name: value}'}</span>}
      {t.type === 'envelope' && <span className="text-muted">wrap as {'{v, t, q}'} (value, source ts, quality)</span>}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove transform ${n} (${t.type})`}
        className="ml-auto rounded p-1.5 text-muted hover:bg-white/10 hover:text-rose-300"
      >
        <Trash2 size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
