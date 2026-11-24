'use strict';

const path = require('path');
const net = require('net');
const dns = require('dns').promises;
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { DriverSupervisor } = require('./driverSupervisor');
const egressGuard = require('./egressGuard');

/**
 * Device manager: the main-process side of the southbound drivers
 * (docs/design/southbound-drivers.md). It owns device configuration, validates
 * it with each driver's pure validators, applies the egress guard, feeds the
 * desired device set to the DriverSupervisor (which runs the drivers in child
 * processes), keeps the latest value per tag, and exposes the normalized
 * tag-source events TagBindings consumes:
 *
 *   'sample'       { sourceType:'device', sourceId, address:<tagKey>, v, type, q, qReason?, tRead }
 *   'source-state' { sourceType:'device', sourceId, state:'online'|'offline', reason }
 *
 * Drivers are read-only; nothing here can write to a device.
 */

const DRIVER_MODULES = {
  'modbus-tcp': path.join(__dirname, '..', 'drivers', 'modbus', 'index.js'),
  s7: path.join(__dirname, '..', 'drivers', 's7', 'index.js'),
  'ethernet-ip': path.join(__dirname, '..', 'drivers', 'eip', 'index.js')
};

const MAX_TAGS_PER_DEVICE = 20000;
const MIN_INTERVAL_MS = 100;
const KEY_RE = /^[A-Za-z0-9_.\-:[\]]{1,128}$/;
const VALUE_FLUSH_MS = 250;

class DeviceValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'DeviceValidationError';
    this.details = details;
  }
}

function loadDrivers(modules) {
  const out = {};
  for (const [protocol, file] of Object.entries(modules)) {
    try {
      out[protocol] = { file, mod: require(file) };
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error; // a driver that is not shipped yet is simply absent
    }
  }
  return out;
}

function isLoopback(address) {
  if (net.isIPv4(address)) return address.startsWith('127.');
  return address === '::1' || /^::ffff:127\./i.test(address);
}

class DeviceManager extends EventEmitter {
  /**
   * @param {object} deps
   * @param {object} deps.profiles profile store with the `devices` collection
   * @param {object} [deps.io] socket.io server for UI updates
   * @param {object} [deps.driverModules] protocol -> absolute module path (tests)
   * @param {object} [deps.supervisorOptions] passed to DriverSupervisor
   * @param {(host:string)=>Promise<void>} [deps.guard] egress check override (tests)
   */
  constructor({ profiles, io = null, driverModules = DRIVER_MODULES, supervisorOptions = {}, guard = null }) {
    super();
    this.type = 'device';
    this.profiles = profiles;
    this.io = io;
    this.drivers = loadDrivers(driverModules);
    this.guard = guard || ((host) => this._guardTarget(host));
    this.values = new Map(); // deviceId -> Map(tagKey -> { v, type, q, qReason, tRead })
    this.states = new Map(); // deviceId -> { state, phase, reason, since }
    this.errors = new Map(); // deviceId -> last configuration/guard error
    this._dirty = new Map(); // deviceId -> Set(tagKey) pending socket flush
    this._flushTimer = null;
    this.started = false;

    this.supervisor = new DriverSupervisor({
      drivers: Object.fromEntries(Object.entries(this.drivers).map(([p, d]) => [p, d.file])),
      ...supervisorOptions
    });
    this.supervisor.on('samples', (batch) => this._onSamples(batch));
    this.supervisor.on('device-state', (evt) => this._onState(evt));
    this.supervisor.on('device-error', (evt) => {
      if (evt?.deviceId) this.errors.set(evt.deviceId, evt.error || 'device error');
      this.io?.emit('devices-changed');
    });
    this.supervisor.on('host-state', () => this.io?.emit('devices-changed'));
  }

  // ---- tag-source adapter contract (TagBindings) ---------------------------

  /** Polled devices need no per-tag monitor; reject tags the device does not define. */
  async ensureMonitored(deviceId, tagKey) {
    const device = this.profiles.getIn('devices', deviceId);
    if (!device) throw new Error(`device ${deviceId} not found`);
    if (!(device.tags || []).some((t) => t.key === tagKey)) {
      throw new Error(`device ${device.name || deviceId} has no tag "${tagKey}"`);
    }
  }

  // ---- lifecycle -------------------------------------------------------------

  async start() {
    if (this.started) return;
    this.started = true;
    await this.apply();
  }

  async stop() {
    this.started = false;
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = null;
    await this.supervisor.shutdown();
  }

