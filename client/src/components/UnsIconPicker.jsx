import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, RotateCcw, Plus, Trash2, Library } from 'lucide-react';
import clsx from 'clsx';
import { Banner, Button, Dialog, Field, Input, Textarea } from './ui';
import { useTheme } from '@/lib/theme';
import {
  loadIcons,
  allIconNames,
  curatedIconNames,
  customIconList,
  saveCustomIcon,
  deleteCustomIcon,
  loadFullLibrary,
  fullLibraryLoaded,
  getIconImage,
  setIconOverride,
  getIconOverride,
  resolveIconName
} from '@/graph/unsIcons';

// Mirrors the server-side validation so bad input fails fast with a local message.
const NAME_RE = /^[a-z0-9-]{1,40}$/;
const PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9\s,.+-]+$/;

const COLUMNS = 8;

/** The theme's text colour as #rrggbb, so previews are legible in both themes. */
function themeInk() {
  try {
    const parts = getComputedStyle(document.documentElement).getPropertyValue('--text').trim().split(/\s+/).map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) return `#${parts.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    /* fall through */
  }
  return '#cbd5e1';
}

/**
 * A grid of icon buttons with one tab stop (roving tabindex): arrow keys move by one icon or one row,
 * Home and End jump to the first and last. Enter or Space picks the focused icon.
 */
function IconGrid({ names, current, ink, label, onPick, renderExtra }) {
  const refs = useRef([]);
  const [focusIdx, setFocusIdx] = useState(0);
  const active = Math.min(focusIdx, Math.max(0, names.length - 1));
  const onKeyDown = (e, i) => {
    const n = names.length;
    let next = null;
    if (e.key === 'ArrowRight') next = Math.min(n - 1, i + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, i - 1);
    else if (e.key === 'ArrowDown') next = Math.min(n - 1, i + COLUMNS);
    else if (e.key === 'ArrowUp') next = Math.max(0, i - COLUMNS);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next === null) return;
    e.preventDefault();
    setFocusIdx(next);
    refs.current[next]?.focus();
  };
  return (
    <div role="group" aria-label={label} className="grid grid-cols-8 gap-1.5">
      {names.map((name, i) => {
        const img = getIconImage(name, ink, 40);
        return (
          <div key={name} className="group relative">
            <button
              ref={(el) => (refs.current[i] = el)}
              type="button"
              tabIndex={i === active ? 0 : -1}
              onClick={() => onPick(name)}
              onKeyDown={(e) => onKeyDown(e, i)}
              onFocus={() => setFocusIdx(i)}
              aria-pressed={name === current}
              aria-label={name}
              title={name}
              className={clsx(
                'grid aspect-square w-full place-items-center rounded-md border transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgb(var(--focus))]',
                name === current ? 'border-accent bg-accent/15' : 'border-line bg-panel hover:border-line-stronger hover:bg-raised'
              )}
            >
              {img && <img src={img.src} alt="" className="h-5 w-5" />}
            </button>
            {renderExtra?.(name)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Icon picker for UNS nodes. Three sources:
 *   - Custom: user-defined single-path SVG icons, stored server-side.
 *   - Curated: the bundled ~130-icon industrial subset (default, searchable).
 *   - Full library: the complete Lucide set (~2,000 icons) as an explicit
 *     lazy opt-in: nothing pulls the big chunk until the user asks.
 * Icons preview using the same rasterizer the canvas uses.
 */
export default function UnsIconPicker({ node, onClose, onPicked }) {
  useTheme(); // re-render when the theme changes so the previews pick up the new text colour
  const ink = themeInk();
  const [query, setQuery] = useState('');
  const [customIcons, setCustomIcons] = useState(customIconList());
  const [fullReady, setFullReady] = useState(fullLibraryLoaded());
  const [loadingFull, setLoadingFull] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadIcons().then(() => setCustomIcons(customIconList()));
  }, []);

  const q = query.trim().toLowerCase();
  const customNames = useMemo(() => customIcons.map((i) => i.name).filter((n) => !q || n.includes(q)), [customIcons, q]);
  const gridNames = useMemo(() => {
    const customSet = new Set(customIcons.map((i) => i.name));
    const source = fullReady ? allIconNames().filter((n) => !customSet.has(n)) : curatedIconNames();
    if (!q) return fullReady ? source.slice(0, 240) : source;
    return source.filter((n) => n.includes(q)).slice(0, 240);
  }, [fullReady, q, customIcons]);

  const current = resolveIconName(node);
  const hasOverride = Boolean(getIconOverride(node.brokerId, node.path));

  const pick = (name) => {
    setIconOverride(node.brokerId, node.path, name);
    onPicked?.(name);
    onClose();
  };

  const submitCustom = async () => {
    const name = newName.trim();
    const svgPath = newPath.trim();
    if (!NAME_RE.test(name)) {
      setFormError('Name must be 1 to 40 characters: lowercase letters, digits and hyphens.');
      return;
    }
    if (!svgPath || svgPath.length > 4000 || !PATH_RE.test(svgPath)) {
      setFormError('Path must be SVG path data only (M, L, C… commands and numbers), at most 4000 characters.');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      await saveCustomIcon(name, svgPath);
      setCustomIcons(customIconList());
      setNewName('');
      setNewPath('');
      setShowAdd(false);
    } catch (e) {
      setFormError(e.message || 'Failed to save icon');
    } finally {
      setSaving(false);
    }
  };

  const removeCustom = async (name) => {
    try {
      await deleteCustomIcon(name);
      setCustomIcons(customIconList());
    } catch {
      // API layer already logged it
    }
  };

  const previewPathOk = newPath.trim() && PATH_RE.test(newPath.trim());

  return (
    <Dialog
      title={`Icon for ${node.name}`}
      description={
        <>
          Current: <span className="mono text-xs text-fg">{current}</span> ({hasOverride ? 'chosen by you' : 'automatic'})
        </>
      }
      size="md"
      onClose={onClose}
      bodyClassName="space-y-4"
    >
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input data-autofocus aria-label="Search icons" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${allIconNames().length.toLocaleString()} icons…`} className="pl-8" />
        </div>
        {hasOverride && (
          <Button
            variant="secondary"
            title="Go back to the automatic icon for this node"
            onClick={() => {
              setIconOverride(node.brokerId, node.path, null);
              onPicked?.(null);
              onClose();
            }}
          >
            <RotateCcw size={13} aria-hidden="true" /> Automatic
          </Button>
        )}
      </div>

      <section aria-labelledby="icons-custom">
        <div className="mb-2 flex items-center justify-between">
          <h3 id="icons-custom" className="text-sm font-medium text-fg">
            Custom
          </h3>
          <Button
            size="sm"
            variant="secondary"
            aria-expanded={showAdd}
            onClick={() => {
              setShowAdd((v) => !v);
              setFormError('');
            }}
          >
            <Plus size={12} aria-hidden="true" /> Add custom icon
          </Button>
        </div>

        {showAdd && (
          <div className="mb-3 space-y-3 border-l-2 border-line pl-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1 space-y-3">
                <Field label="Icon name">
                  <Input className="mono" aria-label="Custom icon name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="my-reactor" />
                </Field>
                <Field label="SVG path data" help="The d attribute of a path in a 24 × 24 view box.">
                  <Textarea className="mono resize-none text-xs" aria-label="SVG path data" value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="M4 20h16M6 20V8l6-4 6 4v12" rows={3} />
                </Field>
              </div>
              <div className="mt-5 grid h-16 w-16 shrink-0 place-items-center rounded-md border border-line bg-app" title="Live preview">
                {previewPathOk ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-8 w-8 text-fg" aria-hidden="true">
                    <path d={newPath.trim()} />
                  </svg>
                ) : (
                  <span className="text-2xs text-subtle">Preview</span>
                )}
              </div>
            </div>
            {formError && (
              <Banner variant="error">{formError}</Banner>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={submitCustom} loading={saving}>
                Save icon
              </Button>
            </div>
          </div>
        )}

        {customNames.length > 0 ? (
          <IconGrid
            names={customNames}
            current={current}
            ink={ink}
            label="Custom icons"
            onPick={pick}
            renderExtra={(name) => (
              <button
                type="button"
                aria-label={`Delete custom icon ${name}`}
                title={`Delete ${name}`}
                onClick={() => removeCustom(name)}
                className="absolute -right-1 -top-1 rounded-full border border-line-strong bg-overlay p-1 text-subtle opacity-0 hover:text-bad focus:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
              >
                <Trash2 size={10} aria-hidden="true" />
              </button>
            )}
          />
        ) : (
          !showAdd && <p className="text-xs text-subtle">No custom icons yet.</p>
        )}
      </section>

      <section aria-labelledby="icons-library">
        <h3 id="icons-library" className="mb-2 text-sm font-medium text-fg">
          {fullReady ? 'All icons' : 'Curated industrial set'}
        </h3>
        {gridNames.length > 0 && <IconGrid names={gridNames} current={current} ink={ink} label={fullReady ? 'All icons' : 'Curated icons'} onPick={pick} />}
        {gridNames.length === 0 && customNames.length === 0 && <p className="py-6 text-center text-sm text-muted">No icons match “{query}”.</p>}

        {!fullReady && (
          <Button
            variant="secondary"
            className="mt-3 w-full"
            loading={loadingFull}
            onClick={() => {
              setLoadingFull(true);
              loadFullLibrary().then(() => {
                setFullReady(true);
                setLoadingFull(false);
              });
            }}
          >
            <Library size={13} aria-hidden="true" /> Load the full library (about 2,000 more icons)
          </Button>
        )}
        {!query && (
          <p className="mt-2 text-xs text-subtle">
            {fullReady ? `Browsing the full set: ${allIconNames().length.toLocaleString()} icons.` : 'Showing the curated industrial set. Load the full library to browse everything.'} Arrow keys move between icons.
          </p>
        )}
      </section>
    </Dialog>
  );
}
