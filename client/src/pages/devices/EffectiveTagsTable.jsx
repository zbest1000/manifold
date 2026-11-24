import { AlertCircle, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import { Table, THead, Th, Tr, Td, StatusText } from '@/components/ui';
import { qualityInfo, formatReading, quarantineReasonText } from '@/lib/deviceStatus';
import { FromProfileBadge } from './FormControls';

export { FromProfileBadge };

const TONE = { good: 'good', uncertain: 'warn', bad: 'bad' };

/**
 * Read-only table of the effective tags a profile gives a device (placeholders
 * already substituted). `errors` maps tag key -> message; `values` and
 * `quarantineReasons` (optional) add the live value and why a tag was quarantined.
 */
export default function EffectiveTagsTable({ tags, errors = {}, values, quarantineReasons, caption = 'Tags from the profile (read-only)', empty = 'The profile has no tags.' }) {
  const live = Boolean(values);
  return (
    <Table caption={caption} className="min-w-[36rem]">
      <THead>
        <Th>Key</Th>
        <Th>Address</Th>
        <Th>Type</Th>
        <Th>Poll group</Th>
        <Th>UNS property</Th>
        {live && <Th>Live value</Th>}
        <Th>Source</Th>
      </THead>
      <tbody>
        {tags.map((t) => {
          const err = errors[t.key];
          const sample = values?.[t.key];
          const q = sample ? qualityInfo(sample.q) : null;
          const reason = quarantineReasons?.[t.key];
          return (
            <Tr key={t.key} className={clsx('align-top', err && 'bg-bad/[0.05]')} data-tag-key={t.key}>
              <Td header className="mono text-xs text-fg">{t.key}</Td>
              <Td className="mono text-xs text-muted">
                {t.address}
                {err && (
                  <p role="alert" className="mt-1 flex items-start gap-1 font-sans text-xs text-bad">
                    <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" /> {err}
                  </p>
                )}
                {reason && (
                  <p className="mt-1 flex items-start gap-1 font-sans text-xs text-warn">
                    <AlertTriangle size={11} className="mt-0.5 shrink-0" aria-hidden="true" /> <span>Quarantined: {quarantineReasonText(reason)}</span>
                  </p>
                )}
              </Td>
              <Td className="text-xs text-muted">{t.type || 'auto'}</Td>
              <Td className="text-xs text-muted">{t.pollGroup || '—'}</Td>
              <Td className="text-xs text-muted">{t.property || '—'}</Td>
              {live && (
                <Td>
                  {sample ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="mono text-xs tabular-nums text-fg">{formatReading(sample.v)}</span>
                      <StatusText tone={TONE[q.key]} className="text-xs">{q.label}</StatusText>
                    </span>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </Td>
              )}
              <Td>
                <FromProfileBadge />
              </Td>
            </Tr>
          );
        })}
        {!tags.length && (
          <tr>
            <td colSpan={live ? 7 : 6} className="px-4 py-6 text-center text-sm text-muted">
              {empty}
            </td>
          </tr>
        )}
      </tbody>
    </Table>
  );
}
