import { useCallback, useRef, useState } from 'react';
import { Dialog, Button, Banner, Table, THead, Th, Tr, Td } from '@/components/ui';

/**
 * Edit conflicts (optimistic concurrency). Every stored object has a `rev`; a save that carries
 * the `rev` it loaded is refused with 409 `{ code: 'stale', current }` when someone else (another
 * tab, an MCP agent) saved first. Nothing is lost silently: this dialog shows what differs between
 * the user's unsaved version and the saved one, and offers
 *
 *   Keep mine (overwrite)  save again on top of the other change
 *   Take theirs            drop my edits and use what is saved
 *   Cancel                 go back to the editor, edits untouched
 *
 * Usage in an editor:
 *   const { resolveConflict, conflictDialog } = useConflict();
 *   try { await api.saveX({ ...payload, rev }); }
 *   catch (e) {
 *     const choice = await resolveConflict(e, { what: 'device', mine: payload });
 *     if (choice === 'mine') await api.saveX({ ...payload, rev: e.current?.rev });
 *     else if (choice === 'theirs') useTheirs(e.current);
 *     // 'cancel' (or a non-conflict error: choice is null and the error is yours to show)
 *   }
 */

export const isStale = (e) => Boolean(e && e.status === 409 && e.code === 'stale');

// Fields that are bookkeeping or runtime state, never a user's edit.
const ALWAYS_IGNORED = new Set(['rev', 'updatedAt', 'id', 'status', 'state', 'metrics', 'instances', 'profileErrors', 'warnings', 'broken', 'hasSecret', 'hasWebhook', 'lockedAt']);
const SECRET_RE = /pass|token|secret|apikey|api_key|credential|webhook/i;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Flatten nested objects to dotted paths; arrays and scalars are leaves. */
function flatten(value, prefix = '', out = {}, depth = 0) {
  if (isObj(value) && depth < 3) {
    for (const [k, v] of Object.entries(value)) {
      if (!prefix && ALWAYS_IGNORED.has(k)) continue;
      flatten(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
  } else if (prefix) out[prefix] = value;
  return out;
}

const show = (v) => {
  if (v === undefined) return '(not set)';
  if (v === null || v === '') return '(empty)';
  if (typeof v === 'string') return v.length > 140 ? `${v.slice(0, 137)}…` : v;
  const s = JSON.stringify(v);
  return s.length > 140 ? `${s.slice(0, 137)}…` : s;
};

/**
 * Rows where the user's version differs from the saved one: [{ path, mine, theirs }].
 * Only fields the user's payload carries are compared (the server adds status and defaults of
 * its own), credentials are never shown, and an unset value equals an empty one.
 */
export function diffRows(mine, theirs) {
  const a = flatten(mine);
  const b = flatten(theirs);
  const norm = (v) => (v === undefined || v === null || v === '' ? null : v);
  const rows = [];
  for (const path of Object.keys(a)) {
    if (path.split('.').some((seg) => SECRET_RE.test(seg))) continue;
    if (JSON.stringify(norm(a[path])) === JSON.stringify(norm(b[path]))) continue;
    rows.push({ path, mine: show(a[path]), theirs: show(b[path]) });
  }
  return rows;
}

export function ConflictDialog({ what = 'item', mine, current, onChoose, busy = false }) {
  const rows = diffRows(mine, current);
  const gone = !current;
  return (
    <Dialog
      title={gone ? `This ${what} was deleted elsewhere` : `This ${what} was changed elsewhere`}
      description={
        gone
          ? 'Someone removed it after you opened it. Your edits are still here.'
          : `Someone saved a newer version (revision ${current.rev ?? '?'}) after you opened it. Nothing has been overwritten yet.`
      }
      size="lg"
      onClose={() => onChoose('cancel')}
      footer={
        <>
          <Button variant="secondary" onClick={() => onChoose('cancel')} disabled={busy}>
            Cancel
          </Button>
          {!gone && (
            <Button variant="secondary" onClick={() => onChoose('theirs')} disabled={busy}>
              Take theirs
            </Button>
          )}
          <Button onClick={() => onChoose('mine')} loading={busy}>
            {gone ? 'Save mine as new' : 'Keep mine (overwrite)'}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="conflict-dialog">
        {gone ? (
          <p className="text-sm text-muted">Saving again creates it anew with your values.</p>
        ) : rows.length ? (
          <>
            <p className="text-sm text-muted">
              {rows.length === 1 ? '1 field differs' : `${rows.length} fields differ`} between your unsaved version and the saved one.
            </p>
            <Table caption={`Fields that differ in this ${what}`} className="text-sm">
              <THead>
                <Th>Field</Th>
                <Th>Yours (unsaved)</Th>
                <Th>Theirs (saved)</Th>
              </THead>
              <tbody>
                {rows.slice(0, 40).map((r) => (
                  <Tr key={r.path}>
                    <Td header className="mono whitespace-nowrap text-xs">{r.path}</Td>
                    <Td className="mono max-w-[16rem] break-words text-xs" data-testid="conflict-mine">{r.mine}</Td>
                    <Td className="mono max-w-[16rem] break-words text-xs" data-testid="conflict-theirs">{r.theirs}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            {rows.length > 40 && <p className="text-xs text-subtle">…and {rows.length - 40} more fields.</p>}
          </>
        ) : (
          <Banner variant="info">
            No visible field differs. The other change touched something this form does not show (a stored credential, or runtime state), so keeping yours is safe.
          </Banner>
        )}
        <p className="text-xs text-subtle">
          <strong className="font-medium text-muted">Keep mine</strong> saves your version on top. <strong className="font-medium text-muted">Take theirs</strong> discards
          your unsaved edits and shows what is saved. <strong className="font-medium text-muted">Cancel</strong> returns to the editor with your edits intact.
        </p>
      </div>
    </Dialog>
  );
}

/**
 * Hook: `resolveConflict(error, { what, mine })` resolves with 'mine' | 'theirs' | 'cancel' when the
 * error is a stale-revision 409, or with null for any other error (the caller reports it).
 */
export function useConflict() {
  const [pending, setPending] = useState(null);
  const resolver = useRef(null);

  const resolveConflict = useCallback(
    (error, { what = 'item', mine = {} } = {}) => {
      if (!isStale(error)) return Promise.resolve(null);
      return new Promise((resolve) => {
        resolver.current = resolve;
        setPending({ what, mine, current: error.current || null });
      });
    },
    []
  );

  const choose = useCallback((choice) => {
    const resolve = resolver.current;
    resolver.current = null;
    setPending(null);
    resolve?.(choice);
  }, []);

  const conflictDialog = pending ? <ConflictDialog what={pending.what} mine={pending.mine} current={pending.current} onChoose={choose} /> : null;
  return { resolveConflict, conflictDialog };
}
