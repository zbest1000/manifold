'use strict';

/**
 * In-process Matter Server simulator: speaks the python-matter-server / matter.js server
 * WebSocket API (server info greeting, message_id commands, start_listening + event stream).
 *
 * It answers ONLY the read commands. Any other command (commission_*, device_command,
 * write_attribute, remove_node, interview_node, ...) is refused with an error AND recorded in
 * `sim.violations`, so tests can assert that Manifold never sent one.
 *
 * The node dump is modelled on real dumps from python-matter-server (attributes keyed
 * "endpoint/cluster/attribute", struct fields keyed by field id as text).
 */

const { startWsServer } = require('./wsTestServer');

const READ = new Set(['start_listening', 'get_nodes', 'get_node', 'server_info', 'diagnostics', 'read_attribute', 'ping_node']);

function basicInfo(vendor, product, label, sw = '1.0.0') {
  return {
    '0/40/0': 17,
    '0/40/1': vendor,
    '0/40/2': 4874,
    '0/40/3': product,
    '0/40/4': 77,
    '0/40/5': label,
    '0/40/9': 6650,
    '0/40/10': sw,
    '0/40/15': `SN-${product.length}${label.length}`,
    '0/40/18': `uid-${product}`,
    '0/40/65532': 0,
    '0/40/65533': 3,
    '0/29/0': [{ 0: 22, 1: 1 }],
    '0/29/1': [29, 31, 40, 48, 49, 51, 60, 62, 63],
    '0/29/3': [1],
  };
}

function defaultNodes() {
  const now = '2026-11-20T10:00:00.000000';
  const node = (id, attrs, extra = {}) => ({
    node_id: id,
    date_commissioned: now,
    last_interview: now,
    interview_version: 6,
    available: true,
    is_bridge: false,
    attributes: attrs,
    attribute_subscriptions: [],
    ...extra,
  });
  return [
    node(1, {
      ...basicInfo('Eve Systems', 'Eve Weather', 'Balcony'),
      '1/29/0': [{ 0: 770, 1: 2 }, { 0: 775, 1: 2 }, { 0: 773, 1: 2 }],
      '1/1026/0': 2134, // 21.34 degC
      '1/1026/1': -4000,
      '1/1026/2': 8500,
      '1/1029/0': 4520, // 45.20 %
      '1/1027/0': 1013, // 101.3 kPa (unit 0.1 kPa)
      '1/47/0': 1,
      '1/47/11': 3010, // 3.010 V
      '1/47/12': 172, // 86 %
      '1/47/14': 0,
      '1/47/15': false,
    }),
    node(2, {
      ...basicInfo('Signify', 'Hue color lamp', 'Desk lamp'),
      '1/29/0': [{ 0: 269, 1: 4 }],
      '1/6/0': true,
      '1/6/16384': true,
      '1/6/16385': 0,
      '1/8/0': 254,
      '1/8/2': 1,
      '1/8/3': 254,
      '1/8/17': null,
      '1/768/0': 120,
      '1/768/1': 200,
      '1/768/3': 24939,
      '1/768/4': 24701,
      '1/768/7': 366,
      '1/768/8': 2,
      '1/64512/1': 'vendor specific', // unknown cluster, readable by number
    }),
    node(3, {
      ...basicInfo('Eve Systems', 'Eve Energy', 'Coffee machine'),
      '1/29/0': [{ 0: 266, 1: 3 }, { 0: 1296, 1: 1 }],
      '1/6/0': false,
      '1/144/0': 2,
      '1/144/4': 230120, // 230.12 V
      '1/144/5': 1250, // 1.25 A
      '1/144/8': 287650, // 287.65 W
      '1/144/14': 50010, // 50.01 Hz
      '1/145/1': { 0: 12345678, 1: 760000000 }, // 12345.678 Wh
      '1/145/2': null,
    }),
    node(4, {
      ...basicInfo('Aqara', 'Door and Window Sensor P2', 'Front door'),
      '1/29/0': [{ 0: 21, 1: 1 }],
      '1/69/0': true,
      '1/47/12': 200,
    }, { available: false }),
    node(5, {
      ...basicInfo('Nanoleaf', 'Multi sensor', 'Hallway'),
      '1/29/0': [{ 0: 769, 1: 2 }],
      '1/513/0': 2050,
      '1/513/18': 2100,
      '1/513/17': 2600,
      '1/513/28': 4,
      '1/513/41': 1,
      '2/29/0': [{ 0: 10, 1: 2 }],
      '2/257/0': 1,
      '2/257/3': 1,
      '3/29/0': [{ 0: 514, 1: 2 }],
      '3/258/14': 5025, // 50.25 %
      '3/258/8': 50,
      '4/29/0': [{ 0: 44, 1: 1 }],
      '4/91/0': 2,
      '4/1037/0': 612.5,
      '4/1037/8': 0, // ppm
      '4/1066/0': 7.25,
      '4/1066/8': 4, // ug/m3
      '5/29/0': [{ 0: 263, 1: 3 }, { 0: 262, 1: 3 }],
      '5/1030/0': 1,
      '5/1024/0': 21761, // 10^((21761-1)/10000) = 149.97 lx
    }),
  ];
}

/**
 * @param {object} [o]
 * @param {number} [o.schemaVersion=11]
 * @param {number} [o.minSupportedSchemaVersion=9]
 * @param {Array} [o.nodes]
 * @param {boolean} [o.tls] use the test certificate (wss)
 * @param {string} [o.requireToken]
 * @param {(req)=>object} [o.handshake] misbehave in the handshake
 * @param {boolean} [o.noGreeting] never send the server info
 */
