import { createContext, useContext } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown, Pencil, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { IconButton } from './controls';
import { Tooltip } from './tooltip';

/* ------------------------------------------------------------------ */
/* Table: real <table> semantics, compact rows, optional sortable heads */
/* ------------------------------------------------------------------ */

/** Table — a scroll-contained, captioned table. `caption` is read by screen readers. */
export function Table({ caption, children, className, wrapperClassName }) {
  return (
    // A scrolling region must be reachable by keyboard (focusable) and named.
    <div role="region" aria-label={caption} tabIndex={0} className={clsx('relative overflow-x-auto rounded-lg border border-line bg-panel', wrapperClassName)}>
      <table className={clsx('w-full min-w-[32rem] border-collapse text-left text-sm', className)}>
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function THead({ children }) {
  return (
    <thead className="border-b border-line">
      <tr>{children}</tr>
    </thead>
  );
}

const SortContext = createContext(null);

/** TableSort — provides {sort, onSort} to descendant <Th sortKey> cells. */
export function TableSort({ sort, onSort, children }) {
  return <SortContext.Provider value={{ sort, onSort }}>{children}</SortContext.Provider>;
}

/**
 * Th — column header with scope="col". Give `sortKey` (inside <TableSort>) to
 * make it a sortable button with aria-sort. `srOnly` hides the text visually
 * (for action columns) while keeping it announced. `hint` explains a sortable column in a tooltip on
 * its sort button (a separate hint button inside the sort button would nest two buttons).
 */
export function Th({ children, sortKey, hint, align = 'left', srOnly = false, className }) {
  const ctx = useContext(SortContext);
  const alignClass = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  const base = clsx('h-8 whitespace-nowrap px-3 align-middle text-xs font-medium text-muted', alignClass, className);
  if (sortKey && ctx?.onSort) {
    const active = ctx.sort?.key === sortKey;
    const dir = active ? ctx.sort.dir : null;
    const Icon = dir === 'asc' ? ChevronUp : dir === 'desc' ? ChevronDown : ChevronsUpDown;
    const button = (
      <button
        type="button"
        onClick={() => ctx.onSort(sortKey)}
        className={clsx('group inline-flex items-center gap-1 rounded transition-colors hover:text-fg', align === 'right' && 'flex-row-reverse', active && 'text-fg')}
      >
        {hint ? <span className="border-b border-dotted border-line-stronger">{children}</span> : children}
        <Icon size={12} aria-hidden="true" className={active ? 'text-accent-text' : 'opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70'} />
      </button>
    );
    return (
      <th scope="col" aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'} className={base}>
        {hint ? (
          <Tooltip label={hint} side="bottom">
            {button}
          </Tooltip>
        ) : (
          button
        )}
      </th>
    );
  }
  return (
    <th scope="col" className={base}>
      {srOnly ? <span className="sr-only">{children}</span> : children}
    </th>
  );
}

/** Tr — a row with hover tint; `highlight` marks the selected/edited row (accent rule + tint). */
export function Tr({ children, className, highlight = false, ...rest }) {
  return (
    <tr
      className={clsx(
        'border-t border-line transition-colors duration-100 first:border-t-0 hover:bg-[rgb(var(--tint)/0.035)]',
        highlight && 'bg-accent/[0.07] shadow-[inset_2px_0_0_rgb(var(--accent))] hover:bg-accent/[0.09]',
        className
      )}
      {...rest}
    >
      {children}
    </tr>
  );
}

export function Td({ children, className, align = 'left', header = false, ...rest }) {
  const Cell = header ? 'th' : 'td';
  return (
    <Cell
      {...(header ? { scope: 'row' } : {})}
      className={clsx('px-3 py-2 align-middle', align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left', header && 'font-normal', className)}
      {...rest}
    >
      {children}
    </Cell>
  );
}

/** Edit + delete icon buttons for the last cell of a table row. `what` names the row for assistive tech. */
export function RowActions({ what, onEdit, onDelete, children }) {
  return (
    <span className="inline-flex items-center justify-end gap-0.5">
      {children}
      {onEdit && <IconButton icon={Pencil} label={`Edit ${what}`} size={14} onClick={onEdit} />}
      {onDelete && <IconButton icon={Trash2} label={`Delete ${what}`} size={14} className="hover:bg-bad/10 hover:text-bad" onClick={onDelete} />}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Page layout                                                         */
/* ------------------------------------------------------------------ */

/** PageBody — the scrolling content area under a PageHeader (responsive gutter). */
export function PageBody({ children, className }) {
  return <div className={clsx('min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5', className)}>{children}</div>;
}

/** Toolbar — a row of grouped controls above a table or canvas. Separate groups with <ToolbarDivider/>. */
export function Toolbar({ children, className, label }) {
  return (
    <div role="toolbar" aria-label={label} className={clsx('flex flex-wrap items-center gap-2', className)}>
      {children}
    </div>
  );
}

export function ToolbarDivider() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px bg-line" />;
}
