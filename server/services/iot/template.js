'use strict';

/**
 * A tiny, safe evaluator for the value templates Home Assistant MQTT discovery configs use most.
 * It is NOT Jinja: it parses one `{{ ... }}` expression of this grammar and nothing else.
 *
 *   expr    := mul (('+' | '-') mul)*
 *   mul     := unary (('*' | '/' | '//' | '%') unary)*
 *   unary   := '-' unary | postfix
 *   postfix := primary ( '.' ident | '[' (string | int) ']' | '|' filter )*
 *   primary := 'value' | 'value_json' | number | string | '(' expr ')'
 *   filter  := 'float' ['(' number ')'] | 'int' ['(' number ')'] | 'round' ['(' int ')']
 *
 * Anything else (statements, `if`, `is defined`, function calls, other filters, states(), ...)
 * makes compile() return { supported: false, reason }: the tag is then marked "template not
 * supported" and its raw payload stays available. Nothing is ever executed: the parser builds a
 * small tree and evaluate() walks it with own-property reads only.
 */

const MAX_TEMPLATE = 512;
const MAX_TOKENS = 200;
const MAX_DEPTH = 20;

class Missing extends Error {}
class EvalError extends Error {}

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') return null; // escapes are not part of the subset
        s += src[j++];
      }
      if (j >= src.length) return null;
      out.push({ t: 'str', v: s });
      i = j + 1;
    } else if (src.startsWith('//', i)) {
      out.push({ t: 'op', v: '//' });
      i += 2;
    } else if ('+-*/%|.[]()'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
    } else return null;
    if (out.length > MAX_TOKENS) return null;
  }
  return out;
}

function parse(tokens) {
  let p = 0;
  let depth = 0;
  const peek = () => tokens[p];
  const isOp = (v) => tokens[p]?.t === 'op' && tokens[p].v === v;
  const fail = (why) => {
    throw new EvalError(why);
  };
  const enter = () => {
    if (++depth > MAX_DEPTH) fail('expression nested too deeply');
  };

  function expr() {
    enter();
    let left = mul();
    while (isOp('+') || isOp('-')) {
      const op = tokens[p++].v;
      left = { k: 'bin', op, a: left, b: mul() };
    }
    depth--;
    return left;
  }
  function mul() {
    let left = unary();
    while (isOp('*') || isOp('/') || isOp('//') || isOp('%')) {
      const op = tokens[p++].v;
      left = { k: 'bin', op, a: left, b: unary() };
    }
    return left;
  }
  function unary() {
    if (isOp('-')) {
      p++;
      enter();
      const n = { k: 'neg', a: unary() };
      depth--;
      return n;
    }
    return postfix();
  }
  function numberArg() {
    if (!isOp('(')) return undefined;
    p++;
    let sign = 1;
    if (isOp('-')) {
      p++;
      sign = -1;
    }
    const t = peek();
    if (t?.t !== 'num') fail('filter argument must be a number');
    p++;
    if (!isOp(')')) fail('filter takes one argument');
    p++;
    return sign * t.v;
  }
  function postfix() {
    let node = primary();
    for (;;) {
      if (isOp('.')) {
        p++;
        const t = peek();
        if (t?.t !== 'id' && t?.t !== 'num') fail('expected a name after "."');
        p++;
        node = { k: 'get', a: node, key: t.t === 'num' ? String(t.v) : t.v };
      } else if (isOp('[')) {
        p++;
        const t = peek();
        if (t?.t !== 'str' && !(t?.t === 'num' && Number.isInteger(t.v))) fail('only string or integer indexes are supported');
        p++;
        if (!isOp(']')) fail('expected "]"');
        p++;
        node = { k: 'get', a: node, key: t.v };
      } else if (isOp('|')) {
        p++;
        const t = peek();
        if (t?.t !== 'id' || !['float', 'int', 'round'].includes(t.v)) fail(`filter "${t?.v ?? ''}" is not supported`);
        p++;
        const arg = numberArg();
        if (t.v === 'round' && arg !== undefined && (!Number.isInteger(arg) || arg < 0 || arg > 12)) fail('round() takes a precision of 0..12');
        node = { k: 'filter', name: t.v, arg, a: node };
      } else return node;
    }
  }
  function primary() {
    const t = peek();
    if (!t) fail('unexpected end of expression');
    p++;
    if (t.t === 'num') return { k: 'lit', v: t.v };
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'id' && (t.v === 'value' || t.v === 'value_json')) return { k: t.v };
    if (t.t === 'op' && t.v === '(') {
      const e = expr();
      if (!isOp(')')) fail('expected ")"');
      p++;
      return e;
    }
    fail(`"${t.v}" is not supported`);
  }

  const tree = expr();
  if (p !== tokens.length) fail(`unexpected "${tokens[p].v}"`);
  return tree;
}

