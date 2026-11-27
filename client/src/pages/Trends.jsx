import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, X, Plus, Database, Download } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { useStore } from '@/store/store';
import PageHeader from '@/components/PageHeader';
import TrendChart, { seriesColor } from '@/components/TrendChart';
import { useChartTheme } from '@/components/charts';
import { liveQuality, liveTime, shortTag, unitFrom } from '@/components/chartMath';
import { SERIES_DASH } from '@/graph/dataPalette';
import { downloadTrendsCsv, trendsExportUrl } from '@/lib/trendsExport';
import { Banner, Button, ButtonLink, Card, EmptyState, Field, HelpButton, IconButton, Input, PageBody, SegmentedControl, Select, Toggle } from '@/components/ui';

/**
 * Trends — chart time-series from three sources: a historian, a local file
 * recording, or LIVE from the in-memory message ring (no storage required).
 * Add up to MAX_TAGS topics, pick a window, get a chart.
 */

const MAX_TAGS = 10;

// Pull a numeric value out of a message payload for charting. Handles a bare
// number, a JSON object with a value-ish field, or a numeric string.
function numericFrom(payload) {
  if (typeof payload === 'number') return Number.isFinite(payload) ? payload : null;
  if (typeof payload === 'string') {
    const n = Number(payload);
    return Number.isFinite(n) ? n : null;
  }
  if (payload && typeof payload === 'object') {
    for (const k of ['value', 'v', 'val', 'reading']) {
      if (typeof payload[k] === 'number' && Number.isFinite(payload[k])) return payload[k];
    }
    const first = Object.values(payload).find((v) => typeof v === 'number' && Number.isFinite(v));
    return first ?? null;
  }
  return null;
}

// Build reader-shaped series ({ series: [{ tag, unit, points: [[tsMs, value, quality]] }] })
// from the live recent-message ring for each requested topic. A Bad sample is
// kept (value null) so the chart shows the gap.
async function liveSeries(brokerId, tags, from, to) {
  const series = await Promise.all(
    tags.map(async (tag) => {
      try {
        const r = await api.topicMessages(brokerId, tag, 500);
        const msgs = r.messages || [];
        const points = msgs
          .map((m) => {
            const q = liveQuality(m);
            const v = numericFrom(m.payload);
            return [liveTime(m), q < 64 ? null : v, q];
          })
          .filter(([ts, v, q]) => (v != null || q < 64) && Number.isFinite(ts) && ts >= from && ts <= to)
          .sort((a, b) => a[0] - b[0]);
        const unit = msgs.map((m) => unitFrom(m.payload)).find(Boolean) || '';
        return { tag, unit, points };
      } catch {
        return { tag, points: [] };
      }
    })
  );
  return { series, meta: { quality: 'stored' } };
}

/** A unit for a stored-source series that has none, from the topic's latest live payload on any broker. */
function liveUnitOf(tag, brokers) {
  for (const b of brokers) {
    const t = useStore.getState().getTopics(b.id).find((x) => x.topic === tag);
    const u = t ? unitFrom(t.payload) : '';
    if (u) return u;
  }
  return '';
}

const RANGE_PRESETS = [
  { label: '15m', ms: 15 * 60_000 },
  { label: '1h', ms: 3_600_000 },
  { label: '6h', ms: 6 * 3_600_000 },
  { label: '24h', ms: 24 * 3_600_000 },
  { label: '7d', ms: 7 * 24 * 3_600_000 }
];

const AUTO_REFRESH_MS = 30_000;
const NONE = []; // stable empty list

