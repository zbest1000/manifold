/**
 * Which Topics view to open. Above ~200 topics the node graph is dense enough
 * that the Tree is the better default; once the user picks a view themselves,
 * that choice is remembered and wins.
 */
export const TREE_DEFAULT_THRESHOLD = 200;
export const VIEW_KEY = 'tc.topicsView';
export const VIEWS = ['graph', '3d', 'tree'];

export function loadSavedView() {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return VIEWS.includes(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveView(view) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // preference is best-effort
  }
}

/** The view to show: the user's remembered/explicit choice, else a size-based default. */
export function resolveTopicsView(userView, topicCount) {
  if (VIEWS.includes(userView)) return userView;
  return topicCount > TREE_DEFAULT_THRESHOLD ? 'tree' : 'graph';
}
