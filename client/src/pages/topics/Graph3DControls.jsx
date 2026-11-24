import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Rotate3d, SlidersHorizontal, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import { Toggle } from '@/components/ui';
import { ToolToggle } from '@/components/CanvasChrome';

/** Look-and-feel controls for the 3D view, as toolbar items: depth colouring, spin, and a menu with the size sliders. */
export default function Graph3DControls({ beautify, onBeautify, autoRotate, onAutoRotate, nodeScale, onNodeScale, linkOpacity, onLinkOpacity }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative flex items-center gap-0.5">
      <ToolToggle pressed={beautify} onClick={onBeautify} icon={Sparkles} label="Depth colour" title="Colour nodes by depth and spin slowly" showLabel="lg" />
      <ToolToggle pressed={autoRotate} onClick={onAutoRotate} icon={Rotate3d} label="Spin" title="Rotate slowly" showLabel="lg" />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Node size and link opacity"
        className={clsx('inline-flex h-8 items-center gap-1 rounded px-2 text-sm font-medium transition-colors', open ? 'bg-raised text-fg' : 'text-muted hover:bg-raised hover:text-fg')}
      >
        <SlidersHorizontal size={15} aria-hidden="true" />
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div role="dialog" aria-label="3D look" className="absolute left-0 top-full z-30 mt-1 w-64 space-y-3 rounded-md border border-line-strong bg-overlay p-3 shadow-overlay">
          <label className="block">
            <span className="mb-1 flex justify-between text-xs font-medium text-muted">
              Node size <span className="tabular-nums text-fg">{nodeScale.toFixed(1)}×</span>
            </span>
            <input type="range" min="0.5" max="2" step="0.1" value={nodeScale} onChange={(e) => onNodeScale(Number(e.target.value))} className="w-full accent-accent" />
          </label>
          <label className="block">
            <span className="mb-1 flex justify-between text-xs font-medium text-muted">
              Link opacity <span className="tabular-nums text-fg">{Math.round(linkOpacity * 100)} %</span>
            </span>
            <input type="range" min="0.05" max="0.8" step="0.05" value={linkOpacity} onChange={(e) => onLinkOpacity(Number(e.target.value))} className="w-full accent-accent" />
          </label>
          <Toggle checked={autoRotate} onChange={onAutoRotate} label="Spin" />
        </div>
      )}
    </div>
  );
}
