'use strict';

/**
 * In-process Z-Wave JS Server simulator (@zwave-js/server WebSocket API): version greeting,
 * set_api_schema, start_listening with a realistic network state, node/controller/driver
 * events.
 *
 * Only cache-read commands are answered. Everything else (node.set_value, node.poll_value,
 * node.refresh_info, controller.begin_inclusion, ...) is refused with an error AND recorded
 * in `sim.violations` so tests can assert Manifold never sent one.
 */

const { startWsServer } = require('./wsTestServer');

const READ = new Set(['set_api_schema', 'start_listening', 'node.get_defined_value_ids', 'node.get_value_metadata', 'node.get_value']);

const md = (type, extra = {}) => ({ type, readable: true, writeable: false, ...extra });

function val(commandClass, commandClassName, endpoint, property, value, metadata, extra = {}) {
  return { endpoint, commandClass, commandClassName, property, propertyName: String(property), value, metadata, ccVersion: 1, ...extra };
}

function defaultNodes() {
  return [
    { nodeId: 1, index: 0, status: 4, ready: true, isControllerNode: true, label: 'ZST10 700', deviceConfig: { manufacturer: 'Zooz', label: 'ZST10 700' }, values: [] },
    {
      nodeId: 2,
      index: 0,
      status: 1, // asleep (battery)
      ready: true,
      isListening: false,
      name: 'Hall sensor',
      location: 'Hall',
      deviceConfig: { manufacturer: 'Aeotec', label: 'ZW100', description: 'MultiSensor 6' },
      values: [
        val(49, 'Multilevel Sensor', 0, 'Air temperature', 21.5, md('number', { label: 'Air temperature', unit: '°C', ccSpecific: { sensorType: 1, scale: 0 } })),
        val(49, 'Multilevel Sensor', 0, 'Humidity', 48, md('number', { label: 'Humidity', unit: '%' })),
        val(49, 'Multilevel Sensor', 0, 'Illuminance', 120, md('number', { label: 'Illuminance', unit: 'Lux' })),
        val(113, 'Notification', 0, 'Home Security', 8, md('number', { label: 'Motion sensor status', states: { 0: 'idle', 8: 'Motion detection' }, min: 0, max: 255 }), { propertyKey: 'Motion sensor status', propertyKeyName: 'Motion sensor status' }),
        val(113, 'Notification', 0, 'Power Management', 0, md('number', { label: 'Over-current/voltage status', states: { 0: 'idle', 6: 'Over-current detected' } }), { propertyKey: 'Over-current/voltage status' }),
        val(128, 'Battery', 0, 'level', 87, md('number', { label: 'Battery level', unit: '%', min: 0, max: 100 })),
        val(128, 'Battery', 0, 'isLow', false, md('boolean', { label: 'Low battery level' })),
        val(112, 'Configuration', 0, 3, 240, md('number', { label: 'PIR reset time', unit: 'seconds', min: 10, max: 3600, writeable: true })),
        val(112, 'Configuration', 0, 101, 241, md('number', { label: 'Report group 1, temperature bit', writeable: true }), { propertyKey: 32 }),
      ],
    },
    {
      nodeId: 3,
      index: 0,
      status: 4, // alive (mains)
      ready: true,
      isListening: true,
      deviceConfig: { manufacturer: 'Zooz', label: 'ZEN15', description: 'Power Switch' },
      values: [
        val(37, 'Binary Switch', 0, 'currentValue', true, md('boolean', { label: 'Current value' })),
        val(37, 'Binary Switch', 0, 'targetValue', true, md('boolean', { label: 'Target value', writeable: true })),
        val(38, 'Multilevel Switch', 0, 'Up', undefined, { type: 'boolean', readable: false, writeable: true, label: 'Perform a level change (Up)' }),
        val(38, 'Multilevel Switch', 0, 'duration', { value: 5, unit: 'seconds' }, md('duration', { label: 'Remaining duration' })),
        val(50, 'Meter', 0, 'value', 12.34, md('number', { label: 'Electric Consumption [kWh]', unit: 'kWh', ccSpecific: { meterType: 1, scale: 0 } }), { propertyKey: 65537, propertyKeyName: 'Electric_kWh_Consumed' }),
        val(50, 'Meter', 0, 'value', 150.5, md('number', { label: 'Electric Consumption [W]', unit: 'W' }), { propertyKey: 66049, propertyKeyName: 'Electric_W_Consumed' }),
        val(114, 'Manufacturer Specific', 0, 'manufacturerId', 634, md('number', { label: 'Manufacturer ID' })),
        val(134, 'Version', 0, 'firmwareVersions', ['1.4', '2.0'], md('string[]', { label: 'Z-Wave chip firmware versions' })),
        val(99, 'User Code', 0, 'userCode', { type: 'Buffer', data: [1, 2, 255] }, md('buffer', { label: 'User code (1)' }), { propertyKey: 1 }),
      ],
    },
    {
      nodeId: 4,
      index: 0,
      status: 3, // dead
      ready: true,
      deviceConfig: { manufacturer: 'Yale', label: 'YRD256' },
      values: [val(98, 'Door Lock', 0, 'currentMode', 255, md('number', { label: 'Current lock mode', states: { 0: 'Unsecured', 255: 'Secured' } }))],
    },
    {
      nodeId: 5,
      index: 0,
      status: 4,
      ready: true,
      deviceConfig: { manufacturer: 'Fibargroup', label: 'FGRGBW-442' },
      values: [
        val(38, 'Multilevel Switch', 1, 'currentValue', 99, md('number', { label: 'Current value', min: 0, max: 99 })),
        val(38, 'Multilevel Switch', 2, 'currentValue', 0, md('number', { label: 'Current value', min: 0, max: 99 })),
      ],
    },
  ];
}

