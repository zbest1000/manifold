'use strict';

/**
 * Declared namespace model validation — real governance on top of the
 * heuristic UNS lint (unsLint.js). The lint asks "does this namespace look
 * healthy in general?"; a namespace model asks "does it match the hierarchy
 * WE declared?". The user writes down their ISA-95-style topic contract —
 * one rule per level — and the live topic set is graded against it.
 *
 * Model shape (persisted in the profile store 'nsmodels' collection):
 *   {
 *     id, name,
 *     appliesTo: 'factory'            // topic prefix; '' = whole namespace
 *     levels: [                       // one entry per hierarchy level AFTER the prefix
 *       { name: 'site', rule: { kind: 'enum', values: ['plant-a', 'plant-b'] } },
 *       { name: 'area', rule: { kind: 'pattern', pattern: '^line[0-9]+$' } },
 *       { name: 'cell', rule: { kind: 'any' } }
 *     ],
 *     allowDeeper: false              // are topics deeper than the declared levels OK?
 *   }
 *
 * Semantics:
 * - Only topics under `appliesTo` are checked; everything else is out of scope.
 * - `$…` topics (e.g. $SYS) and the spBv1.0 Sparkplug namespace are exempt —
 *   system namespaces have their own structure and are not user governance.
 * - A topic conforms iff every declared level matches its rule AND the depth
 *   constraints hold: it must reach all declared levels, and may only go
 *   deeper when `allowDeeper` is set.
 * - Patterns match the WHOLE segment (compiled as ^(?:pattern)$) — 'line'
 *   silently matching 'mainline' is exactly the kind of drift a model exists
 *   to catch.
 * - One violation per topic, at the first failing level, so
 *   checked = conforming + violationsTotal always holds.
 *
 * Pure functions over a topic-string array — no trie, store, or IO coupling —
 * so the whole thing is trivially testable.
 */

const MAX_VIOLATIONS = 200;
const SPARKPLUG_ROOT = 'spBv1.0';
const RULE_KINDS = ['enum', 'pattern', 'any'];

/** Human-readable slice of an enum's values for violation reasons. */
function enumPreview(values) {
  const shown = values.slice(0, 6).join(', ');
  return values.length > 6 ? `${shown}, …` : shown;
}

/**
 * Validate + normalize a model. Returns { ok: true, model } with a cleaned
 * copy (trimmed names, normalized prefix, only known fields kept), or
 * { ok: false, error } — the error names the offending level and, for regex
 * failures, includes the bad pattern verbatim.
 */
function validateModel(raw) {
  const bad = (error) => ({ ok: false, error });
  if (!raw || typeof raw !== 'object') return bad('model body is required');
  if (typeof raw.name !== 'string' || !raw.name.trim()) return bad('name is required');

  let appliesTo = '';
  if (raw.appliesTo != null) {
    if (typeof raw.appliesTo !== 'string') return bad('appliesTo must be a string topic prefix');
    appliesTo = raw.appliesTo.trim().replace(/^\/+|\/+$/g, '');
  }

  if (!Array.isArray(raw.levels) || raw.levels.length === 0) {
    return bad('levels must be a non-empty array');
  }
  if (raw.levels.length > 32) return bad('too many levels (max 32)');

  const levels = [];
  for (let i = 0; i < raw.levels.length; i++) {
    const lvl = raw.levels[i];
    const name = typeof lvl?.name === 'string' ? lvl.name.trim() : '';
    if (!name) return bad(`level ${i + 1}: name is required`);
    const rule = lvl.rule || {};
    if (!RULE_KINDS.includes(rule.kind)) {
      return bad(`level "${name}": rule.kind must be one of ${RULE_KINDS.join(', ')}`);
    }
    if (rule.kind === 'enum') {
      const values = Array.isArray(rule.values) ? rule.values.map((v) => String(v).trim()).filter(Boolean) : [];
      if (values.length === 0) return bad(`level "${name}": enum rule needs at least one value`);
      levels.push({ name, rule: { kind: 'enum', values } });
    } else if (rule.kind === 'pattern') {
      if (typeof rule.pattern !== 'string' || !rule.pattern) {
        return bad(`level "${name}": pattern rule needs a pattern`);
      }
      try {
        // Compile exactly as evaluate() will — full-segment anchored.
        void new RegExp(`^(?:${rule.pattern})$`);
      } catch (e) {
        return bad(`level "${name}": invalid pattern "${rule.pattern}" — ${e.message}`);
      }
      levels.push({ name, rule: { kind: 'pattern', pattern: rule.pattern } });
    } else {
      levels.push({ name, rule: { kind: 'any' } });
    }
  }

  return {
    ok: true,
    model: { name: raw.name.trim(), appliesTo, levels, allowDeeper: Boolean(raw.allowDeeper) }
  };
}

