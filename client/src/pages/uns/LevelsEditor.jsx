import { useState } from 'react';
import { Trash2, Plus } from 'lucide-react';
import { DEFAULT_LEVELS, levelColor } from '@/graph/unsLevels';
import { useCanvasTokens } from '@/graph/canvasTokens';
import { Button, IconButton, Input } from '@/components/ui';
import { SidePanel } from '@/components/CanvasChrome';

/** Names for each hierarchy depth (the level ladder), edited in the docked side panel. */
export default function LevelsEditor({ levels, onSave, onClose }) {
  const tokens = useCanvasTokens();
  const [draft, setDraft] = useState(levels);
  const set = (i, v) => setDraft((d) => d.map((x, j) => (j === i ? v : x)));
  const clean = draft.map((s) => s.trim()).filter(Boolean);
  return (
    <SidePanel
      title="Level ladder"
      label="Level ladder"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={() => setDraft([...DEFAULT_LEVELS])}>
            Reset
          </Button>
          <Button
            variant="secondary"
            disabled={clean.length < 2}
            onClick={() => {
              onSave(clean);
              onClose();
            }}
          >
            Save levels
          </Button>
        </>
      }
    >
      <div className="space-y-3 p-4">
        <p className="text-sm text-muted">
          One name per hierarchy depth (ISA-95 by default). The last name repeats for deeper levels. Sparkplug and $SYS branches keep their own names.
        </p>
        <ol className="space-y-1.5">
          {draft.map((lvl, i) => (
            <li key={i} className="flex items-center gap-2">
              <svg width="12" height="12" aria-hidden="true" className="shrink-0">
                <circle cx="6" cy="6" r="4.5" fill="none" stroke={levelColor(i, tokens)} strokeWidth="1.75" />
              </svg>
              <span className="w-4 shrink-0 text-right font-mono text-xs text-subtle">{i}</span>
              <Input aria-label={`Name for hierarchy depth ${i}`} value={lvl} onChange={(e) => set(i, e.target.value)} />
              {draft.length > 2 && <IconButton icon={Trash2} size={14} label={`Remove level ${i}`} side="left" className="hover:bg-bad/10 hover:text-bad" onClick={() => setDraft((d) => d.filter((_, j) => j !== i))} />}
            </li>
          ))}
        </ol>
        <Button size="sm" variant="ghost" onClick={() => setDraft((d) => [...d, `Level ${d.length}`])}>
          <Plus size={14} aria-hidden="true" /> Add level
        </Button>
      </div>
    </SidePanel>
  );
}