const same = (a, b) => a.commandClass === b.commandClass && (a.endpoint || 0) === (b.endpoint || 0) && a.property === b.property && (a.propertyKey ?? null) === (b.propertyKey ?? null);

async function startZwaveJsServerSimulator(o = {}) {
  const state = {
    version: { type: 'version', driverVersion: o.driverVersion || '15.0.0', serverVersion: o.serverVersion || '3.0.0', homeId: 3735928559, minSchemaVersion: o.minSchemaVersion ?? 0, maxSchemaVersion: o.maxSchemaVersion ?? 44 },
    nodes: new Map((o.nodes || defaultNodes()).map((n) => [n.nodeId, JSON.parse(JSON.stringify(n))])),
  };
  const commands = [];
  const violations = [];
  const listeners = new Set();
  const sim = { commands, violations, state, connections: 0, schemas: [], hold: null };

  const tlsOptions = o.tls ? (() => {
    const { KEY, CERT } = require('./tlsFixture');
    return { key: KEY, cert: CERT };
  })() : null;

  const server = await startWsServer({
    path: o.path || '/',
    tlsOptions,
    requireToken: o.requireToken,
    onConnection(peer) {
      sim.connections++;
      let schema = 0;
      peer.sendJson(state.version);
      peer.on('close', () => listeners.delete(peer));
      peer.on('message', (text, isBinary) => {
        if (isBinary) return;
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        const { messageId, command, ...args } = msg;
        commands.push({ command, args });
        const ok = (result) => peer.sendJson({ type: 'result', messageId, success: true, result });
        const err = (errorCode, message) => peer.sendJson({ type: 'result', messageId, success: false, errorCode, message });
        if (!READ.has(command)) {
          violations.push({ command, args });
          return err('unknown_command', `Manifold simulator refuses ${command}`);
        }
        if (sim.hold === command) return;
        const node = state.nodes.get(args.nodeId);
        const findValue = () => node && node.values.find((v) => same(v, args.valueId || {}));
        switch (command) {
          case 'set_api_schema':
            if (args.schemaVersion < state.version.minSchemaVersion || args.schemaVersion > state.version.maxSchemaVersion) return err('schema_incompatible');
            schema = args.schemaVersion;
            sim.schemas.push(schema);
            return ok({});
          case 'start_listening':
            listeners.add(peer);
            return ok({
              state: {
                driver: { logConfig: { enabled: true, level: 'info' }, statisticsEnabled: false },
                controller: { homeId: state.version.homeId, ownNodeId: 1, sdkVersion: '7.19.3', type: 1, isPrimary: true },
                nodes: [...state.nodes.values()],
              },
            });
          case 'node.get_defined_value_ids':
            if (!node) return err('node_not_found');
            return ok({ valueIds: node.values.map(({ commandClass, endpoint, property, propertyKey }) => ({ commandClass, endpoint, property, ...(propertyKey !== undefined ? { propertyKey } : {}) })) });
          case 'node.get_value_metadata': {
            if (!node) return err('node_not_found');
            const v = findValue();
            return ok(v ? v.metadata : { type: 'any', readable: true, writeable: true });
          }
          case 'node.get_value': {
            if (schema < 14) return err('schema_incompatible', 'node.get_value needs schema 14');
            if (!node) return err('node_not_found');
            const v = findValue();
            return ok({ value: v ? v.value : undefined });
          }
          default:
            return err('unknown_command');
        }
      });
    },
  });

  const broadcast = (event) => {
    const text = JSON.stringify({ type: 'event', event });
    for (const p of listeners) p.send(text);
  };

  Object.assign(sim, {
    port: server.port,
    requests: server.requests,
    listeners,
    /** Change a value and stream "value updated". */
    valueUpdated(nodeId, valueId, newValue) {
      const n = state.nodes.get(nodeId);
      const v = n.values.find((x) => same(x, valueId));
      const prevValue = v ? v.value : undefined;
      if (v) v.value = newValue;
      broadcast({ source: 'node', event: 'value updated', nodeId, args: { commandClassName: v && v.commandClassName, commandClass: valueId.commandClass, endpoint: valueId.endpoint || 0, property: valueId.property, ...(valueId.propertyKey !== undefined ? { propertyKey: valueId.propertyKey } : {}), newValue, prevValue, propertyName: String(valueId.property) } });
    },
    valueAdded(nodeId, value) {
      state.nodes.get(nodeId).values.push(value);
      broadcast({ source: 'node', event: 'value added', nodeId, args: { commandClass: value.commandClass, endpoint: value.endpoint, property: value.property, propertyKey: value.propertyKey, newValue: value.value } });
    },
    valueRemoved(nodeId, valueId) {
      const n = state.nodes.get(nodeId);
      n.values = n.values.filter((x) => !same(x, valueId));
      broadcast({ source: 'node', event: 'value removed', nodeId, args: { ...valueId, prevValue: 1 } });
    },
    valueNotification(nodeId, valueId, value) {
      broadcast({ source: 'node', event: 'value notification', nodeId, args: { ...valueId, value } });
    },
    metadataUpdated(nodeId, valueId, metadata) {
      const v = state.nodes.get(nodeId).values.find((x) => same(x, valueId));
      if (v) v.metadata = metadata;
      broadcast({ source: 'node', event: 'metadata updated', nodeId, args: { ...valueId, metadata } });
    },
    /** 'sleep' | 'wake up' | 'dead' | 'alive' */
    nodeStatus(nodeId, event) {
      state.nodes.get(nodeId).status = { sleep: 1, 'wake up': 2, dead: 3, alive: 4 }[event];
      broadcast({ source: 'node', event, nodeId });
    },
    nodeAdded(node) {
      state.nodes.set(node.nodeId, node);
      broadcast({ source: 'controller', event: 'node added', node, result: {} });
    },
    nodeRemoved(nodeId) {
      const node = state.nodes.get(nodeId);
      state.nodes.delete(nodeId);
      broadcast({ source: 'controller', event: 'node removed', node, reason: 0 });
    },
    statistics(nodeId) {
      broadcast({ source: 'node', event: 'statistics updated', nodeId, statistics: { commandsTX: 1, commandsRX: 2 } });
    },
    driverReady() {
      broadcast({ source: 'driver', event: 'driver ready' });
    },
    /** Change a cached value without any event (resync must find it). */
    setSilently(nodeId, valueId, value) {
      state.nodes.get(nodeId).values.find((x) => same(x, valueId)).value = value;
    },
    sendRaw(text) {
      for (const p of listeners) p.send(text);
    },
    sendOversized(bytes) {
      broadcast({ source: 'driver', event: 'logging', message: 'x'.repeat(Math.max(0, bytes - 80)) });
    },
    sendFragmented(event) {
      for (const p of listeners) p.sendFragmented(JSON.stringify({ type: 'event', event }), 3);
    },
    dropAll() {
      for (const p of server.peers) p.drop();
    },
    close: () => server.close(),
  });
  return sim;
}

module.exports = { startZwaveJsServerSimulator, defaultNodes, READ_COMMANDS: [...READ] };
