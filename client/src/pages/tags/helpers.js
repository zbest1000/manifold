// Pure helpers for the Tags page. Topic resolution mirrors
// server/services/tagBindings.js (slug / targetTopic / statusTopic) EXACTLY so
// the wizard preview shows what the server will publish.

/** Same as the server: trim, then collapse whitespace and MQTT-reserved / + # into "_". */
export function slug(name) {
  return String(name).trim().replace(/[\s/+#]+/g, '_');
}

export function targetTopic(template, tagName) {
  const t = String(template || 'uns/{name}');
  return t.includes('{name}') ? t.replace(/\{name\}/g, slug(tagName)) : `${t.replace(/\/+$/, '')}/${slug(tagName)}`;
}

export function statusTopic(template) {
  const t = String(template || 'uns/{name}');
  return t.includes('{name}') ? t.replace(/\{name\}/g, '_status') : `${t.replace(/\/+$/, '')}/_status`;
}

// ---- template validation ---------------------------------------------------

export const TEMPLATE_VARIABLES = [{ token: '{name}', help: 'tag name, with spaces and / + # replaced by _' }];

/** Returns an error string, or null when the template is publishable. */
export function validateTemplate(template) {
  const t = String(template ?? '');
  if (!t.trim()) return 'Enter a path template, for example site/area/line/{name}.';
  if (/[+#]/.test(t)) return 'MQTT wildcards (+ and #) cannot appear in a publish topic.';
  if (/\s/.test(t)) return 'The path template cannot contain spaces.';
  if (t.startsWith('/')) return 'Do not start the path with a slash.';
  if (t.startsWith('$')) return 'Topics starting with $ are reserved by the broker.';
  if (/\/\//.test(t)) return 'The path has an empty segment (two slashes in a row).';
  const unknown = [...t.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).filter((v) => v !== 'name');
  if (unknown.length) return `Unknown variable {${unknown[0]}}. Only {name} is supported.`;
  if (/[{}]/.test(t.replace(/\{name\}/g, ''))) return 'Unbalanced braces in the path template.';
  return null;
}

// ---- raw device address detection -------------------------------------------

const RAW_ADDRESS_RE = /^(DB\d+\.|4\d{4,5}$|ns=\d+;)/i;

/** True when a topic segment / tag name looks like a PLC or OPC UA address rather than a property name. */
export function looksLikeRawAddress(segment) {
  return RAW_ADDRESS_RE.test(String(segment ?? '').trim());
}

/**
 * Problems with one tag name once it becomes a topic segment.
 * kind 'address' = looks like a device address; 'slugged' = the server will rewrite characters.
 */
export function nameWarnings(name) {
  const out = [];
  const raw = String(name ?? '');
  if (looksLikeRawAddress(raw)) {
    out.push({ kind: 'address', message: 'Looks like a raw device address. Use a meaningful property name.' });
  }
  if (!raw.trim()) {
    out.push({ kind: 'empty', message: 'Empty name.' });
  } else if (slug(raw) !== raw) {
    out.push({ kind: 'slugged', message: `Contains characters the server replaces with "_" (becomes ${slug(raw)}).` });
  }
  return out;
}

// ---- preview + collisions -----------------------------------------------------

/**
 * rows: [{ key, address, name }]. Returns rows with resolved topic + warnings.
 * Warnings come from the tag name as well as every topic segment the template contributes.
 */
export function resolvePreview(template, rows) {
  return rows.map((r) => {
    const topic = targetTopic(template, r.name);
    const warnings = nameWarnings(r.name);
    if (!warnings.some((w) => w.kind === 'address') && topic.split('/').some(looksLikeRawAddress)) {
      warnings.push({ kind: 'address', message: 'A topic segment looks like a raw device address.' });
    }
    return { ...r, topic, warnings };
  });
}

/** Map topic -> keys for topics produced by 2+ rows. Empty Map when there are none. */
export function findCollisions(resolved) {
  const by = new Map();
  for (const r of resolved) {
    if (!by.has(r.topic)) by.set(r.topic, []);
    by.get(r.topic).push(r.key);
  }
  for (const [t, keys] of [...by]) if (keys.length < 2) by.delete(t);
  return by;
}

export function examplePayload(format, now = 1700000000000) {
  return format === 'envelope' ? JSON.stringify({ v: 42.5, t: now, q: 192 }) : '42.5';
}

// ---- topic paths ------------------------------------------------------------

export function commonPrefix(topics) {
  if (!topics.length) return '';
  let prefix = topics[0].split('/');
  for (const t of topics.slice(1)) {
    const segs = t.split('/');
    let i = 0;
    while (i < prefix.length && prefix[i] === segs[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.length ? prefix.join('/') + '/' : '';
}

// ---- bound-tag index -------------------------------------------------------------

/** Scope for a Sparkplug node: group/edge/device ('' device = node-level metrics). */
export function spScope(meta) {
  return `${meta?.group ?? ''}/${meta?.edge ?? ''}/${meta?.device ?? ''}`;
}

function bindingPath(b, tagName) {
  const t = b.target || {};
  if (t.mode === 'sparkplug') {
    const dev = t.device || slug(b.name || b.id);
    return `spBv1.0/${t.group}/DDATA/${t.edge}/${dev}`;
  }
  return tagName == null ? t.pathTemplate || '' : targetTopic(t.pathTemplate, tagName);
}

/** The browse-source id a binding source reads from (the `id` of a /api/tags/sources entry). */
export function bindingSourceId(s = {}) {
  if (s.type === 'opcua') return s.connectionId;
  if (s.type === 'mqtt' || s.type === 'sparkplug') return s.brokerId;
  if (s.type === 'iot') return `${s.brokerId}|${s.deviceId}`;
  return s.deviceId ?? s.connectionId;
}

/**
 * Index of which source tags already appear in a binding.
 * byKey: `${type}|${sourceId}|${address}` (sparkplug: `|${scope}|${metric}`) -> [{ id, name, path }]
 * wildcard: `sparkplug|${brokerId}|${scope}` for sparkplug bindings with no metric list.
 */
export function buildBoundIndex(bindings) {
  const byKey = new Map();
  const wildcard = new Map();
  const add = (map, key, entry) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  };
  for (const b of bindings || []) {
    const s = b.source || {};
    const label = b.name || String(b.id).slice(0, 8);
    if (s.type === 'sparkplug') {
      const base = `sparkplug|${s.brokerId}|${spScope(s)}`;
      const path = bindingPath(b, null);
      if (Array.isArray(s.metrics) && s.metrics.length) {
        for (const m of s.metrics) add(byKey, `${base}|${m}`, { id: b.id, name: label, path });
      } else {
        add(wildcard, base, { id: b.id, name: label, path });
      }
    } else if (Array.isArray(s.tags)) {
      const sid = bindingSourceId(s);
      for (const t of s.tags) {
        const address = typeof t === 'string' ? t : t.address;
        const name = typeof t === 'string' ? t : t.name;
        add(byKey, `${s.type}|${sid}|${address}`, { id: b.id, name: label, path: bindingPath(b, name) });
      }
    }
  }
  return { byKey, wildcard };
}

/** Bindings that already include this browse node (tag), or []. */
export function boundFor(index, source, node) {
  if (!index || !source || node.kind !== 'tag') return [];
  if (source.type === 'sparkplug') {
    const scope = spScope(node.meta);
    return [
      ...(index.byKey.get(`sparkplug|${source.id}|${scope}|${node.address}`) || []),
      ...(index.wildcard.get(`sparkplug|${source.id}|${scope}`) || [])
    ];
  }
  return index.byKey.get(`${source.type}|${source.id}|${node.address}`) || [];
}

// ---- URL source param ----------------------------------------------------------------

/** "device:abc:1" -> { type: 'device', id: 'abc:1' }; null when malformed. */
export function parseSourceParam(value) {
  if (!value) return null;
  const v = String(value);
  const i = v.indexOf(':');
  if (i < 1 || i === v.length - 1) return null;
  return { type: v.slice(0, i), id: v.slice(i + 1) };
}

export const sourceKey = (s) => (s ? `${s.type}:${s.id}` : '');

export const SOURCE_GROUPS = [
  { type: 'device', label: 'Devices' },
  { type: 'opcua', label: 'OPC UA servers' },
  { type: 'sparkplug', label: 'Sparkplug (via MQTT broker)' },
  { type: 'iot', label: 'IoT devices (via MQTT broker)' },
  { type: 'mqtt', label: 'MQTT topics' }
];

export function groupSources(sources) {
  const known = new Set(SOURCE_GROUPS.map((g) => g.type));
  const groups = SOURCE_GROUPS.map((g) => ({ ...g, items: sources.filter((s) => s.type === g.type) }));
  const other = sources.filter((s) => !known.has(s.type));
  if (other.length) groups.push({ type: 'other', label: 'Other', items: other });
  return groups.filter((g) => g.items.length);
}

// ---- selection scope ------------------------------------------------------------------

/** Sparkplug bindings cover one group/edge/device scope. Returns an error message or null. */
export function sparkplugScopeError(entries) {
  const scopes = new Set(entries.map((e) => spScope(e.meta)));
  if (scopes.size > 1) {
    return `Selected metrics span ${scopes.size} Sparkplug devices. A binding covers one group/edge/device; select metrics from one device at a time.`;
  }
  return null;
}
