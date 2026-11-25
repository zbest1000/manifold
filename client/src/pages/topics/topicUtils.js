export function numericFromPayload(payload) {
  if (typeof payload === 'number') return payload;
  if (typeof payload === 'string') {
    const n = Number(payload);
    return Number.isFinite(n) ? n : null;
  }
  if (payload && typeof payload === 'object') {
    for (const key of ['value', 'v', 'val', 'temperature', 'temp']) {
      if (Number.isFinite(payload[key])) return payload[key];
    }
  }
  return null;
}

export function shortText(payload) {
  if (payload == null) return '';
  if (typeof payload === 'object') return JSON.stringify(payload);
  return String(payload);
}

// Resolve a link endpoint whether it's still an id string or a d3-mutated node object.
export const endId = (e) => (e && typeof e === 'object' ? e.id : e);
