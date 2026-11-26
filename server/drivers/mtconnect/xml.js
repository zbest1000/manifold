'use strict';

/**
 * A small, tolerant XML reader for MTConnect agent documents (Devices, Streams, Error, Assets).
 *
 *  - Elements, attributes (single, double or unquoted values), text, CDATA, comments,
 *    processing instructions and DOCTYPE are understood. Namespace prefixes are dropped from
 *    element and attribute names; xmlns* and xsi:* attributes are ignored. MTConnect versions
 *    1.3 through 2.x use different namespace URIs and prefixes; the element names are what matter.
 *  - Entities: the five predefined ones and numeric references. A DOCTYPE is skipped and its
 *    entity declarations are never read, so there is no entity expansion at all.
 *  - Stray or misnested end tags are tolerated (the end tag closes the nearest open element of
 *    that name; an end tag that matches nothing is ignored).
 *  - A document that ends inside an element or a tag is an ERROR, not a partial result: a
 *    truncated /sample answer would otherwise advance the sequence cursor past observations
 *    that were never read.
 *  - Bounded: nesting depth and element count.
 *
 * Node shape: { name, attrs: {name: value}, children: [node], text: string (direct text, concatenated) }.
 */

const MAX_DEPTH = 64;
const MAX_NODES = 2_000_000;

class XmlError extends Error {}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m;
  });
}

const local = (name) => {
  const c = name.indexOf(':');
  return c < 0 ? name : name.slice(c + 1);
};

const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 13;

/**
 * @param {string} text
 * @returns {{name:string, attrs:object, children:object[], text:string}} the root element
 * @throws {XmlError} when no element is found or the document is incomplete
 */
function parseXml(text) {
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack = [];
  let root = null;
  let nodes = 0;

  const fail = (msg) => {
    throw new XmlError(msg);
  };

  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      if (stack.length) stack[stack.length - 1].text += decode(text.slice(i));
      i = n;
      break;
    }
    if (lt > i && stack.length) stack[stack.length - 1].text += decode(text.slice(i, lt));
    i = lt;
    const c1 = text[i + 1];
    if (c1 === '!') {
      if (text.startsWith('<!--', i)) {
        const e = text.indexOf('-->', i + 4);
        if (e < 0) fail('unterminated comment');
        i = e + 3;
      } else if (text.startsWith('<![CDATA[', i)) {
        const e = text.indexOf(']]>', i + 9);
        if (e < 0) fail('unterminated CDATA section');
        if (stack.length) stack[stack.length - 1].text += text.slice(i + 9, e);
        i = e + 3;
      } else {
        // DOCTYPE or another declaration: skip, honouring an internal subset in [...] and quotes.
        let depth = 0;
        let j = i + 2;
        let quote = 0;
        for (; j < n; j++) {
          const c = text.charCodeAt(j);
          if (quote) {
            if (c === quote) quote = 0;
          } else if (c === 34 || c === 39) quote = c;
          else if (c === 91) depth++;
          else if (c === 93) depth--;
          else if (c === 62 && depth <= 0) break;
        }
        if (j >= n) fail('unterminated declaration');
        i = j + 1;
      }
      continue;
    }
    if (c1 === '?') {
      const e = text.indexOf('?>', i + 2);
      if (e < 0) fail('unterminated processing instruction');
      i = e + 2;
      continue;
    }
    if (c1 === '/') {
      const e = text.indexOf('>', i + 2);
      if (e < 0) fail('unterminated end tag');
      const name = local(text.slice(i + 2, e).trim());
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      i = e + 1;
      if (!stack.length && root) break; // root closed: anything after it is ignored
      continue;
    }
    // start tag
    let j = i + 1;
    while (j < n && !isWs(text.charCodeAt(j)) && text[j] !== '/' && text[j] !== '>') j++;
    const rawName = text.slice(i + 1, j);
    if (!rawName) {
      // a lone "<" in text: treat as text
      if (stack.length) stack[stack.length - 1].text += '<';
      i += 1;
      continue;
    }
    const node = { name: local(rawName), attrs: {}, children: [], text: '' };
    let selfClose = false;
    for (;;) {
      while (j < n && isWs(text.charCodeAt(j))) j++;
      if (j >= n) fail(`unterminated start tag <${rawName}>`);
      const ch = text[j];
      if (ch === '>') {
        j++;
        break;
      }
      if (ch === '/') {
        if (text[j + 1] === '>') {
          selfClose = true;
          j += 2;
          break;
        }
        j++;
        continue;
      }
      let k = j;
      while (k < n && !isWs(text.charCodeAt(k)) && text[k] !== '=' && text[k] !== '>' && text[k] !== '/') k++;
      const an = text.slice(j, k);
      j = k;
      while (j < n && isWs(text.charCodeAt(j))) j++;
      let value = '';
      if (text[j] === '=') {
        j++;
        while (j < n && isWs(text.charCodeAt(j))) j++;
        const q = text[j];
        if (q === '"' || q === "'") {
          const e = text.indexOf(q, j + 1);
          if (e < 0) fail(`unterminated attribute value in <${rawName}>`);
          value = decode(text.slice(j + 1, e));
          j = e + 1;
        } else {
          let e = j;
          while (e < n && !isWs(text.charCodeAt(e)) && text[e] !== '>') e++;
          if (text[e - 1] === '/' && text[e] === '>') e--;
          value = decode(text.slice(j, e));
          j = e;
        }
      }
      if (an && an !== 'xmlns' && !an.startsWith('xmlns:') && !an.startsWith('xsi:')) {
        const key = local(an);
        if (!Object.prototype.hasOwnProperty.call(node.attrs, key) || !an.includes(':')) node.attrs[key] = value;
      }
    }
    i = j;
    if (++nodes > MAX_NODES) fail('document has too many elements');
    if (stack.length) stack[stack.length - 1].children.push(node);
    else if (!root) root = node;
    else continue; // a second root element is ignored
    if (!selfClose) {
      if (stack.length >= MAX_DEPTH) fail(`elements are nested deeper than ${MAX_DEPTH}`);
      stack.push(node);
    } else if (!stack.length) break;
  }
  if (!root) fail('no XML element found');
  if (stack.length) fail(`document is incomplete: <${stack[stack.length - 1].name}> was never closed`);
  return root;
}

/** Depth-first walk; `fn(node, ancestors)` returns false to skip a subtree. */
function walk(node, fn, ancestors = []) {
  if (fn(node, ancestors) === false) return;
  ancestors.push(node);
  for (const c of node.children) walk(c, fn, ancestors);
  ancestors.pop();
}

const child = (node, name) => node.children.find((c) => c.name === name);
const childrenNamed = (node, name) => node.children.filter((c) => c.name === name);

module.exports = { parseXml, walk, child, childrenNamed, XmlError, decode };
