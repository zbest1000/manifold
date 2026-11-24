import { useRef } from 'react';
import clsx from 'clsx';

/** Accessible two-tab switch (roving focus: arrow keys move between tabs). */
export default function DevicesTabs({ tab, onChange, counts }) {
  const refs = useRef({});
  const items = [
    ['devices', `Devices${counts.devices !== undefined ? ` (${counts.devices})` : ''}`],
    ['profiles', `Profiles${counts.profiles !== undefined ? ` (${counts.profiles})` : ''}`]
  ];
  const onKey = (e, i) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
    onChange(items[n][0]);
    refs.current[items[n][0]]?.focus();
  };
  return (
    <div role="tablist" aria-label="Devices and profiles" className="flex gap-1 border-b border-white/5 px-4 sm:px-6">
      {items.map(([id, label], i) => (
        <button
          key={id}
          ref={(el) => {
            refs.current[id] = el;
          }}
          type="button"
          role="tab"
          id={`tab-${id}`}
          aria-selected={tab === id}
          aria-controls={`panel-${id}`}
          tabIndex={tab === id ? 0 : -1}
          onClick={() => onChange(id)}
          onKeyDown={(e) => onKey(e, i)}
          className={clsx('-mb-px border-b-2 px-3 py-2 text-sm font-medium transition', tab === id ? 'border-accent-400 text-slate-100' : 'border-transparent text-slate-400 hover:text-slate-200')}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
