'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSelector, evaluate, select, flatten, SelectorError } = require('../drivers/httpjson/selector');

const doc = {
  device: { id: 'm1', 'fw-version': '1.2', 'a b': 7, 'it\'s': 'q' },
  power: { total: 12.5, phases: [{ id: 'L1', w: 4.1 }, { id: 'L2', w: 4.2 }, { id: 'L3', w: 4.2 }] },
  items: [
    { id: 'main', kwh: 100, ok: true, meta: { zone: 'a' } },
    { id: 'aux', kwh: 7, ok: false, meta: { zone: 'b' } },
    { id: 3, kwh: 1 }
  ],
  flag: false,
  nothing: null,
  $weird: 1,
  '': 'empty key'
};

const get = (sel) => select(sel, doc);

test('member access, bracket keys, indexes (including negative)', () => {
  assert.deepEqual(get('$.power.total'), { found: true, value: 12.5 });
  assert.equal(get('$.device.fw-version').value, '1.2');
  assert.equal(get("$.device['a b']").value, 7);
  assert.equal(get('$["device"]["a b"]').value, 7);
  assert.equal(get("$.device['it\\'s']").value, 'q');
  assert.equal(get('$.power.phases[1].w').value, 4.2);
  assert.equal(get('$.power.phases[-1].id').value, 'L3');
  assert.equal(get('$.$weird').value, 1);
  assert.equal(get("$['']").value, 'empty key');
  assert.equal(get('$.flag').value, false);
  assert.equal(get('$.nothing').value, null);
  assert.equal(get('$').value, doc);
});

test('equality filter on strings, numbers, booleans, null and chained members', () => {
  assert.equal(get('$.items[?(@.id=="aux")].kwh').value, 7);
  assert.equal(get("$.items[?(@.id=='main')].kwh").value, 100);
  assert.equal(get('$.items[?(@.id==3)].kwh').value, 1);
  assert.equal(get('$.items[?(@.ok==false)].id').value, 'aux');
  assert.equal(get('$.items[?(@.meta.zone == "b")].id').value, 'aux');
  assert.equal(get('$.items[?(@.id=="nope")].kwh').found, false);
  // first match wins
  assert.equal(get('$.power.phases[?(@.w==4.2)].id').value, 'L2');
});

test('misses say where the walk stopped, and never throw', () => {
  assert.deepEqual(get('$.power.nope.x'), { found: false, at: '$.power' });
  assert.deepEqual(get('$.power.phases[9]'), { found: false, at: '$.power.phases' });
  assert.deepEqual(get('$.power.total.x'), { found: false, at: '$.power.total' });
  assert.deepEqual(get('$.power[0]'), { found: false, at: '$.power' });
  assert.deepEqual(get('$.items.id'), { found: false, at: '$.items' });
  assert.equal(get('$.items[?(@.id=="x")]').found, false);
});

test('only own properties are readable (no prototype walk)', () => {
  for (const sel of ['$.constructor', '$.__proto__', '$.toString', '$.power.hasOwnProperty', "$['constructor']"]) {
    assert.equal(get(sel).found, false, sel);
  }
  const polluted = JSON.parse('{"__proto__":{"x":1},"a":1}');
  assert.equal(select('$.a', polluted).value, 1);
  assert.equal({}.x, undefined);
});

test('script expressions, wildcards, recursion, slices and unions are rejected at parse time', () => {
  const bad = [
    '', 'power.total', '$..total', '$.*', '$[*]', '$.items[*].id', '$.items[0:2]', '$.items[0,1]',
    '$.items[(@.length-1)]', '$.items[?(@.kwh>5)]', '$.items[?(@.id=="a" && @.kwh==1)]', '$.items[?(@.id=="a")', '$.items[?(@.id==)]',
    '$.items[?(@.id==foo)]', '$.items[?(process.exit())]', '$.items[?(@.id=="a"||true)]', '$.a.b(', '$.a b', '$.', '$.[0]', '$[0', "$['a]", '$.a..', '$[?(@==1)]', '$.items[?(@=="x")]',
    `$${'.a'.repeat(40)}`, `$['${'a'.repeat(600)}']`, 1, null
  ];
  for (const sel of bad) assert.throws(() => parseSelector(sel), SelectorError, String(sel).slice(0, 60));
  assert.throws(() => parseSelector('$..x'), /recursive/);
  assert.throws(() => parseSelector('$.*'), /wildcard/);
});

test('a filter is only ever compared, never executed', () => {
  // a literal that looks like code is just a string
  const d = { l: [{ n: 'process.exit()' }, { n: 'x' }] };
  assert.equal(select('$.l[?(@.n=="process.exit()")].n', d).value, 'process.exit()');
});

test('flatten: leaves with selectors that evaluate back to the same value', () => {
  const { leaves, truncated } = flatten(doc);
  assert.equal(truncated, false);
  const sels = leaves.map((l) => l.selector);
  assert.ok(sels.includes('$.power.total'));
  assert.ok(sels.includes('$.power.phases[2].id'));
  assert.ok(sels.includes("$.device['fw-version']"));
  for (const l of leaves) {
    const r = evaluate(parseSelector(l.selector), doc);
    assert.equal(r.found, true, l.selector);
    assert.equal(r.value, l.value, l.selector);
  }
  assert.deepEqual(leaves.find((l) => l.selector === '$.flag'), { selector: '$.flag', value: false, type: 'bool' });
  assert.equal(leaves.find((l) => l.selector === '$.nothing').type, 'null');
});

test('flatten is bounded in leaves, depth and array length', () => {
  const big = { a: Array.from({ length: 1000 }, (_, i) => ({ v: i })) };
  const r = flatten(big, { maxArrayItems: 5 });
  assert.equal(r.leaves.length, 5);
  assert.equal(r.truncated, true);
  const wide = Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`k${i}`, i]));
  const w = flatten(wide, { maxLeaves: 100 });
  assert.equal(w.leaves.length, 100);
  assert.equal(w.truncated, true);
  let deep = 1;
  for (let i = 0; i < 40; i++) deep = { x: deep };
  const d = flatten(deep, { maxDepth: 10 });
  assert.equal(d.leaves.length, 0);
  assert.equal(d.truncated, true);
});
