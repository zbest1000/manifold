// MQTT topic matching for view filters. If the query contains wildcards (+ or
// #) it is treated as an MQTT topic filter; otherwise it is a case-insensitive
// substring match. This lets users filter with patterns like
// "factory/+/temperature" or "site-a/#" as well as plain text.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const cache = new Map();

function filterToRegex(filter) {
  if (cache.has(filter)) return cache.get(filter);
  const parts = filter.split('/');
  let pattern = '^';
  parts.forEach((p, i) => {
    const last = i === parts.length - 1;
    if (p === '#') {
      // '#' matches this level and everything below (including nothing)
      pattern = pattern.replace(/\/$/, '');
      pattern += '(/.*)?';
    } else {
      pattern += (p === '+' ? '[^/]+' : escapeRe(p)) + (last ? '' : '/');
    }
  });
  pattern += '$';
  const re = new RegExp(pattern);
  cache.set(filter, re);
  return re;
}

export function isWildcard(query) {
  return /[+#]/.test(query);
}

export function topicMatches(query, topic) {
  const q = query.trim();
  if (!q) return true;
  if (isWildcard(q)) {
    try {
      return filterToRegex(q).test(topic);
    } catch {
      return false;
    }
  }
  return topic.toLowerCase().includes(q.toLowerCase());
}
