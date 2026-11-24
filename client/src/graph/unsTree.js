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
