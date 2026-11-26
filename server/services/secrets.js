'use strict';

/**
 * One shared definition of "this field name looks like a credential" and one
 * deep redaction function, used by the audit log AND the config export so the
 * two can never disagree about what is secret.
 *
 * Matches (case-insensitive, by key name): pass/passphrase/password, token,
 * secret, key (apiKey, privateKey, ...), credential(s), cert/certificate,
 * authorization, anything containing "webhook" (webhookUrl: its URL path is the
 * secret for Slack/Teams-style hooks), "community" (SNMP v1/v2c community
 * strings), plus the exact names `ca` and `pfx` (TLS material). Add new
 * credential-bearing field names HERE.
 */
const SECRET_KEY_RE = /pass|token|secret|key|credential|cert|authorization|webhook|community|^ca$|^pfx$/i;

const isSecretKey = (k) => SECRET_KEY_RE.test(String(k));

// scheme://user:password@host — strip the password (and keep the user name), wherever the URL
// sits in the text: error messages quote URLs mid-sentence ("... from a URL that includes
// credentials: http://u:p@host").
const URL_CREDS_RE = /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*):[^/\s@]*@/gi;
function stripUrlCredentials(s) {
  return typeof s === 'string' ? s.replace(URL_CREDS_RE, '$1:***@') : s;
}

/**
 * Deep copy of `value` with every secret-named field replaced by `mask`
 * (default null — what config export wants, since import then keeps the stored
 * secret) and URL passwords stripped from string values. Preserves structure
 * (arrays are not truncated). Cycles and depth beyond `maxDepth` collapse to
 * `mask` rather than leaking the raw value.
 */
// Arrays under these property names hold definitions whose `key` field is an
// identifier (device/profile tag key), not key material.
const IDENTIFIER_LISTS = new Set(['tags', 'ownTags']);

function redactSecrets(value, { mask = null, maxDepth = 12 } = {}, depth = 0, identifiers = false) {
  if (typeof value === 'string') return stripUrlCredentials(value);
  if (!value || typeof value !== 'object') return value;
  if (depth > maxDepth) return mask;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, { mask, maxDepth }, depth + 1, identifiers));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === '__proto__') continue; // never copy a prototype-rewriting key
    if (identifiers && k === 'key') {
      out[k] = typeof v === 'string' || typeof v === 'number' ? v : mask;
      continue;
    }
    out[k] =
      isSecretKey(k) && v !== null && v !== undefined && v !== ''
        ? mask
        : redactSecrets(v, { mask, maxDepth }, depth + 1, IDENTIFIER_LISTS.has(k) && Array.isArray(v));
  }
  return out;
}

module.exports = { SECRET_KEY_RE, isSecretKey, redactSecrets, stripUrlCredentials };
