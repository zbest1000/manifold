import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import clsx from 'clsx';

/**
 * Payload viewer on the design system's code styles: a collapsible JSON tree in
 * the data face. Quiet by design: keys muted, values in the text colour, null
 * and empty values subtle. Colour is not used for syntax (state colours mean
 * state only).
 */
export default function PayloadTree({ data, name = null, depth = 0 }) {
  const [open, setOpen] = useState(depth < 2);
  const isObj = data !== null && typeof data === 'object';
  if (!isObj) {
    const empty = data === null || data === undefined || data === '';
    return (
      <div className="flex min-w-0 gap-1">
        {name !== null && <span className="shrink-0 text-muted">{name}:</span>}
        <span className={clsx('min-w-0 break-all', empty ? 'text-subtle' : typeof data === 'string' ? 'text-fg' : 'font-medium text-fg')}>
          {data === null ? 'null' : data === undefined ? '' : typeof data === 'string' ? `"${data}"` : String(data)}
        </span>
      </div>
    );
  }
  const entries = Array.isArray(data) ? data.map((v, i) => [i, v]) : Object.entries(data);
  const brackets = Array.isArray(data) ? ['[', ']'] : ['{', '}'];
  return (
    <div className="min-w-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 rounded text-left hover:bg-raised">
        <ChevronRight size={12} aria-hidden="true" className={clsx('text-subtle transition-transform', open && 'rotate-90')} />
        {name !== null && <span className="text-muted">{name}:</span>}
        <span className="text-subtle">
          {brackets[0]}
          {!open && ` ${entries.length} ${entries.length === 1 ? 'item' : 'items'} ${brackets[1]}`}
        </span>
      </button>
      {open && (
        <div className="ml-1.5 border-l border-line pl-3">
          {entries.map(([k, v]) => (
            <PayloadTree key={k} name={k} data={v} depth={depth + 1} />
          ))}
          <span className="text-subtle">{brackets[1]}</span>
        </div>
      )}
    </div>
  );
}
