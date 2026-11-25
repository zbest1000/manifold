/**
 * Paging of long branches, shared by the UNS topology canvas and the UNS Tree
 * view (pure: no DOM, no React; tested in src/test/unsPaging.test.js).
 *
 * A branch with more than PAGE_SIZE children shows one page of them at a time,
 * preceded by a pager: first / previous / next / last (first and last only when
 * there are more than three pages), the range shown ("51–100 of 2,000") and a
 * filter by name for that branch, so one child among thousands is found without
 * paging. The state per branch is { page, filter }, keyed by the branch's node
 * id; it lives for the browser session (sessionStorage), so collapsing and
 * re-opening an ancestor, or leaving the page and coming back, keeps it.
 * A deep link to a node inside a long branch opens the page that contains it
 * (pagingForPath).
 */

export const PAGE_SIZE = 50;
export const SESSION_KEY = 'manifold.unsPaging';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Sibling order by name, natural (line2 before line10); ties broken by code point. */
export const compareNames = (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/** Does a branch with `count` children page? */
export const isPaged = (count, pageSize = PAGE_SIZE) => count > pageSize;

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * One page of a branch's (already sorted) children.
 * `nameOf(child)` gives the name the filter matches (substring, case-insensitive).
 * Returns { items, page, pages, total, all, from, to, filter } where `from`/`to`
 * are 1-based and inclusive (0 / 0 when nothing matches), `total` the children
 * after the filter and `all` before it.
 */
export function pageSlice(sorted, state = null, { pageSize = PAGE_SIZE, nameOf = (c) => c.name } = {}) {
  const filter = norm(state?.filter);
  const list = filter ? sorted.filter((c) => norm(nameOf(c)).includes(filter)) : sorted;
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(0, Math.floor(Number(state?.page) || 0)), pages - 1);
  const start = page * pageSize;
  const items = list.slice(start, start + pageSize);
  return { items, page, pages, total, all: sorted.length, from: items.length ? start + 1 : 0, to: start + items.length, filter: state?.filter ? String(state.filter) : '' };
}

/** "51–100 of 2,000"; with a filter "1–12 of 12 matching "s01" (2,000 in all)"; "No match for "x" (2,000 in all)". */
export function rangeLabel({ from, to, total, all, filter }) {
  if (filter) {
    if (!total) return `No match for "${filter}" (${all.toLocaleString()} in all)`;
    return `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()} matching "${filter}" (${all.toLocaleString()} in all)`;
  }
  return `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`;
}

/** Which pager controls exist and are enabled. First / last only with more than three pages. */
export function pagerControls({ page, pages }) {
  const ends = pages > 3;
  return {
    first: { shown: ends, enabled: ends && page > 0 },
    prev: { shown: true, enabled: page > 0 },
    next: { shown: true, enabled: page < pages - 1 },
    last: { shown: ends, enabled: ends && page < pages - 1 }
  };
}

/** The page index a pager action leads to ('first' | 'prev' | 'next' | 'last'), clamped. */
export function stepPage({ page, pages }, action) {
  const target = action === 'first' ? 0 : action === 'last' ? pages - 1 : action === 'prev' ? page - 1 : action === 'next' ? page + 1 : page;
  return Math.min(Math.max(0, target), pages - 1);
}

/**
 * The state that shows child `name` of a branch: its page, keeping the
 * branch's filter when it matches the name, else clearing it.
 */
export function stateShowing(sorted, name, state = null, { pageSize = PAGE_SIZE, nameOf = (c) => c.name } = {}) {
  const keepFilter = state?.filter && norm(name).includes(norm(state.filter));
  const filter = keepFilter ? state.filter : '';
  const list = filter ? sorted.filter((c) => norm(nameOf(c)).includes(norm(filter))) : sorted;
  const i = list.findIndex((c) => nameOf(c) === name);
  return { page: i < 0 ? 0 : Math.floor(i / pageSize), filter };
}

/**
 * Paging that makes the node at `path` (under `root`) visible: for every
 * ancestor with a paged child list, the page holding the next segment. Returns
 * a NEW Map (unchanged entries kept) or the same Map when nothing changes.
 * `idOf(node)` is the paging key (the node id).
 */
export function pagingForPath(root, path, paging, { pageSize = PAGE_SIZE, idOf = (n) => n.id } = {}) {
  const segs = String(path ?? '').split('/').filter(Boolean);
  let node = root;
  let next = paging;
  for (const seg of segs) {
    if (!node?.children) break;
    const child = node.children.get(seg);
    if (!child) break;
    if (isPaged(node.children.size, pageSize)) {
      const sorted = [...node.children.values()].sort((a, b) => compareNames(a.name, b.name));
      const key = idOf(node);
      const cur = next.get(key) || null;
      const want = stateShowing(sorted, child.name, cur, { pageSize });
      if (!cur || cur.page !== want.page || (cur.filter || '') !== want.filter) {
        if (next === paging) next = new Map(paging);
        next.set(key, want);
      }
    }
    node = child;
  }
  return next;
}

/** Paging Map from sessionStorage (empty when missing, malformed or blocked). */
export function loadPaging(storage = typeof sessionStorage !== 'undefined' ? sessionStorage : null) {
  try {
    const raw = storage?.getItem(SESSION_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    if (!obj || typeof obj !== 'object') return new Map();
    const out = new Map();
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') out.set(k, { page: Math.max(0, Math.floor(Number(v.page) || 0)), filter: typeof v.filter === 'string' ? v.filter : '' });
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Persist a paging Map for the session (best effort; default states are dropped). */
export function savePaging(paging, storage = typeof sessionStorage !== 'undefined' ? sessionStorage : null) {
  try {
    const obj = {};
    for (const [k, v] of paging) if (v && (v.page > 0 || v.filter)) obj[k] = { page: v.page, filter: v.filter || '' };
    storage?.setItem(SESSION_KEY, JSON.stringify(obj));
  } catch {
    // storage blocked or full: paging still works for this page view
  }
}
