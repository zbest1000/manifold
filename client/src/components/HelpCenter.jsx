import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { LifeBuoy, X, Search, BookOpen } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '@/store/store';
import { HELP_SECTIONS, HELP_TOPICS } from './helpContent';

/**
 * Tiny renderer for help copy: blank-line paragraph breaks, **bold**, `code`,
 * and numbered-step lines. Deliberately not a markdown engine — the content
 * format (helpContent.js) only promises these three things.
 */
function HelpBody({ text }) {
  const paragraphs = text.split('\n\n');
  return (
    <div className="space-y-2">
      {paragraphs.map((p, i) => (
        <p key={i} className="text-sm leading-relaxed text-slate-300">
          {p.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((chunk, j) => {
            if (chunk.startsWith('**') && chunk.endsWith('**')) {
              return (
                <b key={j} className="font-semibold text-slate-100">
                  {chunk.slice(2, -2)}
                </b>
              );
            }
            if (chunk.startsWith('`') && chunk.endsWith('`')) {
              return (
                <code key={j} className="mono rounded bg-white/5 px-1 py-0.5 text-xs text-accent-200">
                  {chunk.slice(1, -1)}
                </code>
              );
            }
            return chunk;
          })}
        </p>
      ))}
    </div>
  );
}

/**
 * HelpCenter — the app-wide help panel: getting-started tour, task guides, a
 * glossary of the industrial jargon the UI necessarily uses, and keyboard
 * shortcuts. Opened from the sidebar Help button or `?` anywhere. Open state
 * lives in the store so pages can deep-link (openHelp('guide-alarm')).
 */
export default function HelpCenter() {
  const open = useStore((s) => s.helpOpen);
  const topicId = useStore((s) => s.helpTopic);
  const closeHelp = useStore((s) => s.closeHelp);
  const [section, setSection] = useState('start');
  const [query, setQuery] = useState('');

  // Deep-link: when opened with a topic id, jump to that topic's section and
  // scroll it into view (a page's guide can sit far down the list).
  const active = topicId ? HELP_TOPICS.find((t) => t.id === topicId) : null;
  const shownSection = active ? active.section : section;
  const activeRef = useRef(null);
  useEffect(() => {
    if (open && active) activeRef.current?.scrollIntoView({ block: 'start' });
  }, [open, active]);

  const q = query.trim().toLowerCase();
  const topics = useMemo(() => {
    if (q) {
      // Search spans ALL sections — rank title hits first.
      const hit = (t) => `${t.title} ${t.keywords} ${t.body}`.toLowerCase().includes(q);
      return HELP_TOPICS.filter(hit).sort((a, b) => {
        const at = a.title.toLowerCase().includes(q) ? 0 : 1;
        const bt = b.title.toLowerCase().includes(q) ? 0 : 1;
        return at - bt;
      });
    }
    return HELP_TOPICS.filter((t) => t.section === shownSection);
  }, [q, shownSection]);

  const sectionLabel = (id) => HELP_SECTIONS.find((s) => s.id === id)?.label || id;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeHelp}
          />
          <motion.aside
            className="fixed right-0 top-0 z-50 flex h-screen w-full max-w-lg flex-col border-l border-white/10 bg-surface-900 shadow-2xl"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'tween', duration: 0.2 }}
            role="dialog"
            aria-label="Help"
          >
            <header className="flex items-center justify-between border-b border-white/5 px-4 py-3">
              <div className="flex items-center gap-2">
                <LifeBuoy size={16} className="text-accent-400" />
                <h2 className="text-sm font-semibold text-slate-100">Help</h2>
              </div>
              <button
                onClick={closeHelp}
                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
                aria-label="Close help"
              >
                <X size={16} />
              </button>
            </header>

            <div className="border-b border-white/5 px-4 py-2.5">
              <div className="relative">
                <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search help — try “alarm”, “wildcard”, “historian”…"
                  className="w-full rounded-lg border border-white/10 bg-surface-950/60 py-1.5 pl-8 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent-500/60 focus:outline-none focus:ring-2 focus:ring-accent-500/20"
                />
              </div>
            </div>

            {!q && (
              <div className="flex flex-wrap gap-1.5 border-b border-white/5 px-4 py-2.5">
                {HELP_SECTIONS.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      setSection(s.id);
                      if (topicId) useStore.getState().openHelp(null); // clear deep-link
                    }}
                    aria-pressed={shownSection === s.id}
                    className={clsx(
                      'rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset transition',
                      shownSection === s.id
                        ? 'bg-accent-500/15 text-accent-300 ring-accent-500/30'
                        : 'bg-transparent text-slate-400 ring-white/10 hover:text-slate-200'
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              {topics.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-slate-500">
                  <BookOpen size={26} className="text-slate-600" />
                  <p className="text-sm">No help topics match “{query}”</p>
                  <p className="max-w-xs text-xs text-slate-600">Try a broader term — page names, protocols, or the thing you’re trying to do.</p>
                </div>
              ) : (
                <ul className="divide-y divide-white/5">
                  {topics.map((t) => (
                    <li key={t.id} ref={active?.id === t.id ? activeRef : undefined} className={clsx('px-4 py-3.5', active?.id === t.id && 'bg-accent-500/5')}>
                      <div className="mb-1.5 flex items-baseline justify-between gap-2">
                        <h3 className="text-sm font-semibold text-slate-100">{t.title}</h3>
                        {q && <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-600">{sectionLabel(t.section)}</span>}
                      </div>
                      <HelpBody text={t.body} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
