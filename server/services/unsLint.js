'use strict';

/**
 * UNS conformance lint — structural health checks for a live MQTT namespace.
 *
 * A Unified Namespace works because the hierarchy is predictable: consistent
 * naming, data only on leaves, comparable depth across branches. These checks
 * walk the observed topic trie (never the raw topic list) and report where the
 * namespace drifts from that. Rules are heuristics, not a spec — each finding
 * says what was seen and why it hurts, and the caller decides what matters.
 *
 * Cost: one DFS over the trie, O(nodes). Findings are bounded; counts are not.
 */

const MAX_FINDINGS = 300;

const RULES = {
  'empty-segment': {
    severity: 'error',
    weight: 10,
    title: 'Empty topic segment',
    why: 'A `//` in a topic almost always means a template variable failed to substitute.'
  },
  'naming-mix': {
    severity: 'warn',
    weight: 4,
    title: 'Mixed naming conventions among siblings',
    why: 'Sibling nodes mixing snake_case / camelCase / kebab-case / spaces make filters and mappings error-prone.'
  },
  'space-in-name': {
    severity: 'warn',
    weight: 3,
    title: 'Whitespace in segment name',
    why: 'Spaces in topic segments break many client libraries, URLs, and shell tooling.'
  },
  'data-on-branch': {
    severity: 'info',
    weight: 1,
    title: 'Payload published on a branch node',
    why: 'In a UNS, data belongs on leaves; a branch that also carries a payload is ambiguous to consumers.'
  },
  'deep-chain': {
    severity: 'info',
    weight: 1,
    title: 'Long single-child chain',
    why: 'Several consecutive levels with exactly one child add depth without adding information.'
  },
  'raw-address': {
    severity: 'warn',
    weight: 3,
    title: 'Topic name looks like a raw device address',
    why: 'A leaf named after a PLC address (DB10.DBD4, 40012, ns=2;s=..., Program:Main.X) ties every consumer to the device wiring; map it to a property name such as "speed".'
  },
  'depth-variance': {
    severity: 'info',
    weight: 2,
    title: 'Very uneven leaf depth',
    why: 'Leaves at wildly different depths suggest branches modeling different hierarchy schemes.'
  }
};

// Raw device address shapes: S7 (DB10.DBD4, DB1.DBX0.1), Modicon 5/6-digit
// references (0xxxx coils, 1xxxx inputs, 3xxxx input / 4xxxx holding registers),
// OPC UA node ids (ns=2;s=...), Logix program-scoped tags (Program:Main.X).
const RAW_ADDRESS_RES = [
  /^DB\d+\.DB[XBWD]\d+(\.\d+)?$/i,
  /^[0134]\d{4,5}$/,
  /^ns=\d+;/i,
  /^Program:/i
];

/** Does a topic segment look like a raw device address? */
function looksLikeRawAddress(seg) {
  const s = String(seg || '');
  return RAW_ADDRESS_RES.some((re) => re.test(s));
}

// Roots whose shape is defined by a protocol, not by an ISA-95 hierarchy:
// hierarchy-shape rules (depth-variance, deep-chain) do not apply under them.
// (`$`-prefixed roots such as $SYS are skipped by the walk altogether.)
const NON_HIERARCHY_ROOTS = new Set(['spBv1.0']);
const isHierarchyRoot = (seg) => !seg.startsWith('$') && !NON_HIERARCHY_ROOTS.has(seg);

/** Classify a segment's naming convention (coarse buckets are enough for a mix check). */
function convention(seg) {
  if (/\s/.test(seg)) return 'spaces';
  if (seg.includes('_')) return 'snake_case';
  if (seg.includes('-')) return 'kebab-case';
  if (/^[A-Z0-9]+$/.test(seg)) return 'UPPERCASE';
  if (/^[A-Z]/.test(seg)) return 'PascalCase';
  if (/[a-z][A-Z]/.test(seg)) return 'camelCase';
  return 'lowercase';
}

/**
 * Lint a topic trie. Returns { score, findings, stats, truncated }.
 * `trie` is a TopicTrie; `$`-prefixed root branches are skipped (broker
 * plumbing like $SYS is not part of the namespace).
 */
