/** What saving an edit changes: renamed, removed and added topics (diffTopics). */
export default function TopicChanges({ diff }) {
  const changes = diff.renamed.length + diff.removed.length + diff.added.length;
  return (
    <div className="space-y-4 text-sm">
      {!changes && <p className="text-muted">No topic changes. Saving keeps every topic where it is.</p>}
      {diff.renamed.length > 0 && (
        <div>
          <p className="font-medium text-fg">
            {diff.renamed.length} topic{diff.renamed.length === 1 ? '' : 's'} renamed
          </p>
          <p className="helper">The old topics&apos; retained messages are cleared when you save.</p>
          <ul className="mt-1.5 space-y-1">
            {diff.renamed.slice(0, 50).map((r) => (
              <li key={`${r.unitName || ''}${r.address}`} className="min-w-0 font-mono text-xs">
                <span className="block truncate text-subtle line-through" title={r.from}>
                  {r.from}
                </span>
                <span className="block truncate text-fg" title={r.to}>
                  {r.to}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {diff.removed.length > 0 && (
        <div>
          <p className="font-medium text-fg">
            {diff.removed.length} topic{diff.removed.length === 1 ? '' : 's'} removed
          </p>
          <p className="helper">No longer published; retained values are cleared.</p>
          <ul className="mt-1.5 space-y-0.5">
            {diff.removed.slice(0, 50).map((r) => (
              <li key={r.topic} className="truncate font-mono text-xs text-subtle" title={r.topic}>
                {r.topic}
              </li>
            ))}
          </ul>
        </div>
      )}
      {diff.added.length > 0 && (
        <div>
          <p className="font-medium text-fg">
            {diff.added.length} topic{diff.added.length === 1 ? '' : 's'} added
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {diff.added.slice(0, 50).map((r) => (
              <li key={r.topic} className="truncate font-mono text-xs text-fg" title={r.topic}>
                {r.topic}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
