import { useEffect, useRef, useState } from 'react';
import { Play, Pause, RotateCcw } from 'lucide-react';

/**
 * Replays buffered message activity over the graph. Steps through the buffered
 * messages in chronological order (time-compressed) and fires `graphRef.pulseNode`
 * for each, so you can watch a burst of traffic play back on the topology.
 */
export default function ReplayScrubber({ messages, toNodeId, graphRef, durationMs = 6000 }) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const rafRef = useRef(0);
  const startRef = useRef(0);
  const idxRef = useRef(0);

  // Chronological copy with resolved node ids (oldest first)
  const events = useRef([]);
  events.current = messages
    .map((m) => ({ t: new Date(m.timestamp).getTime(), nodeId: toNodeId(m) }))
    .filter((e) => e.nodeId && Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t);

  const stop = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    setPlaying(false);
  };

  useEffect(() => () => rafRef.current && cancelAnimationFrame(rafRef.current), []);

  const play = () => {
    const evs = events.current;
    if (evs.length < 2) return;
    const t0 = evs[0].t;
    const t1 = evs[evs.length - 1].t;
    const span = Math.max(t1 - t0, 1);
    idxRef.current = 0;
    startRef.current = 0;
    setPlaying(true);

    const step = (ts) => {
      if (!startRef.current) startRef.current = ts;
      const elapsed = ts - startRef.current;
      const frac = Math.min(elapsed / durationMs, 1);
      const virtualNow = t0 + frac * span;

      while (idxRef.current < evs.length && evs[idxRef.current].t <= virtualNow) {
        graphRef.current?.pulseNode(evs[idxRef.current].nodeId);
        idxRef.current++;
      }
      setProgress(frac);

      if (frac < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = 0;
        setPlaying(false);
      }
    };
    rafRef.current = requestAnimationFrame(step);
  };

  const disabled = events.current.length < 2;

  return (
    <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-white/10 bg-surface-900/80 px-2.5 py-1.5 backdrop-blur">
      <button
        onClick={playing ? stop : play}
        disabled={disabled}
        title={disabled ? 'Not enough buffered messages' : 'Replay buffered activity'}
        className="grid h-6 w-6 place-items-center rounded-lg bg-accent-500/20 text-accent-200 hover:bg-accent-500/30 disabled:opacity-40"
      >
        {playing ? <Pause size={13} /> : <Play size={13} />}
      </button>
      <div className="relative h-1.5 w-28 overflow-hidden rounded-full bg-white/10">
        <div className="absolute inset-y-0 left-0 rounded-full bg-accent-500" style={{ width: `${progress * 100}%` }} />
      </div>
      <button
        onClick={() => {
          stop();
          setProgress(0);
        }}
        title="Reset"
        className="text-slate-400 hover:text-slate-200"
      >
        <RotateCcw size={13} />
      </button>
      <span className="text-[11px] text-slate-500">Replay</span>
    </div>
  );
}
