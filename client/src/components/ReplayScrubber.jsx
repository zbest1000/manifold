import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, RotateCcw, Gauge } from 'lucide-react';

/**
 * Replays buffered message activity over the graph. Steps through the buffered
 * messages in chronological order (time-compressed) and fires `graphRef.pulseNode`
 * for each, so you can watch a burst of traffic play back on the topology.
 *
 * The track is a real seek control: click or drag to scrub, arrow keys to nudge.
 * Speed cycles 0.5x/1x/2x, and the label shows the replayed clock time.
 */
const SPEEDS = [0.5, 1, 2];

function fmtClock(ms) {
  if (!Number.isFinite(ms)) return '--:--:--';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function ReplayScrubber({ messages, toNodeId, graphRef, durationMs = 6000 }) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(1);
  const rafRef = useRef(0);
  const startTsRef = useRef(0); // rAF timestamp when the current play leg began
  const baseFracRef = useRef(0); // progress fraction at the start of this leg
  const idxRef = useRef(0);
  const progressRef = useRef(0);
  const speedRef = useRef(1);
  const trackRef = useRef(null);
  const draggingRef = useRef(false);

  progressRef.current = progress;
  speedRef.current = speed;

  // Chronological copy with resolved node ids (oldest first).
  const events = useRef([]);
  events.current = messages
    .map((m) => ({ t: new Date(m.timestamp).getTime(), nodeId: toNodeId(m) }))
    .filter((e) => e.nodeId && Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t);

  const evs = events.current;
  const disabled = evs.length < 2;
  const t0 = disabled ? 0 : evs[0].t;
  const span = disabled ? 1 : Math.max(evs[evs.length - 1].t - t0, 1);

  const cancelRaf = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  };

  useEffect(() => () => cancelRaf(), []);

  const step = useCallback(
    (ts) => {
      const list = events.current;
      if (!startTsRef.current) startTsRef.current = ts;
      const effective = durationMs / speedRef.current;
      const frac = Math.min(baseFracRef.current + (ts - startTsRef.current) / effective, 1);
      const virtualNow = list[0].t + frac * Math.max(list[list.length - 1].t - list[0].t, 1);

      while (idxRef.current < list.length && list[idxRef.current].t <= virtualNow) {
        graphRef.current?.pulseNode(list[idxRef.current].nodeId);
        idxRef.current++;
      }
      setProgress(frac);

      if (frac < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = 0;
        setPlaying(false);
      }
    },
    [durationMs, graphRef]
  );

  // Jump to a fraction without pulsing the skipped events (scrub, not fast-forward).
  const seekTo = useCallback(
    (fracRaw) => {
      const list = events.current;
      if (list.length < 2) return;
      const frac = Math.max(0, Math.min(1, fracRaw));
      const virtual = list[0].t + frac * Math.max(list[list.length - 1].t - list[0].t, 1);
      let i = 0;
      while (i < list.length && list[i].t <= virtual) i++;
      idxRef.current = i;
      baseFracRef.current = frac;
      startTsRef.current = 0; // step re-baselines to the next frame
      setProgress(frac);
    },
    []
  );

  const play = () => {
    if (disabled) return;
    // Restart from the top if we're at (or past) the end.
    if (progressRef.current >= 1) seekTo(0);
    baseFracRef.current = progressRef.current;
    startTsRef.current = 0;
    setPlaying(true);
    cancelRaf();
    rafRef.current = requestAnimationFrame(step);
  };

  const pause = () => {
    cancelRaf();
    setPlaying(false);
  };

  const reset = () => {
    pause();
    seekTo(0);
  };

  const fracFromPointer = (clientX) => {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return (clientX - r.left) / Math.max(r.width, 1);
  };

  const onTrackDown = (e) => {
    if (disabled) return;
    e.preventDefault();
    draggingRef.current = true;
    trackRef.current?.setPointerCapture?.(e.pointerId);
    seekTo(fracFromPointer(e.clientX));
  };
  const onTrackMove = (e) => {
    if (!draggingRef.current) return;
    seekTo(fracFromPointer(e.clientX));
  };
  const onTrackUp = (e) => {
    draggingRef.current = false;
    trackRef.current?.releasePointerCapture?.(e.pointerId);
  };
  const onTrackKey = (e) => {
    if (disabled) return;
    const nudge = 0.05;
    if (e.key === 'ArrowLeft') seekTo(progressRef.current - nudge);
    else if (e.key === 'ArrowRight') seekTo(progressRef.current + nudge);
    else if (e.key === 'Home') seekTo(0);
    else if (e.key === 'End') seekTo(1);
    else if (e.key === ' ' || e.key === 'Enter') playing ? pause() : play();
    else return;
    e.preventDefault();
  };

  const cycleSpeed = () => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]);

  const virtualMs = disabled ? NaN : t0 + progress * span;

  return (
    <div className="pointer-events-auto flex items-center gap-2.5 rounded-xl border border-white/10 bg-surface-900/80 px-2.5 py-1.5 backdrop-blur">
      <button
        onClick={playing ? pause : play}
        disabled={disabled}
        title={disabled ? 'Not enough buffered messages' : playing ? 'Pause' : 'Replay buffered activity'}
        className="grid h-6 w-6 place-items-center rounded-lg bg-accent-500/20 text-accent-200 hover:bg-accent-500/30 disabled:opacity-40"
      >
        {playing ? <Pause size={13} /> : <Play size={13} />}
      </button>

      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Replay position"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        aria-valuetext={fmtClock(virtualMs)}
        onPointerDown={onTrackDown}
        onPointerMove={onTrackMove}
        onPointerUp={onTrackUp}
        onKeyDown={onTrackKey}
        className={clsxTrack(disabled)}
      >
        <div className="pointer-events-none absolute inset-y-0 left-0 my-auto h-1.5 rounded-full bg-white/10" style={{ width: '100%' }} />
        <div className="pointer-events-none absolute inset-y-0 left-0 my-auto h-1.5 rounded-full bg-accent-500" style={{ width: `${progress * 100}%` }} />
        <div
          className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-300 shadow ring-2 ring-surface-900"
          style={{ left: `${progress * 100}%` }}
        />
      </div>

      <span className="w-[52px] text-center text-[11px] tabular-nums text-slate-400" title="Replayed clock time">
        {fmtClock(virtualMs)}
      </span>

      <button
        onClick={cycleSpeed}
        disabled={disabled}
        title="Playback speed"
        className="flex items-center gap-1 rounded-lg border border-white/10 px-1.5 py-1 text-[11px] font-medium text-slate-400 hover:text-slate-200 disabled:opacity-40"
      >
        <Gauge size={12} />
        {speed}×
      </button>

      <button onClick={reset} disabled={disabled} title="Reset to start" className="text-slate-400 hover:text-slate-200 disabled:opacity-40">
        <RotateCcw size={13} />
      </button>
    </div>
  );
}

// The track is a focusable seek surface: relative box, generous height for the
// hit area, visible focus ring for keyboard users.
function clsxTrack(disabled) {
  return [
    'relative h-5 w-40 shrink-0 rounded-full',
    disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60'
  ].join(' ');
}
