import { useMemo } from 'react';
import clsx from 'clsx';
import { RefreshCw, AlertTriangle, Loader2 } from 'lucide-react';
import { Field, Input, Button } from '@/components/ui';
import PreviewList from './PreviewList';
import AlsoPublished from './AlsoPublished';
import { FieldError } from './TargetStep';
import { buildItems, blockingCollisions, generalWarnings, sizeSummary, fmtBytes } from './previewModel';
import { assetStatusTopic, assetMetaTopic, normalizeAssetPath } from './assetPath';
import { statusTopic } from './helpers';

const help = 'text-xs leading-snug text-slate-400';
const FORMATS = [
  { v: 'envelope', t: 'Envelope (recommended)', d: 'Value, timestamp, quality and unit, so consumers can tell a bad or stale reading from a good one.' },
  { v: 'plain', t: 'Plain value', d: 'Just the raw value. It cannot carry quality: when the source drops, only the status topic changes.' }
];

function SizeLine({ size }) {
  if (!size) return null;
  const over = size.worstCaseBytes > size.capBytes;
  return (
    <div className="rounded-xl border border-white/10 px-3 py-2">
      <p className="text-xs text-slate-200">
        Object size: about <b>{fmtBytes(size.bytes)}</b> now, worst case <b>{fmtBytes(size.worstCaseBytes)}</b> of a {fmtBytes(size.capBytes)} cap
        {size.units > 1 ? ` (largest of ${size.units} assets)` : ''}.
      </p>
      <div role="img" aria-label={`Worst case uses ${Math.round(size.ratio * 100)} percent of the cap`} className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className={clsx('h-full', over || size.ratio > 0.8 ? 'bg-amber-400' : 'bg-accent-500')} style={{ width: `${Math.round(size.ratio * 100)}%` }} />
      </div>
    </div>
  );
}

