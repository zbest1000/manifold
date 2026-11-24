import clsx from 'clsx';
import { AlertCircle, AlertTriangle, Lock } from 'lucide-react';
import { qualityInfo, formatValue, quarantineReasonText } from '@/lib/deviceStatus';

export function FromProfileBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 text-2xs font-semibold text-sky-300" title="Defined by the device profile; edit the profile to change it">
      <Lock size={9} aria-hidden="true" /> from profile
    </span>
  );
}

/**
 * Read-only table of the effective tags a profile gives a device (placeholders
 * already substituted). `errors` maps tag key -> message; `values` and
 * `quarantineReasons` (optional) add the live value and why a tag was quarantined.
 */
export default function EffectiveTagsTable({ tags, errors = {}, values, quarantineReasons, caption = 'Tags from the profile (read-only)', empty = 'The profile has no tags.' }) {
  const live = Boolean(values);
  return (
    <div className="max-w-full overflow-x-auto rounded-xl border border-white/10" tabIndex={0} role="region" aria-label={`${caption} (scrolls horizontally)`}>
      <table className="w-full border-collapse text-left text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-white/[0.03] text-2xs uppercase tracking-wide text-slate-400">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Key</th>
            <th scope="col" className="px-3 py-2 font-medium">Address</th>
            <th scope="col" className="px-3 py-2 font-medium">Type</th>
            <th scope="col" className="px-3 py-2 font-medium">Poll group</th>
            <th scope="col" className="px-3 py-2 font-medium">UNS property</th>
            {live && <th scope="col" className="px-3 py-2 font-medium">Live value</th>}
            <th scope="col" className="px-3 py-2 font-medium">Source</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {tags.map((t) => {
            const err = errors[t.key];
            const sample = values?.[t.key];
            const q = sample ? qualityInfo(sample.q) : null;
            const reason = quarantineReasons?.[t.key];
            return (
              <tr key={t.key} className={clsx('align-top', err && 'bg-rose-500/5')} data-tag-key={t.key}>
                <td className="mono px-3 py-1.5 text-slate-100">{t.key}</td>
                <td className="mono px-3 py-1.5 text-slate-300">
                  {t.address}
                  {err && (
                    <p role="alert" className="mt-1 flex items-start gap-1 font-sans text-2xs text-rose-300">
                      <AlertCircle size={11} className="mt-0.5 shrink-0" aria-hidden="true" /> {err}
                    </p>
                  )}
                  {reason && (
                    <p className="mt-1 flex items-start gap-1 font-sans text-2xs text-amber-300">
                      <AlertTriangle size={11} className="mt-0.5 shrink-0" aria-hidden="true" /> <span><span className="font-semibold">Quarantined</span>: {quarantineReasonText(reason)}</span>
                    </p>
                  )}
                </td>
                <td className="px-3 py-1.5 text-slate-300">{t.type || 'auto'}</td>
                <td className="px-3 py-1.5 text-slate-400">{t.pollGroup || '—'}</td>
                <td className="px-3 py-1.5 text-slate-400">{t.property || '—'}</td>
                {live && (
                  <td className="px-3 py-1.5">
                    {sample ? (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="mono text-slate-100">{formatValue(sample.v)}</span>
                        <span className={clsx('text-[10px] font-semibold uppercase', q.key === 'good' ? 'text-emerald-300' : q.key === 'uncertain' ? 'text-amber-300' : 'text-rose-300')}>{q.key === 'good' ? 'OK' : q.label}</span>
                      </span>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                )}
                <td className="px-3 py-1.5"><FromProfileBadge /></td>
              </tr>
            );
          })}
          {!tags.length && (
            <tr>
              <td colSpan={7} className="px-4 py-6 text-center text-slate-500">{empty}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
