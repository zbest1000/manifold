'use strict';

const { EventEmitter } = require('events');

/**
 * OPC UA tag source adapter: wraps an OpcuaManager and speaks the normalized
 * tag-source contract used by TagBindings.
 *
 *   on(event, fn) / off(event, fn)
 *   ensureMonitored(sourceId, address, intervalMs) -> Promise
 *   describe(sourceId, address) -> Promise<{ type, unit, range, description }>
 *     metadata the server publishes for a node (EngineeringUnits / EURange
 *     properties, DataType, Description); null fields when it has none.
 *
 * Events
 *   'sample'       { sourceType:'opcua', sourceId, address, v, type, q, qReason?, tSource?, tRead }
 *   'source-state' { sourceType:'opcua', sourceId, state:'online'|'offline', reason }
 *
 * 'source-state' derives from the manager's optional 'connection-state' event;
 * if a manager never emits it, no source-state is produced (old behaviour).
 */

/**
 * OPC UA status -> 0..255 quality (192 Good, 64 Uncertain, 0 Bad), from the
 * severity bits of the numeric code when there is one (a StatusCode object,
 * its number, or a string such as "BadSensorFailure (0x808c0000)"), else from
 * the name prefix. Names alone are fragile: "Good#Overflow", "GoodClamped" or
 * a localized name still carry the right severity in the code.
 */
function opcQuality(status) {
  let code;
  if (typeof status === 'number') code = status;
  else if (status && typeof status === 'object' && typeof status.value === 'number') code = status.value;
  else {
    const s = String(status ?? '');
    const hex = /0x([0-9a-f]{1,8})\b/i.exec(s);
    if (hex) code = parseInt(hex[1], 16);
    else if (/^\s*good/i.test(s)) return 192;
    else if (/^\s*uncertain/i.test(s)) return 64;
    else return 0;
  }
  const severity = (code >>> 30) & 0x3; // 00 Good, 01 Uncertain, 10/11 Bad
  if (severity === 0) return 192;
  if (severity === 1) return 64;
  return 0;
}

// OPC UA built-in type ids (Part 6) -> normalized names.
const BUILTIN_BY_ID = {
  1: 'bool', 2: 'int8', 3: 'uint8', 4: 'int16', 5: 'uint16', 6: 'int32', 7: 'uint32',
  8: 'int64', 9: 'uint64', 10: 'float32', 11: 'float64', 12: 'string', 13: 'datetime'
};
const BY_NAME = {
  boolean: 'bool', sbyte: 'int8', byte: 'uint8', int16: 'int16', uint16: 'uint16',
  int32: 'int32', uint32: 'uint32', int64: 'int64', uint64: 'uint64', float: 'float32',
  double: 'float64', string: 'string', datetime: 'datetime'
};

/** Normalize an OPC UA dataType (name like 'Double', 'DataType.Double', or numeric id). */
function normalizeType(dataType) {
  if (dataType === null || dataType === undefined) return 'unknown';
  const raw = String(dataType).trim();
  if (/^\d+$/.test(raw)) return BUILTIN_BY_ID[Number(raw)] || 'unknown';
  const name = raw.replace(/^DataType\./i, '').replace(/\s*\(\d+\)$/, '').toLowerCase();
  return BY_NAME[name] || 'unknown';
}

/**
 * Type of one sample. Arrays and matrices are not scalars of their element
 * type (a typed Sparkplug metric or a cast would turn them into null), so
 * they report 'unknown' and travel as JSON.
 */
function sampleType(evt) {
  if (evt.arrayType && evt.arrayType !== 'Scalar') return 'unknown';
  return normalizeType(evt.dataType);
}

function sampleTime(evt) {
  // Source timestamp first; servers without one still stamp the value when they read it.
  for (const t of [evt.sourceTimestamp, evt.serverTimestamp]) {
    if (!t) continue;
    const ms = new Date(t).getTime();
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return undefined;
}

class OpcuaSource extends EventEmitter {
  constructor(manager) {
    super();
    this.type = 'opcua';
    this.manager = manager;
    this._onValue = (evt) => {
      if (!evt) return;
      const q = opcQuality(evt.statusCode !== null && evt.statusCode !== undefined ? evt.statusCode : evt.status);
      this.emit('sample', {
        sourceType: 'opcua',
        sourceId: evt.connectionId,
        address: evt.nodeId,
        v: evt.value,
        type: sampleType(evt),
        q,
        qReason: q === 192 || !evt.status ? undefined : String(evt.status),
        tSource: sampleTime(evt),
        tRead: Date.now()
      });
    };
    this._onState = (evt) => {
      if (!evt || (evt.state !== 'online' && evt.state !== 'offline')) return;
      this.emit('source-state', {
        sourceType: 'opcua',
        sourceId: evt.connectionId,
        state: evt.state,
        reason: evt.reason
      });
    };
    manager.on('value', this._onValue);
    manager.on('connection-state', this._onState);
  }

  ensureMonitored(sourceId, address, intervalMs) {
    // Owned by the bindings: the OPC UA page stopping the same node keeps it monitored.
    return this.manager.monitor(sourceId, address, intervalMs, { owner: 'bindings' });
  }

  /** Server-side metadata of a node (unit, range, type, description), or null if unavailable. */
  async describe(sourceId, address) {
    if (typeof this.manager.describeNode !== 'function') return null;
    const meta = await this.manager.describeNode(sourceId, address);
    if (!meta) return null;
    return {
      type: normalizeType(meta.type) === 'unknown' ? null : normalizeType(meta.type),
      unit: meta.unit || null,
      range: meta.range || null,
      description: meta.description || null
    };
  }

  /** Detach from the wrapped manager. */
  close() {
    this.manager.off?.('value', this._onValue);
    this.manager.off?.('connection-state', this._onState);
    this.removeAllListeners();
  }
}

module.exports = { OpcuaSource, normalizeType, opcQuality };
