'use strict';

/**
 * Matter Server WebSocket API (python-matter-server and its matter.js successor speak the same
 * API) - READ-ONLY encoding.
 *
 *   client -> server  { "message_id": "m1", "command": "<command>", "args": { ... } }
 *   server -> client  greeting (first message): ServerInfo
 *                       { fabric_id, compressed_fabric_id, schema_version,
 *                         min_supported_schema_version, sdk_version, wifi_credentials_set,
 *                         thread_credentials_set, bluetooth_enabled }
 *                     result  { message_id, result }
 *                     error   { message_id, error_code, details }
 *                     event   { event: "attribute_updated" | "node_added" | ..., data }
 *
 * Only the commands in READ_COMMANDS can be encoded. Everything that commissions, controls,
 * writes, removes or re-interviews a node is absent from this file on purpose; encodeCommand
 * throws for anything not on the list, and it is the only function that builds outgoing text.
 */

const { JsonWsSession, BridgeError } = require('../common/wsJsonSession');

/** The complete set of commands Manifold may send to a Matter Server. */
const READ_COMMANDS = Object.freeze([
  'start_listening', // full node dump, then the event stream
  'get_nodes', // node dump (periodic resync)
  'get_node', // one node
  'server_info', // server info
  'diagnostics', // server diagnostics (info + nodes + recent events)
  'read_attribute', // live attribute read (schema >= 9), used only by "probe"
]);
const READ_SET = new Set(READ_COMMANDS);

/** Schema version this client was written against (python-matter-server 8.x / matter.js server). */
const SCHEMA_TESTED = 11;
/** read_attribute needs at least this schema. */
const SCHEMA_READ_ATTRIBUTE = 9;

class ReadOnlyViolation extends Error {
  constructor(command) {
    super(`command "${command}" is not a read command; Manifold never sends it`);
    this.name = 'ReadOnlyViolation';
  }
}

function encodeCommand(command, args, messageId) {
  if (typeof command !== 'string' || !READ_SET.has(command)) throw new ReadOnlyViolation(command);
  return JSON.stringify({ message_id: String(messageId), command, args: args && typeof args === 'object' ? args : {} });
}

function isServerInfo(o) {
  return o && typeof o === 'object' && !('message_id' in o) && !('event' in o) && Number.isInteger(o.schema_version);
}

function classify(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (isServerInfo(o)) return { kind: 'hello', data: o };
  if (typeof o.event === 'string') return { kind: 'event', data: { event: o.event, data: o.data } };
  if ('message_id' in o) {
    if ('error_code' in o) {
      const details = typeof o.details === 'string' ? o.details : o.details ? JSON.stringify(o.details) : '';
      return { kind: 'result', id: o.message_id, ok: false, code: o.error_code, error: `error ${o.error_code}${details ? `: ${details}` : ''}` };
    }
    return { kind: 'result', id: o.message_id, ok: true, result: o.result };
  }
  return null;
}

/** Schema notes for the connection test and status: what works with this server. */
function schemaReport(info) {
  const notes = [];
  const v = info.schema_version;
  if (Number.isInteger(info.min_supported_schema_version) && info.min_supported_schema_version > SCHEMA_TESTED) {
    throw new BridgeError(
      'schema',
      `the Matter Server requires clients of schema ${info.min_supported_schema_version} or newer; Manifold speaks schema ${SCHEMA_TESTED}. Update Manifold or use an older server.`
    );
  }
  if (v > SCHEMA_TESTED) notes.push(`server schema ${v} is newer than the tested ${SCHEMA_TESTED}; reading should still work`);
  if (v < SCHEMA_READ_ATTRIBUTE) notes.push(`schema ${v} has no read_attribute: probe shows the server's cached value`);
  return { schema: v, canReadAttribute: v >= SCHEMA_READ_ATTRIBUTE, notes };
}

/**
 * One connection to a Matter Server.
 * Events: 'event' ({event, data}), 'lost' (reason).
 */
class MatterServerConnection {
  constructor({ target, timeouts, ws, createWs }) {
    this.timeouts = { hello: 5000, request: 10000, listen: 30000, ...(timeouts || {}) };
    this.session = new JsonWsSession({ target, encode: encodeCommand, classify, ws, createWs });
    this.info = null;
    this.report = null;
  }

  on(evt, fn) {
    this.session.on(evt, fn);
    return this;
  }

  isOpen() {
    return this.session.isOpen();
  }

  async open() {
    this.info = await this.session.open(this.timeouts.hello);
    this.report = schemaReport(this.info);
    this.session.on('hello', (info) => {
      this.info = info;
    });
    return this.info;
  }

  /** start_listening: resolves with the node list; events follow on 'event'. */
  async startListening() {
    const nodes = await this.session.request('start_listening', {}, this.timeouts.listen);
    if (!Array.isArray(nodes)) throw new BridgeError('protocol', 'start_listening did not return a node list');
    return nodes;
  }

  async getNodes() {
    const nodes = await this.session.request('get_nodes', {}, this.timeouts.listen);
    if (!Array.isArray(nodes)) throw new BridgeError('protocol', 'get_nodes did not return a node list');
    return nodes;
  }

  getNode(nodeId) {
    return this.session.request('get_node', { node_id: nodeId }, this.timeouts.request);
  }

  /** Live read through the server (a Matter read interaction). Returns { "<ep>/<cl>/<attr>": value }. */
  async readAttribute(nodeId, attributePath) {
    if (!this.report || !this.report.canReadAttribute) throw new BridgeError('schema', 'this server version has no read_attribute');
    const r = await this.session.request('read_attribute', { node_id: nodeId, attribute_path: attributePath }, this.timeouts.request);
    // Older servers answered with the bare value; current ones with a path -> value map.
    return r && typeof r === 'object' && !Array.isArray(r) && attributePath in r ? r : { [attributePath]: r };
  }

  close() {
    return this.session.close();
  }
}

module.exports = { MatterServerConnection, READ_COMMANDS, encodeCommand, classify, schemaReport, ReadOnlyViolation, SCHEMA_TESTED, SCHEMA_READ_ATTRIBUTE };
