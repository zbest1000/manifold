import { useRef, useState } from 'react';
import { ArrowUp, ArrowDown, GripVertical } from 'lucide-react';
import clsx from 'clsx';
import { Checkbox, IconButton } from '@/components/ui';

/** Published fields first (in order), then the rest in schema order. */
export function orderedOptions(options, current) {
  return [...current.filter((o) => options.includes(o)), ...options.filter((o) => !current.includes(o))];
}

/** Move `key` by `delta` within the published fields (no-op at either end). */
export function moveField(current, key, delta) {
  const i = current.indexOf(key);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= current.length) return current;
  const next = [...current];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** Put `key` where `before` is (drag and drop), keeping the rest in order. */
export function placeField(current, key, before) {
  if (key === before || !current.includes(key) || !current.includes(before)) return current;
  const rest = current.filter((k) => k !== key);
  rest.splice(rest.indexOf(before), 0, key);
  return rest;
}

/**
 * The payload fields as an ordered list: tick to publish, then reorder with the arrow buttons,
 * the arrow keys on a row's handle, or drag. The order is what the server publishes.
 */
export default function FieldOrder({ options, current, required = [], disabledKeys = [], descriptions = {}, onChange, readOnly }) {
  const [drag, setDrag] = useState(null);
  const [announce, setAnnounce] = useState('');
  const listRef = useRef(null);
  const rows = orderedOptions(options, current);
  const move = (key, delta, from = 'arrow') => {
    const next = moveField(current, key, delta);
    if (next === current) return;
    onChange(next);
    setAnnounce(`${key} moved to position ${next.indexOf(key) + 1} of ${next.length}.`);
    // Keep focus on the moved row's control after the re-render.
    const sel = from === 'grip' ? 'button[draggable]' : `button[data-dir="${delta < 0 ? 'up' : 'down'}"]`;
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-field="${key}"] ${sel}`)?.focus());
  };
  const toggle = (key, on) => onChange(on ? [...current, key] : current.filter((k) => k !== key));

  return (
    <>
      <ol ref={listRef} className="mt-1.5 divide-y divide-line rounded-md border border-line" aria-label="Payload fields in publish order">
        {rows.map((o) => {
          const on = current.includes(o);
          const pos = current.indexOf(o);
          return (
            <li
              key={o}
              data-field={o}
              onDragOver={(e) => drag && on && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (drag && on) onChange(placeField(current, drag, o));
                setDrag(null);
              }}
              className={clsx('flex min-h-9 items-center gap-2 px-2 py-1', drag === o && 'opacity-50', !on && 'bg-app/50')}
            >
              <button
                type="button"
                draggable={on && !readOnly}
                disabled={!on || readOnly}
                aria-label={`Reorder ${o}: arrow keys move it, or drag`}
                onDragStart={(e) => {
                  setDrag(o);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={() => setDrag(null)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                  e.preventDefault();
                  move(o, e.key === 'ArrowUp' ? -1 : 1, 'grip');
                }}
                className="flex h-7 w-5 shrink-0 items-center justify-center rounded text-faint enabled:cursor-grab enabled:hover:text-fg disabled:text-transparent"
              >
                <GripVertical size={14} aria-hidden="true" />
              </button>
              <span className="w-5 shrink-0 text-right font-mono text-2xs text-subtle">{on ? pos + 1 : ''}</span>
              <Checkbox
                className="min-w-0 flex-1"
                checked={on}
                disabled={readOnly || required.includes(o) || disabledKeys.includes(o)}
                onChange={(v) => toggle(o, v)}
                label={
                  <span>
                    <span className="font-mono text-xs">{o}</span> <span className="text-muted">{descriptions[o] || ''}</span>
                  </span>
                }
              />
              <IconButton icon={ArrowUp} size={13} className="h-7 w-7" data-dir="up" label={`Move ${o} up`} disabled={!on || pos === 0 || readOnly} onClick={() => move(o, -1)} />
              <IconButton icon={ArrowDown} size={13} className="h-7 w-7" data-dir="down" label={`Move ${o} down`} disabled={!on || pos === current.length - 1 || readOnly} onClick={() => move(o, 1)} />
            </li>
          );
        })}
      </ol>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </>
  );
}
