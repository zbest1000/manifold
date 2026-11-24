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
  UserTokenType
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
// ---------------------------------------------------------------------------

let certificateManagerPromise = null;

function pkiRootFolder() {
  return path.join(process.env.MANIFOLD_DATA_DIR || path.join(__dirname, '..', 'data'), 'pki');
}

function clientCertificateFile(certificateManager) {
  // Same default path OPCUAClient derives when given a certificate manager.
  return path.join(certificateManager.rootDir, 'own', 'certs', 'client_certificate.pem');
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
  let files = [];
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

// Translate node-opcua's security status codes into something actionable.
function withTrustHint(error) {
  const message = error?.message || String(error);
  if (/BadSecurityChecksFailed|BadCertificateUntrusted|certificate\b.*\bnot trusted|untrusted/i.test(message)) {
    return new Error(
      'server certificate not trusted — retry with trustServer or trust it via the certificates API ' +
        `(POST /api/opcua/trust). If the server rejected OUR certificate instead, trust the Manifold ` +
        `client certificate (GET /api/opcua/certificate) on the server. [${message}]`
    );
  }
  return error;
}

function toPlainValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return { type: 'buffer', base64: value.toString('base64') };
  if (Array.isArray(value)) return value.map(toPlainValue);
  if (typeof value === 'object') {
    if (typeof value.toJSON === 'function') return value.toJSON();
    return JSON.parse(JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  }
  return value;
}

const DEFAULT_BACKOFF = { initialMs: 1000, maxMs: 60_000 };
const DEFAULT_FLUSH_MS = 100;

class OpcuaManager extends EventEmitter {
  /**
   * @param io socket.io server (only emit()/volatile used)
   * @param options.clientFactory (clientOptions) => client   (tests inject a fake)
   * @param options.backoff { initialMs, maxMs }               reconnect delays
   * @param options.random () => [0,1)                         jitter source
   * @param options.valueFlushMs                               socket value coalescing window
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
    this._pendingValues = new Map(); // `${connectionId}\0${nodeId}` -> evt
    this._flushTimer = null;
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

  // -- connect / supervise ---------------------------------------------------

  /**
   * Connect. By default a failed first connect throws and nothing is kept.
   * With `{ supervise: true }` (restore of a saved connection) a failure keeps
   * the entry and retries forever with jittered exponential backoff.
   */
  async connect(config = {}, { supervise = false } = {}) {
    if (!config.endpointUrl) {
      throw new Error('endpointUrl is required (e.g. opc.tcp://host:4840)');
    }

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
      monitored: new Map(),
      // nodeId -> samplingInterval, so monitors can be rebuilt after reconnect
      monitorSpecs: new Map(),
      closing: false,
      supervise,
      connState: null,
      epoch: 0,
      attempt: 0,
      retryTimer: null,
      chain: Promise.resolve()
    };
    this.connections.set(connectionId, entry);
    this.io.emit('opcua-connection-attempt', { connectionId, connection: { ...info } });

    try {
      await this._establish(entry);
      return { connectionId, status: 'connected', endpointUrl: config.endpointUrl };
    } catch (rawError) {
      const error = withTrustHint(rawError);
      info.lastError = error.message;
      this.io.emit('opcua-error', { connectionId, error: error.message });
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
      connectionStrategy: { maxRetry: 2, initialDelay: 1000, maxDelay: 5000 },
      keepSessionAlive: true
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
    return { client: this._clientFactory(clientOptions), certificateManager };
  }

  /** One connect attempt: new client + session, then go online. Throws on failure. */
  async _establish(entry) {
    const { info, config } = entry;
    const { client, certificateManager } = await this._buildClient(entry);
    entry.client = client;
    const mine = () => entry.client === client && !entry.closing;

    client.on('connection_lost', () => {
      if (!mine()) return;
      entry.epoch++;
      info.status = 'reconnecting';
      this.io.emit('opcua-reconnecting', { connectionId: info.id });
      this._setState(entry, 'offline', 'connection lost');
    });
    client.on('connection_reestablished', () => {
      if (!mine()) return;
      info.status = 'connected';
      this.io.emit('opcua-connected', { connectionId: info.id, connection: { ...info } });
      this._sessionUsable(entry).catch(() => {});
    });
    client.on('close', () => {
      // node-opcua gave up for good (or user disconnect, which sets closing).
      if (!mine()) return;
      entry.epoch++;
      entry.session = null;
      entry.subscription = null;
      entry.monitored.clear();
      info.monitoredCount = 0;
      info.lastError = info.lastError || 'connection closed';
      this._setState(entry, 'offline', 'connection closed');
      this._scheduleRetry(entry);
    });

    // trustServer: node-opcua's accept-unknown flag lives on the certificate
    // manager (shared across connections), not on the connect call — so we
    // toggle it for the duration of this connect and restore it in `finally`.
    // The window is small; a concurrent secure connect during it would also
    // be auto-accepted, which is an acceptable trade-off for this tool.
    const toggleAutoAccept = certificateManager !== null && config.trustServer === true;
    const previousAutoAccept = toggleAutoAccept
      ? certificateManager.automaticallyAcceptUnknownCertificate
      : null;
    if (toggleAutoAccept) certificateManager.automaticallyAcceptUnknownCertificate = true;

    try {
      await client.connect(config.endpointUrl);
      if (entry.closing) throw new Error('connection closed');
      const userIdentity = config.username
        ? { type: UserTokenType.UserName, userName: config.username, password: config.password || '' }
        : { type: UserTokenType.Anonymous };
      const session = await client.createSession(userIdentity);
      if (entry.closing) {
        await session.close?.().catch(() => {});
        throw new Error('connection closed');
      }
      entry.session = session;
    } catch (error) {
      // Detach before disconnecting so the dying client's 'close' is ignored.
      if (entry.client === client) entry.client = null;
      await client.disconnect().catch(() => {});
      throw error;
    } finally {
      if (toggleAutoAccept) certificateManager.automaticallyAcceptUnknownCertificate = previousAutoAccept;
    }

    info.status = 'connected';
    info.connectedAt = new Date();
    info.lastError = null;
    entry.attempt = 0;
    this.io.emit('opcua-connected', { connectionId: info.id, connection: { ...info } });
    await this._sessionUsable(entry);
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

  _scheduleRetry(entry) {
    if (entry.closing || entry.retryTimer) return;
    const { initialMs, maxMs } = this._backoff;
    const ceiling = Math.min(maxMs, initialMs * 2 ** Math.min(entry.attempt, 30));
    const delay = Math.round(ceiling * (0.5 + this._random() * 0.5));
    entry.attempt++;
    if (entry.info.status !== 'reconnecting') {
      entry.info.status = 'reconnecting';
      this.io.emit('opcua-reconnecting', { connectionId: entry.info.id });
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
    this.io.emit('opcua-connection-attempt', {
      connectionId: entry.info.id,
      connection: { ...entry.info }
    });
    try {
      await this._establish(entry);
    } catch (rawError) {
      const error = withTrustHint(rawError);
      entry.info.lastError = error.message;
      if (entry.closing) return;
      this._setState(entry, 'offline', `connect failed: ${error.message}`);
      this._scheduleRetry(entry);
    }
  }

  /**
   * Connect with security None, list the server's endpoints, disconnect.
   * Bounded by DISCOVERY_TIMEOUT_MS (opc.tcp — the HTTP timeout helper does
   * not apply here) so a black-holed host can't pin the request forever.
   */
  async discoverEndpoints(endpointUrl, timeoutMs = DISCOVERY_TIMEOUT_MS) {
    if (!endpointUrl) {
      throw new Error('endpointUrl is required (e.g. opc.tcp://host:4840)');
    }
    const client = OPCUAClient.create({
      applicationName: APPLICATION_NAME,
      endpointMustExist: false,
      securityMode: MessageSecurityMode.None,
      securityPolicy: SecurityPolicy.None,
      connectionStrategy: { maxRetry: 0, initialDelay: 500, maxDelay: 1000 }
    });

    let timer = null;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`endpoint discovery timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      timer.unref?.();
    });

    try {
      const endpoints = await Promise.race([
        (async () => {
          await client.connect(endpointUrl);
          return client.getEndpoints();
        })(),
        deadline
      ]);
      return (endpoints || [])
        .map((endpoint) => {
          const policyUri = endpoint.securityPolicyUri || '';
          return {
            endpointUrl: endpoint.endpointUrl || null,
            securityMode: MessageSecurityMode[endpoint.securityMode] || String(endpoint.securityMode),
            securityPolicy: policyUri.includes('#') ? policyUri.split('#').pop() : policyUri,
            securityLevel: endpoint.securityLevel ?? 0,
            serverCertificate:
              endpoint.serverCertificate && endpoint.serverCertificate.length
                ? describeCertificate(endpoint.serverCertificate)
                : null
          };
        })
        .sort((a, b) => b.securityLevel - a.securityLevel);
    } finally {
      if (timer) clearTimeout(timer);
      client.disconnect().catch(() => {});
    }
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
    let files = [];
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
      return describeCertificate(der);
    }
    return null;
  }

  requireSession(connectionId) {
    const entry = this.connections.get(connectionId);
    if (!entry || !entry.session) {
      throw new Error(`OPC UA connection ${connectionId} is not established`);
    }
    return entry;
  }

  async browse(connectionId, nodeId = ROOT_NODE_ID) {
    const entry = this.requireSession(connectionId);
    const result = await entry.session.browse(nodeId);

    const references = (result.references || []).map((ref) => ({
      nodeId: ref.nodeId.toString(),
      browseName: ref.browseName.toString(),
      displayName: ref.displayName?.text || ref.browseName.name,
      nodeClass: NODE_CLASS_NAMES[ref.nodeClass] || String(ref.nodeClass),
      typeDefinition: ref.typeDefinition?.toString() || null,
      isForward: ref.isForward
    }));

    return { nodeId, references };
  }

  async read(connectionId, nodeId) {
    const entry = this.requireSession(connectionId);
    const attributes = [
      ['displayName', AttributeIds.DisplayName],
      ['browseName', AttributeIds.BrowseName],
      ['nodeClass', AttributeIds.NodeClass],
      ['description', AttributeIds.Description],
      ['dataType', AttributeIds.DataType],
      ['value', AttributeIds.Value],
      ['accessLevel', AttributeIds.AccessLevel]
    ];

    const results = await entry.session.read(
      attributes.map(([, attributeId]) => ({ nodeId, attributeId }))
    );

    const out = { nodeId };
    attributes.forEach(([key], i) => {
      const dv = results[i];
      if (!dv.statusCode.isGood()) return;
      let value = dv.value?.value;
      if (key === 'nodeClass') value = NODE_CLASS_NAMES[value] || value;
      else if (key === 'displayName' || key === 'description') value = value?.text ?? null;
      else if (key === 'browseName') value = value?.toString() ?? null;
      else if (key === 'dataType') value = value?.toString() ?? null;
      else value = toPlainValue(value);
      out[key] = value;
    });

    const valueDv = results[5];
    out.valueStatus = valueDv.statusCode.toString();
    out.sourceTimestamp = valueDv.sourceTimestamp || null;
    return out;
  }

  /**
   * Monitor a node. Serialized per connection and idempotent: concurrent calls
   * never create two subscriptions or duplicate items, and re-monitoring an
   * already-monitored node resolves as a no-op.
   */
  async monitor(connectionId, nodeId, samplingInterval = 500) {
    const entry = this.requireSession(connectionId);
    return this._serial(entry, () => this._monitorInner(entry, nodeId, samplingInterval));
  }

  async _monitorInner(entry, nodeId, samplingInterval) {
    const connectionId = entry.info.id;
    if (entry.monitored.has(nodeId)) {
      return { connectionId, nodeId, status: 'already-monitored' };
    }
    if (!entry.session || entry.closing) {
      throw new Error(`OPC UA connection ${connectionId} is not established`);
    }

    if (!entry.subscription) {
      entry.subscription = await entry.session.createSubscription2({
        requestedPublishingInterval: 250,
        requestedLifetimeCount: 1000,
        requestedMaxKeepAliveCount: 20,
        maxNotificationsPerPublish: 100,
        publishingEnabled: true,
        priority: 10
      });
    }

    const item = await entry.subscription.monitor(
      { nodeId, attributeId: AttributeIds.Value },
      { samplingInterval, discardOldest: true, queueSize: 10 },
      TimestampsToReturn.Both
    );

    item.on('changed', (dataValue) => {
      const evt = {
        connectionId,
        nodeId,
        value: toPlainValue(dataValue.value?.value),
        dataType: dataValue.value?.dataType !== undefined ? String(dataValue.value.dataType) : null,
        status: dataValue.statusCode.toString(),
        sourceTimestamp: dataValue.sourceTimestamp || null,
        serverTimestamp: dataValue.serverTimestamp || null
      };
      // Socket clients get the latest value per node, coalesced (see _flushValues);
      // the in-process tap (tag binding engine) stays immediate.
      this._queueValue(evt);
      this.emit('value', evt);
    });

    entry.monitored.set(nodeId, item);
    entry.monitorSpecs.set(nodeId, samplingInterval);
    entry.info.monitoredCount = entry.monitored.size;
    this.io.emit('opcua-monitor-started', { connectionId, nodeId, samplingInterval });
    return { connectionId, nodeId, status: 'monitoring', samplingInterval };
  }

  /**
   * Rebuild the subscription and every monitored item after a reconnect.
   * Deterministic over clever: the old subscription is torn down even if it
   * survived (a redundant re-subscribe is cheap; a silently dead monitor is
   * not) and each recorded (nodeId, interval) is re-monitored.
   */
  async _recoverMonitors(connectionId) {
    const entry = this.connections.get(connectionId);
    if (!entry || entry.monitorSpecs.size === 0) return;
    return this._serial(entry, async () => {
      const specs = [...entry.monitorSpecs.entries()];
      if (entry.subscription) {
        await entry.subscription.terminate().catch(() => {});
        entry.subscription = null;
      }
      entry.monitored.clear();
      entry.monitorSpecs.clear();
      entry.info.monitoredCount = 0;
      for (const [nodeId, interval] of specs) {
        await this._monitorInner(entry, nodeId, interval).catch((error) => {
          entry.info.lastError = `re-monitor ${nodeId}: ${error.message}`;
          // keep the spec so the next reconnect retries it
          entry.monitorSpecs.set(nodeId, interval);
        });
      }
    });
  }

  async unmonitor(connectionId, nodeId) {
    const entry = this.requireSession(connectionId);
    await this._serial(entry, async () => {
      const item = entry.monitored.get(nodeId);
      if (item) {
        await item.terminate();
        entry.monitored.delete(nodeId);
        entry.monitorSpecs.delete(nodeId);
        entry.info.monitoredCount = entry.monitored.size;
      }
      this._pendingValues.delete(`${connectionId}\u0000${nodeId}`);
    });
    this.io.emit('opcua-monitor-stopped', { connectionId, nodeId });
    return { connectionId, nodeId, status: 'stopped' };
  }

  /**
   * Update a saved endpoint in place: validate first (a bad body must not kill
   * a live session), close the existing session if any, then connect again
   * under the SAME id. disconnect() sets `closing` on the OLD entry only —
   * connect() builds a fresh entry, so the update never ends up stuck in a
   * terminal state. Like a POST-created connection, it starts with no monitors.
   */
  async updateConnection(connectionId, config = {}) {
    if (!config.endpointUrl) {
      throw new Error('endpointUrl is required (e.g. opc.tcp://host:4840)');
    }
    if (this.connections.has(connectionId)) {
      await this.disconnect(connectionId, 'updated');
    }
    return this.connect({ ...config, id: connectionId });
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

    try {
      for (const item of entry.monitored.values()) {
        await item.terminate().catch(() => {});
      }
      if (entry.subscription) await entry.subscription.terminate().catch(() => {});
      if (entry.session) await entry.session.close().catch(() => {});
      if (entry.client) await entry.client.disconnect();
    } finally {
      this.connections.delete(connectionId);
      this.io.emit('opcua-disconnected', { connectionId });
    }
    return { connectionId, status: 'disconnected' };
  }

  getConnections() {
    return Array.from(this.connections.values()).map((entry) => ({
      ...entry.info,
      monitoredNodes: Array.from(entry.monitored.keys())
    }));
  }

  async shutdown() {
    for (const connectionId of Array.from(this.connections.keys())) {
      await this.disconnect(connectionId, 'shutdown').catch(() => {});
    }
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this._pendingValues.clear();
  }
}

module.exports = OpcuaManager;
