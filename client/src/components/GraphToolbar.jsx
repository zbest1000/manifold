import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Activity, Circle, Tag, Map as MapIcon, Download, Maximize2, Orbit, PanelRight, MoreHorizontal, Palette } from 'lucide-react';
import clsx from 'clsx';
import { STYLE_LIST, LAYOUT_LIST, resolveGraphStyle, resolveStyleId } from '@/graph/graphStyles';
import { useCanvasTokens } from '@/graph/canvasTokens';
import { useGraphPrefs } from '@/store/selectors';
import { IconButton } from '@/components/ui';
import { BarDivider, ToolToggle } from '@/components/CanvasChrome';

/**
 * Controls for a node graph, grouped by job with dividers:
 *   display  Flow, Activity, Values, Map (toggles)
 *   view     Radial (beautify), Fit, Properties
 *   export   PNG, JSON (one menu)
 *   style    drawing style + layout (one menu)
 * Below md the display toggles and export fold into a "More" menu.
 *
 * `inline` renders the controls as items of the page's toolbar row (Topics);
 * otherwise they float over the canvas top-right (OPC UA, i3X).
 * `showFlow` gates message-flow controls to views with a live stream.
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
  hasSelection = false,
  inline = false
}) {
  const { graphStyle, graphLayout, setGraphStyle, setGraphLayout, flowEnabled, setFlowEnabled, activitySize, setActivitySize, showValues, setShowValues, showMinimap, setShowMinimap } =
    useGraphPrefs();
  const [menu, setMenu] = useState(null); // 'style' | 'export' | 'more' | null
  const rootRef = useRef(null);

  // Layout can be bound to the shared store (MQTT) or overridden per-view
  // (OPC UA / i3X default to a hierarchical layout without changing the global).
  const currentLayout = onLayoutChange ? layoutValue : graphLayout;
  const chooseLayout = onLayoutChange || setGraphLayout;
  const styleId = resolveStyleId(graphStyle);
  const active = STYLE_LIST.find((s) => s.id === styleId) || STYLE_LIST[0];

  // Close menus on outside click / Escape.
  useEffect(() => {
    if (!menu) return undefined;
    const onDown = (e) => rootRef.current && !rootRef.current.contains(e.target) && setMenu(null);
    const onKey = (e) => e.key === 'Escape' && setMenu(null);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);
  const toggleMenu = (m) => setMenu((cur) => (cur === m ? null : m));

  const toggles = [
    showFlow && { id: 'flow', label: 'Flow', icon: Activity, on: flowEnabled, set: () => setFlowEnabled(!flowEnabled), hint: 'Animate messages travelling down the tree' },
    showFlow && { id: 'activity', label: 'Activity', icon: Circle, on: activitySize, set: () => setActivitySize(!activitySize), hint: 'Size nodes by recent message rate' },
    { id: 'values', label: 'Values', icon: Tag, on: showValues, set: () => setShowValues(!showValues), hint: 'Show latest values on leaves (zoomed in)' },
    { id: 'map', label: 'Map', icon: MapIcon, on: showMinimap, set: () => setShowMinimap(!showMinimap), hint: 'Overview map in the corner' }
  ].filter(Boolean);
  const exports = [onExportPng && { id: 'png', label: 'Export PNG', run: onExportPng }, onExportJson && { id: 'json', label: 'Export JSON', run: onExportJson }].filter(Boolean);

  const menuCls = 'absolute right-0 top-full z-30 mt-1 rounded-md border border-line-strong bg-overlay p-1 shadow-overlay';
  const itemCls = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-fg hover:bg-raised focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';

  return (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label="Graph controls"
      className={clsx(
        'pointer-events-auto flex min-w-0 items-center gap-1',
        !inline && 'absolute right-4 top-16 z-10 max-w-[calc(100%-2rem)] rounded-md border border-line bg-panel p-0.5 shadow-overlay md:top-4'
      )}
    >
      <div role="group" aria-label="Display" className="hidden items-center gap-0.5 md:flex">
        {toggles.map((t) => (
          <ToolToggle key={t.id} pressed={t.on} onClick={t.set} icon={t.icon} label={t.label} title={t.hint} showLabel="lg" />
        ))}
      </div>
      <BarDivider />
      <div role="group" aria-label="View" className="flex items-center gap-0.5">
        {onBeautify && <ToolToggle pressed={currentLayout === 'radial'} onClick={onBeautify} icon={Orbit} label="Radial" title="Radial layout" showLabel={false} />}
        {onFit && <IconButton icon={Maximize2} label="Fit graph to view" onClick={() => onFit()} />}
        {onProperties && <IconButton icon={PanelRight} label={hasSelection ? 'Properties of the selected node' : 'Properties (select a node first)'} disabled={!hasSelection} onClick={() => hasSelection && onProperties()} />}
      </div>

      {exports.length > 0 && (
        <div className="relative hidden md:block">
          <IconButton icon={Download} label="Export" aria-haspopup="menu" aria-expanded={menu === 'export'} onClick={() => toggleMenu('export')} />
          {menu === 'export' && (
            <div role="menu" aria-label="Export" className={clsx(menuCls, 'w-44')}>
              {exports.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  role="menuitem"
                  className={itemCls}
                  onClick={() => {
                    x.run();
                    setMenu(null);
                  }}
                >
                  {x.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Below md: display toggles + export in one overflow menu */}
      <div className="relative md:hidden">
        <IconButton icon={MoreHorizontal} label="More graph controls" aria-haspopup="menu" aria-expanded={menu === 'more'} onClick={() => toggleMenu('more')} />
        {menu === 'more' && (
          <div role="menu" aria-label="More graph controls" className={clsx(menuCls, 'w-52')}>
            {toggles.map((t) => (
              <button key={t.id} type="button" role="menuitemcheckbox" aria-checked={t.on} onClick={t.set} className={itemCls}>
                <t.icon size={14} aria-hidden="true" className="text-muted" />
                <span className="flex-1">{t.label}</span>
                {t.on && <Check size={14} className="text-accent-text" aria-hidden="true" />}
              </button>
            ))}
            {exports.length > 0 && <div className="my-1 h-px bg-line" aria-hidden="true" />}
            {exports.map((x) => (
              <button
                key={x.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  x.run();
                  setMenu(null);
                }}
                className={itemCls}
              >
                <Download size={14} aria-hidden="true" className="text-muted" />
                {x.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <BarDivider />
      <div className="relative">
        <button
          type="button"
          onClick={() => toggleMenu('style')}
          aria-expanded={menu === 'style'}
          aria-haspopup="dialog"
          aria-label={`${active.name} style and layout`}
          className="inline-flex h-8 items-center gap-1.5 rounded px-2 text-sm font-medium text-muted transition-colors hover:bg-raised hover:text-fg"
        >
          <Palette size={15} aria-hidden="true" />
          <span className="hidden sm:inline">{active.name}</span>
          <ChevronDown size={14} aria-hidden="true" className={clsx('transition-transform', menu === 'style' && 'rotate-180')} />
        </button>
        {menu === 'style' && <StyleMenu styleId={styleId} onStyle={setGraphStyle} layout={currentLayout} onLayout={chooseLayout} className={clsx(menuCls, 'w-72 max-w-[calc(100vw-2rem)] p-3')} />}
      </div>
    </div>
  );
}

function StyleMenu({ styleId, onStyle, layout, onLayout, className }) {
  const tokens = useCanvasTokens();
  return (
    <div role="dialog" aria-label="Graph style and layout" className={className}>
      <p className="mb-2 text-xs font-medium text-muted">Style</p>
      <div className="grid grid-cols-3 gap-2">
        {STYLE_LIST.map((s) => {
          const on = s.id === styleId;
          return (
            <button
              type="button"
              key={s.id}
              onClick={() => onStyle(s.id)}
              title={s.description}
              aria-pressed={on}
              className={clsx('overflow-hidden rounded-md border text-left transition-colors', on ? 'border-accent ring-1 ring-accent' : 'border-line hover:border-line-strong')}
            >
              <StylePreview style={resolveGraphStyle(s.id, tokens)} />
              <span className="flex items-center justify-between px-1.5 py-1 text-xs font-medium text-fg">
                {s.name}
                {on && <Check size={12} className="text-accent-text" aria-hidden="true" />}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mb-2 mt-3 text-xs font-medium text-muted">Layout</p>
      <div className="grid grid-cols-3 gap-1">
        {LAYOUT_LIST.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => onLayout(l.id)}
            aria-pressed={l.id === layout}
            className={clsx(
              'h-7 rounded px-2 text-xs font-medium transition-colors',
              l.id === layout ? 'bg-raised text-fg shadow-[inset_0_0_0_1px_rgb(var(--border-strong))]' : 'text-muted hover:bg-raised hover:text-fg'
            )}
          >
            {l.name}
          </button>
        ))}
      </div>
    </div>
  );
}

// A tiny preview drawn with the style's own resolved colours.
function StylePreview({ style }) {
  const nodes = [
    { x: 22, y: 30, r: 4, c: style.palette[3] },
    { x: 50, y: 15, r: 6, c: style.palette[0] },
    { x: 78, y: 30, r: 4, c: style.palette[4] },
    { x: 50, y: 38, r: 3.5, c: style.palette[5] }
  ];
  return (
    <div className="h-11 w-full" style={{ background: style.background }}>
      <svg viewBox="0 0 100 48" className="h-full w-full" aria-hidden="true">
        {style.grid && (
          <g stroke={style.grid.color} strokeWidth="0.6">
            {[12, 24, 36].map((y) => (
              <line key={`h${y}`} x1="0" y1={y} x2="100" y2={y} />
            ))}
            {[20, 40, 60, 80].map((x) => (
              <line key={`v${x}`} x1={x} y1="0" x2={x} y2="48" />
            ))}
          </g>
        )}
        <g stroke={style.link.color} strokeWidth="1">
          <line x1="22" y1="30" x2="50" y2="15" />
          <line x1="50" y1="15" x2="78" y2="30" />
          <line x1="50" y1="15" x2="50" y2="38" />
        </g>
        {nodes.map((n, i) =>
          style.node.square ? (
            <rect key={i} x={n.x - n.r} y={n.y - n.r} width={n.r * 2} height={n.r * 2} fill={n.c} stroke={style.node.stroke} strokeWidth="1" />
          ) : (
            <circle key={i} cx={n.x} cy={n.y} r={n.r} fill={n.c} stroke={style.node.stroke} strokeWidth="1" />
          )
        )}
      </svg>
    </div>
  );
}