function lintTrie(trie, { maxFindings = MAX_FINDINGS } = {}) {
  const findings = [];
  const ruleCounts = {}; // rule -> total occurrences (exact even when findings truncate)
  let truncated = false;
  const add = (rule, path, detail) => {
    ruleCounts[rule] = (ruleCounts[rule] || 0) + 1;
    if (findings.length >= maxFindings) {
      truncated = true;
      return;
    }
    const def = RULES[rule];
    findings.push({ rule, severity: def.severity, title: def.title, why: def.why, path, detail });
  };

  let topicCount = 0;
  let branchCount = 0;
  let hierarchyTopics = 0; // leaf topics under ISA-95-style roots (depth-variance basis)
  let leafDepthMin = Infinity;
  let leafDepthMax = 0;

  // Iterative DFS. `chain` counts consecutive pass-through levels (exactly one
  // child, no payload) ending at this node; a chain that terminates at length
  // >= 3 is reported once, at its deepest link.
  const stack = [];
  for (const [seg, child] of trie.root.children || []) {
    if (seg.startsWith('$')) continue;
    stack.push({ node: child, seg, path: seg, depth: 1, chain: 0, hierarchy: isHierarchyRoot(seg) });
  }

  while (stack.length) {
    const { node, seg, path, depth, chain, hierarchy } = stack.pop();
    const kidCount = node.children ? node.children.size : 0;
    const isLeaf = kidCount === 0;

    if (seg === '') add('empty-segment', path, 'Segment between two consecutive slashes is empty.');
    else if (/\s/.test(seg)) add('space-in-name', path, `Segment "${seg}" contains whitespace.`);

    if (node.slot >= 0) {
      topicCount++;
      if (kidCount > 0) add('data-on-branch', path, `Topic has a payload and ${kidCount} child level(s).`);
      if (isLeaf) {
        if (looksLikeRawAddress(seg)) add('raw-address', path, `Leaf "${seg}" looks like a device address, not a property name.`);
        if (hierarchy) {
          hierarchyTopics++;
          if (depth < leafDepthMin) leafDepthMin = depth;
          if (depth > leafDepthMax) leafDepthMax = depth;
        }
      }
    }
    if (kidCount > 0) branchCount++;

    // Single-child chain accounting.
    const passThrough = kidCount === 1 && node.slot < 0;
    const chainHere = passThrough ? chain + 1 : 0;
    if (!passThrough && chain >= 3 && hierarchy) {
      add('deep-chain', path, `${chain} consecutive level(s) above this node each have exactly one child.`);
    }

    if (kidCount > 0) {
      // Naming-mix check across this node's children.
      const conventions = new Map(); // convention -> example segment
      for (const [cSeg, cNode] of node.children) {
        if (cSeg !== '') {
          const c = convention(cSeg);
          if (!conventions.has(c)) conventions.set(c, cSeg);
        }
        stack.push({
          node: cNode,
          seg: cSeg,
          path: `${path}/${cSeg}`,
          depth: depth + 1,
          chain: chainHere,
          hierarchy
        });
      }
      // 'lowercase' mixes fine with anything single-word; only flag when two or
      // more *marked* conventions coexist (snake vs kebab vs camel vs spaces...).
      const marked = [...conventions.keys()].filter((c) => c !== 'lowercase');
      if (marked.length >= 2) {
        const examples = marked.map((c) => `${c} ("${conventions.get(c)}")`).join(', ');
        add('naming-mix', path, `Children mix ${examples}.`);
      }
    }
  }

  if (hierarchyTopics > 1 && leafDepthMax - leafDepthMin > 3) {
    add(
      'depth-variance',
      '',
      `Leaf topics span depths ${leafDepthMin}–${leafDepthMax}; a spread this wide usually means branches follow different models.`
    );
  }

  // Score: start at 100, subtract per-occurrence weights (diminishing via sqrt so
  // one systemic issue repeated 500 times doesn't zero out everything else).
  let penalty = 0;
  for (const [rule, count] of Object.entries(ruleCounts)) {
    penalty += RULES[rule].weight * Math.sqrt(count);
  }
  const score = Math.max(0, Math.round(100 - penalty));

  return {
    score,
    findings,
    truncated,
    stats: {
      topics: topicCount,
      branches: branchCount,
      leafDepthMin: hierarchyTopics ? leafDepthMin : 0,
      leafDepthMax,
      byRule: ruleCounts
    }
  };
}

module.exports = { lintTrie, RULES, looksLikeRawAddress, NON_HIERARCHY_ROOTS };
