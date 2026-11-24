'use strict';

const { EventEmitter } = require('events');

/**
 * OPC UA tag source adapter: wraps an OpcuaManager and speaks the normalized
 * tag-source contract used by TagBindings.
 *
 *   on(event, fn) / off(event, fn)
 *   ensureMonitored(sourceId, address, intervalMs) -> Promise
 *
 * Events
 *   'sample'       { sourceType:'opcua', sourceId, address, v, type, q, qReason?, tSource?, tRead }
 *   'source-state' { sourceType:'opcua', sourceId, state:'online'|'offline', reason }
 *
 * 'source-state' derives from the manager's optional 'connection-state' event;
 * if a manager never emits it, no source-state is produced (old behaviour).
 */

function opcQuality(status) {
  const s = String(status || '');
  if (s.startsWith('Good')) return 192;
  if (s.startsWith('Uncertain')) return 64;
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

class OpcuaSource extends EventEmitter {
  constructor(manager) {
    super();
    this.type = 'opcua';
    this.manager = manager;
    this._onValue = (evt) => {
      if (!evt) return;
      this.emit('sample', {
        sourceType: 'opcua',
        sourceId: evt.connectionId,
        address: evt.nodeId,
        v: evt.value,
        type: normalizeType(evt.dataType),
        q: opcQuality(evt.status),
        qReason: evt.status ? String(evt.status) : undefined,
        tSource: evt.sourceTimestamp ? new Date(evt.sourceTimestamp).getTime() || undefined : undefined,
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
    return this.manager.monitor(sourceId, address, intervalMs);
  }

  /** Detach from the wrapped manager. */
  close() {
    this.manager.off?.('value', this._onValue);
    this.manager.off?.('connection-state', this._onState);
    this.removeAllListeners();
  }
}

module.exports = { OpcuaSource, normalizeType, opcQuality };
