import { useMemo } from 'react';
import { X, ListFilter, Pencil, Upload } from 'lucide-react';
import { READ_ONLY_REASON } from '@/store/selectors';
import { Button, ButtonLink, EmptyState, Banner, Panel, Card, LoadingState, Select, IconButton, StatusText } from '@/components/ui';
import TagTree from './TagTree';
import HostStatePanel from './HostStatePanel';
import TagPath from './TagPath';
import { shortLabels } from './tagPath';
import { HEALTH_TONE, HEALTH_LABEL } from './bindingHealthView';
import { sourceKey } from './helpers';
import { defaultFilter } from './mqttModel';

/**
 * The "Map tags" workspace: the source tree on the left; the selection, "map by rule / filter",
 * what already maps this source and the Sparkplug host state on the right.
 */
export default function MapWorkspace({ page, selection, setSelection, onToggle, onAddMany, onEdit, readOnly, addLabel }) {
  const { sources, sourcesLoaded, sourcesError, loadSources, wantedParam, wantedMissing, source, groups, pickSource, boundIndex, mine, health, brokers, sparkplug, onSparkplug } = page;
  const list = [...selection.values()];
  const labels = useMemo(() => shortLabels([...selection.values()].map((t) => t.address)), [selection]);
  const remove = (id) =>
    setSelection((p) => {
      const n = new Map(p);
      n.delete(id);
      return n;
    });

  if (!source) {
    return (
      <>
        {sourcesError && (
          <Banner variant="error" title="Could not load the list of sources" onRetry={loadSources}>
            {sourcesError}
          </Banner>
        )}
        {!sourcesLoaded ? (
          <LoadingState label="sources" rows={3} />
        ) : (
          !sourcesError && (
            <Card>
              <EmptyState
                title="No sources connected"
                hint="Tags come from live connections. Add a device, connect an OPC UA server, or connect a broker (its topics and Sparkplug devices appear automatically)."
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <ButtonLink to="/devices" variant="secondary">
                      Devices
                    </ButtonLink>
                    <ButtonLink to="/opcua" variant="secondary">
                      OPC UA
                    </ButtonLink>
                    <ButtonLink to="/brokers" variant="secondary">
                      Brokers
                    </ButtonLink>
                  </div>
                }
              />
            </Card>
          )
        )}
      </>
    );
  }

  const ruleCard =
    source.type === 'device'
      ? { title: 'Every tag of this device', hint: 'Map all tags, or those matching include and exclude rules. Tags added to the device later are picked up when they match.', label: 'Map by rule', spec: { srcType: 'device', source, selectMode: 'rules' } }
      : source.type === 'mqtt'
        ? { title: 'Every topic under a filter', hint: 'Map each topic under a wildcard filter (one value per topic). Topics that appear later are picked up automatically.', label: 'Map by filter', spec: { srcType: 'mqtt', source, selectMode: 'rules', filter: defaultFilter(list.map((t) => t.address)) } }
        : null;

  return (
    <>
      {sourcesError && (
        <Banner variant="error" title="Could not load the list of sources" onRetry={loadSources}>
          {sourcesError}
        </Banner>
      )}
      {wantedMissing && (
        <Banner variant="warn" title="That source is not connected">
          The link names <span className="mono">{wantedParam}</span>, which is not online right now. Showing another source; check that the device or connection is up.
        </Banner>
      )}
      <div className="grid min-w-0 gap-4 lg:h-[calc(100dvh-12.5rem)] lg:min-h-[30rem] lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-label="Tag browser" className="flex h-[32rem] min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-panel lg:h-auto">
          <div className="flex flex-wrap items-end gap-2 border-b border-line px-3 py-2.5">
            <Select label="Source" id="tag-source" fieldClassName="min-w-0 flex-1 basis-60" value={sourceKey(source)} onChange={(e) => pickSource(e.target.value)} disabled={sources.length === 0}>
              {groups.map((g) => (
                <optgroup key={g.type} label={g.label}>
                  {g.items.map((s) => (
                    <option key={sourceKey(s)} value={sourceKey(s)}>
                      {s.label}
                      {s.state && s.state !== 'online' ? ` (${s.state})` : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </div>
          <TagTree key={sourceKey(source)} source={source} selection={selection} onToggle={onToggle} onAddMany={onAddMany} boundIndex={boundIndex} />
        </section>

        <aside aria-label="Selection and existing mappings" className="flex min-w-0 flex-col gap-4 lg:overflow-y-auto">
          <Panel
            title={<span id="selection-heading">Selected {source.type === 'mqtt' ? 'topics' : 'tags'}</span>}
            count={<span aria-live="polite">{selection.size}</span>}
            actions={
              <>
                {source.type !== 'sparkplug' && (
                  <Button size="sm" variant="ghost" disabled={readOnly} title={readOnly ? READ_ONLY_REASON : 'Open the editor and import rows from a CSV file'} onClick={() => onEdit({ srcType: source.type, source, picked: list, selectMode: 'list', csv: true })}>
                    <Upload size={12} aria-hidden="true" /> CSV
                  </Button>
                )}
                {selection.size > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => setSelection(() => new Map())}>
                    Clear
                  </Button>
                )}
              </>
            }
            flush
          >
            {selection.size === 0 ? (
              <p className="px-4 py-3 text-sm text-muted">Tick tags in the tree, or use Select all on a folder, then {addLabel.toLowerCase()}.</p>
            ) : (
              <ul className="max-h-60 divide-y divide-line overflow-y-auto" aria-labelledby="selection-heading">
                {list.map((t) => (
                  <li key={t.id} className="flex h-8 items-center justify-between gap-2 pl-4 pr-1">
                    <TagPath name={t.name} info={labels.get(String(t.address))} />
                    <IconButton icon={X} size={12} className="h-6 w-6 shrink-0" label={`Remove ${t.name} from selection`} onClick={() => remove(t.id)} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {ruleCard && (
            <Card className="p-4">
              <p className="text-sm font-medium text-fg">{ruleCard.title}</p>
              <p className="mt-0.5 text-xs text-subtle">{ruleCard.hint}</p>
              <Button size="sm" variant="secondary" className="mt-3" disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined} onClick={() => onEdit(ruleCard.spec)}>
                <ListFilter size={12} aria-hidden="true" /> {ruleCard.label}
              </Button>
            </Card>
          )}

          <Panel title="Mappings of this source" count={mine.length} flush>
            {mine.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted">Nothing from this source is mapped yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {mine.map((b) => {
                  const h = health[b.id];
                  const label = b.name || b.id.slice(0, 8);
                  return (
                    <li key={b.id} className="flex items-center gap-2 py-1.5 pl-4 pr-1">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-fg">{label}</span>
                        <StatusText tone={HEALTH_TONE[h?.state] || 'neutral'} className="text-xs">
                          {HEALTH_LABEL[h?.state] || (b.enabled === false ? 'Disabled' : 'Waiting')}
                        </StatusText>
                      </span>
                      <IconButton icon={Pencil} size={14} label={`${readOnly ? 'View' : 'Edit'} mapping ${label}`} onClick={() => onEdit({ binding: b })} />
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Card className="p-4">
            <HostStatePanel brokers={brokers} hosts={sparkplug?.hosts || {}} onStatus={onSparkplug} />
          </Card>
        </aside>
      </div>
    </>
  );
}
