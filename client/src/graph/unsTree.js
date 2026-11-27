/** Build the namespace tree for one broker from its flat topic list. */
export function buildUnsTree(broker, topics) {
  const root = {
    id: `uns:${broker.id}`,
    path: '',
    name: broker.name || `${broker.host}:${broker.port}`,
    depth: 0,
    brokerId: broker.id,
    children: new Map(),
    topicCount: 0
  };
  for (const t of topics) {
    if (!t.topic || t.topic.startsWith('$')) continue; // $SYS is broker internals, not namespace
    const segs = t.topic.split('/').filter(Boolean);
    let node = root;
    root.topicCount++;
    let path = '';
    for (let i = 0; i < segs.length; i++) {
      path = i === 0 ? segs[i] : `${path}/${segs[i]}`;
      let child = node.children.get(segs[i]);
      if (!child) {
        child = {
          id: `uns:${broker.id}:${path}`,
          path,
          name: segs[i],
          depth: i + 1,
          brokerId: broker.id,
          children: new Map(),
          topicCount: 0
        };
        node.children.set(segs[i], child);
      }
      child.topicCount++;
      node = child;
    }
  }
  return root;
}

/** Mounted sources (OPC UA / i3X) use a `mount:<id>` pseudo broker id. */
export const isMountNode = (node) => String(node.brokerId).startsWith('mount:');

/**
 * The selected node as the CURRENT tree has it. A selection keeps the node object it was made with; the
 * tree is rebuilt as topics arrive, so the details panel must read counts and rates from the newest copy
 * (a node selected by a deep link right after load would otherwise keep its first, smaller topic count).
 * Falls back to the kept object while the node is not in the tree (not seen yet, or another namespace).
 */
export function liveSelection(selected, byId) {
  if (!selected) return null;
  return byId?.get(selected.id) || selected;
}
