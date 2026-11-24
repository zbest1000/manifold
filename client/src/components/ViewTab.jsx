import clsx from 'clsx';

/** Shared view-switcher tab (Graph / 3D / Tree …) used by the graph pages. */
export default function ViewTab({ active, onClick, icon: Icon, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-400/60',
        active ? 'bg-accent-500/20 text-accent-200' : 'bg-surface-950/60 text-muted hover:text-slate-200'
      )}
    >
      <Icon size={14} aria-hidden="true" />
      {label}
    </button>
  );
}
