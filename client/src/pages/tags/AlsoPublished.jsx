import { pretty } from './previewModel';

const help = 'text-xs leading-snug text-slate-400';

/** The retained documents a binding publishes besides the data, with their opt-out toggles. */
export default function AlsoPublished({ form, set, statusT, metaT, data }) {
  const statuses = data?.status || [];
  const metas = data?.meta || [];
  return (
    <div className="space-y-2 rounded-xl border border-white/10 px-3 py-2.5">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">Also published (retained)</h4>
      <label className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 text-sm text-slate-100">
        <input type="checkbox" checked={form.statusTopic} onChange={(e) => set({ statusTopic: e.target.checked })} className="row-span-2 mt-1 accent-accent-500" />
        <span className="font-mono text-xs break-all">{statusT || '<asset>/_status'}</span>
        <span className={help}>
          Online or offline, since when and why, so consumers can see when the source is down.
          {statuses.length > 1 ? ` One per instance (${statuses.length}).` : ''}
        </span>
      </label>
      <label className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 text-sm text-slate-100">
        <input type="checkbox" checked={form.metaTopic} onChange={(e) => set({ metaTopic: e.target.checked })} className="row-span-2 mt-1 accent-accent-500" />
        <span className="font-mono text-xs break-all">{metaT || '<asset>/_meta'}</span>
        <span className={help}>Each tag's type, unit, range and where it comes from, for discovery tools.</span>
      </label>
      {form.metaTopic && metas[0] && (
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-300">Example _meta document</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/30 px-2 py-1 font-mono text-slate-300">{pretty(metas[0].payload)}</pre>
        </details>
      )}
      {!form.statusTopic && !form.metaTopic && <p className={help}>Neither is published. Consumers cannot tell a quiet source from a dead one.</p>}
    </div>
  );
}
