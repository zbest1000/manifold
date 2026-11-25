import { useMemo } from 'react';
import { Dialog, Button, Banner } from '@/components/ui';
import { describeConflict } from './staleEdit';

function Changes({ title, list, both, empty }) {
  return (
    <section aria-label={title} className="min-w-0">
      <h3 className="text-sm font-medium text-fg">{title}</h3>
      {list.length === 0 ? (
        <p className="mt-1 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="mt-1.5 max-h-60 space-y-1 overflow-y-auto rounded-md border border-line p-2">
          {list.slice(0, 60).map((d) => (
            <li key={d.path} className="min-w-0 text-xs">
              <span className="font-mono text-fg">{d.path}</span>
              {both.includes(d.path) && <span className="ml-1.5 text-warn">(both changed)</span>}
              <span className="block truncate font-mono text-subtle line-through" title={d.from}>
                {d.from}
              </span>
              <span className="block truncate font-mono text-fg" title={d.to}>
                {d.to}
              </span>
            </li>
          ))}
          {list.length > 60 && <li className="text-xs text-subtle">and {list.length - 60} more</li>}
        </ul>
      )}
    </section>
  );
}

/**
 * Someone saved this mapping after the editor loaded it. Shows what changed there and here;
 * nothing is lost until the user picks: keep mine (overwrite), take theirs, or back to editing.
 */
export default function StaleEditDialog({ base, mine, theirs, busy, onKeepMine, onTakeTheirs, onCancel }) {
  const c = useMemo(() => describeConflict({ base, mine, theirs }), [base, mine, theirs]);
  return (
    <Dialog
      title="This mapping was changed elsewhere"
      description="Someone saved it (another tab, user or tool) after you opened it. Your edits are still here."
      onClose={onCancel}
      size="xl"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={onTakeTheirs}>
            Take theirs
          </Button>
          <Button variant="danger" onClick={onKeepMine} loading={busy}>
            Keep mine (overwrite)
          </Button>
        </>
      }
    >
      {c.both.length > 0 && (
        <Banner variant="warn" title={`${c.both.length} field${c.both.length === 1 ? ' was' : 's were'} changed in both places`} className="mb-3">
          Keep mine replaces their values with yours; take theirs drops your edits.
        </Banner>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <Changes title="Changed elsewhere" list={c.elsewhere} both={c.both} empty="Nothing that this editor shows (only internal fields changed)." />
        <Changes title="Your changes" list={c.here} both={c.both} empty="You changed nothing yet." />
      </div>
    </Dialog>
  );
}
