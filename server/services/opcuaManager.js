const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID: uuidv4 } = require('crypto');
const {
  OPCUAClient,
  MessageSecurityMode,
  SecurityPolicy,
  AttributeIds,
  TimestampsToReturn,
  UserTokenType,
  DataType,
  VariantArrayType,
  BrowseDirection
} = require('node-opcua-client');
// node-opcua-client does not re-export the certificate manager — pull it (and
// the cert parsing helpers) from the packages it is built on.
const { OPCUACertificateManager, makeSubject } = require('node-opcua-certificate-manager');
const { exploreCertificateInfo, makeSHA1Thumbprint, readCertificate } = require('node-opcua-crypto');

const NODE_CLASS_NAMES = {
  0: 'Unspecified',
  1: 'Object',
  2: 'Variable',
  4: 'Method',
  8: 'ObjectType',
  16: 'VariableType',
  32: 'ReferenceType',
  64: 'DataType',
  128: 'View'
};

const ROOT_NODE_ID = 'ns=0;i=84';
const SERVER_STATE_NODE_ID = 'ns=0;i=2259'; // Server_ServerStatus_State
const MAX_MONITORED_ITEMS_PER_CALL_NODE_ID = 'ns=0;i=11714'; // ServerCapabilities.OperationLimits.MaxMonitoredItemsPerCall

const APPLICATION_NAME = 'Manifold';
// Must match the URI baked into the application certificate — node-opcua's
// certificate sanity check compares the two on every secure connect.
const APPLICATION_URI = 'urn:manifold:client';
const DISCOVERY_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Application PKI (lazily initialized, shared by every secure connection).
// Rooted at <MANIFOLD_DATA_DIR|server/data>/pki with the standard node-opcua
// layout: own/{certs,private}, trusted/certs, rejected/, issuers/...
// Unknown server certificates are NOT auto-accepted; they land in rejected/
// where the trust API (or a connect with trustServer:true) can promote them.
// The private key is kept owner-only (0600 in a 0700 folder).
// ---------------------------------------------------------------------------

let certificateManagerPromise = null;

function pkiRootFolder() {
  return path.join(process.env.MANIFOLD_DATA_DIR || path.join(__dirname, '..', 'data'), 'pki');
}

function clientCertificateFile(certificateManager) {
  // Same default path OPCUAClient derives when given a certificate manager.
  return path.join(certificateManager.rootDir, 'own', 'certs', 'client_certificate.pem');
}

function restrictPrivateKey(certificateManager) {
  // node-opcua-pki writes the key with the process umask (usually 0644).
  const privateDir = path.join(certificateManager.rootDir, 'own', 'private');
  try {
    fs.chmodSync(privateDir, 0o700);
    for (const file of fs.readdirSync(privateDir)) fs.chmodSync(path.join(privateDir, file), 0o600);
  } catch {
    // best effort (e.g. a filesystem without POSIX permissions)
  }
}

function getCertificateManager() {
  if (!certificateManagerPromise) {
    certificateManagerPromise = (async () => {
      const certificateManager = new OPCUACertificateManager({
        rootFolder: pkiRootFolder(),
        automaticallyAcceptUnknownCertificate: false,
        keySize: 2048 // fast to generate on first use, universally accepted
      });
      await certificateManager.initialize();
      const certificateFile = clientCertificateFile(certificateManager);
      if (!fs.existsSync(certificateFile)) {
        const hostname = os.hostname();
        await certificateManager.createSelfSignedCertificate({
          applicationUri: APPLICATION_URI,
          dns: [hostname],
          outputFile: certificateFile,
          subject: makeSubject(APPLICATION_NAME, hostname),
          startDate: new Date(),
          validity: 365 * 10
        });
      }
      restrictPrivateKey(certificateManager);
      return certificateManager;
    })();
    // A failed init (e.g. unwritable data dir) must not poison every later
    // call — drop the cached promise so the next caller retries.
    certificateManagerPromise.catch(() => {
      certificateManagerPromise = null;
    });
  }
  return certificateManagerPromise;
}

function describeCertificate(der) {
  const cert = { thumbprint: makeSHA1Thumbprint(der).toString('hex') };
  try {
    const info = exploreCertificateInfo(der);
    cert.subject = formatSubject(info.subject);
    cert.validFrom = info.notBefore || null;
    cert.validTo = info.notAfter || null;
  } catch {
    // unparsable cert — the thumbprint is still enough to identify/trust it
  }
  return cert;
}

function formatSubject(subject) {
  if (!subject) return null;
  if (typeof subject === 'string') return subject;
  const parts = Object.entries(subject)
    .filter(([, v]) => typeof v === 'string' && v.length)
    .map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(', ') : null;
}

