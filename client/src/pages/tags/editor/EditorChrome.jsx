import { X } from 'lucide-react';
import clsx from 'clsx';
import { Button, IconButton, SegmentedControl, Banner } from '@/components/ui';
import { READ_ONLY_REASON } from '@/store/selectors';

const VIEWS = [
  { value: 'edit', label: 'Edit' },
  { value: 'preview', label: 'Preview' }
];

/** Title, source line, the edit / preview switch below xl, and close. */
export function EditorHeader({ titleId, title, subtitle, view, onView, onClose }) {
  return (
    <>
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-line px-4 py-2">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-base font-medium text-fg">
            {title}
          </h2>
          <p className="truncate text-xs text-muted">{subtitle}</p>
        </div>
        <SegmentedControl size="sm" className="hidden sm:inline-flex xl:hidden" label="Show" value={view} onChange={onView} options={VIEWS} />
        <IconButton icon={X} label="Close" side="left" onClick={onClose} />
      </header>
      <div className="flex shrink-0 border-b border-line px-4 py-1.5 sm:hidden">
        <SegmentedControl size="sm" className="w-full [&>button]:flex-1 [&>button]:justify-center" label="Show" value={view} onChange={onView} options={VIEWS} />
      </div>
    </>
  );
}

/** Jump links to the sections, with the published count and a dot where there are problems. */
export function SectionNav({ sections, problems, published }) {
  return (
    <nav aria-label="Sections" className="sticky top-0 z-20 flex gap-1 overflow-x-auto border-b border-line bg-overlay px-3 py-1.5 sm:px-4">
      {sections.map((s) => {
        const p = problems(s.id);
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => document.getElementById(`map-${s.id}`)?.scrollIntoView({ block: 'start' })}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-xs font-medium text-muted transition-colors hover:bg-raised hover:text-fg"
            aria-label={p ? `${s.label}, ${p} problem${p === 1 ? '' : 's'}` : undefined}
          >
            {s.label}
            {s.id === 'tags' && <span className="font-mono text-2xs text-subtle">{published}</span>}
            {p > 0 && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-bad" />}
          </button>
        );
      })}
    </nav>
  );
}

const Note = ({ children }) => <div className="px-4 pt-4 sm:px-5">{children}</div>;

/** What the editor must say before the form: another tab, read-only, a failed save or load. */
export function EditorNotices({ otherTabs, readOnly, saveError, onDismissError, schema, devices }) {
  return (
    <>
      {otherTabs > 0 && (
        <Note>
          <Banner variant="warn" title="Also open in another tab">
            This mapping is open in {otherTabs === 1 ? 'another tab' : `${otherTabs} other tabs`} of this browser. Whichever saves second is asked before overwriting the other.
          </Banner>
        </Note>
      )}
      {readOnly && (
        <Note>
          <Banner variant="info" title="Read-only session">
            You can look at this mapping, but saving is disabled. Sign in with the admin token to make changes.
          </Banner>
        </Note>
      )}
      {saveError && (
        <Note>
          <Banner variant="error" title="Could not save the mapping" onDismiss={onDismissError}>
            {saveError}
          </Banner>
        </Note>
      )}
      {schema.status === 'error' && (
        <Note>
          <Banner variant="error" title="Could not load the mapping options" onRetry={schema.retry}>
            {schema.error}. Field lists fall back to what this page knows.
          </Banner>
        </Note>
      )}
      {devices?.status === 'error' && (
        <Note>
          <Banner variant="error" title="Could not read the device's tags" onRetry={devices.retry}>
            {devices.error}
          </Banner>
        </Note>
      )}
    </>
  );
}

/** Status line (the first problem jumps to its field), cancel / close and save. */
export function EditorFooter({ status, onStatus, onCancel, onSave, busy, readOnly, label }) {
  return (
    <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">
      {status && (
        <p role="status" className={clsx('mr-auto min-w-0 flex-1 basis-full truncate text-xs sm:basis-64', status.tone === 'bad' ? 'text-bad' : 'text-muted')}>
          {status.tone === 'bad' && onStatus ? (
            <button type="button" className="max-w-full truncate text-left underline-offset-2 hover:underline" onClick={onStatus}>
              {status.text}
            </button>
          ) : (
            status.text
          )}
        </p>
      )}
      <Button variant="secondary" onClick={onCancel}>
        {readOnly ? 'Close' : 'Cancel'}
      </Button>
      <Button onClick={onSave} loading={busy} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : 'Ctrl+S'}>
        {label}
      </Button>
    </footer>
  );
}
