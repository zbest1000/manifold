'use strict';

/**
 * A small, safe JSONPath subset, written by hand. No script expressions, no eval, no recursion
 * operator; a selector is parsed into plain steps and walked over own properties only.
 *
 *   $                      the document
 *   $.a.b                  member access (also `.a-b`, `.$x`)
 *   $['a b']  $["a"]       bracket keys (\\ \' \" and \/ escapes)
 *   $.list[0]  $.list[-1]  array index (negative counts from the end)
 *   $.list[?(@.id=="x")]   first array element whose member equals a literal
 *                          (@.a.b chains; literal: "text", 'text', number, true, false, null)
 *
 * A filter yields the FIRST matching element. Wildcards, slices, unions and `..` are rejected
 * at parse time with a message that names the unsupported construct.
 */

const MAX_SELECTOR_LENGTH = 512;
const MAX_STEPS = 32;

class SelectorError extends Error {}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function readQuoted(src, i) {
  const q = src[i];
  let out = '';
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      const n = src[j + 1];
      if (n === undefined) break;
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      j += 2;
      continue;
    }
    if (c === q) return { value: out, end: j + 1 };
    out += c;
    j++;
  }
  throw new SelectorError('unterminated quoted string in selector');
}

function readLiteral(src, i) {
  const c = src[i];
  if (c === '"' || c === "'") return readQuoted(src, i);
  const m = /^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![A-Za-z0-9_])/.exec(src.slice(i));
  if (!m) throw new SelectorError('filter literal must be "text", a number, true, false or null');
  const t = m[1];
  const value = t === 'true' ? true : t === 'false' ? false : t === 'null' ? null : Number(t);
  return { value, end: i + t.length };
}

function parseFilter(src, i) {
  // src[i] is "?" ; expect ?(@.a.b == literal)
  let j = i + 1;
  if (src[j] !== '(') throw new SelectorError('filter must look like [?(@.field=="value")]');
  j++;
  while (src[j] === ' ') j++;
  if (src[j] !== '@') throw new SelectorError('filter must start with @');
  j++;
  const chain = [];
  for (;;) {
    if (src[j] === '.') {
      const m = /^\.([A-Za-z0-9_$-]+)/.exec(src.slice(j));
      if (!m) throw new SelectorError('filter member names may use letters, digits, _ $ and -');
      chain.push(m[1]);
      j += m[0].length;
    } else if (src[j] === '[') {
      if (src[j + 1] !== "'" && src[j + 1] !== '"') throw new SelectorError('filter brackets must hold a quoted name');
      const q = readQuoted(src, j + 1);
      if (src[q.end] !== ']') throw new SelectorError('missing ] in filter');
      chain.push(q.value);
      j = q.end + 1;
    } else break;
  }
  if (!chain.length) throw new SelectorError('filter needs a member after @, for example @.id');
  while (src[j] === ' ') j++;
  if (src.slice(j, j + 2) !== '==') throw new SelectorError('only == is supported in a filter');
  j += 2;
  while (src[j] === ' ') j++;
  const lit = readLiteral(src, j);
  j = lit.end;
  while (src[j] === ' ') j++;
  if (src[j] !== ')') throw new SelectorError('filter must end with )');
  j++;
  while (src[j] === ' ') j++;
  if (src[j] !== ']') throw new SelectorError('missing ] after filter');
  return { step: { op: 'filter', chain, equals: lit.value }, end: j + 1 };
}

/**
 * @param {string} src
 * @returns {Array<{op:'key',key:string}|{op:'index',index:number}|{op:'filter',chain:string[],equals:*}>}
 * @throws {SelectorError}
 */
