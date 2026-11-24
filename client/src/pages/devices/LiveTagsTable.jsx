import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import clsx from 'clsx';
import { Input, SegmentedControl, StatusText, TableSort, Th, EmptyState } from '@/components/ui';
import { nextSort } from '@/lib/sortRows';
import { buildLiveRows, filterLiveRows, sortLiveRows, liveCounts, visibleWindow } from '@/lib/deviceTagView';
import { formatAge } from '@/lib/deviceStatus';
import { FromProfileBadge } from './FormControls';

const ROW_H = 32;
const COLS = ['w-[30%]', 'w-[12%]', 'w-[8%]', 'w-[13%]', 'w-[8%]', 'w-[29%]'];

function useNow(ms) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const QUALITY_TONE = { good: 'good', uncertain: 'warn', bad: 'bad', none: 'neutral' };

function qualityTitle(r) {
  return [
    `Quality: ${r.qualityLabel}`,
    r.reason && `Reason: ${r.reason}`,
    r.quarantined && `Quarantined: ${r.quarantineText}. The device rejected this tag; it is retried periodically.`,
    r.stale && 'Stale: no update for more than 3 x the poll interval',
    r.sample?.tRead && `Read ${new Date(r.sample.tRead).toLocaleTimeString()}`
  ]
    .filter(Boolean)
    .join(' · ');
}

function Row({ r, index }) {
  const bad = r.quality === 'bad';
  const word = r.stale && r.quality === 'good' ? 'Stale' : r.qualityLabel;
  const tone = r.stale && r.quality === 'good' ? 'warn' : QUALITY_TONE[r.quality];
  return (
    <tr
      data-tag-key={r.key}
      data-row-state={r.quarantined ? 'quarantined' : bad ? 'bad' : r.stale ? 'stale' : 'ok'}
      aria-rowindex={index + 2}
      title={qualityTitle(r)}
      style={{ height: ROW_H }}
      className={clsx('border-t border-line text-sm', bad && 'bg-bad/[0.06]', r.quarantined && !bad && 'bg-warn/[0.06]')}
    >
      <td className={clsx('truncate border-l-2 py-0 pl-[10px] pr-3 align-middle', bad ? 'border-l-bad' : r.quarantined ? 'border-l-warn' : 'border-l-transparent')}>
        <span className="mono text-xs text-fg">{r.key}</span>
        <span className="mono ml-2 text-xs text-subtle">{r.address}</span>
        {r.origin === 'profile' && <span className="ml-2 align-middle"><FromProfileBadge /></span>}
      </td>
      <td className="px-3 text-right align-middle">
        <span data-quality={r.quality} data-stale={r.stale ? 'true' : undefined} className={clsx('mono text-xs tabular-nums', bad ? 'text-subtle line-through decoration-bad/60' : 'text-fg', r.stale && 'opacity-70')}>
          {r.display}
        </span>
      </td>
      <td className="truncate px-3 align-middle text-xs text-subtle">{r.unit}</td>
      <td className="truncate px-3 align-middle">
        <StatusText tone={tone} className="text-xs">
          {word}
        </StatusText>
      </td>
      <td className={clsx('px-3 text-right align-middle text-xs tabular-nums', r.stale ? 'text-warn' : 'text-subtle')}>{r.ageMs === null ? '—' : formatAge(r.ageMs)}</td>
      <td className="truncate px-3 align-middle text-xs">
        {r.quarantined ? <span className="text-warn">Quarantined: {r.quarantineText}</span> : r.reason && r.quality !== 'good' ? <span className="text-muted">{r.reason}</span> : null}
      </td>
    </tr>
  );
}

/**
 * Live tags of one device: value, quality (with the driver's reason), unit, age and the quarantine
 * reason. Filter, sort, and windowed rendering (fixed 32px rows), so 2,000 tags cost as much as 30.
 */
