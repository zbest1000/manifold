import { useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { resolveIconName, getIconImage } from '@/graph/unsIcons';
import { lastActive, nodeValue, nodeRate, staleness, expectedInterval } from '@/graph/unsLive';

export function IconRow({ node, onChange }) {
  const name = resolveIconName(node);
  const img = getIconImage(name, '#cbd5e1', 40);
  return (
    <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-black/20 px-2 py-1.5">
      <span className="flex items-center gap-2 text-slate-400">
        {img && <img src={img.src} alt="" className="h-4 w-4" />}
        <span className="font-mono text-xs">{name}</span>
      </span>
      <button onClick={onChange} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-accent-300 hover:bg-white/10">
        <Pencil size={11} /> change
      </button>
    </div>
  );
}

const STALE_LABEL = { fresh: 'fresh', overdue: 'overdue', dead: 'dead' };
const STALE_CLASS = { fresh: 'text-emerald-400', overdue: 'text-amber-400', dead: 'text-red-400' };

export function LiveRows({ node }) {
  // Re-read liveness once a second while the panel is open.
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const ts = lastActive(node);
  const val = nodeValue(node);
  const rate = nodeRate(node);
  const stale = node.children.size === 0 ? staleness(node) : null;
  const interval = expectedInterval(node);
  return (
    <>
      <Row k="Last activity" v={ts ? formatDistanceToNow(ts, { addSuffix: true }) : '—'} />
      {rate > 0 && <Row k="Rate" v={`${rate.toLocaleString()} msg/s`} />}
      {val && (
        <div className="rounded-lg bg-black/20 px-2 py-1.5">
          <div className="mb-0.5 text-xs uppercase tracking-wide text-slate-400">Latest value</div>
          <div className="break-all font-mono text-xs text-teal-300">{val.value.slice(0, 300)}</div>
        </div>
      )}
      {stale && (
        <Row
          k="Staleness"
          v={
            <span className={STALE_CLASS[stale]}>
              {STALE_LABEL[stale]}
              {interval > 0 ? ` (~every ${Math.round(interval / 1000) || 1}s)` : ''}
            </span>
          }
        />
      )}
    </>
  );
}

export function Row({ k, v }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-slate-400">{k}</span>
      <span className="font-medium text-slate-200">{v}</span>
    </div>
  );
}

