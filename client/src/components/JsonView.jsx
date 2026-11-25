import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import clsx from 'clsx';

/** Compact, dependency-free collapsible JSON tree with syntax colouring (design-system state tokens). */
export default function JsonView({ data, name = null, depth = 0, defaultOpen = true }) {
  const [open, setOpen] = useState(depth < 2 ? defaultOpen : false);

  if (data === null) return <Leaf name={name} value="null" cls="text-subtle" />;
  if (typeof data === 'number') return <Leaf name={name} value={String(data)} cls="text-warn" />;
  if (typeof data === 'boolean') return <Leaf name={name} value={String(data)} cls="text-info" />;
  if (typeof data === 'string') return <Leaf name={name} value={`"${data}"`} cls="text-good" />;

  const isArray = Array.isArray(data);
  const entries = isArray ? data.map((v, i) => [i, v]) : Object.entries(data || {});
  const bracket = isArray ? ['[', ']'] : ['{', '}'];

  if (entries.length === 0) {
    return <Leaf name={name} value={`${bracket[0]}${bracket[1]}`} cls="text-subtle" />;
  }

  return (
    <div className="mono text-xs leading-relaxed">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded hover:bg-raised"
      >
        <ChevronRight size={12} className={clsx('text-subtle transition', open && 'rotate-90')} />
        {name !== null && <span className="text-accent-text">{name}: </span>}
        <span className="text-subtle">
          {bracket[0]}
          {!open && <span className="px-1 text-faint">{entries.length} items</span>}
          {!open && bracket[1]}
        </span>
      </button>
      {open && (
        <div className="border-l border-line pl-4">
          {entries.map(([k, v]) => (
            <JsonView key={k} name={String(k)} data={v} depth={depth + 1} />
          ))}
          <div className="text-subtle">{bracket[1]}</div>
        </div>
      )}
    </div>
  );
}

function Leaf({ name, value, cls }) {
  return (
    <div className="mono text-xs leading-relaxed">
      {name !== null && <span className="text-accent-text">{name}: </span>}
      <span className={cls}>{value}</span>
    </div>
  );
}