async function startMatterServerSimulator(o = {}) {
  const state = {
    info: {
      fabric_id: 2,
      compressed_fabric_id: 1125920889023645,
      schema_version: o.schemaVersion ?? 11,
      min_supported_schema_version: o.minSupportedSchemaVersion ?? 9,
      sdk_version: o.sdkVersion || '2025.7.0',
      wifi_credentials_set: false,
      thread_credentials_set: true,
      bluetooth_enabled: false,
    },
    nodes: new Map((o.nodes || defaultNodes()).map((n) => [n.node_id, JSON.parse(JSON.stringify(n))])),
  };
  const commands = []; // every command received: { command, args }
  const violations = []; // every non-read command
  const listeners = new Set();
  const reads = []; // read_attribute calls
  const sim = {
    commands,
    violations,
    reads,
    state,
    connections: 0,
    hold: null, // command name whose answer is withheld (timeouts)
  };

  const tlsOptions = o.tls ? (() => {
    const { KEY, CERT } = require('./tlsFixture');
    return { key: KEY, cert: CERT };
  })() : null;

  const server = await startWsServer({
    path: o.path || '/ws',
    tlsOptions,
    requireToken: o.requireToken,
    handshake: o.handshake,
    onConnection(peer) {
      sim.connections++;
      if (!o.noGreeting) peer.sendJson(state.info);
      peer.on('close', () => listeners.delete(peer));
      peer.on('message', (text, isBinary) => {
        if (isBinary) return;
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        const { message_id: id, command, args = {} } = msg;
        commands.push({ command, args });
        const reply = (result) => peer.sendJson({ message_id: id, result });
        const error = (code, details) => peer.sendJson({ message_id: id, error_code: code, details });
        if (!READ.has(command)) {
          violations.push({ command, args });
          return error(1, `Manifold simulator refuses non-read command ${command}`);
        }
        if (sim.hold === command) return;
        const node = (nid) => state.nodes.get(nid);
        switch (command) {
          case 'start_listening':
            listeners.add(peer);
            return reply([...state.nodes.values()]);
          case 'get_nodes':
            return reply([...state.nodes.values()]);
          case 'get_node':
            return node(args.node_id) ? reply(node(args.node_id)) : error(5, `Node ${args.node_id} does not exist`);
          case 'server_info':
            return reply(state.info);
          case 'diagnostics':
            return reply({ info: state.info, nodes: [...state.nodes.values()], events: [] });
          case 'read_attribute': {
            if (state.info.schema_version < 9) return error(0, 'Unknown command');
            reads.push(args);
            const n = node(args.node_id);
            if (!n) return error(5, `Node ${args.node_id} does not exist`);
            if (!n.available) return error(6, 'Node is not available');
            const path = String(args.attribute_path);
            return reply(path in n.attributes ? { [path]: n.attributes[path] } : {});
          }
          case 'ping_node':
            return reply({});
          default:
            return error(0, 'Unknown command');
        }
      });
    },
  });

  const broadcast = (obj) => {
    const text = JSON.stringify(obj);
    for (const p of listeners) p.send(text);
  };

  Object.assign(sim, {
    port: server.port,
    url: `${o.tls ? 'wss' : 'ws'}://127.0.0.1:${server.port}${o.path || '/ws'}`,
    requests: server.requests,
    peers: server.peers,
    listeners,
    /** Change an attribute and stream attribute_updated. */
    setAttribute(nodeId, path, value) {
      const n = state.nodes.get(nodeId);
      n.attributes[path] = value;
      broadcast({ event: 'attribute_updated', data: [nodeId, path, value] });
    },
    /** Change an attribute WITHOUT an event (the resync must find it). */
    setSilently(nodeId, path, value) {
      state.nodes.get(nodeId).attributes[path] = value;
    },
    setAvailable(nodeId, available) {
      const n = state.nodes.get(nodeId);
      n.available = available;
      broadcast({ event: 'node_updated', data: n });
    },
    addNode(n) {
      state.nodes.set(n.node_id, n);
      broadcast({ event: 'node_added', data: n });
    },
    removeNode(nodeId) {
      state.nodes.delete(nodeId);
      broadcast({ event: 'node_removed', data: nodeId });
    },
    nodeEvent(nodeId) {
      broadcast({ event: 'node_event', data: { node_id: nodeId, endpoint_id: 1, cluster_id: 59, event_id: 1, event_number: 1, priority: 1, timestamp: Date.now(), timestamp_type: 0, data: { newPosition: 1 } } });
    },
    serverShutdown() {
      broadcast({ event: 'server_shutdown', data: null });
    },
    /** Send arbitrary text (malformed JSON, unknown shapes) to every listening client. */
    sendRaw(text) {
      for (const p of listeners) p.send(text);
    },
    sendFragmented(obj) {
      for (const p of listeners) p.sendFragmented(JSON.stringify(obj), 4);
    },
    /** One text frame of `bytes` bytes (to exceed the client's cap). */
    sendOversized(bytes) {
      const pad = 'x'.repeat(Math.max(0, bytes - 40));
      broadcast({ event: 'node_event', data: { pad } });
    },
    dropAll() {
      for (const p of server.peers) p.drop();
    },
    close: () => server.close(),
  });
  return sim;
}

module.exports = { startMatterServerSimulator, defaultNodes, READ_COMMANDS: [...READ] };
