import { useEffect, useRef, useState } from 'react';
import { Play, Pause, RotateCcw } from 'lucide-react';

const fmtClock = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleTimeString([], { hour12: false }) : '');

/**
 * Replays buffered message activity over the graph. Steps through the buffered
 * messages in chronological order (time-compressed) and fires `graphRef.pulseNode`
 * for each, so you can watch a burst of traffic play back on the topology.
 *
 * The buffer is read lazily through `getMessages()` when playback starts or the
 * track is scrubbed, so the parent page does no per-tick work for it. The track
 * is a keyboard slider (Left/Right 5%, Home/End, Space/Enter to play) with time
 * labels for the buffered window and quarter tick marks.
 */
export default function ReplayScrubber({ getMessages, messages, toNodeId, graphRef, durationMs = 6000 }) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const rafRef = useRef(0);
  const startRef = useRef(0);
  const idxRef = useRef(0);
  const fromRef = useRef(0);
  const eventsRef = useRef([]);
  const trackRef = useRef(null);
  const loadRef = useRef(null);

  const readEvents = () => {
    const msgs = getMessages ? getMessages() : messages || [];
    return msgs
      .map((m) => ({ t: new Date(m.timestamp).getTime(), nodeId: toNodeId(m) }))
      .filter((e) => e.nodeId && Number.isFinite(e.t))
      .sort((a, b) => a.t - b.t);
  };
  const spanOf = (evs) => ({ t0: evs[0]?.t ?? NaN, t1: evs[evs.length - 1]?.t ?? NaN, count: evs.length });

  const [span, setSpan] = useState(() => spanOf(readEvents()));

  const load = () => {
    const evs = readEvents();
    eventsRef.current = evs;
    setSpan(spanOf(evs));
    return evs;
  };

  // Keep the latest `load` reachable from the interval without re-subscribing.
  useEffect(() => {
    loadRef.current = load;
  });

  // Refresh the window labels occasionally (not per tick) so they stay honest.
  useEffect(() => {
    loadRef.current();
    const t = setInterval(() => document.visibilityState === 'visible' && !rafRef.current && loadRef.current(), 5000);
    return () => clearInterval(t);
  }, []);

  const stop = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    setPlaying(false);
  };

  useEffect(() => () => rafRef.current && cancelAnimationFrame(rafRef.current), []);

  const play = (fromFrac = 0) => {
    const evs = load();
    if (evs.length < 2) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const t0 = evs[0].t;
    const total = Math.max(evs[evs.length - 1].t - t0, 1);
    fromRef.current = fromFrac;
    startRef.current = 0;
    // Skip events before the start point so seeking doesn't replay history.
    idxRef.current = evs.findIndex((e) => e.t >= t0 + fromFrac * total);
    if (idxRef.current < 0) idxRef.current = evs.length;
    setPlaying(true);

    const step = (ts) => {
      if (!startRef.current) startRef.current = ts;
      const frac = Math.min(fromFrac + ((ts - startRef.current) / durationMs) * (1 - fromFrac), 1);
      const virtualNow = t0 + frac * total;
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

  const seek = (frac) => {
    const f = Math.min(1, Math.max(0, frac));
    setProgress(f);
    if (playing) play(f);
  };

  const disabled = span.count < 2;
  const total = span.t1 - span.t0;
  const valueText = disabled
    ? 'No buffered messages'
    : `${fmtClock(span.t0 + progress * total)} of ${fmtClock(span.t0)} to ${fmtClock(span.t1)}`;

  const onTrackKey = (e) => {
    if (disabled) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') seek(progress + 0.05);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') seek(progress - 0.05);
    else if (e.key === 'Home') seek(0);
    else if (e.key === 'End') seek(1);
    else if (e.key === ' ' || e.key === 'Enter') (playing ? stop : () => play(progress >= 1 ? 0 : progress))();
    else return;
    e.preventDefault();
  };

  const onTrackPointer = (e) => {
    if (disabled || !trackRef.current) return;
    const r = trackRef.current.getBoundingClientRect();
    seek((e.clientX - r.left) / r.width);
  };

  return (
    <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-md border border-line bg-panel py-1 pl-1 pr-2 shadow-overlay" role="group" aria-label="Replay">
      <button
        type="button"
        onClick={playing ? stop : () => play(progress >= 1 ? 0 : progress)}
        disabled={disabled}
        aria-label={playing ? 'Pause replay' : 'Play replay'}
        title={disabled ? 'Not enough buffered messages' : 'Replay buffered activity'}
        className="grid h-7 w-7 place-items-center rounded text-fg transition-colors hover:bg-raised disabled:opacity-40"
      >
        {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
      </button>
      <div className="flex flex-col">
        <div
          ref={trackRef}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="Replay position"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          aria-valuetext={valueText}
          aria-disabled={disabled}
          onKeyDown={onTrackKey}
          onPointerDown={onTrackPointer}
          className="relative h-3 w-32 cursor-pointer rounded-full sm:w-40"
        >
          <div className="absolute inset-x-0 top-1 h-1 overflow-hidden rounded-full bg-raised">
            <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${progress * 100}%` }} />
          </div>
          {[0.25, 0.5, 0.75].map((f) => (
            <span key={f} aria-hidden="true" className="absolute top-0.5 h-2 w-px bg-line-strong" style={{ left: `${f * 100}%` }} />
          ))}
        </div>
        <div className="mono flex justify-between text-2xs text-subtle" aria-hidden="true">
          <span>{disabled ? '--:--:--' : fmtClock(span.t0)}</span>
          <span>{disabled ? '--:--:--' : fmtClock(span.t1)}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          stop();
          setProgress(0);
        }}
        aria-label="Reset replay"
        title="Reset"
        className="grid h-7 w-7 place-items-center rounded text-muted transition-colors hover:bg-raised hover:text-fg"
      >
        <RotateCcw size={13} aria-hidden="true" />
      </button>
      <span className="text-xs text-muted">Replay</span>
    </div>
  );
}
