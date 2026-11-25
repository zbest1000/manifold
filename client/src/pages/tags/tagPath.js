// Disambiguating labels for tag lists: tags from different folders often share a name ("temp"),
// so a list shows as many trailing path levels as it takes to tell them apart, shortened from the
// start ("…/line2/temp"); the full address goes in the tooltip.

/** Path levels of an address: MQTT topics and browse paths split on "/", OPC UA string ids on "." after "s=". */
export function pathLevels(address) {
  const a = String(address ?? '');
  const ua = /^ns=\d+;s=(.*)$/.exec(a);
  if (ua) return ua[1].split(/[./]/).filter(Boolean);
  return a.split('/').filter(Boolean);
}

/**
 * Map(address -> { label, parent, full, shortened }) for a list of addresses. `label` is the
 * shortest unique tail (at least the last level); `parent` is that tail without the last level.
 */
export function shortLabels(addresses) {
  const list = [...new Set(addresses.map(String))];
  const levels = new Map(list.map((a) => [a, pathLevels(a)]));
  const tail = (a, k) => levels.get(a).slice(-k).join('/');
  const out = new Map();
  for (const a of list) {
    const segs = levels.get(a);
    let k = 1;
    while (k < segs.length && list.some((b) => b !== a && levels.get(b).length >= 1 && tail(b, k) === tail(a, k))) k++;
    const label = segs.length ? tail(a, k) : a;
    out.set(a, { label, parent: segs.length > 1 ? segs.slice(-k, -1).join('/') : '', full: a, shortened: k < segs.length });
  }
  return out;
}
