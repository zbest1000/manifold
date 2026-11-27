'use strict';

/**
 * Z-Wave JS Server (@zwave-js/server) WebSocket API - READ-ONLY encoding.
 *
 *   server -> client  greeting: { type:"version", driverVersion, serverVersion, homeId,
 *                                 minSchemaVersion, maxSchemaVersion }
 *   client -> server  { messageId, command, ...args }
 *   server -> client  { type:"result", messageId, success:true, result }
 *                     { type:"result", messageId, success:false, errorCode, message?, zwaveErrorCode? }
 *                     { type:"event", event:{ source:"driver"|"controller"|"node", event, ... } }
 *
 * Only READ_COMMANDS can be encoded; encodeCommand is the only function that builds outgoing
 * text and throws for anything else. Every command on the list is answered from the server's
 * own value cache: none of them transmits on the Z-Wave radio, so a battery device is never
 * woken. (node.poll_value, node.refresh_values, node.refresh_info, node.ping and the like DO
 * transmit; they are not on the list and are not named in this driver.)
 */

const { JsonWsSession, BridgeError } = require('../common/wsJsonSession');

const READ_COMMANDS = Object.freeze([
  'set_api_schema', // choose the API schema for this connection (no device traffic)
  'start_listening', // full state (driver, controller, nodes with values), then events
  'node.get_defined_value_ids', // cached value ids of a node
  'node.get_value_metadata', // cached metadata of one value
  'node.get_value', // cached value (schema >= 14)
]);
const READ_SET = new Set(READ_COMMANDS);

/** Highest schema this client was written and tested against. */
const SCHEMA_MAX = 44;
/** Oldest schema accepted (start_listening state with node values and status). */
const SCHEMA_MIN = 3;
/** node.get_value exists from this schema. */
const SCHEMA_GET_VALUE = 14;

class ReadOnlyViolation extends Error {
  constructor(command) {
    super(`command "${command}" is not a read command; Manifold never sends it`);
    this.name = 'ReadOnlyViolation';
  }
}

function encodeCommand(command, args, messageId) {
  if (typeof command !== 'string' || !READ_SET.has(command)) throw new ReadOnlyViolation(command);
  const a = args && typeof args === 'object' ? args : {};
  const { messageId: _m, command: _c, ...rest } = a; // arguments cannot override the envelope
  return JSON.stringify({ messageId: String(messageId), command, ...rest });
}

function classify(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (o.type === 'version' && Number.isInteger(o.maxSchemaVersion)) return { kind: 'hello', data: o };
  if (o.type === 'result' && 'messageId' in o) {
    if (o.success === true) return { kind: 'result', id: o.messageId, ok: true, result: o.result };
    const why = [o.errorCode, o.message || o.zwaveErrorCodeName || (o.zwaveErrorCode !== undefined ? `Z-Wave error ${o.zwaveErrorCode}` : '')].filter(Boolean).join(': ');
    return { kind: 'result', id: o.messageId, ok: false, code: o.errorCode, error: why || 'command failed' };
  }
  if (o.type === 'event' && o.event && typeof o.event === 'object' && typeof o.event.event === 'string') return { kind: 'event', data: o.event };
  return null;
}

/** Pick the schema for a server's range, or throw a clear error. */
function chooseSchema(version) {
  const min = Number.isInteger(version.minSchemaVersion) ? version.minSchemaVersion : 0;
  const max = version.maxSchemaVersion;
  const schema = Math.min(max, SCHEMA_MAX);
  if (schema < min) throw new BridgeError('schema', `Z-Wave JS Server requires schema ${min} or newer; Manifold speaks up to ${SCHEMA_MAX}. Update Manifold or use an older server.`);
  if (schema < SCHEMA_MIN) throw new BridgeError('schema', `Z-Wave JS Server ${version.serverVersion || ''} offers schema ${max} at most; Manifold needs ${SCHEMA_MIN} or newer. Update the server.`.replace('  ', ' '));
  const notes = [];
  if (max > SCHEMA_MAX) notes.push(`server offers schema ${max}; Manifold uses ${SCHEMA_MAX}, the newest it was tested with`);
  if (schema < SCHEMA_GET_VALUE) notes.push(`schema ${schema} has no node.get_value: values come from the event stream only, without periodic resync`);
  return { schema, canGetValue: schema >= SCHEMA_GET_VALUE, notes };
}

class ZwaveJsConnection {
  constructor({ target, timeouts, ws, createWs }) {
    this.timeouts = { hello: 5000, request: 10000, listen: 30000, ...(timeouts || {}) };
    this.session = new JsonWsSession({ target, encode: encodeCommand, classify, ws, createWs });
    this.version = null;
    this.schema = null;
  }

  on(evt, fn) {
    this.session.on(evt, fn);
    return this;
  }

  isOpen() {
    return this.session.isOpen();
  }

  /** Connect, read the version greeting and agree on a schema. */
  async open() {
    this.version = await this.session.open(this.timeouts.hello);
    this.schema = chooseSchema(this.version);
    await this.session.request('set_api_schema', { schemaVersion: this.schema.schema }, this.timeouts.request);
    return this.version;
  }

  /** start_listening: resolves with { driver, controller, nodes }; events follow. */
  async startListening() {
    const r = await this.session.request('start_listening', {}, this.timeouts.listen);
    const state = r && r.state;
    if (!state || !Array.isArray(state.nodes)) throw new BridgeError('protocol', 'start_listening did not return a state with nodes');
    return state;
  }

  async getValue(nodeId, valueId) {
    if (!this.schema.canGetValue) throw new BridgeError('schema', 'node.get_value needs schema 14');
    const r = await this.session.request('node.get_value', { nodeId, valueId }, this.timeouts.request);
    return r ? r.value : undefined;
  }

  async getValueMetadata(nodeId, valueId) {
    return this.session.request('node.get_value_metadata', { nodeId, valueId }, this.timeouts.request);
  }

  async getDefinedValueIds(nodeId) {
    const r = await this.session.request('node.get_defined_value_ids', { nodeId }, this.timeouts.request);
    return r && Array.isArray(r.valueIds) ? r.valueIds : [];
  }

  close() {
    return this.session.close();
  }
}

module.exports = { ZwaveJsConnection, READ_COMMANDS, encodeCommand, classify, chooseSchema, ReadOnlyViolation, SCHEMA_MAX, SCHEMA_MIN, SCHEMA_GET_VALUE };