export default function LiveTagsTable({ tags, values, quarantineReasons, groups, initialChip = 'all' }) {
  const now = useNow(1000);
  const [text, setText] = useState('');
  const [chip, setChip] = useState(initialChip);
  const [sort, setSort] = useState({ key: 'key', dir: 'asc' });
  const scroller = useRef(null);
  const [view, setView] = useState({ top: 0, height: 480 });

  const intervalOf = useMemo(() => Object.fromEntries(Object.entries(groups || {}).map(([id, g]) => [id, Math.max(Number(g.intervalMs) || 0, Number(g.effectiveIntervalMs) || 0)])), [groups]);
  const rows = useMemo(() => buildLiveRows(tags, values, quarantineReasons, intervalOf, now), [tags, values, quarantineReasons, intervalOf, now]);
  const counts = useMemo(() => liveCounts(rows), [rows]);
  const shown = useMemo(() => sortLiveRows(filterLiveRows(rows, text, chip), sort), [rows, text, chip, sort]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const measure = () => setView((v) => (v.height === el.clientHeight ? v : { ...v, height: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const raf = useRef(0);
  const onScroll = (e) => {
    const top = e.currentTarget.scrollTop;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => setView((v) => ({ ...v, top })));
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  // A new filter or sort starts at the top.
  const toTop = () => {
    if (scroller.current) scroller.current.scrollTop = 0;
    setView((v) => ({ ...v, top: 0 }));
  };
  const changeText = (v) => {
    setText(v);
    toTop();
  };
  const changeChip = (v) => {
    setChip(v);
    toTop();
  };
  const changeSort = (key) => {
    setSort((s) => nextSort(s, key));
    toTop();
  };

  const { start, end } = visibleWindow({ total: shown.length, rowHeight: ROW_H, viewport: view.height, scrollTop: view.top });
  const chips = [
    ['all', 'All', counts.all],
    ['problems', 'Problems', counts.problems],
    ['bad', 'Bad', counts.bad],
    ['stale', 'Stale', counts.stale],
    ['quarantined', 'Quarantined', counts.quarantined]
  ].filter(([id, , n]) => id === 'all' || id === 'problems' || id === chip || n > 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="toolbar" aria-label="Filter tags" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <div className="relative min-w-0 flex-1 basis-44">
          <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input aria-label="Filter tags" placeholder="Filter by key, address or reason" value={text} onChange={(e) => changeText(e.target.value)} className="pl-8" />
        </div>
        <SegmentedControl size="sm" label="Show tags" value={chip} onChange={changeChip} options={chips.map(([id, label, n]) => ({ value: id, label: `${label} ${n.toLocaleString()}` }))} />
        <span className="text-xs tabular-nums text-subtle" aria-live="polite">
          {shown.length === rows.length ? `${rows.length.toLocaleString()} tags` : `${shown.length.toLocaleString()} of ${rows.length.toLocaleString()}`}
        </span>
      </div>

      <div ref={scroller} onScroll={onScroll} role="region" aria-label="Live tags" tabIndex={0} className="min-h-0 flex-1 overflow-auto">
        <TableSort sort={sort} onSort={changeSort}>
          <table className="w-full min-w-[40rem] table-fixed border-collapse text-left text-sm" aria-rowcount={shown.length + 1}>
            <caption className="sr-only">Live values of the tags of this device</caption>
            <colgroup>
              {COLS.map((c) => (
                <col key={c} className={c} />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-10 border-b border-line bg-panel">
              <tr aria-rowindex={1}>
                <Th sortKey="key">Tag</Th>
                <Th sortKey="value" align="right">Value</Th>
                <Th sortKey="unit">Unit</Th>
                <Th sortKey="quality">Quality</Th>
                <Th sortKey="age" align="right">Age</Th>
                <Th sortKey="quarantine">Reason</Th>
              </tr>
            </thead>
            <tbody>
              {start > 0 && (
                <tr aria-hidden="true" style={{ height: start * ROW_H }}>
                  <td colSpan={6} />
                </tr>
              )}
              {shown.slice(start, end).map((r, i) => (
                <Row key={r.key} r={r} index={start + i} />
              ))}
              {end < shown.length && (
                <tr aria-hidden="true" style={{ height: (shown.length - end) * ROW_H }}>
                  <td colSpan={6} />
                </tr>
              )}
            </tbody>
          </table>
        </TableSort>
        {shown.length === 0 && (
          <EmptyState title={rows.length ? 'No tags match' : 'This device has no tags'} hint={rows.length ? 'Nothing fits the current filter.' : 'Open the editor to add tags, paste a table or import from the controller.'} />
        )}
      </div>
    </div>
  );
}
