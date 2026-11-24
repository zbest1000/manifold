import clsx from 'clsx';
import { AlertTriangle } from 'lucide-react';
import { pretty, unitTypeLabel } from './previewModel';

const help = 'text-xs leading-snug text-slate-400';

/**
 * One row per tag: editable name (with unit/type beside it), the resolved topic, the example
 * payload, and any warning with the fix right there (the name field).
 * item: { row, entry, rawAddress, clashOthers, clashSelf, slugged, fallbackTopic, memberPayload }
 */
function TagRow({ item, editable, mode, object, live, onRename }) {
  const { row, entry, rawAddress, clashOthers, clashSelf, slugged, fallbackTopic, memberPayload } = item;
  const topic = entry?.topic || fallbackTopic;
  const blocked = clashOthers || clashSelf;
  const payload = entry ? entry.payload : memberPayload;
  const bad = blocked || rawAddress;
  const label = unitTypeLabel(row.meta);
  return (
    <li className={clsx('grid gap-x-3 gap-y-1.5 px-3 py-2.5 sm:grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)]', blocked && 'bg-rose-500/10')}>
      <div className="min-w-0">
        {editable ? (
          <input
            value={row.name}
            onChange={(e) => onRename(row.key, e.target.value)}
            aria-label={`Published name for ${row.address}`}
            aria-invalid={bad || undefined}
            className={clsx(
              'w-full rounded-lg border bg-surface-950/60 px-2 py-1 font-mono text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-accent-500/30',
              blocked ? 'border-rose-500/60' : bad ? 'border-amber-500/50' : 'border-white/10'
            )}
          />
        ) : (
          <span className="font-mono text-xs text-slate-100">{row.name}</span>
        )}
        <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-slate-400">
          <span className="truncate font-mono" title={row.address}>{row.address}</span>
          {label && <span className="text-slate-300">{label}</span>}
        </p>
      </div>
      <div className="min-w-0 space-y-1">
        <p className={clsx('break-all font-mono text-xs', blocked ? 'text-rose-300' : 'text-slate-100')}>
          {mode === 'sparkplug' ? `metric ${row.name}` : object ? `member "${row.name}" of the object` : topic}
        </p>
        {payload !== undefined && (
          <pre
            aria-label={`Example payload for ${row.name}`}
            className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/30 px-2 py-1 font-mono text-xs text-slate-300"
          >
            {pretty(payload)}
          </pre>
        )}
        {live && entry && !entry.hasValue && <p className={help}>No value read yet: the payload shows a placeholder.</p>}
        {clashOthers && (
          <p className="text-xs text-rose-300">
            Already published by {clashOthers.map((b) => b.name || b.id).join(', ')}. Rename this tag or change the asset path.
          </p>
        )}
        {clashSelf && <p className="text-xs text-rose-300">Same topic as another tag in this binding.</p>}
        {rawAddress && (
          <p className="flex items-start gap-1 text-xs text-amber-300">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" aria-hidden="true" /> {rawAddress.message}
          </p>
        )}
        {!bad && slugged && <p className="text-xs text-amber-300">Characters the server replaces with _ (becomes {slugged}).</p>}
      </div>
    </li>
  );
}

export default function PreviewList({ items, editable, mode, object, live, onRename, truncated, total }) {
  return (
    <div>
      <ul aria-label="Per-tag preview" className="max-h-96 divide-y divide-white/5 overflow-auto rounded-xl border border-white/5">
        {items.map((it) => (
          <TagRow key={it.row.key} item={it} editable={editable} mode={mode} object={object} live={live} onRename={onRename} />
        ))}
      </ul>
      {truncated && <p className={clsx(help, 'mt-1')}>Showing the first {items.length} of {total} tags; collisions and warnings are checked across all of them.</p>}
    </div>
  );
}