export default function Trends() {
  const allBrokers = useStore((s) => s.brokers);
  const connectedBrokers = useMemo(() => allBrokers.filter((b) => b.status === 'connected'), [allBrokers]);
  const topicVersion = useStore((s) => s.topicVersion);
  const [sourceType, setSourceType] = useState('live'); // 'live' | 'historian' | 'recording'
  const [historians, setHistorians] = useState([]);
  const [recordings, setRecordings] = useState([]);
  const [histId, setHistId] = useState('');
  const [recId, setRecId] = useState('');
  const [pickedBrokerId, setBrokerId] = useState('');
  const [tags, setTags] = useState([]);
  const [query, setQuery] = useState('');
  // Tag-search results remember the (source, query) they answer, so a change shows none until the new ones arrive.
  const [suggestState, setSuggestState] = useState({ key: '', list: NONE });
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [rangeMs, setRangeMs] = useState(3_600_000);
  // Latest series fetch: { key (the request it answers), scope (source it belongs to), data: { series, start, end }, error }
  const [result, setResult] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [normalize, setNormalize] = useState(false);
  const [exportMode, setExportMode] = useState('bucketed'); // 'bucketed' (as charted) | 'raw'
  const [exporting, setExporting] = useState(false);
  const searchSeq = useRef(0);
  const [sourcesError, setSourcesError] = useState('');
  const [sourcesTry, setSourcesTry] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .listHistorians()
      .then((r) => {
        if (!alive) return;
        const list = r.historians || [];
        setHistorians(list);
        // Prefer a historian with tag search (timebase queries fine but has
        // no tag-listing API, so it's a worse default).
        const first = list.find((h) => h.type !== 'timebase') || list[0];
        if (first) setHistId((prev) => prev || first.id);
      })
      .catch((e) => alive && setSourcesError(`Could not load historians: ${e?.message || 'request failed'}`));
    api
      .listRecordings()
      .then((r) => {
        if (!alive) return;
        const files = (r.recordings || []).filter((rec) => rec.target?.type !== 'historian');
        setRecordings(files);
        if (files[0]) {
          setRecId((prev) => prev || files[0].id);
          // A recording has persisted history, so default to it instead of the
          // memory-only live view — Trends then has data on first load.
          setSourceType((prev) => (prev === 'live' ? 'recording' : prev));
        }
      })
      .catch((e) => alive && setSourcesError(`Could not load recordings: ${e?.message || 'request failed'}`));
    return () => {
      alive = false;
    };
  }, [sourcesTry]);

  // The live broker defaults to the first connected one until the user picks another.
  const brokerId = pickedBrokerId || connectedBrokers[0]?.id || '';

  const usingRecording = sourceType === 'recording';
  const usingLive = sourceType === 'live';
  const selected = useMemo(() => historians.find((h) => h.id === histId) || null, [historians, histId]);
  // Historians (except Timebase) offer a tag-listing search; the live source
  // suggests from the broker's observed topics; recordings list captured topics.
  const searchable = (sourceType === 'historian' && selected && selected.type !== 'timebase') || usingLive || usingRecording;

  // Live topic suggestions from the broker's observed topic set, filtered by the
  // query — so you can pick a topic to trend instead of typing it blind.
  const liveSuggestions = useMemo(() => {
    if (!usingLive || !brokerId) return [];
    const q = query.trim().toLowerCase();
    const topics = useStore
      .getState()
      .getTopics(brokerId)
      .map((t) => t.topic || t)
      .filter((t) => typeof t === 'string' && !t.startsWith('$SYS/'));
    const filtered = q ? topics.filter((t) => t.toLowerCase().includes(q)) : topics;
    return filtered.filter((t) => !tags.includes(t)).sort().slice(0, 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- topicVersion signals topic-set changes; topics come from the non-reactive index
  }, [usingLive, brokerId, query, tags, topicVersion]);

  // Debounced tag search against the active stored source (historian or
  // recording). The live source suggests locally via liveSuggestions instead.
  const suggestKey = `${usingRecording ? recId : histId}|${query}`;
  useEffect(() => {
    const id = usingRecording ? recId : histId;
    if (usingLive || !id || !searchable) return undefined;
    const seq = ++searchSeq.current;
    const t = setTimeout(() => {
      const p = usingRecording ? api.recordingTags(id, query, 25) : api.historianTags(id, query, 25);
      p.then((r) => {
        if (seq === searchSeq.current) setSuggestState({ key: suggestKey, list: r.tags || NONE });
      }).catch(() => {
        if (seq === searchSeq.current) setSuggestState({ key: suggestKey, list: NONE });
      });
    }, 300);
    return () => clearTimeout(t);
  }, [usingLive, usingRecording, recId, histId, query, searchable, suggestKey]);
  const suggestions = !usingLive && searchable && suggestState.key === suggestKey ? suggestState.list : NONE;

  const addTag = (raw) => {
    const tag = String(raw || '').trim();
    if (!tag) return;
    setTags((prev) => (prev.includes(tag) || prev.length >= MAX_TAGS ? prev : [...prev, tag]));
    setQuery('');
    setSuggestOpen(false);
  };

  const removeTag = (tag) => setTags((prev) => prev.filter((t) => t !== tag));

  const sourceId = usingLive ? brokerId : usingRecording ? recId : histId;

  const active = Boolean(sourceId) && tags.length > 0;
  const scope = `${usingLive ? 'live' : usingRecording ? 'rec' : 'hist'}|${sourceId}`;
  const requestKey = `${scope}|${tags.join('\u0000')}|${rangeMs}|${reloadTick}`;
  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  useEffect(() => {
    if (!sourceId || tags.length === 0) return undefined;
    let alive = true;
    const end = Date.now();
    const start = end - rangeMs;
    const query = usingLive
      ? liveSeries(sourceId, tags, start, end)
      : usingRecording
        ? api.recordingSeries(sourceId, { tags, from: start, to: end, maxPoints: 1000 })
        : api.historianQuery(sourceId, {
            tags,
            start: new Date(start).toISOString(),
            end: new Date(end).toISOString(),
            maxPoints: 1000
          });
    query
      // A recording or historian with no samples for any requested tag returns no
      // series at all; chart the tags as empty so the page says "No samples in
      // this range" rather than "Nothing to chart yet / pick a source".
      .then((r) => alive && setResult({ key: requestKey, scope, data: { series: r.series?.length ? r.series : tags.map((tag) => ({ tag, points: [] })), meta: r.meta || null, start, end }, error: '' }))
      // keep the last good data for this source, but say the refresh failed
      .catch((e) => alive && setResult((prev) => ({ key: requestKey, scope, data: prev?.scope === scope ? prev.data : null, error: e.message })));
    return () => {
      alive = false;
    };
  }, [usingLive, usingRecording, sourceId, tags, rangeMs, requestKey, scope]);

  const current = active && result?.scope === scope ? result : null;
  const data = current?.data ?? null;
  const error = current?.error ?? '';
  const loading = active && result?.key !== requestKey;

  // Auto-refresh: 30s cadence, skipped while the tab is hidden.
  useEffect(() => {
    if (!autoRefresh) return undefined;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, [autoRefresh, reload]);

  const shownSuggestions = usingLive ? liveSuggestions : suggestions.filter((s) => !tags.includes(s));

  const chartTheme = useChartTheme();
  // Series in the order the tags were added, so slot colours match the tag chips.
  const orderedSeries = useMemo(() => {
    const list = data?.series || [];
    const rank = (t) => {
      const i = tags.indexOf(t);
      return i < 0 ? tags.length : i;
    };
    // A historian stores no unit: borrow the one the topic's live payload carries.
    return list
      .slice()
      .sort((a, b) => rank(a.tag) - rank(b.tag))
      .map((s) => (s.unit ? s : { ...s, unit: liveUnitOf(s.tag, connectedBrokers) || undefined }));
  }, [data, tags, connectedBrokers]);
  const distinctUnits = new Set(orderedSeries.map((s) => s.unit || '')).size;
  const normalizeForced = distinctUnits > 2;
  const sources = [
    { value: 'live', label: 'Live', on: connectedBrokers.length > 0 },
    { value: 'historian', label: 'Historian', on: historians.length > 0 },
    { value: 'recording', label: 'Recording', on: recordings.length > 0 }
  ].filter((o) => o.on || o.value === sourceType);
  const sourceList = usingLive ? connectedBrokers : usingRecording ? recordings : historians;
  const sourceName = sourceList.find((x) => x.id === sourceId)?.name;
  const rangeLabel = RANGE_PRESETS.find((p) => p.ms === rangeMs)?.label || '';
  const listId = 'trend-tag-suggestions';

  // CSV of what is shown: the same source, tags (in chart order, with the units on the axis) and range.
  const exportCsv = async () => {
    if (!data || exporting) return;
    setExporting(true);
    try {
      const url = trendsExportUrl({
        source: usingLive ? 'live' : usingRecording ? 'recording' : 'historian',
        id: sourceId,
        tags: orderedSeries.map((s) => s.tag),
        units: orderedSeries.map((s) => s.unit || ''),
        from: data.start,
        to: data.end,
        mode: exportMode
      });
      await downloadTrendsCsv(url);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setExporting(false);
    }
  };
  const showList = suggestOpen && searchable && shownSuggestions.length > 0;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Trends"
        subtitle={tags.length ? `${tags.length} of ${MAX_TAGS} tags · last ${rangeLabel}${sourceName ? ` · ${sourceName}` : ''}` : undefined}
        actions={
          <>
            <HelpButton title="How Trends works" label="How Trends works">
              <p>Trends charts numeric values over time. Pick a source, add up to ten tags, and choose a range.</p>
              <p>Three sources:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <b>Live</b>: reads straight from a broker&apos;s recent message stream, held in memory. No historian needed.
                </li>
                <li>
                  <b>Historian</b>: reads back from a time-series database you set up under Pipelines, over any range. Search pulls tag names straight from the historian.
                </li>
                <li>
                  <b>Recording</b>: replays a file captured by the Recorder.
                </li>
              </ul>
              <p>
                Only numeric values plot. A payload like <code>{'{ value: 401, unit: "V" }'}</code> charts its <code>value</code> and labels the axis in V; plain numbers chart directly; text is
                skipped. Times are shown in your time zone, named under the chart. Hover the chart for the values at a point; drag across it to zoom, double-click to reset.
              </p>
              <p>
                Units: tags with one unit share a labelled axis; two units get a left and a right axis; with more, each tag is scaled to its own range (Normalize) and the readout keeps the real value and unit.
              </p>
              <p>
                Quality: a Bad sample is not plotted. The line breaks and a red triangle marks it on the time axis. Over long ranges samples are averaged per interval: the average uses only the
                usable samples, an interval with only Bad samples is a gap, and one that mixed Bad and good samples is marked partial with a hollow amber diamond. The readout says which. A faint
                dashed line bridges an outage (no samples for much longer than usual). InfluxDB stores no quality, so there nothing can be marked.
              </p>
              <p>
                Export CSV saves the tags and range on screen: times in ISO 8601 UTC, one value and one quality column per tag (the unit in the header), empty cells where a tag had no
                sample. Pick <b>as charted</b> for the averaged points the chart draws, or <b>raw samples</b> for every stored sample; the file name and its first lines say which.
              </p>
            </HelpButton>
            <Toggle checked={autoRefresh} onChange={setAutoRefresh} label="Auto refresh" />
            <Button variant="secondary" onClick={reload} disabled={!sourceId || tags.length === 0} loading={loading && active}>
              {!(loading && active) && <RefreshCw size={14} aria-hidden="true" />} Refresh
            </Button>
          </>
        }
      />

      <PageBody className="space-y-4">
        {sourcesError && (
          <Banner
            variant="error"
            title={sourcesError}
            onRetry={() => {
              setSourcesError('');
              setSourcesTry((v) => v + 1);
            }}
          />
        )}
        {historians.length === 0 && recordings.length === 0 && connectedBrokers.length === 0 ? (
          <Card>
            <EmptyState
              icon={Database}
              title="Nothing to trend yet"
              hint="Connect a broker to chart live values from the message stream (no storage needed), or add a historian or a recording for longer history."
              action={
                <ButtonLink to="/brokers" variant="primary">
                  Connect a broker
                </ButtonLink>
              }
            />
          </Card>
        ) : (
          <>
            <Card className="space-y-4 p-4">
              <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
                <Field label="Source">
                  <SegmentedControl label="Data source" value={sourceType} onChange={setSourceType} options={sources} />
                </Field>
                <Select
                  label={usingLive ? 'Broker' : usingRecording ? 'Recording' : 'Historian'}
                  fieldClassName="min-w-[12rem] flex-1 sm:max-w-xs"
                  value={sourceId}
                  onChange={(e) => {
                    if (usingLive) setBrokerId(e.target.value);
                    else if (usingRecording) setRecId(e.target.value);
                    else setHistId(e.target.value);
                  }}
                >
                  {sourceList.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name || x.id.slice(0, 8)}
                      {usingLive || usingRecording ? '' : ` (${x.type})`}
                    </option>
                  ))}
                </Select>
                <Field label="Range">
                  <SegmentedControl label="Time range" value={rangeMs} onChange={setRangeMs} options={RANGE_PRESETS.map((p) => ({ value: p.ms, label: p.label }))} />
                </Field>
              </div>

              <div>
                <Field label={`Tags · ${tags.length} of ${MAX_TAGS}`} help={tagHelp(usingLive, usingRecording, selected)}>
                  <div className="relative flex gap-2">
                    <Input
                      role="combobox"
                      aria-expanded={showList}
                      aria-controls={listId}
                      aria-autocomplete="list"
                      value={query}
                      placeholder={tags.length >= MAX_TAGS ? 'Ten tags is the maximum' : searchable ? 'Search topics, or type a path and press Enter' : 'Type the tag path and press Enter'}
                      disabled={tags.length >= MAX_TAGS}
                      className="font-mono text-xs"
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setSuggestOpen(true);
                      }}
                      onFocus={() => setSuggestOpen(true)}
                      onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addTag(query);
                        }
                        if (e.key === 'Escape') setSuggestOpen(false);
                      }}
                    />
                    <Button variant="secondary" onClick={() => addTag(query)} disabled={!query.trim() || tags.length >= MAX_TAGS}>
                      <Plus size={14} aria-hidden="true" /> Add tag
                    </Button>
                    {showList && (
                      <ul id={listId} role="listbox" aria-label="Matching tags" className="absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-md border border-line-strong bg-overlay py-1 shadow-overlay">
                        {shownSuggestions.map((sug) => (
                          <li
                            key={sug}
                            role="option"
                            aria-selected="false"
                            tabIndex={-1}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              addTag(sug);
                            }}
                            className="cursor-pointer truncate px-3 py-1.5 font-mono text-xs text-fg hover:bg-raised"
                          >
                            {sug}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </Field>
                {tags.length > 0 && (
                  <ul aria-label="Selected tags" className="mt-3 flex flex-wrap gap-1.5">
                    {tags.map((tag, i) => (
                      <li key={tag} className="inline-flex h-7 max-w-full items-center gap-1.5 rounded border border-line bg-raised pl-2 text-xs text-fg">
                        <svg width="16" height="6" aria-hidden="true" className="shrink-0">
                          <line x1="0" y1="3" x2="16" y2="3" stroke={seriesColor(i, chartTheme)} strokeWidth="2" strokeDasharray={tags.length > 1 && SERIES_DASH[i] ? SERIES_DASH[i].join(' ') : undefined} />
                        </svg>
                        <span className="max-w-[16rem] truncate font-mono" title={tag}>
                          {shortTag(tag, 34)}
                        </span>
                        <IconButton icon={X} size={12} label={`Remove tag ${tag}`} className="h-7 w-7" onClick={() => removeTag(tag)} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>

            <Card className="p-4">
              {tags.length === 0 && !error ? (
                <EmptyState title="Add a tag to start" hint="Search the source above, or type a topic path and press Enter. Up to ten tags share one chart." className="min-h-[18rem]" />
              ) : (
                <>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-medium text-fg">Chart</h2>
                    <div className="flex flex-wrap items-center gap-2">
                      {usingLive ? (
                        <span className="text-xs text-muted">CSV holds the raw samples shown</span>
                      ) : (
                        <Select aria-label="CSV values" value={exportMode} onChange={(e) => setExportMode(e.target.value)} className="w-auto">
                          <option value="bucketed">CSV: as charted (bucketed)</option>
                          <option value="raw">CSV: raw samples</option>
                        </Select>
                      )}
                      <Button variant="secondary" size="sm" onClick={exportCsv} loading={exporting} disabled={!data || orderedSeries.length === 0}>
                        {!exporting && <Download size={14} aria-hidden="true" />} Export CSV
                      </Button>
                    </div>
                    {orderedSeries.length > 1 && (
                      <Toggle
                        checked={normalize || normalizeForced}
                        disabled={normalizeForced}
                        onChange={setNormalize}
                        label="Normalize"
                        description={normalizeForced ? 'On: more than two units cannot share axes' : distinctUnits === 2 ? 'Off: one axis per unit' : undefined}
                      />
                    )}
                  </div>
                  <TrendChart series={orderedSeries} loading={loading} error={error} height={380} normalize={normalize} meta={data?.meta} onRetry={reload} />
                </>
              )}
            </Card>
          </>
        )}
      </PageBody>
    </div>
  );
}

function tagHelp(usingLive, usingRecording, historian) {
  if (usingLive) return "Live values from the broker's recent message stream, held in memory. Only numeric values plot.";
  if (usingRecording) return 'From a local recording file. No external database needed.';
  if (historian?.type === 'timebase') return 'Timebase has no tag-listing API: type the exact tag path and press Enter.';
  return 'Search pulls tag names straight from the historian.';
}
