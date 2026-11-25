// Labels for the server's per-mapping diagnosis (GET /api/tags/bindings `health`):
//   { state: 'publishing' | 'waiting' | 'problem' | 'disabled' | 'source-missing', reasons: [{ code, message, fix? }] }
// An older server sends no `health`: healthFallback derives the state from `status` alone.

export const HEALTH_LABEL = {
  publishing: 'Publishing',
  waiting: 'Waiting',
  problem: 'Not publishing',
  disabled: 'Disabled',
  'source-missing': 'Source missing'
};

export const HEALTH_TONE = { publishing: 'good', waiting: 'neutral', problem: 'bad', disabled: 'neutral', 'source-missing': 'bad' };

/** The diagnosis of one mapping, from the server or (older server) from its status counters. */
export function healthFallback(b, status = {}, health = {}) {
  if (health[b.id]) return health[b.id];
  const s = status[b.id] || {};
  if (b.enabled === false) return { state: 'disabled', reasons: [] };
  if (s.lastError) return { state: 'problem', reasons: [{ code: 'error', message: `Last error: ${s.lastError}` }] };
  if (s.sourceState?.state === 'online') return { state: 'publishing', reasons: [] };
  if (s.sourceState?.state === 'offline') return { state: 'problem', reasons: [{ code: 'source-offline', message: `The source is offline${s.sourceState.reason ? ` (${s.sourceState.reason})` : ''}.` }] };
  return { state: 'waiting', reasons: [] };
}

/** Sort rank for the State column: problems first. */
export const HEALTH_RANK = { 'source-missing': 0, problem: 1, waiting: 2, publishing: 3, disabled: 4 };

/** Short labels for the server's warning types (preview, save). */
export const WARNING_LABEL = {
  'raw-address': 'Raw address',
  collision: 'Collision',
  'asset-path': 'Asset path',
  'no-quality': 'No quality',
  'fields-ignored': 'Fields ignored',
  'credential-like-context': 'Looks like a credential',
  'unknown-override': 'Unknown tag',
  'disabled-missing': 'Missing tag',
  'device-context': 'Device context',
  'no-tags': 'Nothing published',
  'duplicate-name': 'Duplicate name',
  'sparkplug-context-collision': 'Sparkplug property',
  'loop-risk': 'Loop risk',
  'option-ignored': 'Option ignored'
};