function parseSelector(src) {
  if (typeof src !== 'string') throw new SelectorError('selector must be a string');
  const s = src.trim();
  if (!s) throw new SelectorError('selector is empty');
  if (s.length > MAX_SELECTOR_LENGTH) throw new SelectorError(`selector is longer than ${MAX_SELECTOR_LENGTH} characters`);
  if (s[0] !== '$') throw new SelectorError('selector must start with $');
  const steps = [];
  let i = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '.') {
      if (s[i + 1] === '.') throw new SelectorError('".." (recursive descent) is not supported');
      if (s[i + 1] === '*') throw new SelectorError('wildcards are not supported; address one value');
      const m = /^\.([\p{L}\p{N}_$-]+)/u.exec(s.slice(i));
      if (!m) throw new SelectorError(`expected a member name after "." at position ${i}`);
      steps.push({ op: 'key', key: m[1] });
      i += m[0].length;
    } else if (c === '[') {
      const n = s[i + 1];
      if (n === "'" || n === '"') {
        const q = readQuoted(s, i + 1);
        if (s[q.end] !== ']') throw new SelectorError(`missing ] at position ${q.end}`);
        steps.push({ op: 'key', key: q.value });
        i = q.end + 1;
      } else if (n === '?') {
        const f = parseFilter(s, i + 1);
        steps.push(f.step);
        i = f.end;
      } else if (n === '*') {
        throw new SelectorError('wildcards are not supported; address one value');
      } else {
        const m = /^\[(-?\d+)\]/.exec(s.slice(i));
        if (!m) throw new SelectorError(`unsupported bracket expression at position ${i} (slices, unions and scripts are not supported)`);
        const index = Number(m[1]);
        if (!Number.isSafeInteger(index)) throw new SelectorError('array index is out of range');
        steps.push({ op: 'index', index });
        i += m[0].length;
      }
    } else {
      throw new SelectorError(`unexpected "${c}" at position ${i}`);
    }
    if (steps.length > MAX_STEPS) throw new SelectorError(`selector has more than ${MAX_STEPS} steps`);
  }
  return steps;
}

const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

function chainValue(el, chain) {
  let cur = el;
  for (const k of chain) {
    if (!own(cur, k) || Array.isArray(cur)) return { found: false };
    cur = cur[k];
  }
  return { found: true, value: cur };
}

/**
 * Evaluate parsed steps against a document.
 * @returns {{found:true, value:*}|{found:false, at:string}} `at` says where the walk stopped.
 */
function evaluate(steps, doc) {
  let cur = doc;
  let where = '$';
  for (const st of steps) {
    if (st.op === 'key') {
      if (!own(cur, st.key) || Array.isArray(cur)) return { found: false, at: where };
      cur = cur[st.key];
      where += IDENT_RE.test(st.key) ? `.${st.key}` : `['${st.key}']`;
    } else if (st.op === 'index') {
      if (!Array.isArray(cur)) return { found: false, at: where };
      const idx = st.index < 0 ? cur.length + st.index : st.index;
      if (idx < 0 || idx >= cur.length) return { found: false, at: where };
      cur = cur[idx];
      where += `[${st.index}]`;
    } else {
      if (!Array.isArray(cur)) return { found: false, at: where };
      const hit = cur.find((el) => {
        const r = chainValue(el, st.chain);
        return r.found && r.value === st.equals;
      });
      if (hit === undefined) return { found: false, at: `${where}[?(...)]` };
      cur = hit;
      where += '[?(...)]';
    }
  }
  return { found: true, value: cur };
}

/** Parse once and evaluate; throws SelectorError on a bad selector. */
function select(src, doc) {
  return evaluate(parseSelector(src), doc);
}

function keyStep(k) {
  return IDENT_RE.test(k) ? `.${k}` : `['${String(k).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
}

/**
 * Flatten a document into leaf selectors with sample values, for browsing.
 * Bounded: depth, breadth per array, and total leaves.
 * @returns {{leaves:Array<{selector:string, value:*, type:'number'|'bool'|'string'|'null'}>, truncated:boolean}}
 */
function flatten(doc, { maxLeaves = 500, maxDepth = 10, maxArrayItems = 25 } = {}) {
  const leaves = [];
  let truncated = false;
  const walk = (v, sel, depth) => {
    if (leaves.length >= maxLeaves) {
      truncated = true;
      return;
    }
    if (v !== null && typeof v === 'object') {
      if (depth >= maxDepth) {
        truncated = true;
        return;
      }
      if (Array.isArray(v)) {
        if (v.length > maxArrayItems) truncated = true;
        v.slice(0, maxArrayItems).forEach((el, i) => walk(el, `${sel}[${i}]`, depth + 1));
      } else {
        for (const k of Object.keys(v)) walk(v[k], `${sel}${keyStep(k)}`, depth + 1);
      }
      return;
    }
    const type = v === null ? 'null' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : 'string';
    leaves.push({ selector: sel, value: v, type });
  };
  walk(doc, '$', 0);
  return { leaves, truncated };
}

module.exports = { parseSelector, evaluate, select, flatten, SelectorError, MAX_SELECTOR_LENGTH };
