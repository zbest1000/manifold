import { useEffect, useRef, useState } from 'react';
import { Search, Upload, Download } from 'lucide-react';
import { Button, SegmentedControl, LoadingState, EmptyState, Input } from '@/components/ui';
import { EditorSection } from './parts';
import TagTable, { ROW_H } from './TagTable';
import TagInspector from './TagInspector';
import BulkBar from './BulkBar';
import CsvImport from '../CsvImport';
import { rowsToCsv } from '../csvRows';
import { downloadText } from '@/lib/download';
import { READ_ONLY_REASON } from '@/store/selectors';

/** The per-tag section of the mapping editor: filter, bulk bar, the table and the active row's details. */
export default function TagsSection({ t }) {
  const { state, setRows, viewRows, verdicts, selected, setSelected, activeKey, activate, problemsByRow, flags, readOnly, scrollReq, setScrollReq, notice, setNotice, inspector, setInspector, activeRow, activeIndex, schema, focus, query, setQuery, currentFilter, setFilter, filters, pub, n, tagDefs, csvAtStart } = t;
  const [csv, setCsv] = useState(Boolean(csvAtStart));
  return (
    <EditorSection
      id="map-tags"
      title="Tags"
      count={`${pub.length.toLocaleString()} published${n !== pub.length ? ` of ${n.toLocaleString()}` : ''}`}
      actions={
        <>
          <div className="relative w-48">
            <Search size={13} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
            <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter" aria-label="Filter tags by name, key or description" className="h-7 py-0 pl-8 text-xs" />
          </div>
          <SegmentedControl size="sm" label="Show tags" value={currentFilter} onChange={setFilter} options={filters} />
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setCsv(true)} disabled={readOnly || !state.tagsLoaded} title={readOnly ? READ_ONLY_REASON : 'Import mapping rows from CSV'}>
            <Upload size={12} aria-hidden="true" /> Import CSV
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => downloadText(`${(state.name || 'mapping').replace(/[^\w-]+/g, '_')}.csv`, rowsToCsv(state.rows, state.srcType), 'text/csv')} disabled={!state.rows.length} title="Download the rows as CSV">
            <Download size={12} aria-hidden="true" /> Export CSV
          </Button>
        </>
      }
    >
      {selected.size > 0 && (
        <BulkBar
          selected={selected}
          rows={state.rows}
          onRows={setRows}
          flags={flags}
          onClear={() => setSelected(new Set())}
          onDone={(msg) => setNotice(msg)}
        />
      )}
      {!state.tagsLoaded ? (
        <LoadingState label="tags" rows={4} />
      ) : n === 0 ? (
        <div className="rounded-lg border border-line">
          <EmptyState title={state.selectMode === 'rules' ? 'The device has no tags yet' : 'No tags in this mapping'} hint={state.selectMode === 'rules' ? 'Tags added on the Devices page are picked up automatically when they match the rules.' : 'Add tags under What to map, or pick them in the tree on the Tags page.'} />
        </div>
      ) : viewRows.length === 0 ? (
        <div className="rounded-lg border border-line">
          <EmptyState title="No tag matches this filter" action={<Button size="sm" variant="secondary" onClick={() => { setFilter('all'); setQuery(''); }}>Show all tags</Button>} />
        </div>
      ) : (
        <TagTableWithScroll
          rows={viewRows}
          verdicts={verdicts}
          selected={selected}
          onSelect={setSelected}
          activeKey={activeKey}
          onActivate={activate}
          onRows={setRows}
          problems={problemsByRow}
          flags={flags}
          readOnly={readOnly}
          caption={`Tags in this mapping, ${viewRows.length} shown`}
          scrollReq={scrollReq}
          onPasted={(lines, count) => setNotice(`Pasted ${lines} line${lines === 1 ? '' : 's'} into ${count} tag${count === 1 ? '' : 's'}.`)}
        />
      )}
      <p className="helper mt-2" aria-live="polite">
        {notice || 'Paste a column from a spreadsheet into names, units or descriptions to fill many tags at once. Up and down arrows move between rows; shift-click selects a range.'}
      </p>
      {inspector && activeRow && flags.overrides && (
        <TagInspector
          key={activeRow.key}
          state={state}
          row={activeRow}
          index={Math.max(0, activeIndex)}
          total={viewRows.length}
          onRow={(fn) => setRows((rs) => rs.map((r) => (r.key === activeRow.key ? fn(r) : r)))}
          onMove={(d) => {
            const next = viewRows[activeIndex + d];
            if (next) activate(next.key, { scroll: false });
            if (next) setScrollReq({ key: next.key, n: Date.now() });
          }}
          onClose={() => setInspector(false)}
          problems={problemsByRow.get(activeRow.key) || []}
          schema={schema}
          readOnly={readOnly}
          serverTag={focus.data?.valid ? (focus.data.tags?.[0] || focus.data.members?.[0] || null) : null}
        />
      )}
      {flags.list && selected.size > 0 && !readOnly && (
        <div className="mt-2">
          <Button
            size="sm"
            variant="danger-ghost"
            onClick={() => {
              setRows((rs) => rs.filter((r) => !selected.has(r.key)));
              setNotice(`${selected.size} tag${selected.size === 1 ? '' : 's'} removed from the mapping.`);
              setSelected(new Set());
            }}
          >
            Remove {selected.size} selected from the mapping
          </Button>
        </div>
      )}
      {csv && (
        <CsvImport
          state={state}
          tagDefs={tagDefs}
          onClose={() => setCsv(false)}
          onApply={(rows, message) => {
            setRows(() => rows);
            setNotice(message);
            setCsv(false);
          }}
        />
      )}
    </EditorSection>
  );
}

/** TagTable plus "scroll to this row" requests from outside (preview links, problem jumps). */
function TagTableWithScroll({ scrollReq, ...props }) {
  const holder = useRef(null);
  const rowsRef = useRef(props.rows);
  useEffect(() => {
    rowsRef.current = props.rows;
  });
  useEffect(() => {
    if (!scrollReq) return undefined;
    const index = rowsRef.current.findIndex((r) => r.key === scrollReq.key);
    if (index < 0) return undefined;
    const id = requestAnimationFrame(() => {
      const el = holder.current?.querySelector('[role="region"]');
      if (!el) return;
      const top = index * ROW_H;
      if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - 2 * ROW_H) el.scrollTop = Math.max(0, top - 2 * ROW_H);
      // The scroll event re-renders the window; focus once the row is in the DOM.
      requestAnimationFrame(() => {
        if (scrollReq.focusName) el.querySelector(`[data-cell="${index}:name"]`)?.focus();
      });
    });
    return () => cancelAnimationFrame(id);
  }, [scrollReq]);
  return (
    <div ref={holder}>
      <TagTable {...props} />
    </div>
  );
}
