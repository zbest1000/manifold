import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Upload, Download, ChevronDown, ChevronRight, Cable, Search, ChevronLeft, Microscope } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button, Input, Banner } from '@/components/ui';
import TagRow, { ProfileTagRow } from './TagRow';
import TagImportDialog from './TagImportDialog';
import BrowseImportDialog from './BrowseImportDialog';
import { tagTypeNames, typeOptional as isTypeOptional, addressExample, extraColumns } from './model';
import { serializeTags, pasteIntoTags } from '@/lib/deviceTags';
import { isStale } from '@/lib/deviceStatus';
import { downloadText } from '@/lib/download';

let seq = 0;
export const newTagId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

const PAGE = 100; // rows rendered at once in the editor; the table pages beyond this

const HEAD = [
  ['Key', 'min-w-[8rem]'],
  ['Address', 'min-w-[15rem]'],
  ['Type', 'min-w-[5.5rem]'],
  ['Poll group', 'min-w-[5.5rem]'],
  ['Scale', 'min-w-[3.5rem]'],
  ['Offset', 'min-w-[3.5rem]'],
  ['Unit', 'min-w-[4.5rem]'],
  ['UNS property', 'min-w-[8rem]']
];
const EXTRA_HEAD = {
  length: ['Length', 'min-w-[7.5rem]'],
  bit: ['Bit', 'min-w-[4rem]'],
  byteOrder: ['Byte order', 'min-w-[7.5rem]'],
  wordOrder: ['Word order', 'min-w-[7.5rem]'],
  description: ['Description', 'min-w-[10rem]']
};
const TH = 'h-8 whitespace-nowrap px-1.5 text-left align-middle text-xs font-medium text-muted';

/**
 * The tag editor: ONE table, one row per tag, on the system's table styles. Paste a block copied from
 * a spreadsheet into any cell, import/export CSV, add and delete rows. A device from a profile shows the
 * profile's tags first, read-only and marked "Profile". Beyond 100 rows the table pages and filters.
 * Validation and live values are passed in so rows stay cheap to render.
 */
