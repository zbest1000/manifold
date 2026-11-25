'use strict';

/**
 * A real OPC UA server (node-opcua, devDependency) for integration and UI tests.
 *
 *   const srv = await startOpcuaTestServer({ port: 0 });
 *   srv.endpointUrl                       opc.tcp://127.0.0.1:<port>
 *   srv.nodeId('Scalars.Double')          'ns=1;s=Scalars.Double'
 *   srv.set('Scalars.Double', 1.5)        change a value (pushed to monitored items)
 *   srv.setStatus('Quality.Value', 'Bad', { value, sourceTimestamp })
 *   await srv.restart()                   stop and start again on the SAME port and certificate
 *   await srv.stop() / srv.start()        an outage of any length, then recovery
 *   srv.closeSessions({ deleteSubscriptions })   server-side session close (as a timeout does)
 *   srv.deleteSubscriptions()             server-side subscription deletion
 *   srv.setSlowMs(ms)                     reads of Slow.Value take this long
 *   srv.trustClients(false)               the server stops trusting client certificates
 *   srv.sessionCount() / srv.monitoredItemCount()
 *   await srv.close()
 *
 * Address space (namespace 1, string node ids), under Objects/Manifold:
 *   Scalars/{Boolean,SByte,Byte,Int16,UInt16,Int32,UInt32,Int64,UInt64,Float,Double,String,DateTime}
 *   Arrays/{DoubleArray,Int32Array,StringArray}
 *   Structs/{Range (a standard structure), Custom (a server-defined structure)}
 *   Analog/{Temperature (degC, 0..150), Pressure (kPa, 0..1000)}  AnalogItemType with EURange + EngineeringUnits
 *   Quality/Value  status code and source timestamp are under test control
 *   Slow/Value     reads take setSlowMs() milliseconds
 *   Deep/L1/L2/.../L8/Leaf
 *   Large/Item000..Item(N-1)  (default 300) for browse paging
 *
 * Endpoints: None, and Sign + SignAndEncrypt with Basic256Sha256 (and Aes128_Sha256_RsaOaep);
 * anonymous and username/password (operator / secret, viewer / viewer).
 *
 * Certificates: each server has its own PKI folder; the server's own certificate and key are
 * generated once per test run and cached (os.tmpdir()/manifold-opcua-test-cert-<pid of the
 * first generator>) so starting further servers is fast. By default the server accepts any
 * client certificate (trustClients(true)).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  OPCUAServer,
  OPCUACertificateManager,
  Variant,
  DataType,
  VariantArrayType,
  StatusCodes,
  SecurityPolicy,
  MessageSecurityMode,
  standardUnits,
  nodesets
} = require('node-opcua');
const { readCertificate } = require('node-opcua-crypto');

const TYPES_NAMESPACE_URI = 'urn:manifold:test-types';
const TYPES_NODESET = path.join(__dirname, '..', 'fixtures', 'opcua-test-types.xml');

const USERS = { operator: 'secret', viewer: 'viewer' };

const SCALARS = [
  ['Boolean', DataType.Boolean, true],
  ['SByte', DataType.SByte, -8],
  ['Byte', DataType.Byte, 200],
  ['Int16', DataType.Int16, -1234],
  ['UInt16', DataType.UInt16, 54321],
  ['Int32', DataType.Int32, -123456789],
  ['UInt32', DataType.UInt32, 3000000000],
  // node-opcua carries 64-bit integers as [high, low] 32-bit words
  ['Int64', DataType.Int64, [0x7fffffff, 0xffffffff]],
  ['UInt64', DataType.UInt64, [0xffffffff, 0xfffffffe]],
  ['Float', DataType.Float, 1.5],
  ['Double', DataType.Double, 3.14159],
  ['String', DataType.String, 'hello'],
  ['DateTime', DataType.DateTime, new Date('2026-01-02T03:04:05.000Z')]
];

const ARRAYS = [
  ['DoubleArray', DataType.Double, [1.5, 2.5, 3.5]],
  ['Int32Array', DataType.Int32, [1, -2, 3]],
  ['StringArray', DataType.String, ['a', 'b', 'c']]
];

const CERT_CACHE_ENV = 'MANIFOLD_OPCUA_TEST_CERT_CACHE';

function certCacheDir() {
  if (!process.env[CERT_CACHE_ENV]) {
    process.env[CERT_CACHE_ENV] = path.join(os.tmpdir(), `manifold-opcua-test-cert-${process.pid}`);
  }
  return process.env[CERT_CACHE_ENV];
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

/** Convert a JS value + DataType into a Variant (arrays become Array variants). */
function toVariant(dataType, value) {
  if (Array.isArray(value) && dataType !== DataType.Int64 && dataType !== DataType.UInt64) {
    return new Variant({ dataType, arrayType: VariantArrayType.Array, value });
  }
  const is64 = dataType === DataType.Int64 || dataType === DataType.UInt64;
  return new Variant({ dataType, value, ...(is64 ? { arrayType: VariantArrayType.Scalar } : {}) });
}

