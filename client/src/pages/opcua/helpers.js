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

/** Why this connection form cannot be submitted yet, or '' when it can. */
export function formProblem(form) {
  const url = String(form.endpointUrl || '').trim();
  if (!url) return 'Endpoint URL is required';
  if (!/^opc\.tcp:\/\/[^/\s]+/i.test(url)) return 'The endpoint URL must look like opc.tcp://host:4840';
  const mode = form.securityMode || 'None';
  const policy = form.securityPolicy || 'None';
  if (mode !== 'None' && policy === 'None') return `Security mode ${mode} needs a security policy (for example Basic256Sha256)`;
  if (mode === 'None' && policy !== 'None') return `Security policy ${policy} needs a security mode of Sign or SignAndEncrypt`;
  return '';
}

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
    // A value that is not Good says so on the node too, not only in the side panel.
    const q = v.status ? qualityOf(v.status) : null;
    const text = formatValue(v.value);
    out[`opcua:${connectionId}:${nodeId}`] = { text: q && q.tone !== 'good' ? `${text} · ${q.label}` : text };
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

/** Which form field a validation message belongs to ('url' or 'security'). */
export const problemField = (message) => (/endpoint url/i.test(message || '') ? 'url' : 'security');

/**
 * What a connection's state means for the person looking at it: label, tone and a plain explanation.
 * The server retries a lost or failing connection forever with growing, jittered delays.
 */
export function connectionState(c) {
  switch (c.status) {
    case 'connected':
      return { label: 'Connected', tone: 'good', note: null };
    case 'connecting':
      return { label: 'Connecting', tone: 'warn', note: 'Opening a session.' };
    case 'reconnecting':
      return { label: 'Reconnecting', tone: 'warn', note: 'Keeps retrying with growing delays.' };
    case 'error':
      return { label: 'Failed', tone: 'bad', note: null };
    default:
      return { label: c.status || 'Unknown', tone: 'neutral', note: null };
  }
}

/** Quality word and tone for an OPC UA status string such as "Good (0x00000000)". */
export function qualityOf(status) {
  const s = String(status || '');
  if (!s || /^good/i.test(s)) return { label: 'Good', tone: 'good' };
  if (/^uncertain/i.test(s)) return { label: 'Uncertain', tone: 'warn' };
  return { label: 'Bad', tone: 'bad' };
}

/** The status code name when it says more than the quality word ("BadSensorFailure"), else null. */
export function statusDetail(status) {
  const name = String(status || '').replace(/\s*\(0x[0-9a-f]+\)\s*$/i, '').trim();
  if (!name || /^(good|bad|uncertain)$/i.test(name)) return null;
  return name;
}

/** Monitored values of a connection, limited to the nodes the server is still monitoring. */
export function activeValues(connection, values) {
  const nodes = connection?.monitoredNodes;
  if (!Array.isArray(nodes)) return values || {};
  const out = {};
  for (const nodeId of nodes) if (values?.[nodeId]) out[nodeId] = values[nodeId];
  return out;
}
