/**
 * Which Topics view to open. Above ~200 topics the node graph is dense enough
 * that the Tree is the better default (and the page says so in a dismissible
 * note); once the user picks a view themselves, that choice is remembered PER
 * BROKER and wins. The old global choice (`tc.topicsView`, from before choices
 * were per broker) still applies to a broker without its own choice.
 */
export const TREE_DEFAULT_THRESHOLD = 200;
export const VIEW_KEY = 'tc.topicsView'; // legacy global choice (read only)
export const BROKER_VIEW_KEY = 'tc.topicsView.byBroker'; // { [brokerId]: view }
export const NOTE_KEY = 'tc.topicsTreeNote.dismissed'; // { [brokerId]: true }
export const VIEWS = ['graph', '3d', 'tree'];

function readMap(key, storage) {
  try {
    const obj = JSON.parse(storage?.getItem(key) || 'null');
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

function writeMap(key, obj, storage) {
  try {
    storage?.setItem(key, JSON.stringify(obj));
  } catch {
    // preference is best-effort
  }
}

const local = () => (typeof localStorage !== 'undefined' ? localStorage : null);

/** The remembered view for a broker: its own explicit choice, else the legacy global one, else null. */
export function loadSavedView(brokerId = null, storage = local()) {
  const own = brokerId ? readMap(BROKER_VIEW_KEY, storage)[brokerId] : null;
  if (VIEWS.includes(own)) return own;
  try {
    const v = storage?.getItem(VIEW_KEY);
    return VIEWS.includes(v) ? v : null;
  } catch {
    return null;
  }
}

/** Remember an explicit view choice for one broker. */
export function saveView(view, brokerId = null, storage = local()) {
  if (!VIEWS.includes(view) || !brokerId) return;
  const map = readMap(BROKER_VIEW_KEY, storage);
  map[brokerId] = view;
  writeMap(BROKER_VIEW_KEY, map, storage);
}

/** Was the "showing the tree because…" note dismissed for this broker? */
export function noteDismissed(brokerId, storage = local()) {
  return Boolean(brokerId && readMap(NOTE_KEY, storage)[brokerId]);
}

export function dismissNote(brokerId, storage = local()) {
  if (!brokerId) return;
  const map = readMap(NOTE_KEY, storage);
  map[brokerId] = true;
  writeMap(NOTE_KEY, map, storage);
}

/** The view to show: the user's remembered/explicit choice, else a size-based default. */
export function resolveTopicsView(userView, topicCount) {
  if (VIEWS.includes(userView)) return userView;
  return topicCount > TREE_DEFAULT_THRESHOLD ? 'tree' : 'graph';
}
