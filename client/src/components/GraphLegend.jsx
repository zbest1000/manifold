import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { groupColor, GROUP_ORDER } from '@/graph/buildGraph';
import { GRAPH_STYLES, DEFAULT_STYLE } from '@/graph/graphStyles';

// Human-readable names for the node groups that carry color meaning across every
// node-graph view (Topics, i3X, OPC UA, Sparkplug).
export const GROUP_LABELS = {
  broker: 'Broker',
  server: 'Server',
  topic: 'Branch',
  telemetry: 'Telemetry',
  data: 'Data',
  command: 'Command',
  config: 'Config',
  alarm: 'Alarm',
  sparkplug: 'Sparkplug'
};

/**
 * Collapsible legend that decodes node color -> group for the active style. Only
 * lists groups actually present in the current graph. Shared by all graph views.
 */
export default function GraphLegend({ styleId, groups }) {
  const [open, setOpen] = useState(true);
  const palette = (GRAPH_STYLES[styleId] || GRAPH_STYLES[DEFAULT_STYLE])?.palette || [];
  const present = GROUP_ORDER.filter((g) => groups.has(g));
  if (present.length === 0) return null;
  return (
    <div className="pointer-events-auto absolute bottom-4 right-4 z-10 overflow-hidden rounded-md border border-line bg-panel text-muted shadow-overlay">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-fg"
      >
        Legend {open ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-line px-3 py-2">
          {present.map((g) => (
            <span key={g} className="flex items-center gap-1.5 text-xs text-fg">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: groupColor(g, palette) }} />
              {GROUP_LABELS[g] || g}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
