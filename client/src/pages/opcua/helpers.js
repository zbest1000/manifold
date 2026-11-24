/** Pure helpers for the OPC UA page (kept free of React so they are unit-tested). */

export const ROOT = 'ns=0;i=84';

export const BLANK_FORM = {
  name: '',
  endpointUrl: 'opc.tcp://localhost:4840',
  securityMode: 'None',
  securityPolicy: 'None',
  username: '',
  password: '',
  trustServer: false
};

export const SECURITY_MODES = ['None', 'Sign', 'SignAndEncrypt'];
// Only the policies node-opcua actually supports for client connections.
export const SECURITY_POLICIES = ['None', 'Basic256Sha256', 'Aes128_Sha256_RsaOaep', 'Aes256_Sha256_RsaPss'];

/** Keep a discovered value selectable even when it's outside our curated list. */
export const withCurrent = (options, current) => (options.includes(current) ? options : [...options, current]);

/** Render an OPC UA value for display (objects are JSON, everything else String()). */
export function formatValue(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * Latest monitored value per graph node, keyed the way the graph keys OPC UA
 * nodes (`opcua:<connectionId>:<nodeId>`), for the on-node overlay.
 */
export function nodeValueMap(connectionId, values) {
  const out = {};
  for (const [nodeId, v] of Object.entries(values || {})) {
    out[`opcua:${connectionId}:${nodeId}`] = { text: formatValue(v.value) };
  }
  return out;
}

export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—');

/** Form state for editing an existing connection. Passwords are never echoed back. */
export function formFromConnection(c) {
  return {
    ...BLANK_FORM,
    name: c.name || '',
    endpointUrl: c.endpointUrl,
    securityMode: c.securityMode || 'None',
    securityPolicy: c.securityPolicy || 'None',
    username: c.username || ''
  };
}

/** Human label for a connection in prompts and aria-labels. */
export const connectionLabel = (c) => c?.name || c?.endpointUrl || c?.id || 'connection';

/** Which connection should be selected after the list changes. */
export function pickConnectionId(connections, currentId) {
  if (currentId && connections.some((c) => c.id === currentId)) return currentId;
  const firstConnected = connections.find((c) => c.status === 'connected');
  return firstConnected ? firstConnected.id : null;
}
