import { Check, Monitor, Moon, Sun } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '@/store/store';
import { useTheme } from '@/lib/theme';
import { STYLE_LIST, LAYOUT_LIST } from '@/graph/graphStyles';
import { Select, SegmentedControl } from '@/components/ui';
import Section from './Section';

const THEME_OPTIONS = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon }
];

/** The same theme store the sidebar switch uses, so the two always agree. */
export function ThemeSection() {
  const [{ preference, theme }, setPreference] = useTheme();
  return (
    <Section title="Theme" description="System follows your operating system. The sidebar has the same switch.">
      <SegmentedControl label="Theme" options={THEME_OPTIONS} value={preference} onChange={setPreference} />
      <p className="text-xs text-subtle">
        Showing the {theme} theme{preference === 'system' ? ', from your system setting' : ''}.
      </p>
    </Section>
  );
}

/** Default look of the topic graphs. Each preview is drawn in that style's own palette, whatever the app theme. */
export function GraphSection() {
  const graphStyle = useStore((s) => s.graphStyle);
  const graphLayout = useStore((s) => s.graphLayout);
  const setGraphStyle = useStore((s) => s.setGraphStyle);
  const setGraphLayout = useStore((s) => s.setGraphLayout);
  return (
    <Section title="Topic graph" description="The default style and layout for the Topics graph. Each style keeps its own canvas colours in both themes.">
      <div role="group" aria-label="Graph style" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {STYLE_LIST.map((s) => {
          const on = s.id === graphStyle;
          return (
            <button
              key={s.id}
              type="button"
              aria-pressed={on}
              onClick={() => setGraphStyle(s.id)}
              className={clsx(
                'overflow-hidden rounded-md border bg-panel text-left transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--focus))]',
                on ? 'border-accent ring-1 ring-accent' : 'border-line-strong hover:border-line-stronger'
              )}
            >
              <div className="h-16" style={{ background: s.background }}>
                <svg viewBox="0 0 120 64" className="h-full w-full" aria-hidden="true">
                  <line x1="30" y1="40" x2="60" y2="22" stroke={s.link.color} />
                  <line x1="60" y1="22" x2="90" y2="40" stroke={s.link.color} />
                  <line x1="60" y1="22" x2="60" y2="50" stroke={s.link.color} />
                  <circle cx="30" cy="40" r="5" fill={s.palette[0]} stroke={s.node.stroke} strokeWidth={s.node.strokeWidth || 0} />
                  <circle cx="60" cy="22" r="8" fill={s.palette[1] || s.palette[0]} stroke={s.node.stroke} strokeWidth={s.node.strokeWidth || 0} />
                  <circle cx="90" cy="40" r="5" fill={s.palette[2] || s.palette[0]} stroke={s.node.stroke} strokeWidth={s.node.strokeWidth || 0} />
                  <circle cx="60" cy="50" r="4" fill={s.palette[3] || s.palette[0]} stroke={s.node.stroke} strokeWidth={s.node.strokeWidth || 0} />
                </svg>
              </div>
              <div className="flex items-start justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg">{s.name}</p>
                  <p className="text-xs text-subtle">{s.description}</p>
                </div>
                {on && <Check size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-text" />}
              </div>
            </button>
          );
        })}
      </div>
      <div className="w-48 max-w-full">
        <Select label="Layout" value={graphLayout} onChange={(e) => setGraphLayout(e.target.value)} options={LAYOUT_LIST.map((l) => ({ value: l.id, label: l.name }))} />
      </div>
    </Section>
  );
}
