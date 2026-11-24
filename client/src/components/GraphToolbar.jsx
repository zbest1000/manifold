import { useEffect, useRef, useState } from 'react';
import {
  Palette,
  Shuffle,
  Check,
  ChevronDown,
  Activity,
  Circle,
  Tag,
  Map as MapIcon,
  Download,
  Maximize2,
  Sparkles,
  PanelRight,
  MoreHorizontal
} from 'lucide-react';
import clsx from 'clsx';
import { STYLE_LIST, LAYOUT_LIST } from '@/graph/graphStyles';
import { useGraphPrefs } from '@/store/selectors';

/**
 * Floating toolbar for the node graph, grouped into labelled clusters:
 *   Display: Flow, Activity, Values, Map (toggles)
 *   View:    Properties, Beautify, Fit
 *   Export:  PNG, JSON
 *   Style:   visual style + layout popover
 * Below the md breakpoint the Display and Export clusters collapse into a
 * "More" overflow menu so the bar never covers the canvas.
 *
 * `showFlow` gates message-flow controls to views with a live stream. Pass
 * `onFit` / `onExportPng` / `onExportJson` to enable those actions.
 */
export default function GraphToolbar({
  showFlow = false,
  onFit,
  onExportPng,
  onExportJson,
  layoutValue,
  onLayoutChange,
  onBeautify,
  onProperties,
  hasSelection = false
}) {
  const {
    graphStyle,
    graphLayout,
    setGraphStyle,
    setGraphLayout,
    flowEnabled,
    setFlowEnabled,
    activitySize,
    setActivitySize,
    showValues,
    setShowValues,
    showMinimap,
    setShowMinimap
  } = useGraphPrefs();
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const moreRef = useRef(null);

  // Layout can be bound to the shared store (MQTT) or overridden per-view
  // (OPC UA / i3X default to a hierarchical layout without changing the global).
  const currentLayout = onLayoutChange ? layoutValue : graphLayout;
  const chooseLayout = onLayoutChange || setGraphLayout;
  const active = STYLE_LIST.find((s) => s.id === graphStyle) || STYLE_LIST[0];

  // Close the overflow menu on outside click / Escape.
  useEffect(() => {
    if (!more) return undefined;
    const onDown = (e) => moreRef.current && !moreRef.current.contains(e.target) && setMore(false);
    const onKey = (e) => e.key === 'Escape' && setMore(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [more]);

  const toggles = [
    showFlow && { id: 'flow', label: 'Flow', icon: Activity, on: flowEnabled, set: () => setFlowEnabled(!flowEnabled), pulse: true },
    showFlow && { id: 'activity', label: 'Activity', icon: Circle, on: activitySize, set: () => setActivitySize(!activitySize) },
    { id: 'values', label: 'Values', icon: Tag, on: showValues, set: () => setShowValues(!showValues) },
    { id: 'map', label: 'Map', icon: MapIcon, on: showMinimap, set: () => setShowMinimap(!showMinimap) }
  ].filter(Boolean);
  const exports = [
    onExportPng && { id: 'png', label: 'Export PNG', short: 'PNG', icon: Download, run: onExportPng },
    onExportJson && { id: 'json', label: 'Export JSON', short: 'JSON', run: onExportJson }
  ].filter(Boolean);

  return (
    <div className="pointer-events-auto absolute right-4 top-16 z-10 flex max-w-[calc(100%-2rem)] flex-col items-end gap-2 md:top-4 md:max-w-[calc(100%-19rem)]">
      <div className="flex flex-wrap items-start justify-end gap-2" role="toolbar" aria-label="Graph controls">
        <Cluster label="Display" className="hidden md:flex">
          {toggles.map((t) => (
            <Toggle key={t.id} active={t.on} onClick={t.set} icon={t.icon} label={t.label} pulse={t.pulse} />
          ))}
        </Cluster>

        <Cluster label="View">
          {onProperties && (
            // Open the selected node's details panel: a reliable, discoverable
            // replacement for right-click (which the OS/browser can swallow).
            <button
              type="button"
              onClick={() => hasSelection && onProperties()}
              disabled={!hasSelection}
              title={hasSelection ? 'Show properties of the selected node' : 'Select a node first'}
              aria-label="Properties of the selected node"
              className={clsx(btnBase, hasSelection ? btnIdle : 'cursor-not-allowed text-slate-400/60')}
            >
              <PanelRight size={15} aria-hidden="true" />
              <span className="hidden font-medium sm:inline">Properties</span>
            </button>
          )}
          {onBeautify && (
            // Beautify applies the radial arrangement; lit only WHILE that layout is active.
            <Toggle active={currentLayout === 'radial'} onClick={onBeautify} icon={Sparkles} label="Beautify" />
          )}
          {onFit && (
            <button type="button" onClick={() => onFit()} title="Fit graph to view" aria-label="Fit graph to view" className={clsx(btnBase, btnIdle)}>
              <Maximize2 size={15} aria-hidden="true" />
            </button>
          )}
        </Cluster>

        {exports.length > 0 && (
          <Cluster label="Export" className="hidden md:flex">
            {exports.map((x) => (
              <button key={x.id} type="button" onClick={x.run} title={x.label} aria-label={x.label} className={clsx(btnBase, btnIdle)}>
                {x.icon ? <x.icon size={15} aria-hidden="true" /> : <span className="text-xs font-medium">{x.short}</span>}
              </button>
            ))}
          </Cluster>
        )}

        {/* Overflow: the Display + Export clusters, below md */}
        <div ref={moreRef} className="relative md:hidden">
          <button
            type="button"
            onClick={() => setMore((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={more}
            aria-label="More graph controls"
            className={clsx(clusterBox, 'px-2.5 py-2 text-slate-300 hover:text-white')}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </button>
          {more && (
            <div role="menu" aria-label="More graph controls" className="absolute right-0 top-full z-20 mt-2 w-48 rounded-xl border border-white/10 bg-surface-900/95 p-1.5 shadow-2xl backdrop-blur">
              <p className="px-2 pb-1 pt-0.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Display</p>
              {toggles.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={t.on}
                  onClick={t.set}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-200 hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60"
                >
                  <t.icon size={14} aria-hidden="true" />
                  <span className="flex-1">{t.label}</span>
                  {t.on && <Check size={14} className="text-accent-400" aria-hidden="true" />}
                </button>
              ))}
              {exports.length > 0 && <p className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Export</p>}
              {exports.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    x.run();
                    setMore(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-200 hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60"
                >
                  {x.icon ? <x.icon size={14} aria-hidden="true" /> : <span className="w-3.5 text-center text-xs">{'{}'}</span>}
                  {x.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`Visual style and layout (current: ${active.name})`}
          className={clsx(clusterBox, 'gap-2 px-3 py-2 text-sm text-slate-200 hover:border-white/20')}
        >
          <Palette size={16} className="text-accent-400" aria-hidden="true" />
          <span className="hidden font-medium sm:inline">{active.name}</span>
          <ChevronDown size={14} className={clsx('transition', open && 'rotate-180')} aria-hidden="true" />
        </button>
      </div>

      {open && (
        <div className="w-72 max-w-full rounded-2xl border border-white/10 bg-surface-900/95 p-3 shadow-2xl backdrop-blur">
          <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Visual style</p>
          <div className="grid grid-cols-2 gap-2">
            {STYLE_LIST.map((style) => (
              <button
                type="button"
                key={style.id}
                onClick={() => setGraphStyle(style.id)}
                title={style.description}
                aria-pressed={style.id === graphStyle}
                className={clsx(
                  'group relative overflow-hidden rounded-xl border p-0.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60',
                  style.id === graphStyle ? 'border-accent-500/70 ring-1 ring-accent-500/40' : 'border-white/10 hover:border-white/25'
                )}
              >
                <StylePreview style={style} />
                <div className="flex items-center justify-between px-2 py-1.5">
                  <span className="text-xs font-medium text-slate-200">{style.name}</span>
                  {style.id === graphStyle && <Check size={13} className="text-accent-400" aria-hidden="true" />}
                </div>
              </button>
            ))}
          </div>

          <p className="mb-2 mt-4 px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Layout</p>
          <div className="grid grid-cols-3 gap-2">
            {LAYOUT_LIST.map((layout) => (
              <LayoutButton key={layout.id} layout={layout} active={layout.id === currentLayout} onClick={() => chooseLayout(layout.id)} icon={Shuffle} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const clusterBox = 'flex items-center rounded-xl border border-white/10 bg-surface-900/80 backdrop-blur transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60';
const btnBase = 'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60';
const btnIdle = 'text-slate-300 hover:bg-white/10 hover:text-slate-100';

// A labelled group of related controls.
function Cluster({ label, className, children }) {
  return (
    <div role="group" aria-label={label} className={clsx(clusterBox, 'gap-0.5 p-1', className || 'flex')}>
      <span className="hidden px-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400 xl:inline" aria-hidden="true">
        {label}
      </span>
      {children}
    </div>
  );
}

function LayoutButton({ layout, active, onClick, icon: Icon }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'flex items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60',
        active ? 'border-accent-500/70 bg-accent-500/10 text-accent-300' : 'border-white/10 text-slate-300 hover:border-white/25'
      )}
    >
      <Icon size={11} aria-hidden="true" />
      {layout.name}
    </button>
  );
}

function Toggle({ active, onClick, icon: Icon, label, pulse }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={`${label}: ${active ? 'on' : 'off'}`}
      className={clsx(btnBase, active ? 'bg-accent-500/15 text-accent-200 ring-1 ring-inset ring-accent-500/40' : btnIdle)}
    >
      <Icon size={15} className={clsx(pulse && active && 'animate-pulse')} aria-hidden="true" />
      <span className="hidden font-medium lg:inline">{label}</span>
    </button>
  );
}

// A tiny swatch preview built from the style's own palette + background.
function StylePreview({ style }) {
  return (
    <div className="relative h-12 w-full overflow-hidden rounded-lg" style={{ background: style.background }}>
      <svg viewBox="0 0 100 48" className="h-full w-full" aria-hidden="true">
        <line x1="24" y1="30" x2="50" y2="16" stroke={style.link.color} strokeWidth="1" />
        <line x1="50" y1="16" x2="76" y2="30" stroke={style.link.color} strokeWidth="1" />
        <line x1="50" y1="16" x2="50" y2="38" stroke={style.link.color} strokeWidth="1" />
        {[
          { x: 24, y: 30, r: 4, c: style.palette[0] },
          { x: 50, y: 16, r: 6, c: style.palette[1] || style.palette[0] },
          { x: 76, y: 30, r: 4, c: style.palette[2] || style.palette[0] },
          { x: 50, y: 38, r: 3.5, c: style.palette[3] || style.palette[0] }
        ].map((n, i) => (
          <circle key={i} cx={n.x} cy={n.y} r={n.r} fill={n.c} stroke={style.node.stroke} strokeWidth={style.node.strokeWidth || 0} />
        ))}
      </svg>
    </div>
  );
}
