'use strict';

/**
 * One shared definition of "this field name looks like a credential" and one
 * deep redaction function, used by the audit log AND the config export so the
 * two can never disagree about what is secret.
 *
 * Matches (case-insensitive, by key name): pass/passphrase/password, token,
 * secret, key (apiKey, privateKey, ...), credential(s), cert/certificate,
 * authorization, anything containing "webhook" (webhookUrl: its URL path is the
 * secret for Slack/Teams-style hooks), plus the exact names `ca` and `pfx`
 * (TLS material). Add new credential-bearing field names HERE.
 */
const SECRET_KEY_RE = /pass|token|secret|key|credential|cert|authorization|webhook|^ca$|^pfx$/i;

const isSecretKey = (k) => SECRET_KEY_RE.test(String(k));

// scheme://user:password@host — strip the password (and keep the user name).
const URL_CREDS_RE = /^([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*):[^/\s@]*@/i;
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
function redactSecrets(value, { mask = null, maxDepth = 12 } = {}, depth = 0) {
  if (typeof value === 'string') return stripUrlCredentials(value);
  if (!value || typeof value !== 'object') return value;
  if (depth > maxDepth) return mask;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, { mask, maxDepth }, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === '__proto__') continue; // never copy a prototype-rewriting key
    out[k] = isSecretKey(k) && v !== null && v !== undefined && v !== '' ? mask : redactSecrets(v, { mask, maxDepth }, depth + 1);
  }
  return out;
}

module.exports = { SECRET_KEY_RE, isSecretKey, redactSecrets, stripUrlCredentials };
