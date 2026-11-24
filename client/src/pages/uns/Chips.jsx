/** Floating chips over the topology canvas; colours come from the UNS theme tokens. */
export function Chip({ children, tone = 'mqtt', theme }) {
  const base = tone === 'live' ? theme.chipLive : theme.chip;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-medium shadow-sm ${base}`}>
      {children}
    </span>
  );
}

export function Dot({ on }) {
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${on ? 'bg-emerald-400' : 'bg-slate-400'}`} aria-label={on ? 'connected' : 'not connected'} role="img" />;
}
