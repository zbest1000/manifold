// Pure keyboard-navigation + flattening logic for the tag tree (WAI-ARIA tree pattern).

const norm = (s) => String(s ?? '').toLowerCase();

/**
 * Flatten loaded nodes into the visible rows of a flat ARIA tree.
 * nodesByParent: { [browseKey]: node[] } where '' is the root; a folder's children live under node.address.
 * expanded: Set of node ids. filter: case-insensitive substring over name/address of LOADED nodes;
 * when filtering, folders with a matching loaded descendant are shown expanded.
 */
export function flattenVisible(nodesByParent, expanded, filter = '') {
  const f = norm(filter).trim();
  const matches = (n) => norm(n.name).includes(f) || norm(n.address).includes(f);
  const hasMatch = (n, depth = 0) => {
    if (matches(n)) return true;
    if (n.kind !== 'folder' || depth > 40) return false;
    return (nodesByParent[n.address] || []).some((c) => hasMatch(c, depth + 1));
  };
  const out = [];
  const walk = (parentKey, level, parentId) => {
    const all = nodesByParent[parentKey] || [];
    const list = f ? all.filter((n) => hasMatch(n)) : all;
    list.forEach((n, i) => {
      const isFolder = n.kind === 'folder';
      const forced = f && isFolder && (nodesByParent[n.address] || []).some((c) => hasMatch(c));
      const isOpen = isFolder && (expanded.has(n.id) || Boolean(forced));
      out.push({ key: n.id, node: n, level, parentKey: parentId, isFolder, expanded: isOpen, posInSet: i + 1, setSize: list.length });
      if (isOpen) walk(n.address, level + 1, n.id);
    });
  };
  walk('', 1, null);
  return out;
}

/**
 * Decide what a key press does. items = flattenVisible output; focusKey = focused row key.
 * Returns one of:
 *   { type: 'focus', key } | { type: 'expand', key } | { type: 'collapse', key }
 *   { type: 'toggle-expand', key } | { type: 'toggle-select', key } | null
 */
export function treeKeyAction(items, focusKey, key) {
  if (!items.length) return null;
  let idx = items.findIndex((i) => i.key === focusKey);
  if (idx < 0) idx = 0;
  const cur = items[idx];
  switch (key) {
    case 'ArrowDown':
      return idx < items.length - 1 ? { type: 'focus', key: items[idx + 1].key } : null;
    case 'ArrowUp':
      return idx > 0 ? { type: 'focus', key: items[idx - 1].key } : null;
    case 'Home':
      return { type: 'focus', key: items[0].key };
    case 'End':
      return { type: 'focus', key: items[items.length - 1].key };
    case 'ArrowRight':
      if (!cur.isFolder) return null;
      if (!cur.expanded) return { type: 'expand', key: cur.key };
      return items[idx + 1] && items[idx + 1].parentKey === cur.key ? { type: 'focus', key: items[idx + 1].key } : null;
    case 'ArrowLeft':
      if (cur.isFolder && cur.expanded) return { type: 'collapse', key: cur.key };
      return cur.parentKey ? { type: 'focus', key: cur.parentKey } : null;
    case 'Enter':
      return cur.isFolder ? { type: 'toggle-expand', key: cur.key } : { type: 'toggle-select', key: cur.key };
    case ' ':
    case 'Spacebar':
      return { type: 'toggle-select', key: cur.key };
    default:
      return null;
  }
}