  /** Push the stored device set to the supervisor (guarded hosts only). */
  async apply() {
    if (!this.started) return;
    const desired = [];
    const known = new Set();
    for (const device of this.profiles.listIn('devices')) {
      known.add(device.id);
      if (device.enabled === false) continue;
      try {
        await this.guard(device.host);
        this.errors.delete(device.id);
        desired.push(device);
      } catch (error) {
        this.errors.set(device.id, error.message);
        this._onState({ deviceId: device.id, state: 'offline', phase: 'stopped', reason: error.message, since: Date.now() });
      }
    }
    for (const id of [...this.values.keys()]) if (!known.has(id)) this.values.delete(id);
    for (const id of [...this.states.keys()]) if (!known.has(id)) this.states.delete(id);
    for (const id of [...this.errors.keys()]) if (!known.has(id)) this.errors.delete(id);
    this.supervisor.setDevices(desired);
    this.io?.emit('devices-changed');
  }

  /**
   * Device targets pass the egress guard. Loopback is refused unless
   * MANIFOLD_ALLOW_LOOPBACK_DEVICES=1 (local simulators); private ranges need
   * MANIFOLD_ALLOW_PRIVATE_TARGETS=1; metadata ranges are always refused.
   */
  async _guardTarget(host) {
    if (typeof egressGuard.assertAllowedDeviceTarget === 'function') {
      return egressGuard.assertAllowedDeviceTarget(host);
    }
    if (process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES === '1') {
      const addresses = net.isIP(host)
        ? [host]
        : (await dns.lookup(host, { all: true }).catch(() => [])).map((r) => r.address);
      if (addresses.length && addresses.every(isLoopback)) return undefined;
    }
    return egressGuard.assertAllowedHost(host);
  }

  // ---- configuration ---------------------------------------------------------

  protocols() {
    return Object.entries(this.drivers).map(([id, { mod }]) => ({ id, ...(mod.describe ? mod.describe() : {}) }));
  }

  /** Per-tag validation with the driver's pure validator. */
  validateTags(protocol, options, tags) {
    const driver = this.drivers[protocol];
    if (!driver) throw new DeviceValidationError(`unknown protocol "${protocol}"`);
    const seen = new Set();
    return (Array.isArray(tags) ? tags : []).map((tag) => {
      const key = tag?.key;
      if (typeof key !== 'string' || !KEY_RE.test(key)) {
        return { key: key ?? null, ok: false, error: 'key must be 1-128 characters of A-Z a-z 0-9 _ . - : [ ]' };
      }
      if (seen.has(key)) return { key, ok: false, error: 'duplicate key' };
      seen.add(key);
      try {
        const r = driver.mod.validateTag ? driver.mod.validateTag(tag, options || {}) : { ok: true };
        return r.ok ? { key, ok: true, normalized: r.normalized } : { key, ok: false, error: r.error };
      } catch (error) {
        return { key, ok: false, error: error.message };
      }
    });
  }