function readCertificateFolder(folder) {
  let files;
  try {
    files = fs.readdirSync(folder);
  } catch {
    return []; // folder not created yet == empty store
  }
  const out = [];
  for (const file of files) {
    if (!/\.(pem|der|crt|cer)$/i.test(file)) continue;
    try {
      out.push({ file, ...describeCertificate(readCertificate(path.join(folder, file))) });
    } catch {
      // skip files that are not certificates
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Errors an operator can act on. node-opcua reports most failures as a status
// code name buried in a multi-line message; translate the common ones and keep
// the original code in brackets.
// ---------------------------------------------------------------------------

function statusName(message) {
  const m = /\b(Bad[A-Za-z]+|Uncertain[A-Za-z]+)\b/.exec(message);
  return m ? m[1] : null;
}

/** Validate an endpoint URL before anything is sent. Throws an actionable error. */
function checkEndpointUrl(endpointUrl) {
  if (!endpointUrl || typeof endpointUrl !== 'string') {
    throw new Error('endpointUrl is required (e.g. opc.tcp://host:4840)');
  }
  const m = /^opc\.tcp:\/\/([^/:\s]+|\[[0-9a-f:.]+\])(:(\d{1,5}))?(\/.*)?$/i.exec(endpointUrl.trim());
  if (!m || (m[3] && Number(m[3]) > 65535)) {
    throw new Error(`the endpoint URL must look like opc.tcp://host:4840 (got "${endpointUrl}") [BadTcpEndpointUrlInvalid]`);
  }
}

function explainError(error, { secure = false, endpointUrl = '', config = {} } = {}) {
  const raw = error?.message || String(error);
  if (error?.explained) return error;
  const flat = raw.replace(/\s+/g, ' ').trim();
  // 'Cannot recreate session': node-opcua's own repair is switched off (see _establish)
  const code = statusName(flat) || (/Cannot recreate session/i.test(flat) ? 'BadSessionIdInvalid' : null);
  const hostPort = (/^opc\.tcp:\/\/([^/]+)/i.exec(endpointUrl) || [])[1] || endpointUrl;
  let text = null;

  if (/server Certificate verification failed|BadCertificateUntrusted|certificate\b.*\bnot trusted/i.test(flat) && !/socket has been disconnected/i.test(flat)) {
    text =
      "the server's certificate is not trusted by Manifold — trust it under Certificates and trust, then connect again " +
      '(or tick "Trust server certificate on first connect")';
  } else if (/BadSecurityChecksFailed/i.test(flat)) {
    // Sent by the server. Since OPC UA 1.04 servers answer every certificate problem on the secure
    // channel with this one generic code so that they do not reveal which check failed; a failure of
    // *our* check of the server's certificate is raised locally and handled by the branch above.
    text =
      "the server rejected the secure channel — it most likely does not trust Manifold's client certificate: " +
      'give its administrator the certificate shown under Certificates and trust and have it trusted on the server, then connect again. ' +
      'If it is already trusted there, check that the clocks agree and the certificate has not expired (servers do not say which check failed)';
  } else if (secure && /socket has been disconnected|disconnected by third party|ECONNRESET|BadCertificate/i.test(flat)) {
    text =
      "the server closed the connection while the secure channel was being opened — it most likely does not trust Manifold's client certificate: " +
      'give its administrator the certificate shown under Certificates and trust and have it trusted on the server, then connect again';
  } else if (/BadUserAccessDenied|BadIdentityTokenRejected/i.test(flat)) {
    text = config.username
      ? `the server rejected the user name or password for "${config.username}"`
      : 'the server refused anonymous access — set a user name and password';
  } else if (/BadIdentityTokenInvalid/i.test(flat)) {
    text = config.username
      ? 'this endpoint does not accept user name / password logins — pick another endpoint with Discover'
      : 'this endpoint does not allow anonymous access — set a user name and password';
  } else if (/BadTooManySessions/i.test(flat)) {
    text = 'the server has reached its session limit — close unused sessions (or raise the limit) on the server, then retry';
  } else if (/Cannot find an Endpoint matching/i.test(flat)) {
    text = `the server offers no endpoint with security mode ${config.securityMode || 'None'} and policy ${config.securityPolicy || 'None'} — use Discover to see what it offers`;
  } else if (/BadSecurityPolicyRejected/i.test(flat)) {
    text = `the server rejected security policy ${config.securityPolicy || 'None'} — use Discover to see what it offers`;
  } else if (/BadTcpEndpointUrlInvalid/i.test(flat)) {
    text = `the server does not know the endpoint URL ${endpointUrl} — check the path after host:port (Discover lists the exact URLs)`;
  } else if (/ECONNREFUSED/i.test(flat)) {
    text = `connection refused by ${hostPort} (ECONNREFUSED) — nothing is listening on that host and port`;
  } else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(flat)) {
    text = `host not found (ENOTFOUND): ${hostPort}`;
  } else if (/EHOSTUNREACH|ENETUNREACH/i.test(flat)) {
    text = `no network route to ${hostPort} (EHOSTUNREACH)`;
  } else if (/ETIMEDOUT|timeout|timed out/i.test(flat)) {
    text = `no answer from ${hostPort} in time (timed out) — check the address, the port and any firewall in between`;
  } else if (/BadNodeIdUnknown|BadNodeIdInvalid/i.test(flat)) {
    text = 'the node does not exist on the server';
  } else if (/BadSessionIdInvalid|BadSessionClosed|Cannot recreate session/i.test(flat)) {
    text = 'the server closed the session (it timed out or was ended on the server); Manifold reconnects';
  } else if (/BadNotReadable|BadUserAccessDenied/i.test(flat)) {
    text = 'the server does not allow reading this node';
  }
  if (!text) return error instanceof Error ? error : new Error(raw);
  const out = new Error(code && !text.includes(code) ? `${text} [${code}]` : text);
  out.explained = true;
  out.cause = error;
  out.statusCode = code;
  return out;
}

function withTimeout(promise, ms, what) {
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the server did not answer the ${what} within ${Math.round(ms / 1000)} s (timed out)`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Values. node-opcua hands out 64-bit integers as [high, low] 32-bit words,
// numeric arrays as typed arrays and structures as ExtensionObjects; make all
// of them plain JSON so sockets, bindings and the UI see the same thing.
// ---------------------------------------------------------------------------

function int64ToString([high, low], unsigned) {
  const big = (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
  return (unsigned ? big : BigInt.asIntN(64, big)).toString();
}

function isWordPair(v) {
  return Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && Number.isInteger(v[1]);
}

function toPlainValue(value, dataType) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if ((dataType === DataType.Int64 || dataType === DataType.UInt64) && isWordPair(value)) {
    return int64ToString(value, dataType === DataType.UInt64);
  }
  if (Buffer.isBuffer(value)) return { type: 'buffer', base64: value.toString('base64') };
  if (ArrayBuffer.isView(value)) return Array.from(value, (v) => toPlainValue(v, dataType));
  if (Array.isArray(value)) return value.map((v) => toPlainValue(v, dataType));
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value); // NaN/Infinity are not JSON
  if (typeof value === 'object') {
    // NodeId, ExpandedNodeId, QualifiedName, StatusCode: their string form is what people read
    if (value.constructor && /^(NodeId|ExpandedNodeId|QualifiedName)$/.test(value.constructor.name)) return value.toString();
    if (value.constructor && /StatusCode/.test(value.constructor.name)) return value.name || value.toString();
    if (value.constructor && value.constructor.name === 'LocalizedText') return value.text ?? null;
    if (value.constructor && value.constructor.name === 'Variant') return toPlainValue(value.value, value.dataType);
    if (typeof value.toJSON === 'function') return normalizePlain(value.toJSON());
    return normalizePlain(value);
  }
  return value;
}

/** Deep-convert a JSON-ish object (bigints, typed arrays, buffers) to plain JSON. */
function normalizePlain(value) {
  return JSON.parse(
    JSON.stringify(value, function replacer(k, v) {
      if (typeof v === 'bigint') return v.toString();
      const raw = this[k];
      if (ArrayBuffer.isView(raw) && !Buffer.isBuffer(raw)) return Array.from(raw);
      return v;
    })
  );
}

/** A DataValue -> the value-event fields shared by read() and monitored items. */
function plainDataValue(dataValue) {
  const variant = dataValue?.value;
  const dt = variant?.dataType;
  const statusCode = dataValue?.statusCode;
  const sourceTimestamp = validTimestamp(dataValue?.sourceTimestamp);
  const serverTimestamp = validTimestamp(dataValue?.serverTimestamp);
  return {
    value: toPlainValue(variant?.value, dt),
    dataType: dt !== undefined && dt !== null ? DataType[dt] || String(dt) : null,
    arrayType: variant && variant.arrayType !== undefined ? VariantArrayType[variant.arrayType] || 'Scalar' : 'Scalar',
    status: statusCode ? statusCode.toString() : 'Good (0x00000000)',
    statusCode: statusCode && typeof statusCode.value === 'number' ? statusCode.value : null,
    sourceTimestamp,
    serverTimestamp
  };
}

// Servers without a clock send DateTime.MinValue (1601) or nothing at all.
function validTimestamp(t) {
  if (!t) return null;
  const d = t instanceof Date ? t : new Date(t);
  const ms = d.getTime();
  return Number.isFinite(ms) && ms > 86_400_000 ? d : null;
}

const BUILTIN_TYPE_NAMES = Object.fromEntries(
  Object.entries(DataType)
    .filter(([k, v]) => typeof v === 'number' && Number.isNaN(Number(k)))
    .map(([k, v]) => [v, k])
);

const DEFAULT_BACKOFF = { initialMs: 1000, maxMs: 60_000 };
const DEFAULT_FLUSH_MS = 100;
const DEFAULT_SUBSCRIPTION = {
  publishingInterval: 250,
  maxKeepAliveCount: 20, // a keep-alive at least every 5 s when nothing changes
  lifetimeCount: 120, // >= 3 x keep-alive (spec); 30 s without publish requests ends it
  maxNotificationsPerPublish: 1000 // 100 starved a few hundred fast-changing items
};

class OpcuaManager extends EventEmitter {
  /**
   * @param io socket.io server (only emit()/volatile used)
   * @param options.clientFactory (clientOptions) => client   (tests inject a fake)
   * @param options.backoff { initialMs, maxMs }               reconnect delays
   * @param options.random () => [0,1)                         jitter source
   * @param options.valueFlushMs                               socket value coalescing window
   * @param options.subscription { publishingInterval, maxKeepAliveCount, lifetimeCount, maxNotificationsPerPublish }
   * @param options.sessionTimeoutMs                           requested session timeout (default 30 s)
   * @param options.watchdogMs                                 how often silent subscriptions are checked (default 1 s)
   * @param options.operationTimeoutMs                         browse/read/monitor deadline (default 15 s)
   * @param options.browsePageSize                             references requested per browse call (default 1000)
   * @param options.maxBrowseReferences                        cap for one node's children (default 10000)
   * @param options.monitorBatchSize                           monitored items per CreateMonitoredItems call (default 500)
   *
   * Ownership: the manager alone reconnects. node-opcua's own reconnection is
   * switched off (connectionStrategy.maxRetry 0), so a lost channel, a session
   * the server closed or a subscription that went silent all end in the same
   * place: the client is disposed and a fresh client + session + subscription
   * is built by the supervisor with jittered exponential backoff.
   *
   * In-process events: 'value' (immediate) and
   * 'connection-state' { connectionId, state: 'online'|'offline', reason }.
   */
  constructor(io, options = {}) {
    super();
    this.io = io;
    this.connections = new Map(); // connectionId -> entry
    this._clientFactory = options.clientFactory || ((o) => OPCUAClient.create(o));
    this._backoff = { ...DEFAULT_BACKOFF, ...(options.backoff || {}) };
    this._random = options.random || Math.random;
    this._flushMs = options.valueFlushMs ?? DEFAULT_FLUSH_MS;
    this._subscriptionOptions = { ...DEFAULT_SUBSCRIPTION, ...(options.subscription || {}) };
    this._sessionTimeoutMs = options.sessionTimeoutMs ?? 30_000;
    this._watchdogMs = options.watchdogMs ?? 1000;
    this._operationTimeoutMs = options.operationTimeoutMs ?? 15_000;
    this._browsePageSize = options.browsePageSize ?? 1000;
    this._maxBrowseReferences = options.maxBrowseReferences ?? 10_000;
    this._monitorBatchSize = options.monitorBatchSize ?? 500;
    this._pendingValues = new Map(); // `${connectionId}\0${nodeId}` -> evt
    this._flushTimer = null;
    this._watchdogTimer = null;
  }

  // -- state / socket helpers ------------------------------------------------

  _setState(entry, state, reason) {
    if (entry.connState === state) return;
    entry.connState = state;
    this.emit('connection-state', { connectionId: entry.info.id, state, reason });
  }

  _queueValue(evt) {
    this._pendingValues.set(`${evt.connectionId}\u0000${evt.nodeId}`, evt);
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => this._flushValues(), this._flushMs);
    this._flushTimer.unref?.();
  }

  _flushValues() {
    this._flushTimer = null;
    const batch = [...this._pendingValues.values()];
    this._pendingValues.clear();
    const target = this.io.volatile || this.io;
    for (const evt of batch) target.emit('opcua-value', evt);
  }

  _dropPending(connectionId) {
    const prefix = `${connectionId}\u0000`;
    for (const key of this._pendingValues.keys()) {
      if (key.startsWith(prefix)) this._pendingValues.delete(key);
    }
  }

  _serial(entry, fn) {
    const run = entry.chain.then(fn);
    entry.chain = run.catch(() => {});
    return run;
  }

  _explain(entry, error) {
    const config = entry?.config || {};
    return explainError(error, { secure: (config.securityMode || 'None') !== 'None', endpointUrl: config.endpointUrl, config });
  }

  // -- connect / supervise ---------------------------------------------------

  /**
   * Connect. By default a failed first connect throws and nothing is kept.
   * With `{ supervise: true }` (restore of a saved connection) a failure keeps
   * the entry and retries forever with jittered exponential backoff.
   * `monitors` / `owners` (internal) carry monitored nodes over from an edited connection.
   */
  async connect(config = {}, { supervise = false, monitors = null, owners = null } = {}) {
    checkEndpointUrl(config.endpointUrl);

    const connectionId = config.id || uuidv4();
    if (this.connections.has(connectionId)) {
      throw new Error(`OPC UA connection ${connectionId} already exists`);
    }

    const info = {
      id: connectionId,
      name: config.name || config.endpointUrl,
      endpointUrl: config.endpointUrl,
      securityMode: config.securityMode || 'None',
      securityPolicy: config.securityPolicy || 'None',
      username: config.username || null,
      status: 'connecting',
      connectedAt: null,
      lastError: null,
      monitoredCount: 0
    };

    const entry = {
      config,
      client: null,
      session: null,
      subscription: null,
      info,
      monitored: new Map(), // nodeId -> ClientMonitoredItem
      // nodeId -> samplingInterval, so monitors can be rebuilt after reconnect
      monitorSpecs: new Map(monitors || []),
      // nodeId -> Set of owners ('user' = the OPC UA page / REST, 'bindings' = tag bindings): a
      // node stays monitored until its last owner lets go, so stopping a value on the page
      // never cuts the data flow of a tag binding that maps the same node.
      monitorOwners: new Map((owners || []).map(([nodeId, set]) => [nodeId, new Set(set)])),
      monitorErrors: new Map(), // nodeId -> message (failed to create on the server)
      pendingMonitors: new Map(), // nodeId -> { interval, waiters: [{ resolve, reject }] }
      flushQueued: false,
      closing: false,
      establishing: false,
      supervise,
      connState: null,
      epoch: 0,
      attempt: 0,
      retryTimer: null,
      lastPublishAt: 0,
      healing: false,
      stale: null, // { client, session, since } of the connection that dropped
      maxMonitoredPerCall: 0,
      metaCache: new Map(),
      chain: Promise.resolve()
    };
    this.connections.set(connectionId, entry);
    this.io.emit('opcua-connection-attempt', { connectionId, connection: { ...info } });

    try {
      await this._establish(entry);
      return { connectionId, status: 'connected', endpointUrl: config.endpointUrl };
    } catch (rawError) {
      const error = this._explain(entry, rawError);
      info.lastError = error.message;
      // `initial`: the first attempt of an unsupervised connect, whose HTTP caller reports the error itself.
      this.io.emit('opcua-error', { connectionId, error: error.message, initial: !supervise });
      if (supervise && !entry.closing) {
        this._setState(entry, 'offline', `connect failed: ${error.message}`);
        this._scheduleRetry(entry);
        return { connectionId, status: 'reconnecting', endpointUrl: config.endpointUrl };
      }
      info.status = 'error';
      this._setState(entry, 'offline', `connect failed: ${error.message}`);
      if (this.connections.get(connectionId) === entry) this.connections.delete(connectionId);
      throw error;
    }
  }

  async _buildClient(entry) {
    const config = entry.config;
    const securityMode = MessageSecurityMode[config.securityMode] ?? MessageSecurityMode.None;
    const securityPolicy = SecurityPolicy[config.securityPolicy] ?? SecurityPolicy.None;
    const secure = securityMode !== MessageSecurityMode.None;

    const clientOptions = {
      applicationName: APPLICATION_NAME,
      endpointMustExist: false,
      securityMode,
      securityPolicy,
      // maxRetry 0: one attempt, and no node-opcua-internal reconnection —
      // the manager's supervisor is the only owner of reconnects.
      connectionStrategy: { maxRetry: 0, initialDelay: 500, maxDelay: 1000 },
      keepSessionAlive: true,
      requestedSessionTimeout: this._sessionTimeoutMs
    };

    // Security None keeps the historical fast path (no PKI requirement). Any
    // signed/encrypted mode — or an explicit trustServer — runs through the
    // shared application PKI so the client presents our certificate and
    // verifies the server's against trusted/.
    let certificateManager = null;
    if (secure || config.trustServer === true) {
      certificateManager = await getCertificateManager();
      clientOptions.applicationUri = APPLICATION_URI;
      clientOptions.clientCertificateManager = certificateManager;
      clientOptions.certificateFile = clientCertificateFile(certificateManager);
      clientOptions.privateKeyFile = certificateManager.privateKey;
    }
    return { client: this._clientFactory(clientOptions), certificateManager, secure };
  }

  /**
   * trustServer: fetch the server's certificate over an unsecured discovery
   * channel and trust exactly that certificate before the secure connect —
   * no global "accept anything" window that a concurrent connect could use.
   */
  async _trustServerCertificate(entry, certificateManager) {
    const { config } = entry;
    const endpoints = await this._getEndpointsRaw(config.endpointUrl);
    const policyUri = SecurityPolicy[config.securityPolicy] || '';
    const wanted =
      endpoints.find(
        (e) => MessageSecurityMode[e.securityMode] === config.securityMode && e.securityPolicyUri === policyUri && e.serverCertificate?.length
      ) || endpoints.find((e) => e.serverCertificate?.length);
    if (!wanted) return;
    const status = await certificateManager.isCertificateTrusted(wanted.serverCertificate).catch(() => null);
    if (status !== 'Good') await certificateManager.trustCertificate(wanted.serverCertificate);
  }

  /** One connect attempt: new client + session, then go online. Throws on failure. */
  async _establish(entry) {
    const { info, config } = entry;
    const { client, certificateManager } = await this._buildClient(entry);
    if (entry.closing) throw new Error('connection closed');
    entry.client = client;
    entry.establishing = true;
    // Events of a client that is no longer ours (replaced, closing, or still
    // being set up — failures then travel through the promise) are ignored.
    const mine = () => entry.client === client && !entry.closing && !entry.establishing;

    client.on('connection_lost', () => {
      if (mine()) this._forceReconnect(entry, 'connection lost');
    });
    client.on('close', () => {
      if (mine()) this._forceReconnect(entry, 'connection closed');
    });

    try {
      if (certificateManager && config.trustServer === true) await this._trustServerCertificate(entry, certificateManager);
      await client.connect(config.endpointUrl);
      if (entry.closing) throw new Error('connection closed');
      if (entry.stale) await this._closeStaleSession(entry, client);
      const userIdentity = config.username
        ? { type: UserTokenType.UserName, userName: config.username, password: config.password || '' }
        : { type: UserTokenType.Anonymous };
      const session = await client.createSession(userIdentity);
      if (entry.closing) {
        await session.close?.().catch(() => {});
        throw new Error('connection closed');
      }
      entry.session = session;
      // node-opcua repairs a session the server no longer knows on its own (a
      // request answered BadSessionIdInvalid -> new session + re-created
      // subscriptions, behind our back). That fights the supervisor: the
      // repaired subscription and the one _heal() rebuilds both deliver, so
      // every value arrives twice. Its re-entrancy guard is the only switch:
      // holding it makes such a request fail, and _heal()/_forceReconnect()
      // rebuild the session the one way the manager tracks.
      if ('recursive_repair_detector' in session) session.recursive_repair_detector = 1;
      const sessionMine = () => entry.session === session && !entry.closing;
      session.on?.('session_closed', () => {
        if (sessionMine() && !entry.establishing) this._forceReconnect(entry, 'the server closed the session');
      });
      session.on?.('keepalive_failure', () => {
        if (sessionMine() && !entry.establishing) this._forceReconnect(entry, 'session keep-alive failed');
      });
      entry.maxMonitoredPerCall = await this._readMaxMonitoredPerCall(session);
    } catch (error) {
      // Detach before disconnecting so the dying client's 'close' is ignored.
      if (entry.client === client) entry.client = null;
      entry.session = null;
      await client.disconnect().catch(() => {});
      throw error;
    } finally {
      entry.establishing = false;
    }

    info.status = 'connected';
    info.connectedAt = new Date();
    info.lastError = null;
    entry.attempt = 0;
    entry.metaCache.clear();
    this.io.emit('opcua-connected', { connectionId: info.id, connection: { ...info } });
    this._ensureWatchdog();
    await this._sessionUsable(entry);
  }

  async _readMaxMonitoredPerCall(session) {
    try {
      const dv = await withTimeout(session.read({ nodeId: MAX_MONITORED_ITEMS_PER_CALL_NODE_ID, attributeId: AttributeIds.Value }), 5000, 'capability read');
      const n = Number(dv?.value?.value);
      return dv?.statusCode?.isGood?.() && Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  /** Session exists: rebuild monitors, then announce 'online'. */
  async _sessionUsable(entry) {
    const epoch = ++entry.epoch;
    await this._recoverMonitors(entry.info.id).catch((error) => {
      entry.info.lastError = `re-monitor after reconnect: ${error.message}`;
      this.io.emit('opcua-error', { connectionId: entry.info.id, error: entry.info.lastError });
    });
    if (entry.closing || entry.epoch !== epoch || !entry.session) return;
    this._setState(entry, 'online', 'connected');
  }

  /**
   * Drop the current client and let the supervisor build a new one. Every
   * failure of an established connection ends here (lost channel, session
   * closed by the server, silent subscription that a probe could not revive).
   */
  _forceReconnect(entry, reason) {
    if (entry.closing || entry.establishing) return;
    const old = entry.client;
    const oldSession = entry.session;
    entry.client = null;
    entry.session = null;
    entry.subscription = null;
    entry.monitored.clear();
    entry.metaCache.clear();
    entry.epoch++;
    entry.info.monitoredCount = entry.monitorSpecs.size;
    entry.info.lastError = reason;
    this._failPendingMonitors(entry, new Error(`OPC UA connection ${entry.info.id} is reconnecting`), true);
    if (entry.info.status !== 'reconnecting') {
      entry.info.status = 'reconnecting';
      this.io.emit('opcua-reconnecting', { connectionId: entry.info.id, reason });
    }
    this._setState(entry, 'offline', reason);
    if (old && oldSession) this._parkStale(entry, old, oldSession);
    else if (old) old.disconnect().catch(() => {});
    this._scheduleRetry(entry);
  }

  /**
   * Keep the session of a dropped connection so the next client can take it
   * over (ActivateSession on the new channel) and close it properly. Without
   * this every network blip leaves a session behind on the server until its
   * timeout, and a flapping link exhausts small session limits (PLCs often
   * allow only a handful) with BadTooManySessions.
   */
  _parkStale(entry, client, session) {
    this._disposeStale(entry);
    entry.stale = { client, session, since: Date.now() };
  }

  _disposeStale(entry) {
    const stale = entry.stale;
    entry.stale = null;
    if (stale) stale.client.disconnect().catch(() => {});
  }

  async _closeStaleSession(entry, client) {
    const stale = entry.stale;
    entry.stale = null;
    if (!stale) return;
    try {
      if (typeof client.reactivateSession === 'function' && Date.now() - stale.since < this._sessionTimeoutMs) {
        await withTimeout(client.reactivateSession(stale.session), 3000, 'session transfer');
        await withTimeout(stale.session.close(true), 3000, 'session close');
      }
    } catch {
      // the server no longer knows it (restart, timeout): nothing to clean up
    } finally {
      stale.client.disconnect().catch(() => {});
    }
  }

  _scheduleRetry(entry) {
    if (entry.closing || entry.retryTimer) return;
    const { initialMs, maxMs } = this._backoff;
    const ceiling = Math.min(maxMs, initialMs * 2 ** Math.min(entry.attempt, 30));
    const delay = Math.round(ceiling * (0.5 + this._random() * 0.5));
    entry.attempt++;
    entry.info.nextRetryAt = new Date(Date.now() + delay);
    if (entry.info.status !== 'reconnecting') {
      entry.info.status = 'reconnecting';
      this.io.emit('opcua-reconnecting', { connectionId: entry.info.id, reason: entry.info.lastError });
    }
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      this._retry(entry).catch(() => {});
    }, delay);
    entry.retryTimer.unref?.();
  }

  async _retry(entry) {
    if (entry.closing) return;
    // Dispose of the previous (dead) client; detach first so it stays silent.
    const old = entry.client;
    entry.client = null;
    if (old) await old.disconnect().catch(() => {});
    if (entry.closing) return;
    if (entry.stale && Date.now() - entry.stale.since >= this._sessionTimeoutMs) this._disposeStale(entry);
    entry.info.nextRetryAt = null;
    this.io.emit('opcua-connection-attempt', {
      connectionId: entry.info.id,
      connection: { ...entry.info }
    });
    try {
      await this._establish(entry);
    } catch (rawError) {
      const error = this._explain(entry, rawError);
      entry.info.lastError = error.message;
      if (entry.closing) return;
      this.io.emit('opcua-error', { connectionId: entry.info.id, error: error.message });
      this._setState(entry, 'offline', `connect failed: ${error.message}`);
      this._scheduleRetry(entry);
    }
  }

  // -- health watchdog -------------------------------------------------------

  _ensureWatchdog() {
    if (this._watchdogTimer || !this._watchdogMs) return;
    this._watchdogTimer = setInterval(() => this._watchdogTick(), this._watchdogMs);
    this._watchdogTimer.unref?.();
  }

  _stopWatchdogIfIdle() {
    if (this._watchdogTimer && this.connections.size === 0) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  /**
   * A subscription publishes at least a keep-alive every
   * publishingInterval x maxKeepAliveCount. When it stays silent for twice
   * that, the session or the subscription is gone on the server (session
   * timeout, subscription deleted, server-side restart of the session layer)
   * even though the TCP connection looks healthy.
   */
  _watchdogTick() {
    const now = Date.now();
    for (const entry of this.connections.values()) {
      const sub = entry.subscription;
      if (!sub || !entry.session || entry.closing || entry.healing || entry.establishing) continue;
      const interval = Number(sub.publishingInterval) || this._subscriptionOptions.publishingInterval;
      const keepAlive = Number(sub.maxKeepAliveCount) || this._subscriptionOptions.maxKeepAliveCount;
      const deadline = interval * keepAlive * 2 + 1000;
      if (now - entry.lastPublishAt > deadline) this._heal(entry, 'subscription went silent');
    }
  }

  /** Probe the session; reconnect if it is dead, rebuild the subscription if only that is gone. */
  async _heal(entry, reason) {
    if (entry.healing) return;
    entry.healing = true;
    entry.lastPublishAt = Date.now();
    const session = entry.session;
    try {
      const dv = await withTimeout(session.read({ nodeId: SERVER_STATE_NODE_ID, attributeId: AttributeIds.Value }), 5000, 'health check');
      if (entry.session !== session || entry.closing) return;
      if (dv?.statusCode && !dv.statusCode.isGood?.()) throw new Error(dv.statusCode.toString());
      entry.info.lastError = `${reason}; subscription rebuilt`;
      this.io.emit('opcua-error', { connectionId: entry.info.id, error: entry.info.lastError });
      // The session is fine: only the subscription is gone (deleted, expired) or stuck.
      // Drop it (best effort, bounded) and re-create every monitored item.
      await this._recoverMonitors(entry.info.id);
    } catch (error) {
      if (entry.session === session && !entry.closing) this._forceReconnect(entry, `${reason}: ${this._explain(entry, error).message}`);
    } finally {
      entry.healing = false;
    }
  }

  // -- discovery / PKI -------------------------------------------------------

  async _getEndpointsRaw(endpointUrl, timeoutMs = DISCOVERY_TIMEOUT_MS) {
    const client = OPCUAClient.create({
      applicationName: APPLICATION_NAME,
      endpointMustExist: false,
      securityMode: MessageSecurityMode.None,
      securityPolicy: SecurityPolicy.None,
      connectionStrategy: { maxRetry: 0, initialDelay: 500, maxDelay: 1000 }
    });
    try {
      return await withTimeout(
        (async () => {
          await client.connect(endpointUrl);
          return (await client.getEndpoints()) || [];
        })(),
        timeoutMs,
        'endpoint discovery'
      );
    } finally {
      await client.disconnect().catch(() => {});
    }
  }

  /**
   * Connect with security None, list the server's endpoints, disconnect.
   * Bounded by DISCOVERY_TIMEOUT_MS (opc.tcp — the HTTP timeout helper does
   * not apply here) so a black-holed host can't pin the request forever.
   */
  async discoverEndpoints(endpointUrl, timeoutMs = DISCOVERY_TIMEOUT_MS) {
    checkEndpointUrl(endpointUrl);
    let endpoints;
    try {
      endpoints = await this._getEndpointsRaw(endpointUrl, timeoutMs);
    } catch (error) {
      throw explainError(error, { endpointUrl });
    }
    return endpoints
      .map((endpoint) => {
        const policyUri = endpoint.securityPolicyUri || '';
        return {
          endpointUrl: endpoint.endpointUrl || null,
          securityMode: MessageSecurityMode[endpoint.securityMode] || String(endpoint.securityMode),
          securityPolicy: policyUri.includes('#') ? policyUri.split('#').pop() : policyUri,
          securityLevel: endpoint.securityLevel ?? 0,
          userIdentityTokens: (endpoint.userIdentityTokens || []).map((t) => UserTokenType[t.tokenType] || String(t.tokenType)),
          serverCertificate:
            endpoint.serverCertificate && endpoint.serverCertificate.length ? describeCertificate(endpoint.serverCertificate) : null
        };
      })
      .sort((a, b) => b.securityLevel - a.securityLevel);
  }

  /** The application certificate (PEM + parsed details), creating it if needed. */
  async getApplicationCertificate() {
    const certificateManager = await getCertificateManager();
    const certificateFile = clientCertificateFile(certificateManager);
    return {
      applicationUri: APPLICATION_URI,
      pkiFolder: certificateManager.rootDir,
      pem: fs.readFileSync(certificateFile, 'utf8'),
      ...describeCertificate(readCertificate(certificateFile))
    };
  }

  /** Trusted + rejected server certificates currently in the PKI store. */
  async listTrust() {
    const certificateManager = await getCertificateManager();
    return {
      trusted: readCertificateFolder(certificateManager.trustedFolder),
      rejected: readCertificateFolder(certificateManager.rejectedFolder)
    };
  }

  /**
   * Promote a rejected server certificate (by SHA1 thumbprint) to trusted.
   * Returns the certificate description, or null if no rejected certificate
   * matches the thumbprint.
   */
  async trustCertificate(thumbprint) {
    const certificateManager = await getCertificateManager();
    const wanted = String(thumbprint).toLowerCase();
    let files;
    try {
      files = fs.readdirSync(certificateManager.rejectedFolder);
    } catch {
      return null;
    }
    for (const file of files) {
      if (!/\.(pem|der|crt|cer)$/i.test(file)) continue;
      const filePath = path.join(certificateManager.rejectedFolder, file);
      let der;
      try {
        der = readCertificate(filePath);
      } catch {
        continue;
      }
      if (makeSHA1Thumbprint(der).toString('hex').toLowerCase() !== wanted) continue;
      await certificateManager.trustCertificate(der); // moves rejected/ -> trusted/certs
      // If the manager's index knew the cert under a different (canonical)
      // filename, our on-disk copy survives the move — drop it so the same
      // thumbprint never shows up as both trusted and rejected.
      fs.rmSync(filePath, { force: true });
      // Connections waiting for this trust retry now instead of after their backoff.
      for (const entry of this.connections.values()) {
        if (entry.retryTimer && /not trusted|security checks/i.test(entry.info.lastError || '')) {
          clearTimeout(entry.retryTimer);
          entry.retryTimer = null;
          entry.attempt = 0;
          this._retry(entry).catch(() => {});
        }
      }
      return describeCertificate(der);
    }
    return null;
  }

  // -- address space ---------------------------------------------------------

  requireSession(connectionId) {
    const entry = this.connections.get(connectionId);
    if (!entry) throw new Error(`Unknown OPC UA connection ${connectionId}`);
    if (!entry.session) {
      throw new Error(`OPC UA connection ${connectionId} is not established (${entry.info.status}${entry.info.lastError ? `: ${entry.info.lastError}` : ''})`);
    }
    return entry;
  }

  /**
   * Children of a node (forward hierarchical references). Follows browse
   * continuation points, so a folder larger than one server page is listed
   * completely (up to maxBrowseReferences, then `truncated`).
   */
  async browse(connectionId, nodeId = ROOT_NODE_ID) {
    const entry = this.requireSession(connectionId);
    const session = entry.session;
    const refs = [];
    let truncated = false;
    try {
      await withTimeout(
        (async () => {
          session.requestedMaxReferencesPerNode = this._browsePageSize;
          let result = await session.browse({
            nodeId,
            referenceTypeId: 'HierarchicalReferences',
            includeSubtypes: true,
            browseDirection: BrowseDirection.Forward,
            nodeClassMask: 0,
            resultMask: 63
          });
          if (result.statusCode && !result.statusCode.isGood()) throw new Error(result.statusCode.toString());
          refs.push(...(result.references || []));
          while (result.continuationPoint && result.continuationPoint.length) {
            if (refs.length >= this._maxBrowseReferences) {
              truncated = true;
              await session.browseNext(result.continuationPoint, true).catch(() => {});
              break;
            }
            result = await session.browseNext(result.continuationPoint, false);
            if (result.statusCode && !result.statusCode.isGood()) throw new Error(result.statusCode.toString());
            refs.push(...(result.references || []));
          }
        })(),
        this._operationTimeoutMs,
        'browse'
      );
    } catch (error) {
      throw this._explain(entry, error);
    }

    const references = refs.slice(0, this._maxBrowseReferences).map((ref) => ({
      nodeId: ref.nodeId.toString(),
      browseName: ref.browseName.toString(),
      displayName: ref.displayName?.text || ref.browseName.name,
      nodeClass: NODE_CLASS_NAMES[ref.nodeClass] || String(ref.nodeClass),
      typeDefinition: ref.typeDefinition?.toString() || null,
      isForward: ref.isForward
    }));

    return truncated ? { nodeId, references, truncated: true } : { nodeId, references };
  }

  /**
   * Children of MANY nodes in one BrowseRequest per chunk of `chunk` nodes (instead of one
   * request per node), at most `maxPerNode` references each (continuation points are released,
   * not followed: a bounded overview, not a complete listing). Returns Map(nodeId -> { references,
   * truncated }) in the shape browse() uses; a node the server refuses maps to { references: [], error }.
   */
  async browseMany(connectionId, nodeIds, { maxPerNode = 50, chunk = 32 } = {}) {
    const entry = this.requireSession(connectionId);
    const session = entry.session;
    const out = new Map();
    for (let i = 0; i < nodeIds.length; i += chunk) {
      const part = nodeIds.slice(i, i + chunk);
      let results;
      try {
        results = await withTimeout(
          (async () => {
            session.requestedMaxReferencesPerNode = maxPerNode;
            try {
              return await session.browse(
                part.map((nodeId) => ({ nodeId, referenceTypeId: 'HierarchicalReferences', includeSubtypes: true, browseDirection: BrowseDirection.Forward, nodeClassMask: 0, resultMask: 63 }))
              );
            } finally {
              session.requestedMaxReferencesPerNode = this._browsePageSize;
            }
          })(),
          this._operationTimeoutMs,
          'browse'
        );
      } catch (error) {
        throw this._explain(entry, error);
      }
      const release = [];
      part.forEach((nodeId, j) => {
        const r = results[j];
        if (!r || (r.statusCode && !r.statusCode.isGood())) {
          out.set(nodeId, { references: [], error: r?.statusCode?.toString() || 'no result' });
          return;
        }
        const cp = r.continuationPoint && r.continuationPoint.length ? r.continuationPoint : null;
        if (cp) release.push(cp);
        out.set(nodeId, {
          references: (r.references || [])
            .filter((ref) => ref.isForward !== false)
            .slice(0, maxPerNode)
            .map((ref) => ({
              nodeId: ref.nodeId.toString(),
              browseName: ref.browseName.toString(),
              displayName: ref.displayName?.text || ref.browseName.name,
              nodeClass: NODE_CLASS_NAMES[ref.nodeClass] || String(ref.nodeClass),
              typeDefinition: ref.typeDefinition?.toString() || null
            })),
          truncated: Boolean(cp)
        });
      });
      // Free the server-side continuation points we will not follow (servers hold only a few per session).
      for (const cp of release) await session.browseNext(cp, true).catch(() => {});
    }
    return out;
  }

  async _dataTypeName(session, dataTypeNodeId) {
    if (!dataTypeNodeId) return null;
    if (dataTypeNodeId.namespace === 0 && BUILTIN_TYPE_NAMES[dataTypeNodeId.value]) return BUILTIN_TYPE_NAMES[dataTypeNodeId.value];
    try {
      const dv = await session.read({ nodeId: dataTypeNodeId, attributeId: AttributeIds.BrowseName });
      return dv?.value?.value?.name || dataTypeNodeId.toString();
    } catch {
      return dataTypeNodeId.toString();
    }
  }

  async read(connectionId, nodeId) {
    const entry = this.requireSession(connectionId);
    const session = entry.session;
    const attributes = [
      ['displayName', AttributeIds.DisplayName],
      ['browseName', AttributeIds.BrowseName],
      ['nodeClass', AttributeIds.NodeClass],
      ['description', AttributeIds.Description],
      ['dataType', AttributeIds.DataType],
      ['value', AttributeIds.Value],
      ['accessLevel', AttributeIds.AccessLevel],
      ['valueRank', AttributeIds.ValueRank]
    ];

    let results;
    try {
      results = await withTimeout(session.read(attributes.map(([, attributeId]) => ({ nodeId, attributeId }))), this._operationTimeoutMs, 'read');
    } catch (error) {
      throw this._explain(entry, error);
    }
    if (results[2]?.statusCode && /BadNodeIdUnknown|BadNodeIdInvalid/.test(results[2].statusCode.toString())) {
      throw this._explain(entry, new Error(`${results[2].statusCode.toString()} ${nodeId}`));
    }

    const out = { nodeId };
    for (let i = 0; i < attributes.length; i++) {
      const [key] = attributes[i];
      const dv = results[i];
      if (!dv.statusCode.isGood()) continue;
      let value = dv.value?.value;
      if (key === 'nodeClass') value = NODE_CLASS_NAMES[value] || value;
      else if (key === 'displayName' || key === 'description') value = value?.text ?? null;
      else if (key === 'browseName') value = value?.toString() ?? null;
      else if (key === 'dataType') {
        out.dataTypeId = value?.toString() ?? null;
        value = await this._dataTypeName(session, value);
      } else if (key === 'value') value = toPlainValue(value, dv.value?.dataType);
      out[key] = value;
    }

    const valueDv = results[5];
    out.valueStatus = valueDv.statusCode.toString();
    out.sourceTimestamp = validTimestamp(valueDv.sourceTimestamp);
    out.serverTimestamp = validTimestamp(valueDv.serverTimestamp);
    if (out.nodeClass === 'Variable') {
      const meta = await this.describeNode(connectionId, nodeId).catch(() => null);
      if (meta?.unit) out.engineeringUnits = meta.engineeringUnits;
      if (meta?.range) out.euRange = meta.range;
    }
    return out;
  }

  /**
   * Metadata a binding can use for a variable: { type, unit, range, description }.
   * `unit` comes from the EngineeringUnits property (EUInformation.displayName),
   * `range` from EURange. Cached per session.
   */
  async describeNode(connectionId, nodeId) {
    const entry = this.requireSession(connectionId);
    if (entry.metaCache.has(nodeId)) return entry.metaCache.get(nodeId);
    const session = entry.session;
    const meta = { type: null, unit: null, range: null, description: null };
    const props = await withTimeout(
      session.browse({ nodeId, referenceTypeId: 'HasProperty', includeSubtypes: true, browseDirection: BrowseDirection.Forward, nodeClassMask: 0, resultMask: 63 }),
      this._operationTimeoutMs,
      'browse'
    );
    const byName = new Map((props.references || []).map((r) => [r.browseName.name, r.nodeId]));
    const reads = [
      { nodeId, attributeId: AttributeIds.DataType },
      { nodeId, attributeId: AttributeIds.Description }
    ];
    if (byName.has('EngineeringUnits')) reads.push({ nodeId: byName.get('EngineeringUnits'), attributeId: AttributeIds.Value });
    if (byName.has('EURange')) reads.push({ nodeId: byName.get('EURange'), attributeId: AttributeIds.Value });
    const dvs = await withTimeout(session.read(reads), this._operationTimeoutMs, 'read');
    if (dvs[0]?.statusCode?.isGood()) meta.type = await this._dataTypeName(session, dvs[0].value.value);
    if (dvs[1]?.statusCode?.isGood()) meta.description = dvs[1].value.value?.text || null;
    let i = 2;
    if (byName.has('EngineeringUnits')) {
      const eu = dvs[i++]?.value?.value;
      if (eu) {
        meta.unit = eu.displayName?.text || eu.description?.text || null;
        meta.engineeringUnits = { displayName: eu.displayName?.text || null, description: eu.description?.text || null, unitId: eu.unitId ?? null, namespaceUri: eu.namespaceUri || null };
      }
    }
    if (byName.has('EURange')) {
      const r = dvs[i]?.value?.value;
      if (r && Number.isFinite(r.low) && Number.isFinite(r.high)) meta.range = { low: r.low, high: r.high };
    }
    entry.metaCache.set(nodeId, meta);
    return meta;
  }

  // -- monitoring ------------------------------------------------------------

  /**
   * Monitor a node. Idempotent (re-monitoring resolves as already-monitored)
   * and batched: calls made while a CreateMonitoredItems request is in flight
   * (or in the same tick) are sent together, so 500 tags cost one round trip,
   * not 500. While the connection is reconnecting the node is recorded and
   * created on the next session (status 'pending').
   */
  async monitor(connectionId, nodeId, samplingInterval = 500, { owner = 'user' } = {}) {
    const entry = this.connections.get(connectionId);
    if (!entry) throw new Error(`Unknown OPC UA connection ${connectionId}`);
    if (!nodeId || typeof nodeId !== 'string') throw new Error('nodeId is required');
    if (!entry.monitorOwners.has(nodeId)) entry.monitorOwners.set(nodeId, new Set());
    entry.monitorOwners.get(nodeId).add(owner);
    const interval = Number.isFinite(Number(samplingInterval)) && Number(samplingInterval) >= 0 ? Number(samplingInterval) : 500;
    if (entry.monitored.has(nodeId)) return { connectionId, nodeId, status: 'already-monitored' };
    if (!entry.session) {
      if (entry.closing) throw new Error(`OPC UA connection ${connectionId} is not established`);
      entry.monitorSpecs.set(nodeId, interval);
      entry.info.monitoredCount = entry.monitorSpecs.size;
      return { connectionId, nodeId, status: 'pending', samplingInterval: interval };
    }
    return new Promise((resolve, reject) => {
      const pending = entry.pendingMonitors.get(nodeId);
      if (pending) pending.waiters.push({ resolve, reject });
      else entry.pendingMonitors.set(nodeId, { interval, waiters: [{ resolve, reject }] });
      this._queueMonitorFlush(entry);
    });
  }

  _queueMonitorFlush(entry) {
    if (entry.flushQueued) return;
    entry.flushQueued = true;
    setImmediate(() => {
      this._serial(entry, async () => {
        entry.flushQueued = false;
        const batch = new Map(entry.pendingMonitors);
        entry.pendingMonitors.clear();
        if (batch.size) await this._createMonitors(entry, batch);
      });
    });
  }

  _failPendingMonitors(entry, error, keepSpecs) {
    for (const [nodeId, p] of entry.pendingMonitors) {
      if (keepSpecs) entry.monitorSpecs.set(nodeId, p.interval);
      for (const w of p.waiters) {
        if (keepSpecs) w.resolve({ connectionId: entry.info.id, nodeId, status: 'pending', samplingInterval: p.interval });
        else w.reject(error);
      }
    }
    entry.pendingMonitors.clear();
  }

  async _ensureSubscription(entry) {
    if (entry.subscription) return entry.subscription;
    const o = this._subscriptionOptions;
    const subscription = await entry.session.createSubscription2({
      requestedPublishingInterval: o.publishingInterval,
      requestedLifetimeCount: o.lifetimeCount,
      requestedMaxKeepAliveCount: o.maxKeepAliveCount,
      maxNotificationsPerPublish: o.maxNotificationsPerPublish,
      publishingEnabled: true,
      priority: 10
    });
    entry.subscription = subscription;
    entry.lastPublishAt = Date.now();
    const alive = () => {
      if (entry.subscription === subscription) entry.lastPublishAt = Date.now();
    };
    subscription.on?.('keepalive', alive);
    subscription.on?.('received_notifications', alive);
    subscription.on?.('status_changed', (status) => {
      // BadTimeout: the subscription expired on the server (lifetime reached)
      if (entry.subscription === subscription && status && !status.isGood?.()) this._heal(entry, `subscription ended by the server (${status.toString()})`);
    });
    subscription.on?.('terminated', () => {
      if (entry.subscription === subscription && !entry.closing && entry.session) this._heal(entry, 'subscription terminated');
    });
    return subscription;
  }

  /**
   * Create monitored items for a batch { nodeId -> { interval, waiters } }:
   * one CreateMonitoredItems call per (sampling interval, chunk). A node the
   * server refuses (unknown node id, not readable...) rejects its waiters and
   * is not kept.
   */
  async _createMonitors(entry, batch) {
    const connectionId = entry.info.id;
    const epoch = entry.epoch;
    // The first waiter of a node gets the result; concurrent duplicates of a
    // successful monitor see 'already-monitored', like a later call would.
    const settle = (nodeId, ok, value) => {
      (batch.get(nodeId)?.waiters || []).forEach((w, i) => {
        if (!ok) w.reject(value);
        else w.resolve(i > 0 && value.status === 'monitoring' ? { connectionId, nodeId, status: 'already-monitored' } : value);
      });
    };
    const todo = [];
    for (const [nodeId, p] of batch) {
      if (entry.monitored.has(nodeId)) settle(nodeId, true, { connectionId, nodeId, status: 'already-monitored' });
      else todo.push([nodeId, p.interval]);
    }
    if (!todo.length) return;
    if (!entry.session || entry.closing) {
      const err = new Error(`OPC UA connection ${connectionId} is not established`);
      for (const [nodeId, interval] of todo) {
        if (!entry.closing) entry.monitorSpecs.set(nodeId, interval);
        settle(nodeId, !entry.closing, entry.closing ? err : { connectionId, nodeId, status: 'pending', samplingInterval: interval });
      }
      return;
    }

    let subscription;
    try {
      subscription = await withTimeout(this._ensureSubscription(entry), this._operationTimeoutMs, 'subscription request');
    } catch (rawError) {
      const error = this._explain(entry, rawError);
      for (const [nodeId, interval] of todo) {
        entry.monitorSpecs.set(nodeId, interval); // retried on the next session
        settle(nodeId, false, error);
      }
      throw error;
    }

    const byInterval = new Map();
    for (const [nodeId, interval] of todo) {
      if (!byInterval.has(interval)) byInterval.set(interval, []);
      byInterval.get(interval).push(nodeId);
    }
    const chunk = Math.max(1, Math.min(this._monitorBatchSize, entry.maxMonitoredPerCall || Infinity));
    for (const [interval, nodeIds] of byInterval) {
      for (let i = 0; i < nodeIds.length; i += chunk) {
        const part = nodeIds.slice(i, i + chunk);
        let items;
        try {
          items = await withTimeout(this._monitorItems(subscription, part, interval), this._operationTimeoutMs, 'monitor request');
        } catch (rawError) {
          const error = this._explain(entry, rawError);
          for (const nodeId of part) {
            entry.monitorSpecs.set(nodeId, interval);
            settle(nodeId, false, error);
          }
          continue;
        }
        if (entry.epoch !== epoch || entry.subscription !== subscription) {
          // the session went away while we were creating: keep specs, the next session recreates them
          for (const nodeId of part) {
            entry.monitorSpecs.set(nodeId, interval);
            settle(nodeId, true, { connectionId, nodeId, status: 'pending', samplingInterval: interval });
          }
          continue;
        }
        part.forEach((nodeId, k) => this._adoptItem(entry, nodeId, interval, items[k], settle));
      }
    }
    entry.info.monitoredCount = entry.monitorSpecs.size;
  }

  async _monitorItems(subscription, nodeIds, interval) {
    if (typeof subscription.monitorItems !== 'function') {
      // single-item API (older clients, test fakes)
      const out = [];
      for (const nodeId of nodeIds) {
        out.push(await subscription.monitor({ nodeId, attributeId: AttributeIds.Value }, { samplingInterval: interval, discardOldest: true, queueSize: 10 }, TimestampsToReturn.Both));
      }
      return out;
    }
    const group = await subscription.monitorItems(
      nodeIds.map((nodeId) => ({ nodeId, attributeId: AttributeIds.Value })),
      { samplingInterval: interval, discardOldest: true, queueSize: 10 },
      TimestampsToReturn.Both
    );
    return group.monitoredItems;
  }

  _adoptItem(entry, nodeId, interval, item, settle) {
    const connectionId = entry.info.id;
    const status = item?.statusCode;
    if (status && typeof status.isGood === 'function' && !status.isGood()) {
      const error = this._explain(entry, new Error(`${status.toString()} ${nodeId}`));
      entry.monitorSpecs.delete(nodeId);
      entry.monitorOwners.delete(nodeId);
      entry.monitorErrors.set(nodeId, error.message);
      this.io.emit('opcua-error', { connectionId, nodeId, error: `monitor ${nodeId}: ${error.message}` });
      settle(nodeId, false, error);
      return;
    }
    item.on('changed', (dataValue) => {
      if (entry.monitored.get(nodeId) !== item) return; // replaced or removed
      const evt = { connectionId, nodeId, ...plainDataValue(dataValue) };
      // Socket clients get the latest value per node, coalesced (see _flushValues);
      // the in-process tap (tag binding engine) stays immediate.
      this._queueValue(evt);
      this.emit('value', evt);
    });
    entry.monitored.set(nodeId, item);
    entry.monitorSpecs.set(nodeId, interval);
    entry.monitorErrors.delete(nodeId);
    const revised = Number(item.monitoringParameters?.samplingInterval);
    const samplingInterval = Number.isFinite(revised) ? revised : interval;
    this.io.emit('opcua-monitor-started', { connectionId, nodeId, samplingInterval });
    settle(nodeId, true, { connectionId, nodeId, status: 'monitoring', samplingInterval });
  }

  /**
   * Rebuild the subscription and every monitored item on a fresh session.
   * Deterministic over clever: any previous subscription is dropped and each
   * recorded (nodeId, interval) is re-created, batched like monitor().
   */
  async _recoverMonitors(connectionId) {
    const entry = this.connections.get(connectionId);
    if (!entry) return;
    return this._serial(entry, async () => {
      if (entry.subscription) {
        const old = entry.subscription;
        entry.subscription = null;
        await withTimeout(old.terminate(), 2000, 'subscription delete').catch(() => {});
      }
      entry.monitored.clear();
      if (entry.monitorSpecs.size === 0) return;
      const batch = new Map([...entry.monitorSpecs].map(([nodeId, interval]) => [nodeId, { interval, waiters: [] }]));
      entry.monitorSpecs.clear();
      await this._createMonitors(entry, batch);
      if (entry.monitorErrors.size) {
        const [nodeId, message] = entry.monitorErrors.entries().next().value;
        entry.info.lastError = `re-monitor ${nodeId}: ${message}`;
      }
    });
  }

  /**
   * Stop monitoring a node for `owner`. The monitored item is deleted only when
   * no other owner (e.g. a tag binding) still needs it; then the result is
   * { status: 'still-monitored', owners }.
   */
  async unmonitor(connectionId, nodeId, { owner = 'user' } = {}) {
    const entry = this.connections.get(connectionId);
    if (!entry) throw new Error(`Unknown OPC UA connection ${connectionId}`);
    const owners = entry.monitorOwners.get(nodeId);
    if (owners) {
      owners.delete(owner);
      if (owners.size > 0) {
        this.io.emit('opcua-monitor-stopped', { connectionId, nodeId, owners: [...owners] });
        return { connectionId, nodeId, status: 'still-monitored', owners: [...owners] };
      }
      entry.monitorOwners.delete(nodeId);
    }
    await this._serial(entry, async () => {
      const item = entry.monitored.get(nodeId);
      entry.monitored.delete(nodeId);
      entry.monitorSpecs.delete(nodeId);
      entry.monitorErrors.delete(nodeId);
      entry.info.monitoredCount = entry.monitorSpecs.size;
      if (item && entry.session) await withTimeout(item.terminate(), this._operationTimeoutMs, 'unmonitor').catch(() => {});
      this._pendingValues.delete(`${connectionId}\u0000${nodeId}`);
    });
    this.io.emit('opcua-monitor-stopped', { connectionId, nodeId });
    return { connectionId, nodeId, status: 'stopped' };
  }

  /**
   * Update a saved endpoint in place: validate first (a bad body must not kill
   * a live session), close the existing session, then connect again under the
   * SAME id with the same monitored nodes. If the new settings fail, the old
   * connection is restored (supervised) and the error is thrown.
   */
  async updateConnection(connectionId, config = {}) {
    checkEndpointUrl(config.endpointUrl);
    const old = this.connections.get(connectionId);
    const oldConfig = old ? old.config : null;
    const monitors = old ? [...old.monitorSpecs] : [];
    const owners = old ? [...old.monitorOwners].map(([nodeId, set]) => [nodeId, [...set]]) : [];
    if (old) await this.disconnect(connectionId, 'updated');
    try {
      return await this.connect({ ...config, id: connectionId }, { monitors, owners });
    } catch (error) {
      if (oldConfig && !this.connections.has(connectionId)) {
        await this.connect({ ...oldConfig, id: connectionId }, { supervise: true, monitors, owners }).catch(() => {});
      }
      throw error;
    }
  }

  async disconnect(connectionId, reason = 'removed') {
    const entry = this.connections.get(connectionId);
    if (!entry) {
      throw new Error(`Unknown OPC UA connection ${connectionId}`);
    }
    entry.closing = true; // stops retries and silences client events
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
    this._setState(entry, 'offline', reason);
    this._dropPending(connectionId);
    this._failPendingMonitors(entry, new Error(`OPC UA connection ${connectionId} was closed`), false);

    try {
      // Deleting the subscription deletes its monitored items on the server; one call, bounded.
      if (entry.subscription) await withTimeout(entry.subscription.terminate(), 5000, 'subscription delete').catch(() => {});
      if (entry.session) await withTimeout(entry.session.close(), 5000, 'session close').catch(() => {});
      if (entry.client) await withTimeout(entry.client.disconnect(), 5000, 'disconnect').catch(() => {});
    } finally {
      entry.client = null;
      entry.session = null;
      entry.subscription = null;
      entry.monitored.clear();
      this._disposeStale(entry);
      if (this.connections.get(connectionId) === entry) this.connections.delete(connectionId);
      this._stopWatchdogIfIdle();
      this.io.emit('opcua-disconnected', { connectionId });
    }
    return { connectionId, status: 'disconnected' };
  }

  /**
   * Identity of an OPC UA connection: normalised endpoint URL (scheme and host lowercased,
   * localhost = 127.0.0.1, default port 4840, no trailing slash), security mode + policy and user
   * name. Two connections with the same identity open two sessions that read the same data twice;
   * a different user or security is legitimate. Null for an endpoint URL that does not validate.
   */
  static connectionIdentity(config = {}) {
    const m = /^opc\.tcp:\/\/([^/:\s]+|\[[0-9a-f:.]+\])(?::(\d{1,5}))?(\/.*)?$/i.exec(String(config.endpointUrl || '').trim());
    if (!m) return null;
    let host = m[1].toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '::1') host = '127.0.0.1';
    const port = Number(m[2] || 4840);
    const path = (m[3] || '').replace(/\/+$/, '');
    return [`opc.tcp://${host}:${port}${path}`, config.securityMode || 'None', config.securityPolicy || 'None', config.username || ''].join('|');
  }

  /** The connection (live, or among `saved` configs) other than `exceptId` with the same identity, as { id, name }, or null. */
  findDuplicateConnection(config, exceptId = null, saved = []) {
    const want = OpcuaManager.connectionIdentity(config);
    if (!want) return null;
    const candidates = [...[...this.connections.values()].map((e) => e.info), ...saved];
    for (const c of candidates) {
      if (!c || c.id === exceptId) continue;
      if (OpcuaManager.connectionIdentity(c) === want) return { id: c.id, name: c.name || c.endpointUrl || c.id };
    }
    return null;
  }

  getConnections() {
    return Array.from(this.connections.values()).map((entry) => ({
      ...entry.info,
      monitoredNodes: Array.from(entry.monitorSpecs.keys()),
      monitorOwners: Object.fromEntries([...entry.monitorOwners].map(([nodeId, set]) => [nodeId, [...set]])),
      ...(entry.monitorErrors.size ? { monitorErrors: Object.fromEntries(entry.monitorErrors) } : {})
    }));
  }

  async shutdown() {
    await Promise.all(Array.from(this.connections.keys()).map((connectionId) => this.disconnect(connectionId, 'shutdown').catch(() => {})));
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    this._pendingValues.clear();
  }
}

OpcuaManager.toPlainValue = toPlainValue;
OpcuaManager.explainError = explainError;
OpcuaManager.checkEndpointUrl = checkEndpointUrl;
module.exports = OpcuaManager;
