'use strict';

/**
 * CoRE Link Format (RFC 6690) parser for /.well-known/core.
 *
 *   </sensors/temp>;rt="temperature-c";if="sensor";ct=0;obs,</a>;ct="0 50";sz=1200
 *
 * Returns { links, skipped }: each link is
 *   { uri, path, query, attrs, rt: string[], if: string[], ct: number[], obs: boolean, sz?: number, title?: string }
 * Entries that are not parseable are counted in `skipped`, never thrown.
 * Parsing is a single linear scan; the number of links is capped.
 */

const MAX_LINKS = 2000;

function scan(text, sep, angle) {
  const out = [];
  let cur = '';
  let inAngle = false;
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      cur += c;
      if (c === '\\' && i + 1 < text.length) cur += text[++i];
      else if (c === '"') inQuote = false;
    } else if (inAngle) {
      cur += c;
      if (c === '>') inAngle = false;
    } else if (c === '"') {
      inQuote = true;
      cur += c;
    } else if (angle && c === '<') {
      inAngle = true;
      cur += c;
    } else if (c === sep) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function unquote(v) {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(.)/g, '$1');
  return v;
}

const words = (v) => (typeof v === 'string' ? v.split(/\s+/).filter(Boolean) : []);

function parse(text) {
  const links = [];
  let skipped = 0;
  for (const entry of scan(String(text), ',', true)) {
    if (links.length >= MAX_LINKS) {
      skipped++;
      continue;
    }
    const m = /^<([^>]*)>(.*)$/s.exec(entry);
    if (!m) {
      skipped++;
      continue;
    }
    const uri = m[1];
    const attrs = {};
    for (const p of scan(m[2], ';', false)) {
      const eq = p.indexOf('=');
      if (eq < 0) attrs[p.toLowerCase()] = true;
      else attrs[p.slice(0, eq).trim().toLowerCase()] = unquote(p.slice(eq + 1).trim());
    }
    // A resource is addressed by its path (and query); an absolute URI keeps only its path.
    let target = uri;
    const abs = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(uri);
    if (abs) target = abs[1] || '/';
    if (!target.startsWith('/')) {
      skipped++;
      continue;
    }
    const q = target.indexOf('?');
    const sz = attrs.sz !== undefined ? Number(attrs.sz) : undefined;
    links.push({
      uri,
      path: q < 0 ? target : target.slice(0, q),
      query: q < 0 ? '' : target.slice(q + 1),
      attrs,
      rt: words(attrs.rt),
      if: words(attrs.if),
      ct: words(attrs.ct)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 0),
      obs: attrs.obs !== undefined && attrs.obs !== 'false',
      ...(Number.isFinite(sz) ? { sz } : {}),
      ...(typeof attrs.title === 'string' ? { title: attrs.title } : {})
    });
  }
  return { links, skipped };
}

module.exports = { parse, MAX_LINKS };