/** Compile a level rule into a { test(seg), reason(seg) } matcher. */
function compileRule(level) {
  const { rule } = level;
  if (rule.kind === 'enum') {
    const set = new Set(rule.values);
    return {
      test: (seg) => set.has(seg),
      reason: (seg) => `segment "${seg}" is not one of [${enumPreview(rule.values)}]`
    };
  }
  if (rule.kind === 'pattern') {
    const re = new RegExp(`^(?:${rule.pattern})$`); // whole-segment match
    return {
      test: (seg) => re.test(seg),
      reason: (seg) => `segment "${seg}" does not match /${rule.pattern}/`
    };
  }
  return { test: () => true, reason: () => 'unreachable' };
}

/** System namespaces are exempt from governance: $SYS/$share/... and Sparkplug. */
function isExempt(topic) {
  return topic.startsWith('$') || topic === SPARKPLUG_ROOT || topic.startsWith(`${SPARKPLUG_ROOT}/`);
}

/**
 * Grade a topic list against a model. Returns:
 *   { score,            // 0-100, round(100 * conforming / checked); 100 when nothing checked
 *     checked,          // topics in scope (under appliesTo, not exempt)
 *     conforming,
 *     violations,       // [{ topic, level, reason }] first failure per topic, capped
 *     violationsTotal,  // exact (= checked - conforming) even when the list truncates
 *     truncated,
 *     perLevel }        // [{ name, failures }] exact first-failure counts per declared level
 *
 * `level` in a violation is the declared level name, or null for a
 * deeper-than-model depth violation (which belongs to no declared level).
 * Throws only on an invalid model (bad regex) — validate at save time.
 */
function evaluate(topics, model, { maxViolations = MAX_VIOLATIONS } = {}) {
  const levels = model.levels || [];
  const matchers = levels.map(compileRule);
  const prefix = (model.appliesTo || '').replace(/^\/+|\/+$/g, '');
  const prefixSegs = prefix ? prefix.split('/') : [];
  const allowDeeper = Boolean(model.allowDeeper);

  let checked = 0;
  let conforming = 0;
  const violations = [];
  let truncated = false;
  const perLevel = levels.map((l) => ({ name: l.name, failures: 0 }));

  const addViolation = (topic, levelIndex, reason) => {
    if (levelIndex >= 0) perLevel[levelIndex].failures++;
    if (violations.length >= maxViolations) {
      truncated = true;
      return;
    }
    violations.push({ topic, level: levelIndex >= 0 ? levels[levelIndex].name : null, reason });
  };

  for (const topic of topics) {
    if (isExempt(topic)) continue;
    const segs = topic.split('/');

    // Prefix scope: topic must sit at or under `appliesTo`.
    if (prefixSegs.length) {
      if (segs.length < prefixSegs.length) continue;
      let under = true;
      for (let i = 0; i < prefixSegs.length; i++) {
        if (segs[i] !== prefixSegs[i]) {
          under = false;
          break;
        }
      }
      if (!under) continue;
    }

    checked++;
    const rest = segs.slice(prefixSegs.length);

    let failed = false;
    for (let i = 0; i < levels.length; i++) {
      if (i >= rest.length) {
        addViolation(
          topic,
          i,
          `topic ends ${levels.length - rest.length} level(s) short — level "${levels[i].name}" is missing`
        );
        failed = true;
        break;
      }
      if (!matchers[i].test(rest[i])) {
        addViolation(topic, i, `${levels[i].name}: ${matchers[i].reason(rest[i])}`);
        failed = true;
        break;
      }
    }
    if (!failed && rest.length > levels.length && !allowDeeper) {
      addViolation(topic, -1, `topic is ${rest.length - levels.length} level(s) deeper than the declared model`);
      failed = true;
    }
    if (!failed) conforming++;
  }

  return {
    score: checked ? Math.round((100 * conforming) / checked) : 100,
    checked,
    conforming,
    violations,
    violationsTotal: checked - conforming,
    truncated,
    perLevel
  };
}

/**
 * Flatten a TopicTrie into concrete topic strings (nodes with a slot).
 * `$`-prefixed root branches are skipped up front — evaluate() would exempt
 * them anyway, this just avoids walking $SYS at all. Bounded for safety.
 */
function collectTopics(trie, { limit = 200000 } = {}) {
  const out = [];
  const stack = [];
  for (const [seg, child] of trie.root.children || []) {
    if (seg.startsWith('$')) continue;
    stack.push({ node: child, path: seg });
  }
  while (stack.length) {
    const { node, path } = stack.pop();
    if (node.slot >= 0) {
      if (out.length >= limit) break;
      out.push(path);
    }
    if (node.children) {
      for (const [seg, child] of node.children) {
        stack.push({ node: child, path: `${path}/${seg}` });
      }
    }
  }
  return out;
}

module.exports = { evaluate, validateModel, collectTopics, MAX_VIOLATIONS, RULE_KINDS };
