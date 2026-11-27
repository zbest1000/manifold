'use strict';

/**
 * A deliberately small selector for decoded JSON / CBOR documents.
 *
 *   temperature            member "temperature"
 *   sensors.temp.value     nested members
 *   readings[0].v          array index (non-negative)
 *   ["a.b"].c              a member whose name is quoted (double quotes, \" and \\ escapes)
 *   [2][0]                 an array of arrays
 *
 * No wildcards, filters, recursion, functions or expressions. Only own
 * properties are read, and the names __proto__, constructor and prototype are
 * refused, so a selector can never reach into the prototype chain.
 */

const MAX_LENGTH = 256;
const MAX_STEPS = 16;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PLAIN_KEY = /^[A-Za-z0-9_$@:-]+/;

class SelectorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SelectorError';
  }
}

/** @returns {({key:string}|{index:number})[]} steps */
function parse(text) {
  const s = String(text);
  if (s.length > MAX_LENGTH) throw new SelectorError(`selector is longer than ${MAX_LENGTH} characters`);
  if (hasControl(s)) throw new SelectorError('selector contains control characters');
  const steps = [];
  let i = 0;
  const key = (k) => {
    if (BAD_KEYS.has(k)) throw new SelectorError(`"${k}" is not a valid selector key`);
    steps.push({ key: k });
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '.') {
      if (i === 0 || i === s.length - 1 || s[i + 1] === '.' || s[i + 1] === '[') throw new SelectorError(`unexpected "." at position ${i}`);
      i++;
    } else if (c === '[') {
      if (s[i + 1] === '"') {
        let j = i + 2;
        let k = '';
        for (;;) {
          if (j >= s.length) throw new SelectorError('unterminated quoted key');
          if (s[j] === '\\') {
            if (j + 1 >= s.length) throw new SelectorError('unterminated quoted key');
            k += s[j + 1];
            j += 2;
          } else if (s[j] === '"') break;
          else k += s[j++];
        }
        if (s[j + 1] !== ']') throw new SelectorError('expected "]" after a quoted key');
        key(k);
        i = j + 2;
      } else {
        const m = /^\[(\d{1,9})\]/.exec(s.slice(i));
        if (!m) throw new SelectorError(`expected an array index like [0] at position ${i}`);
        steps.push({ index: Number(m[1]) });
        i += m[0].length;
      }
    } else {
      const m = PLAIN_KEY.exec(s.slice(i));
      if (!m) throw new SelectorError(`unexpected "${c}" at position ${i}`);
      key(m[0]);
      i += m[0].length;
    }
    if (steps.length > MAX_STEPS) throw new SelectorError(`selector has more than ${MAX_STEPS} steps`);
  }
  return steps;
}

function hasControl(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

/** True when `text` parses as a path selector. */
function isPath(text) {
  try {
    parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Apply a parsed selector; throws SelectorError naming the first step that is missing. */
function apply(doc, steps) {
  let cur = doc;
  let at = '';
  for (const st of steps) {
    if ('key' in st) {
      if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.hasOwn(cur, st.key)) {
        throw new SelectorError(`no member "${st.key}"${at ? ` under ${at}` : ''}`);
      }
      cur = cur[st.key];
      at += at ? `.${st.key}` : st.key;
    } else {
      if (!Array.isArray(cur) || st.index >= cur.length) {
        throw new SelectorError(`no element [${st.index}]${at ? ` under ${at}` : ''}${Array.isArray(cur) ? ` (length ${cur.length})` : ''}`);
      }
      cur = cur[st.index];
      at += `[${st.index}]`;
    }
  }
  return cur;
}

/** Selectors for every scalar leaf of a document (depth and count limited), for browsing. */
function leaves(doc, { maxLeaves = 200, maxDepth = 6 } = {}) {
  const out = [];
  const keyText = (k) => (/^[A-Za-z0-9_$@:-]+$/.test(k) ? k : `["${k.replace(/["\\]/g, '\\$&')}"]`);
  const walk = (v, path, depth) => {
    if (out.length >= maxLeaves) return;
    if (v !== null && typeof v === 'object') {
      if (depth >= maxDepth) return;
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1));
      else {
        for (const k of Object.keys(v)) {
          if (BAD_KEYS.has(k)) continue;
          const kt = keyText(k);
          walk(v[k], path ? (kt.startsWith('[') ? `${path}${kt}` : `${path}.${kt}`) : kt, depth + 1);
        }
      }
    } else if (path) out.push({ selector: path, value: v });
  };
  walk(doc, '', 0);
  return out;
}

module.exports = { parse, apply, isPath, leaves, SelectorError, MAX_LENGTH };
