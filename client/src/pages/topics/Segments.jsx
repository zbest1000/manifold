import clsx from 'clsx';

// Segmented-toolbar primitives for the unified big-graph control cluster.
export function Segment({ children }) {
  return <div className="flex items-center gap-1.5 px-2 py-1.5">{children}</div>;
}
export function SegLabel({ children }) {
  return <span className="flex items-center gap-1 pr-0.5 text-xs uppercase tracking-wide text-slate-400">{children}</span>;
}
export function SegBtn({ active, onClick, disabled, title, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={clsx(
        'flex items-center gap-1 rounded-md px-2 py-1 transition disabled:cursor-not-allowed disabled:opacity-40',
        active ? 'bg-accent-500/20 text-accent-200' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
      )}
    >
      {children}
    </button>
  );
}

