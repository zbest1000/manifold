import { isWildcard, topicMatches } from '@/lib/mqtt';

/**
 * Ranked search over graph / namespace nodes for the search-and-pick boxes
 * (UNS map, Topics graph). Pure; tested in src/test/nodeSearch.test.js.
 *
 * An item is { id, label, path }. Plain text matches the label or the path,
 * case-insensitive: an exact label first, then a label that starts with the
 * text, then a label that contains it, then a path that contains it; ties go to
 * the shorter path, then alphabetical. A query with + or # is an MQTT filter
 * matched against the path.
 * Returns { results (at most `limit`), total }.
 */
export function searchNodes(items, query, { limit = 50 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { results: [], total: 0 };
  const scored = [];
  if (isWildcard(q)) {
    for (const it of items) if (it.path && topicMatches(q, it.path)) scored.push({ it, rank: 0 });
  } else {
    const lower = q.toLowerCase();
    for (const it of items) {
      const label = String(it.label || '').toLowerCase();
      const path = String(it.path || '').toLowerCase();
      let rank = -1;
      if (label === lower) rank = 0;
      else if (label.startsWith(lower)) rank = 1;
      else if (label.includes(lower)) rank = 2;
      else if (path.includes(lower)) rank = 3;
      if (rank >= 0) scored.push({ it, rank });
    }
  }
  scored.sort((a, b) => a.rank - b.rank || String(a.it.path || '').length - String(b.it.path || '').length || String(a.it.path || a.it.label).localeCompare(String(b.it.path || b.it.label)));
  return { results: scored.slice(0, limit).map((s) => s.it), total: scored.length };
}

/** "3 matches" / "No matches" / "50 of 312 matches shown" for the live region. */
export function matchSummary(shown, total) {
  if (!total) return 'No matches';
  if (shown < total) return `${shown.toLocaleString()} of ${total.toLocaleString()} matches shown`;
  return `${total.toLocaleString()} ${total === 1 ? 'match' : 'matches'}`;
}

/** Next active index for an arrow key in a list of `n` options (wraps; -1 = none active). */
export function stepActive(active, n, key) {
  if (!n) return -1;
  if (key === 'ArrowDown') return active < 0 || active >= n - 1 ? 0 : active + 1;
  if (key === 'ArrowUp') return active <= 0 ? n - 1 : active - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return active;
}
