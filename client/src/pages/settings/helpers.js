/** Pure helpers for the Settings page cards. Alert rule helpers live in pages/alerts/helpers.js. */

const CONFIG_KEYS = ['historians', 'pipelines', 'models', 'recordings', 'contracts', 'bindings', 'alertRules', 'mounts'];

/** "3 pipelines, 1 historians" for the import confirmation. */
export function importSummary(cfg) {
  return CONFIG_KEYS.map((k) => (Array.isArray(cfg?.[k]) && cfg[k].length ? `${cfg[k].length} ${k}` : null))
    .filter(Boolean)
    .join(', ');
}

/** Tone of an audit entry's status: failed calls read bad, successful ones good. */
export const auditTone = (e) => (e.status >= 400 ? 'bad' : 'good');
