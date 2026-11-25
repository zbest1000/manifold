import { useState } from 'react';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { Dialog, Button, Banner, Radio, Path, StatusText, useConfirm } from '@/components/ui';
import { READ_ONLY_REASON } from '@/store/selectors';
import { pretty } from './previewModel';
import { migrateRoute } from './tagsApi';

/** "N pipeline routes were created by the old Tags flow" with a link to the review. */
export function MigrationBanner({ count, onReview }) {
  return (
    <Banner
      variant="info"
      title={`${count} pipeline route${count === 1 ? '' : 's'} can become ${count === 1 ? 'a mapping' : 'mappings'}`}
      action={
        <Button size="sm" variant="secondary" onClick={onReview}>
          Review
        </Button>
      }
    >
      Earlier versions mapped MQTT topics with a pipeline route. A mapping adds per-tag names, units, quality, _status and _meta, deadband, staleness and history. Nothing changes until you review and confirm each one.
    </Banner>
  );
}

/** One candidate: the route as stored, the equivalent mapping, what changes, and the confirm step. */
function Candidate({ c, readOnly, onMigrated }) {
  const [routeAction, setRouteAction] = useState('disable');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);
  const [confirm, confirmDialog] = useConfirm();
  const r = c.route;
  const m = c.mapping;
  const label = r.name || r.id;

  const apply = async () => {
    const ok = await confirm({
      title: `Replace route ${label}?`,
      message: `A mapping "${m.name}" is created from ${m.source.tags === 'all' ? m.source.filter : m.source.tags[0].address} to ${m.target.assetPath}, then the route is ${routeAction === 'delete' ? 'deleted' : 'disabled (it stays under Pipelines, Routes)'}.`,
      confirmLabel: routeAction === 'delete' ? 'Create mapping, delete route' : 'Create mapping, disable route',
      danger: routeAction === 'delete'
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await migrateRoute({ routeId: r.id, mapping: m, route: routeAction });
      setDone(res.binding);
      toast.success(`Mapping ${res.binding?.name || ''} created`);
      onMigrated();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="space-y-3 rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-fg">{label}</span>
        {c.createdByTags && <span className="text-xs text-subtle">created by the Tags page</span>}
        {r.enabled === false && <StatusText tone="neutral">route disabled</StatusText>}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        <Path value={r.source.filter} className="text-fg" />
        <ArrowRight size={12} aria-hidden="true" className="shrink-0 text-faint" />
        <Path value={m.target.assetPath} className="text-fg" />
        <span className="text-subtle">
          on {r.target.brokerId} · {m.target.format}
        </span>
      </div>
      <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
        {c.differences.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted">The route and the mapping as JSON</summary>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          <pre tabIndex={0} role="region" aria-label={`Route ${label}`} className="max-h-60 overflow-auto rounded-md border border-line bg-app p-2 font-mono">
            {pretty(r)}
          </pre>
          <pre tabIndex={0} role="region" aria-label={`Mapping replacing ${label}`} className="max-h-60 overflow-auto rounded-md border border-line bg-app p-2 font-mono">
            {pretty(m)}
          </pre>
        </div>
      </details>
      {c.blocked && <Banner variant="error" title="This one cannot be migrated as is">{c.blocked}</Banner>}
      {error && <Banner variant="error" title="Migration failed">{error}</Banner>}
      {done ? (
        <p className="inline-flex items-center gap-1.5 text-sm text-good">
          <CheckCircle2 size={14} aria-hidden="true" /> Mapping {done.name} created; the route was {routeAction === 'delete' ? 'deleted' : 'disabled'}.
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="radiogroup" aria-label={`What happens to route ${label}`} className="flex flex-wrap gap-x-4 gap-y-1">
            <Radio name={`route-${r.id}`} value="disable" checked={routeAction === 'disable'} onChange={setRouteAction} label="Disable the route" />
            <Radio name={`route-${r.id}`} value="delete" checked={routeAction === 'delete'} onChange={setRouteAction} label="Delete the route" />
          </div>
          <Button size="sm" onClick={apply} loading={busy} disabled={readOnly || Boolean(c.blocked)} title={readOnly ? READ_ONLY_REASON : undefined}>
            Create mapping
          </Button>
        </div>
      )}
      {confirmDialog}
    </li>
  );
}

/**
 * Review of the pipeline routes the old Tags flow created for MQTT topics. Each shows the
 * equivalent mapping and what changes; nothing happens before the user confirms one.
 */
export default function MigrationReview({ candidates, readOnly, onClose, onDone }) {
  // A snapshot: migrated candidates stay listed (with their result) while the page reloads.
  const [list] = useState(candidates);
  return (
    <Dialog
      title="Move topic routes to mappings"
      description="Only routes with the exact shape the Tags page used to create are listed; hand-edited routes are left alone."
      onClose={onClose}
      size="xl"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <ul className="space-y-3">
        {list.map((c) => (
          <Candidate key={c.route.id} c={c} readOnly={readOnly} onMigrated={onDone} />
        ))}
      </ul>
    </Dialog>
  );
}