  /** Normalize and validate a device config; throws DeviceValidationError. */
  normalize(input, id) {
    const d = input || {};
    const driver = this.drivers[d.protocol];
    if (!driver) throw new DeviceValidationError(`protocol must be one of: ${Object.keys(this.drivers).join(', ')}`);
    if (typeof d.host !== 'string' || !d.host.trim() || /[\s/]/.test(d.host)) {
      throw new DeviceValidationError('host is required (hostname or IP address, no scheme)');
    }
    const desc = driver.mod.describe ? driver.mod.describe() : {};
    const port = d.port === undefined || d.port === null || d.port === '' ? desc.defaultPort : Number(d.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DeviceValidationError('port must be 1-65535');

    const pollGroups = (Array.isArray(d.pollGroups) && d.pollGroups.length ? d.pollGroups : [{ id: 'default', intervalMs: 1000 }]).map((g) => ({
      id: String(g.id || '').trim(),
      intervalMs: Number(g.intervalMs)
    }));
    const groupIds = new Set();
    for (const g of pollGroups) {
      if (!KEY_RE.test(g.id)) throw new DeviceValidationError(`poll group id "${g.id}" is invalid`);
      if (groupIds.has(g.id)) throw new DeviceValidationError(`duplicate poll group "${g.id}"`);
      if (!Number.isFinite(g.intervalMs) || g.intervalMs < MIN_INTERVAL_MS) {
        throw new DeviceValidationError(`poll group "${g.id}": intervalMs must be at least ${MIN_INTERVAL_MS}`);
      }
      groupIds.add(g.id);
    }

    const tags = Array.isArray(d.tags) ? d.tags : [];
    if (tags.length > MAX_TAGS_PER_DEVICE) throw new DeviceValidationError(`at most ${MAX_TAGS_PER_DEVICE} tags per device`);
    const options = d.options && typeof d.options === 'object' ? d.options : {};
    const results = this.validateTags(d.protocol, options, tags);
    const details = results.filter((r) => !r.ok).map((r) => ({ key: r.key, error: r.error }));
    for (const tag of tags) {
      if (tag?.pollGroup && !groupIds.has(tag.pollGroup)) {
        details.push({ key: tag.key ?? null, error: `unknown poll group "${tag.pollGroup}"` });
      }
    }
    if (details.length) throw new DeviceValidationError(`${details.length} invalid tag(s)`, details);

    // Protocol-specific top-level fields (unitId, rack, slot, ...) pass through;
    // the driver validates them again when it is created in the host process.
    const { status: _status, ...rest } = d;
    return {
      ...rest,
      id: id || d.id || randomUUID(),
      name: String(d.name || d.host).slice(0, 120),
      protocol: d.protocol,
      enabled: d.enabled !== false,
      host: d.host.trim(),
      port,
      options,
      limits: d.limits && typeof d.limits === 'object' ? d.limits : {},
      pollGroups,
      tags
    };
  }

  list() {
    const status = this.supervisor.getStatus();
    return this.profiles.listIn('devices').map((device) => ({ ...device, status: this.statusOf(device, status) }));
  }

  statusOf(device, status = this.supervisor.getStatus()) {
    const live = status.devices?.[device.id] || {};
    const state = this.states.get(device.id) || {};
    const error = this.errors.get(device.id);
    if (device.enabled === false) return { state: 'offline', phase: 'stopped', reason: 'disabled', tagCount: (device.tags || []).length };
    return {
      state: 'offline',
      phase: 'connecting',
      ...live,
      ...state,
      lastError: error || live.lastError || null,
      tagCount: (device.tags || []).length
    };
  }

  hosts() {
    return this.supervisor.getStatus().hosts || {};
  }

  async save(input, id) {
    const device = this.normalize(input, id);
    await this.guard(device.host); // refuse to store an unreachable-by-policy target
    const saved = this.profiles.upsertIn('devices', device.id, device);
    await this.apply();
    return saved;
  }

  async remove(id) {
    if (!this.profiles.removeIn('devices', id)) return false;
    await this.apply();
    return true;
  }

  async test(input) {
    const device = this.normalize({ ...input, tags: [] }, input?.id || 'test');
    await this.guard(device.host);
    const started = Date.now();
    try {
      const r = await this.supervisor.testConnection(device);
      return { ok: true, latencyMs: r?.latencyMs ?? Date.now() - started, info: r?.info ?? null };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  probe(id, args) {
    if (!this.profiles.getIn('devices', id)) throw new DeviceValidationError('device not found');
    return this.supervisor.probe(id, args || {});
  }

  getValues(id) {
    return Object.fromEntries(this.values.get(id) || []);
  }

  // ---- data path ---------------------------------------------------------------

  _onSamples(batch) {
    if (!batch || !Array.isArray(batch.samples)) return;
    const { deviceId } = batch;
    let store = this.values.get(deviceId);
    if (!store) this.values.set(deviceId, (store = new Map()));
    let dirty = this._dirty.get(deviceId);
    for (const s of batch.samples) {
      const tRead = s.tRead || batch.tRead || Date.now();
      store.set(s.key, { v: s.v, type: s.type, q: s.q, qReason: s.qReason, tRead });
      if (this.io) {
        if (!dirty) this._dirty.set(deviceId, (dirty = new Set()));
        dirty.add(s.key);
      }
      this.emit('sample', {
        sourceType: 'device',
        sourceId: deviceId,
        address: s.key,
        v: s.v,
        type: s.type || 'unknown',
        q: s.q,
        qReason: s.qReason,
        tRead
      });
    }
    if (this.io && !this._flushTimer) {
      this._flushTimer = setTimeout(() => this._flushValues(), VALUE_FLUSH_MS);
      this._flushTimer.unref?.();
    }
  }

  /** Coalesced, volatile UI updates: at most one batch per device per window. */
  _flushValues() {
    this._flushTimer = null;
    const target = this.io.volatile || this.io;
    for (const [deviceId, keys] of this._dirty) {
      const store = this.values.get(deviceId);
      if (!store) continue;
      const values = {};
      for (const key of keys) values[key] = store.get(key);
      target.emit('device-values', { deviceId, values });
    }
    this._dirty.clear();
  }

  _onState(evt) {
    if (!evt?.deviceId) return;
    const prev = this.states.get(evt.deviceId);
    this.states.set(evt.deviceId, { state: evt.state, phase: evt.phase, reason: evt.reason, since: evt.since });
    this.io?.emit('device-state', evt);
    if (!prev || prev.state !== evt.state) {
      this.emit('source-state', { sourceType: 'device', sourceId: evt.deviceId, state: evt.state, reason: evt.reason });
    }
  }
}

module.exports = { DeviceManager, DeviceValidationError, DRIVER_MODULES };