async function startOpcuaTestServer(options = {}) {
  const largeCount = options.largeCount ?? 300;
  const pkiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-opcua-srv-pki-'));
  const state = {
    port: options.port || 0,
    server: null,
    certificateManager: null,
    vars: new Map(), // name -> { node, dataType }
    current: new Map(), // name -> { value, status, sourceTimestamp }
    slowMs: 0,
    trustClients: options.trustClients !== false,
    customStructType: null
  };

  const cache = certCacheDir();
  if (fs.existsSync(path.join(cache, 'own', 'private'))) copyDir(cache, path.join(pkiDir, 'own'));

  async function createCertificateManager() {
    const cm = new OPCUACertificateManager({
      rootFolder: pkiDir,
      automaticallyAcceptUnknownCertificate: state.trustClients
    });
    await cm.initialize();
    return cm;
  }

  function buildAddressSpace(server) {
    const addressSpace = server.engine.addressSpace;
    const namespace = addressSpace.getOwnNamespace();
    const objects = addressSpace.rootFolder.objects;
    const root = namespace.addFolder(objects, { browseName: 'Manifold', nodeId: 's=Manifold' });
    const folder = (parent, name, id) => namespace.addFolder(parent, { browseName: name, nodeId: `s=${id}` });

    const variable = (parent, name, id, dataType, initial, extra = {}) => {
      const isArray = Array.isArray(initial) && dataType !== DataType.Int64 && dataType !== DataType.UInt64;
      const node = namespace.addVariable({
        componentOf: parent,
        browseName: name,
        nodeId: `s=${id}`,
        dataType,
        valueRank: isArray ? 1 : -1,
        accessLevel: 'CurrentRead | CurrentWrite',
        userAccessLevel: 'CurrentRead | CurrentWrite',
        minimumSamplingInterval: 0,
        ...extra
      });
      state.vars.set(id, { node, dataType });
      const cur = state.current.get(id) || { value: initial, status: StatusCodes.Good, sourceTimestamp: new Date() };
      state.current.set(id, cur);
      node.setValueFromSource(toVariant(dataType, cur.value), cur.status, cur.sourceTimestamp);
      return node;
    };

    const scalars = folder(root, 'Scalars', 'Scalars');
    for (const [name, dt, v] of SCALARS) variable(scalars, name, `Scalars.${name}`, dt, v);

    const arrays = folder(root, 'Arrays', 'Arrays');
    for (const [name, dt, v] of ARRAYS) variable(arrays, name, `Arrays.${name}`, dt, v);

    const structs = folder(root, 'Structs', 'Structs');
    const rangeNode = namespace.addVariable({
      componentOf: structs,
      browseName: 'Range',
      nodeId: 's=Structs.Range',
      dataType: 'Range',
      minimumSamplingInterval: 0
    });
    const range = addressSpace.constructExtensionObject(addressSpace.findDataType('Range'), { low: -10, high: 90 });
    rangeNode.setValueFromSource(new Variant({ dataType: DataType.ExtensionObject, value: range }));
    state.vars.set('Structs.Range', { node: rangeNode, dataType: DataType.ExtensionObject, struct: 'Range' });

    // A server-defined structure loaded from a NodeSet2 file (fixtures/opcua-test-types.xml), as a
    // PLC UDT would be: clients must fetch its DataTypeDefinition to decode it.
    try {
      const typesNs = addressSpace.getNamespace(TYPES_NAMESPACE_URI).index;
      const customType = addressSpace.findNode(`ns=${typesNs};i=3001`);
      const customNode = namespace.addVariable({
        componentOf: structs,
        browseName: 'Custom',
        nodeId: 's=Structs.Custom',
        dataType: customType,
        minimumSamplingInterval: 0
      });
      const cur = state.current.get('Structs.Custom') || { value: { running: true, speed: 1450.5, label: 'P-101' }, status: StatusCodes.Good, sourceTimestamp: new Date() };
      state.current.set('Structs.Custom', cur);
      const value = addressSpace.constructExtensionObject(customType, cur.value);
      customNode.setValueFromSource(new Variant({ dataType: DataType.ExtensionObject, value }), cur.status, cur.sourceTimestamp);
      state.vars.set('Structs.Custom', { node: customNode, dataType: DataType.ExtensionObject, struct: customType });
    } catch (error) {
      state.customStructError = error.message;
    }

    const analog = folder(root, 'Analog', 'Analog');
    const analogItem = (name, unit, low, high, initial) => {
      const node = namespace.addAnalogDataItem({
        componentOf: analog,
        browseName: name,
        nodeId: `s=Analog.${name}`,
        dataType: 'Double',
        engineeringUnitsRange: { low, high },
        instrumentRange: { low, high },
        engineeringUnits: unit,
        minimumSamplingInterval: 0
      });
      state.vars.set(`Analog.${name}`, { node, dataType: DataType.Double });
      const cur = state.current.get(`Analog.${name}`) || { value: initial, status: StatusCodes.Good, sourceTimestamp: new Date() };
      state.current.set(`Analog.${name}`, cur);
      node.setValueFromSource(toVariant(DataType.Double, cur.value), cur.status, cur.sourceTimestamp);
    };
    analogItem('Temperature', standardUnits.degree_celsius, 0, 150, 21.5);
    analogItem('Pressure', standardUnits.kilo_pascal || standardUnits.pascal, 0, 1000, 101.3);

    const quality = folder(root, 'Quality', 'Quality');
    variable(quality, 'Value', 'Quality.Value', DataType.Double, 1);

    const slow = folder(root, 'Slow', 'Slow');
    const slowNode = namespace.addVariable({
      componentOf: slow,
      browseName: 'Value',
      nodeId: 's=Slow.Value',
      dataType: 'Double',
      minimumSamplingInterval: 1000,
      value: {
        timestamped_get: (callback) => {
          const reply = () => callback(null, { value: new Variant({ dataType: DataType.Double, value: 42 }), statusCode: StatusCodes.Good, sourceTimestamp: new Date() });
          if (state.slowMs > 0) setTimeout(reply, state.slowMs).unref?.();
          else reply();
        }
      }
    });
    state.vars.set('Slow.Value', { node: slowNode, dataType: DataType.Double, computed: true });

    let parent = folder(root, 'Deep', 'Deep');
    let id = 'Deep';
    for (let i = 1; i <= 8; i++) {
      id = `${id}.L${i}`;
      parent = folder(parent, `L${i}`, id);
    }
    variable(parent, 'Leaf', `${id}.Leaf`, DataType.Int32, 7);
    state.deepLeaf = `${id}.Leaf`;

    const large = folder(root, 'Large', 'Large');
    for (let i = 0; i < largeCount; i++) {
      const name = `Item${String(i).padStart(3, '0')}`;
      variable(large, name, `Large.${name}`, DataType.Int32, i);
    }
  }

  async function start() {
    if (state.server) return;
    state.certificateManager = await createCertificateManager();
    const server = new OPCUAServer({
      port: state.port,
      hostname: '127.0.0.1',
      alternateHostname: ['127.0.0.1'],
      nodeset_filename: [nodesets.standard, TYPES_NODESET],
      serverCertificateManager: state.certificateManager,
      securityPolicies: [SecurityPolicy.None, SecurityPolicy.Basic256Sha256, SecurityPolicy.Aes128_Sha256_RsaOaep],
      securityModes: [MessageSecurityMode.None, MessageSecurityMode.Sign, MessageSecurityMode.SignAndEncrypt],
      allowAnonymous: true,
      userManager: { isValidUser: (user, password) => USERS[user] !== undefined && USERS[user] === password },
      serverCapabilities: { maxSessions: options.maxSessions ?? 50, maxMonitoredItemsPerCall: 1000 },
      maxConnectionsPerEndpoint: options.maxConnections ?? 50,
      buildInfo: { productName: 'Manifold OPC UA test server', manufacturerName: 'Manifold tests', softwareVersion: '1.0.0' },
      serverInfo: { applicationUri: 'urn:manifold:test-server', productUri: 'urn:manifold:test-server', applicationName: { text: 'Manifold OPC UA test server' } },
      isAuditing: false
    });
    await server.initialize();
    buildAddressSpace(server);
    await server.start();
    state.server = server;
    state.port = server.endpoints[0].port;
    const cache2 = certCacheDir();
    if (!fs.existsSync(path.join(cache2, 'own', 'private'))) {
      try {
        copyDir(path.join(pkiDir, 'own'), cache2);
      } catch {
        // caching is an optimisation only
      }
    }
  }

  async function stop() {
    const server = state.server;
    if (!server) return;
    state.server = null;
    state.vars.clear();
    await server.shutdown(0);
  }

  await start();

  const api = {
    get port() {
      return state.port;
    },
    get endpointUrl() {
      return `opc.tcp://127.0.0.1:${state.port}`;
    },
    get running() {
      return state.server !== null;
    },
    get server() {
      return state.server;
    },
    pkiDir,
    users: { ...USERS },
    deepLeaf: () => state.deepLeaf,
    customStructError: () => state.customStructError || null,
    scalarTypes: SCALARS.map(([name]) => name),
    nodeId: (name) => `ns=1;s=${name}`,
    /** Change a value (status Good, source timestamp now unless given). */
    set(name, value, { status = StatusCodes.Good, sourceTimestamp = new Date() } = {}) {
      const v = state.vars.get(name);
      if (!v) throw new Error(`test server: no variable ${name}`);
      const cur = { value, status, sourceTimestamp };
      state.current.set(name, cur);
      if (v.struct) {
        const dt = typeof v.struct === 'string' ? state.server.engine.addressSpace.findDataType(v.struct) : v.struct;
        const ext = state.server.engine.addressSpace.constructExtensionObject(dt, value);
        v.node.setValueFromSource(new Variant({ dataType: DataType.ExtensionObject, value: ext }), status, sourceTimestamp);
      } else {
        v.node.setValueFromSource(toVariant(v.dataType, value), status, sourceTimestamp);
      }
    },
    /** Change only the status code (and optionally value / source timestamp) of a variable. */
    setStatus(name, status, { value, sourceTimestamp = new Date() } = {}) {
      const statusCode = typeof status === 'string' ? StatusCodes[status] : status;
      if (!statusCode) throw new Error(`test server: unknown status ${status}`);
      const cur = state.current.get(name);
      api.set(name, value === undefined ? cur.value : value, { status: statusCode, sourceTimestamp });
    },
    get: (name) => state.current.get(name)?.value,
    setSlowMs(ms) {
      state.slowMs = ms;
    },
    /**
     * Whether the server accepts client certificates it does not know. Turning it off also moves the
     * client certificates trusted so far to rejected/, so the next secure connect is refused.
     */
    async trustClients(on) {
      state.trustClients = !!on;
      const cm = state.certificateManager;
      if (!cm) return;
      cm.automaticallyAcceptUnknownCertificate = !!on;
      if (!on) {
        const trusted = path.join(pkiDir, 'trusted', 'certs');
        for (const f of fs.existsSync(trusted) ? fs.readdirSync(trusted) : []) {
          await cm.rejectCertificate(readCertificate(path.join(trusted, f)));
        }
      }
    },
    /** Trust (again) every client certificate the server has refused. */
    async trustRejectedClients() {
      const cm = state.certificateManager;
      const dir = path.join(pkiDir, 'rejected');
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => /\.(pem|der)$/.test(x)) : []) {
        await cm.trustCertificate(readCertificate(path.join(dir, f)));
      }
    },
    /** Client certificates the server has refused. */
    rejectedClientCertificates() {
      const dir = path.join(pkiDir, 'rejected');
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(pem|der)$/.test(f)) : [];
    },
    sessionCount: () => (state.server ? state.server.engine.currentSessionCount : 0),
    sessions: () => (state.server ? state.server.engine.getSessions() : []),
    subscriptionCount() {
      if (!state.server) return 0;
      return state.server.engine.getSessions().reduce((n, s) => n + (s.publishEngine?.subscriptionCount || 0), 0);
    },
    monitoredItemCount() {
      if (!state.server) return 0;
      let n = 0;
      for (const s of state.server.engine.getSessions()) {
        for (const sub of s.publishEngine?.subscriptions || []) n += sub.monitoredItemCount;
      }
      return n;
    },
    /** Close every session server side, as a session timeout does. */
    closeSessions({ deleteSubscriptions = true } = {}) {
      if (!state.server) return 0;
      const sessions = state.server.engine.getSessions();
      for (const s of sessions) state.server.engine.closeSession(s.authenticationToken, deleteSubscriptions, 'Forcing');
      return sessions.length;
    },
    /** Cut every client connection abruptly (as a network failure does); sessions stay on the server. */
    dropConnections() {
      if (!state.server) return;
      for (const ep of state.server.endpoints) ep.abruptlyInterruptChannels();
    },
    /** Delete every subscription server side; sessions stay. */
    deleteSubscriptions() {
      if (!state.server) return 0;
      let n = 0;
      for (const s of state.server.engine.getSessions()) {
        for (const sub of [...(s.publishEngine?.subscriptions || [])]) {
          s.deleteSubscription(sub.id);
          n++;
        }
      }
      return n;
    },
    start,
    stop,
    async restart() {
      await stop();
      await start();
    },
    async close() {
      await stop();
      fs.rmSync(pkiDir, { recursive: true, force: true });
    }
  };
  return api;
}

module.exports = { startOpcuaTestServer, USERS, SCALARS, ARRAYS };
