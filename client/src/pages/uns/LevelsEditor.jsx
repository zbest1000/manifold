import { useState } from 'react';
import { X, Trash2, Plus } from 'lucide-react';
import { DEFAULT_LEVELS } from '@/graph/unsLevels';

export default function LevelsEditor({ levels, onSave, onClose }) {
  const [draft, setDraft] = useState(levels);
  const set = (i, v) => setDraft((d) => d.map((x, j) => (j === i ? v : x)));
  return (
    <div className="absolute right-4 top-4 z-20 w-72 max-w-[calc(100%-2rem)] rounded-xl border border-white/10 bg-surface-900/95 p-3 shadow-xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-100">Level ladder</span>
        <button aria-label="Close level ladder" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-white/10">
          <X size={14} />
        </button>
      </div>
      <p className="mb-2 text-xs text-slate-400">
        Names for each hierarchy depth (ISA-95 by default). The last name repeats for deeper levels. Sparkplug (spBv1.0) and $SYS branches are not ISA-95 and keep their own names.
      </p>
      <div className="space-y-1.5">
        {draft.map((lvl, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="w-4 text-right font-mono text-xs text-slate-400">{i}</span>
            <input
              aria-label={`Name for hierarchy depth ${i}`}
              value={lvl}
              onChange={(e) => set(i, e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-surface-950/60 px-2 py-1 text-xs text-slate-200 focus:border-accent-500/60 focus:outline-none"
            />
            {draft.length > 2 && (
              <button
                aria-label="Remove level"
                onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
                className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-red-400"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <button
          onClick={() => setDraft((d) => [...d, `Level ${d.length}`])}
          className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-accent-300 hover:bg-white/10"
        >
          <Plus size={12} /> add level
        </button>
        <div className="flex gap-2">
          <button
            onClick={() => setDraft([...DEFAULT_LEVELS])}
            className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-white/10"
          >
            Reset
          </button>
          <button
            onClick={() => {
              const clean = draft.map((s) => s.trim()).filter(Boolean);
              if (clean.length >= 2) {
                onSave(clean);
                onClose();
              }
            }}
            className="rounded-lg bg-accent-500/20 px-2.5 py-1 text-xs font-medium text-accent-200 hover:bg-accent-500/30"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