/** Compile a template string -> { supported: true, tree, usesJson } | { supported: false, reason }. */
function compile(template) {
  if (typeof template !== 'string') return { supported: false, reason: 'template is not a string' };
  if (template.length > MAX_TEMPLATE) return { supported: false, reason: 'template too long' };
  const m = /^\s*\{\{([\s\S]*)\}\}\s*$/.exec(template);
  if (!m || m[1].includes('{{') || m[1].includes('}}') || template.includes('{%')) return { supported: false, reason: 'only a single {{ expression }} is supported' };
  const tokens = tokenize(m[1]);
  if (!tokens || !tokens.length) return { supported: false, reason: 'unsupported characters in template' };
  try {
    const tree = parse(tokens);
    return { supported: true, tree, usesJson: tokens.some((t) => t.t === 'id' && t.v === 'value_json') };
  } catch (error) {
    return { supported: false, reason: error.message };
  }
}

function toFloat(v, def) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.trim()))) return Number(v.trim());
  if (def !== undefined) return def;
  throw new EvalError(`cannot convert ${JSON.stringify(v)?.slice(0, 40)} to a number`);
}

function roundHalfAway(x, n) {
  const f = 10 ** n;
  const r = Math.sign(x) * Math.round(Math.abs(x) * f + Number.EPSILON) / f;
  return Object.is(r, -0) ? 0 : r;
}

function ev(node, ctx) {
  switch (node.k) {
    case 'lit':
      return node.v;
    case 'value':
      return ctx.value;
    case 'value_json':
      if (ctx.json === undefined) throw new EvalError('payload is not JSON');
      return ctx.json;
    case 'get': {
      const base = ev(node.a, ctx);
      if (base === null || typeof base !== 'object') throw new Missing(`no "${node.key}" in the payload`);
      if (Array.isArray(base)) {
        const i = typeof node.key === 'number' ? node.key : /^\d+$/.test(node.key) ? Number(node.key) : NaN;
        if (!(i >= 0 && i < base.length)) throw new Missing(`no index ${node.key} in the payload`);
        return base[i];
      }
      if (!Object.hasOwn(base, node.key)) throw new Missing(`no "${node.key}" in the payload`);
      return base[node.key];
    }
    case 'neg':
      return -toFloat(ev(node.a, ctx));
    case 'filter': {
      const v = ev(node.a, ctx);
      if (node.name === 'float') return toFloat(v, node.arg);
      if (node.name === 'int') return Math.trunc(toFloat(v, node.arg));
      return roundHalfAway(toFloat(v), node.arg ?? 0);
    }
    case 'bin': {
      const a = ev(node.a, ctx);
      const b = ev(node.b, ctx);
      if (node.op === '+' && typeof a === 'string' && typeof b === 'string') return a + b;
      const x = toFloat(a);
      const y = toFloat(b);
      if ((node.op === '/' || node.op === '//' || node.op === '%') && y === 0) throw new EvalError('division by zero');
      if (node.op === '+') return x + y;
      if (node.op === '-') return x - y;
      if (node.op === '*') return x * y;
      if (node.op === '/') return x / y;
      if (node.op === '//') return Math.floor(x / y);
      return x - y * Math.floor(x / y);
    }
    default:
      throw new EvalError('bad template');
  }
}

/**
 * Evaluate a compiled template against a payload: raw = payload text, json = parsed payload
 * (undefined when not JSON). -> { ok: true, v } | { ok: false, missing: bool, reason }.
 */
function evaluate(compiled, raw, json) {
  if (!compiled?.supported) return { ok: false, missing: false, reason: 'template not supported' };
  try {
    const v = ev(compiled.tree, { value: raw, json });
    if (typeof v === 'number' && !Number.isFinite(v)) return { ok: false, missing: false, reason: 'template result is not a finite number' };
    return { ok: true, v };
  } catch (error) {
    if (error instanceof Missing) return { ok: false, missing: true, reason: error.message };
    if (error instanceof EvalError) return { ok: false, missing: false, reason: error.message };
    return { ok: false, missing: false, reason: 'template evaluation failed' };
  }
}

module.exports = { compile, evaluate };