/** Step 2: published names, payload format and the live (server-side) preview. */
export default function NamingStep({ mode, srcType, form, set, resolved, collisions, rows, rename, renameable, errors, preview, isProfile }) {
  const data = preview.data?.valid ? preview.data : null;
  const live = preview.status === 'ok';
  const selfClash = useMemo(() => new Set([...collisions.values()].flat()), [collisions]);
  const items = useMemo(() => buildItems({ rows, resolved, data, isProfile, selfClash }), [rows, resolved, data, isProfile, selfClash]);
  const clash = data ? blockingCollisions(data) : [];
  const general = data ? generalWarnings(data) : [];
  const flagged = items.filter((i) => i.rawAddress || i.clashOthers || i.clashSelf).length;
  const asset = normalizeAssetPath(form.assetPath);
  const statusT = data?.status?.[0] || (isProfile ? null : form.destKind === 'asset' ? assetStatusTopic(asset) : statusTopic(form.pathTemplate));
  const metaT = data?.meta?.[0]?.topic || (isProfile || form.destKind !== 'asset' ? null : assetMetaTopic(asset));

  return (
    <section aria-label="Naming" className="space-y-3">
      {mode === 'sparkplug' && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Group"><Input value={form.group} onChange={(e) => set({ group: e.target.value })} /></Field>
          <Field label="Edge node"><Input value={form.edge} onChange={(e) => set({ edge: e.target.value })} /></Field>
          <Field label="Device"><Input value={form.device} onChange={(e) => set({ device: e.target.value })} /></Field>
          <p className={clsx(help, 'sm:col-span-3')}>
            Publishes to <span className="font-mono">spBv1.0/{form.group || '?'}/DDATA/{form.edge || '?'}/{form.device || '?'}</span>; the metric names are below.
          </p>
        </div>
      )}
      {mode === 'mqtt' && srcType !== 'mqtt' && (
        <fieldset>
          <legend className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">Payload format</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {FORMATS.map((o) => (
              <label key={o.v} className={clsx('flex cursor-pointer items-start gap-2 rounded-xl border p-3', form.format === o.v ? 'border-accent-500/40 bg-accent-500/10' : 'border-white/10 hover:bg-white/5')}>
                <input type="radio" name="format" value={o.v} checked={form.format === o.v} onChange={() => set({ format: o.v })} className="mt-0.5 accent-accent-500" />
                <span className="text-sm text-slate-100">{o.t}<span className={clsx(help, 'block')}>{o.d}</span></span>
              </label>
            ))}
          </div>
          {form.layout === 'object-per-asset' && <p className={clsx(help, 'mt-1.5')}>Object payloads always carry quality, in both formats.</p>}
        </fieldset>
      )}
      <FieldError errors={errors.filter((e) => !e.message.includes('already published by another binding') && e.message !== preview.data?.error)} />

      {srcType !== 'mqtt' && (
        <div className="flex flex-wrap items-center gap-2 text-xs" aria-live="polite">
          {preview.status === 'loading' && <span className="inline-flex items-center gap-1.5 text-slate-300"><Loader2 size={12} className="animate-spin" aria-hidden="true" /> Checking with the server...</span>}
          {live && preview.data?.valid && <span className="text-emerald-300">Checked by the server{preview.data.units > 1 ? ` across ${preview.data.units} instances` : ''}.</span>}
          {preview.status === 'error' && (
            <span role="alert" className="flex flex-wrap items-center gap-2 text-rose-300">
              <AlertTriangle size={12} aria-hidden="true" /> Preview failed: {preview.error}
              <Button size="sm" variant="outline" onClick={preview.retry}><RefreshCw size={12} aria-hidden="true" /> Retry</Button>
            </span>
          )}
        </div>
      )}

      {live && preview.data?.valid === false && (
        <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          <p className="font-semibold">The server would reject this binding</p>
          <p className="mt-0.5 break-words">{preview.data.error}</p>
          {form.layout === 'object-per-asset' && <p className="mt-1 text-rose-200/80">Bind fewer tags, split the binding, or raise the maximum object size under Advanced on the Options step.</p>}
        </div>
      )}
      {clash.length > 0 && (
        <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          <p className="font-semibold">{clash.length} topic{clash.length === 1 ? '' : 's'} already published by another binding. This blocks saving.</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {clash.slice(0, 5).map((c) => (
              <li key={c.topic} className="break-all"><span className="font-mono">{c.topic}</span> by {c.bindings.map((b) => b.name || b.id).join(', ')}</li>
            ))}
          </ul>
        </div>
      )}
      {general.map((w, i) => (
        <p key={i} role="alert" className="text-xs text-rose-300">{w.message}</p>
      ))}

      {data && <SizeLine size={sizeSummary(data)} />}

      <div>
        <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300">
          Names and preview ({rows.length})
          {flagged > 0 && <span className="ml-2 normal-case text-amber-300">{flagged} need attention</span>}
        </h4>
        {isProfile && data && data.units > 1 && <p className={clsx(help, 'mb-1.5')}>Topics shown for the first instance; the others differ only by their asset path.</p>}
        {renameable && <p className={clsx(help, 'mb-1.5')}>Names default to the tag's property. Edit one to override it; only edited names are stored.</p>}
        <PreviewList items={items} editable={renameable} mode={mode} object={form.layout === 'object-per-asset' && mode === 'mqtt'} live={live} onRename={rename} truncated={Boolean(data?.truncated) && data?.layout !== 'object-per-asset'} total={data?.totalTags} />
      </div>

      {data?.layout === 'object-per-asset' && data.objects?.[0] && (
        <div>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300">Object published to <span className="font-mono normal-case">{data.objects[0].topic}</span></h4>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-black/30 px-3 py-2 font-mono text-xs text-slate-300">{JSON.stringify(data.objects[0].payload, null, 2)}</pre>
        </div>
      )}

      {mode === 'mqtt' && srcType !== 'mqtt' && (
        <AlsoPublished form={form} set={set} statusT={statusT} metaT={metaT} data={data} />
      )}
    </section>
  );
}