export default function TagTable({
  tags,
  setTags,
  descriptor,
  pollGroups,
  validation,
  localErrors,
  values,
  showLive,
  selectedId,
  onSelect,
  deviceName,
  quarantined,
  quarantineReasons,
  effective,
  browse,
  profileTags = [],
  profileErrors = {},
  readOnly = false,
  autoBrowse = false,
  onProbe
}) {
  const [advanced, setAdvanced] = useState(false);
  const [importing, setImporting] = useState(false);
  const [browsing, setBrowsing] = useState(() => Boolean(autoBrowse && browse?.supported && !browse?.reason));
  const [now, setNow] = useState(() => Date.now());
  const [text, setText] = useState('');
  const [page, setPage] = useState(0);
  const types = useMemo(() => tagTypeNames(descriptor), [descriptor]);
  // Per-type details: drivers send them as tagTypes objects and/or a tagTypeInfo map.
  const typeInfo = useMemo(() => ({ ...Object.fromEntries((descriptor?.tagTypes || []).filter((t) => typeof t === 'object' && t.name).map((t) => [t.name, t])), ...(descriptor?.tagTypeInfo || {}) }), [descriptor]);
  const typeOptional = isTypeOptional(descriptor);
  const placeholder = addressExample(descriptor);
  const cols = useMemo(() => extraColumns(descriptor), [descriptor]);
  const groupIds = useMemo(() => pollGroups.map((g) => g.id), [pollGroups]);
  const intervalOf = useMemo(() => Object.fromEntries(pollGroups.map((g) => [g.id, Math.max(Number(g.intervalMs) || 0, Number(effective?.[g.id]) || 0)])), [pollGroups, effective]);
  const extraCols = [...cols.always, ...(advanced ? cols.advanced : [])];

  // Re-evaluate staleness once a second while live values are shown.
  useEffect(() => {
    if (!showLive) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [showLive]);

  const makeRow = useCallback(() => ({ _id: newTagId(), key: '', address: '', type: typeOptional ? '' : types[0] || '', pollGroup: groupIds[0] || '' }), [types, typeOptional, groupIds]);
  const addRow = () => {
    setTags((t) => [...t, makeRow()]);
    setText('');
    setPage(Math.floor(tags.length / PAGE)); // the new row is on the last page
  };
  const onChange = useCallback((id, patch) => setTags((ts) => ts.map((t) => (t._id === id ? { ...t, ...patch } : t))), [setTags]);
  const onDelete = useCallback((id) => setTags((ts) => ts.filter((t) => t._id !== id)), [setTags]);

  const onPaste = useCallback(
    (e, rowIdx, col) => {
      const t = e.clipboardData?.getData('text') || '';
      // Single-cell pastes behave normally; anything multi-cell is treated as a spreadsheet block.
      if (!/[\t\n]/.test(t.replace(/\r?\n$/, ''))) return;
      e.preventDefault();
      setTags((ts) => {
        const r = pasteIntoTags(ts, t, rowIdx, col, makeRow);
        queueMicrotask(() => toast.success(`Pasted ${r.touched + r.added} row${r.touched + r.added === 1 ? '' : 's'}${r.added ? ` (${r.added} new)` : ''}`));
        return r.tags;
      });
    },
    [setTags, makeRow]
  );

  const exportCsv = () => {
    const safe = (deviceName || 'device').replace(/[^\w.-]+/g, '_');
    downloadText(`${safe}-tags.csv`, serializeTags(tags, ','), 'text/csv');
  };

  const needle = text.trim().toLowerCase();
  const indexed = useMemo(() => {
    const all = tags.map((t, i) => ({ t, i }));
    return needle ? all.filter(({ t }) => `${t.key} ${t.address}`.toLowerCase().includes(needle)) : all;
  }, [tags, needle]);
  const pages = Math.max(1, Math.ceil(indexed.length / PAGE));
  const pageNo = Math.min(page, pages - 1);
  const slice = indexed.slice(pageNo * PAGE, pageNo * PAGE + PAGE);
  const paged = tags.length > PAGE;
  const colCount = 10 + extraCols.length + (showLive ? 1 : 0);
  const dupHint = validation.error;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={addRow} disabled={readOnly}>
          <Plus size={14} aria-hidden="true" /> Add tag
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => setImporting(true)} disabled={readOnly}>
          <Upload size={14} aria-hidden="true" /> Import / paste
        </Button>
        {browse?.supported && (
          <Button type="button" size="sm" variant="secondary" onClick={() => setBrowsing(true)} disabled={Boolean(browse.reason) || readOnly} title={browse.reason || ''}>
            <Cable size={14} aria-hidden="true" /> Import from controller
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={exportCsv} disabled={!tags.length}>
          <Download size={14} aria-hidden="true" /> Export CSV
        </Button>
        {onProbe && (
          <Button type="button" size="sm" variant="ghost" onClick={onProbe}>
            <Microscope size={14} aria-hidden="true" /> Probe
          </Button>
        )}
        {cols.advanced.length > 0 && (
          <button
            type="button"
            onClick={() => setAdvanced((a) => !a)}
            aria-expanded={advanced}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted transition-colors hover:bg-raised hover:text-fg"
          >
            {advanced ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />} Advanced columns
          </button>
        )}
      </div>

      {browse?.supported && browse.reason && <p className="helper">Import from controller is unavailable: {browse.reason}</p>}
      {dupHint && (
        <Banner variant="warn" title="Address validation unavailable" onRetry={validation.retry}>
          {dupHint}
        </Banner>
      )}

      {paged && (
        <div className="relative max-w-xs">
          <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input aria-label="Filter tag rows" placeholder="Filter by key or address" value={text} onChange={(e) => { setText(e.target.value); setPage(0); }} className="pl-8" />
        </div>
      )}

      <div className="max-w-full overflow-x-auto rounded-lg border border-line bg-panel" tabIndex={0} role="region" aria-label="Tag table (scrolls horizontally)">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">Tags polled from this device. Paste a block from a spreadsheet into any cell to fill several rows.</caption>
          <thead className="border-b border-line">
            <tr>
              <th scope="col" className={`${TH} w-10 pl-2`}>
                <span className="sr-only">Select row</span>
                <span aria-hidden="true">#</span>
              </th>
              {HEAD.slice(0, 2).map(([h, w]) => (
                <th key={h} scope="col" className={`${TH} ${w}`}>
                  {h}
                </th>
              ))}
              {showLive && <th scope="col" className={`${TH} min-w-[9rem]`}>Live value</th>}
              {HEAD.slice(2).map(([h, w]) => (
                <th key={h} scope="col" className={`${TH} ${w}`}>
                  {h}
                </th>
              ))}
              {extraCols.map((c) => (
                <th key={c} scope="col" className={`${TH} ${EXTRA_HEAD[c][1]}`}>
                  {EXTRA_HEAD[c][0]}
                </th>
              ))}
              <th scope="col" className={`${TH} w-10 px-1`}>
                <span className="sr-only">Delete</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {profileTags.map((t) => (
              <ProfileTagRow
                key={`profile-${t.key}`}
                tag={t}
                sample={showLive ? values[t.key] : undefined}
                stale={showLive && isStale(values[t.key], intervalOf[t.pollGroup] || 1000, now)}
                quarantined={Boolean(quarantined?.has(t.key))}
                quarantineReason={quarantineReasons?.[t.key]}
                error={profileErrors[t.key]}
                showLive={showLive}
                extraCols={extraCols}
              />
            ))}
            {slice.map(({ t, i }) => (
              <TagRow
                key={t._id}
                tag={t}
                index={i}
                protocol={descriptor?.id}
                types={types}
                typeOptional={typeOptional}
                placeholder={placeholder}
                stale={showLive && isStale(values[t.key], intervalOf[t.pollGroup] || 1000, now)}
                typeInfo={typeInfo}
                quarantined={Boolean(quarantined?.has(t.key))}
                quarantineReason={quarantineReasons?.[t.key]}
                cols={cols}
                advancedOpen={advanced}
                groupIds={groupIds}
                validation={validation.results[t.key]}
                localError={localErrors[i]}
                sample={showLive ? values[t.key] : undefined}
                showLive={showLive}
                selected={selectedId === t._id}
                onSelect={onSelect}
                onChange={onChange}
                onDelete={onDelete}
                onPaste={onPaste}
                readOnly={readOnly}
              />
            ))}
            {!tags.length && !profileTags.length && (
              <tr>
                <td colSpan={colCount} className="px-4 py-8 text-center text-sm text-muted">
                  No tags yet. Add a row, paste a block copied from a spreadsheet, or import a CSV.
                </td>
              </tr>
            )}
            {tags.length > 0 && indexed.length === 0 && (
              <tr>
                <td colSpan={colCount} className="px-4 py-6 text-center text-sm text-muted">
                  No tag rows match “{text}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-subtle" aria-live="polite">
        <span>
          {tags.length.toLocaleString()} tag{tags.length === 1 ? '' : 's'}
          {profileTags.length ? ` of its own, plus ${profileTags.length.toLocaleString()} from the profile` : ''}
          {validation.pending ? ' · checking addresses…' : ''}
        </span>
        {paged && (
          <span className="inline-flex items-center gap-1">
            <span className="tabular-nums">
              Rows {indexed.length ? pageNo * PAGE + 1 : 0}–{Math.min(indexed.length, pageNo * PAGE + PAGE)} of {indexed.length.toLocaleString()}
            </span>
            <Button type="button" size="sm" variant="ghost" onClick={() => setPage(pageNo - 1)} disabled={pageNo === 0} aria-label="Previous rows">
              <ChevronLeft size={14} aria-hidden="true" />
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setPage(pageNo + 1)} disabled={pageNo >= pages - 1} aria-label="Next rows">
              <ChevronRight size={14} aria-hidden="true" />
            </Button>
          </span>
        )}
      </div>

      {browsing && (
        <BrowseImportDialog
          device={browse.device}
          descriptor={descriptor}
          existing={tags}
          pollGroups={pollGroups}
          makeId={newTagId}
          onClose={() => setBrowsing(false)}
          onAdd={(rows) => {
            setTags((ts) => [...ts, ...rows]);
            setBrowsing(false);
            toast.success(`Added ${rows.length} tag${rows.length === 1 ? '' : 's'} from the controller. Save the device to keep them.`);
          }}
        />
      )}
      {importing && (
        <TagImportDialog
          onClose={() => setImporting(false)}
          existingCount={tags.length}
          makeRow={makeRow}
          onApply={(newTags, replace) => {
            setTags((ts) => (replace ? newTags : [...ts, ...newTags]));
            setImporting(false);
            setPage(0);
            toast.success(`${replace ? 'Replaced with' : 'Added'} ${newTags.length} tag${newTags.length === 1 ? '' : 's'}`);
          }}
        />
      )}
    </div>
  );
}
