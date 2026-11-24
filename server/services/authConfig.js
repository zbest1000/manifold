'use strict';

/**
 * Pure helpers for the auth section of index.js (kept separate so the parsing
 * and role rules are unit-testable without booting the server).
 */

const ROLES = new Set(['admin', 'viewer']);

/**
 * Parse MANIFOLD_TOKENS: comma-separated entries `name:token[:role]`.
 *
 * Rule (documented in README):
 *  - `name` is everything before the FIRST ':'.
 *  - With two segments (`name:token`) the role defaults to `admin`.
 *  - With three or more, the role is the text after the LAST ':' and the token is
 *    everything between the first and last ':' — so a token MAY contain ':' as
 *    long as the role is written explicitly (`bot:ab:cd:viewer` -> token `ab:cd`).
 *  - The role must be exactly `admin` or `viewer`. Anything else (including a
 *    typo like `readonly`, or a ':'-containing token with no explicit role) is
 *    REJECTED — it is never silently treated as admin and never truncated.
 *
 * Returns { tokens: [{name, token, role}], errors: [string] }. Error strings name
 * the entry position and name but NEVER include the token.
 */
function parseNamedTokens(raw) {
  const tokens = [];
  const errors = [];
  const entries = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  entries.forEach((entry, i) => {
    const label = `MANIFOLD_TOKENS entry #${i + 1}`;
    const first = entry.indexOf(':');
    if (first <= 0) return errors.push(`${label}: expected name:token[:role]; entry ignored`);
    const name = entry.slice(0, first);
    const rest = entry.slice(first + 1);
    const last = rest.lastIndexOf(':');
    let token;
    let role;
    if (last === -1) {
      token = rest;
      role = 'admin';
    } else {
      token = rest.slice(0, last);
      role = rest.slice(last + 1).toLowerCase();
    }
    if (!token) return errors.push(`${label} ("${name}"): empty token; entry ignored`);
    if (!ROLES.has(role)) {
      return errors.push(
        `${label} ("${name}"): unrecognised role "${role.slice(0, 32)}" (allowed: admin, viewer; ` +
          'a token containing ":" needs an explicit role as the last segment); entry ignored'
      );
    }
    tokens.push({ name, token, role });
  });
  return { tokens, errors, configured: entries.length > 0 };
}

/**
 * POST routes (path relative to /api) that only READ — the viewer role may call
 * them. Everything else non-GET stays 403 for viewers. Add a route here only if
 * its handler cannot mutate state or reach out with side effects.
 */
const VIEWER_READ_ONLY_POSTS = [
  /^\/historians\/[^/]+\/query$/, // historian trend query
  /^\/pipelines\/preview$/, // pipeline dry-run
  /^\/mqtt\/brokers\/[^/]+\/subscriptions\/resolve$/, // wildcard -> concrete topics
  /^\/devices\/validate-tags$/, // device tag validation (no writes)
  /^\/tags\/bindings\/preview$/, // binding dry run (no publishing)
  /^\/tags\/bindings\/suggest$/, // name/context suggestions for a source (no writes)
  /^\/contracts\/infer$/, // schema inference from an observed payload
  /^\/i3x\/(related|value|history)$/ // i3X reads
];

function isViewerAllowedPost(method, apiPath) {
  if (method !== 'POST') return false;
  const p = String(apiPath || '').split('?')[0].replace(/\/+$/, '');
  return VIEWER_READ_ONLY_POSTS.some((re) => re.test(p));
}

/** May `role` perform this request? (admin: yes; viewer: reads + allowlisted POSTs.) */
function roleAllows(role, method, apiPath) {
  if (role === 'admin') return true;
  if (role !== 'viewer') return false; // unknown role: fail closed
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;
  return isViewerAllowedPost(method, apiPath);
}

module.exports = { parseNamedTokens, roleAllows, isViewerAllowedPost, VIEWER_READ_ONLY_POSTS, ROLES };
