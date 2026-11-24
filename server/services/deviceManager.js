'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { DriverSupervisor } = require('./driverSupervisor');
const egressGuard = require('./egressGuard');
const { compiledView } = require('./mqttMatch');
const profilesModel = require('./deviceProfiles');

/**
 * Device manager: the main-process side of the southbound drivers
 * (docs/design/southbound-drivers.md). It owns device configuration, validates
 * it with each driver's pure validators, applies the egress guard, feeds the
 * desired device set to the DriverSupervisor (which runs the drivers in child
 * processes), keeps the latest value per tag, and exposes the normalized
 * tag-source events TagBindings consumes:
 *
 *   'sample'       { sourceType:'device', sourceId, address:<tagKey>, v, type, q, qReason?, tRead }
 *   'batch-end'    { sourceType:'device', sourceId }   after every supervisor samples batch
 *                  (one poll-group cycle), so object-per-asset bindings publish one object
 *   'source-state' { sourceType:'device', sourceId, state:'online'|'offline', reason }
 *
 * Device profiles (`deviceProfiles` collection, see ./deviceProfiles.js): a
 * device may reference { profileId, params }; everything downstream (drivers,
 * bindings, GET /api/devices) sees the EFFECTIVE device - profile tags with
 * params substituted plus the device's own ad-hoc tags. The stored device keeps
 * only its own tags, so editing a profile re-applies to every instance at once
 * (saveProfile validates every instance first and rejects the edit otherwise).
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

const MAX_META_TEXT = 512;

class DeviceValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'DeviceValidationError';
    this.details = details;
  }
}

/** A delete refused because other objects depend on it (HTTP 409). */
class DeviceConflictError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'DeviceConflictError';
    this.details = details;
  }
}

/** Mapping metadata on a tag (unit, description, property, range) -> error string or null. */
function tagMetaError(tag) {
  for (const f of ['unit', 'description', 'property']) {
    if (tag[f] === undefined || tag[f] === null || tag[f] === '') continue;
    if (typeof tag[f] !== 'string' || tag[f].length > MAX_META_TEXT) return `${f} must be a string of at most ${MAX_META_TEXT} characters`;
  }
  if (typeof tag.property === 'string' && tag.property) {
    if (/[+#]/.test(tag.property)) return 'property must not contain MQTT wildcards (+ #)';
    if (tag.property.startsWith('$')) return 'property must not start with $';
  }
  if (tag.range !== undefined && tag.range !== null) {
    const r = tag.range;
    if (typeof r !== 'object' || !Number.isFinite(Number(r.min)) || !Number.isFinite(Number(r.max)) || Number(r.min) >= Number(r.max)) {
      return 'range must be { min, max } with finite numbers and min < max';
    }
  }
  return null;
}

function checkPollGroups(input) {
  const pollGroups = input.map((g) => ({ id: String(g?.id || '').trim(), intervalMs: Number(g?.intervalMs) }));
  const groupIds = new Set();
  for (const g of pollGroups) {
    if (!KEY_RE.test(g.id)) throw new DeviceValidationError(`poll group id "${g.id}" is invalid`);
    if (groupIds.has(g.id)) throw new DeviceValidationError(`duplicate poll group "${g.id}"`);
    if (!Number.isFinite(g.intervalMs) || g.intervalMs < MIN_INTERVAL_MS) {
      throw new DeviceValidationError(`poll group "${g.id}": intervalMs must be at least ${MIN_INTERVAL_MS}`);
    }
    groupIds.add(g.id);
  }
  return pollGroups;
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
    // deviceId -> { device: effective device, errors }, rebuilt on profile-store revision.
    this.effective = compiledView(profiles, () => {
      const out = new Map();
      for (const d of this.profiles.listIn('devices')) {
        const profile = d.profileId ? this.profiles.getIn('deviceProfiles', d.profileId) : null;
        out.set(d.id, profilesModel.effectiveDevice(d, profile));
      }
      return out;
    });

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
    const device = this.effectiveDevice(deviceId);
    if (!device) throw new Error(`device ${deviceId} not found`);
    if (!(device.tags || []).some((t) => t.key === tagKey)) {
      throw new Error(`device ${device.name || deviceId} has no tag "${tagKey}"`);
    }
  }

  /** Effective device (profile tags + ad-hoc tags), or null. */
  effectiveDevice(id) {
    return this.effective().get(id)?.device || null;
  }

  /** Effective tags of a device ([] when unknown). */
  effectiveTags(id) {
    return this.effectiveDevice(id)?.tags || [];
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
    for (const [id, eff] of this.effective()) {
      const device = eff.device;
      known.add(id);
      if (device.enabled === false) continue;
      if (eff.errors.length) {
        const reason = `configuration: ${eff.errors[0].error}`;
        this.errors.set(id, reason);
        this._onState({ deviceId: id, state: 'offline', phase: 'stopped', reason, since: Date.now() });
        continue;
      }
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
    await egressGuard.assertAllowedDeviceTarget(host, { purpose: 'device' });
  }

  // ---- configuration ---------------------------------------------------------

  /** Driver descriptors in the one shape the UI renders forms from. */
  protocols() {
    const TYPES = { integer: 'number', number: 'number', select: 'select', boolean: 'boolean' };
    const field = (f) => ({
      ...f,
      name: f.name ?? f.key,
      label: f.label || f.name || f.key,
      type: TYPES[f.type] || 'text' // tsap, string, ... render as text inputs
    });
    // A "presets" entry is not an input: it becomes descriptor.presets,
    // one-click value sets such as the S7 rack/slot per CPU family.
    const split = (fields = []) => ({
      fields: fields.filter((f) => f.type !== 'presets').map(field),
      presets: fields.filter((f) => f.type === 'presets').flatMap((f) => f.presets || [])
    });
    return Object.entries(this.drivers).map(([id, { mod }]) => {
      const d = mod.describe ? mod.describe() : {};
      return {
        ...d,
        id,
        label: d.label || id,
        experimental: Boolean(d.experimental),
        capabilities: { browse: false, subscribe: false, maxInFlight: 1, ...(d.capabilities || {}) },
        deviceFields: split(d.deviceFields).fields,
        optionFields: split(d.optionFields).fields,
        presets: split(d.deviceFields).presets,
        tagTypes: d.tagTypes || []
      };
    });
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
        const metaError = tagMetaError(tag);
      if (metaError) return { key, ok: false, error: metaError };
      const r = driver.mod.validateTag ? driver.mod.validateTag(tag, options || {}) : { ok: true };
        return r.ok ? { key, ok: true, normalized: r.normalized } : { key, ok: false, error: r.error };
      } catch (error) {
        return { key, ok: false, error: error.message };
      }
    });
  }

  /**
   * Normalize and validate a device config; throws DeviceValidationError.
   * `profileOverride` validates against a profile that is not stored yet
   * (profile edits check every instance before saving).
   */
  normalize(input, id, { profileOverride } = {}) {
    const d = input || {};
    let profile = null;
    if (d.profileId !== undefined && d.profileId !== null && d.profileId !== '') {
      profile = profileOverride && profileOverride.id === d.profileId ? profileOverride : this.profiles.getIn('deviceProfiles', d.profileId);
      if (!profile) throw new DeviceValidationError(`device profile "${d.profileId}" not found`);
      if (d.protocol && d.protocol !== profile.protocol) {
        throw new DeviceValidationError(`protocol "${d.protocol}" does not match the profile's "${profile.protocol}"`);
      }
    }
    const protocol = profile ? profile.protocol : d.protocol;
    const driver = this.drivers[protocol];
    if (!driver) throw new DeviceValidationError(`protocol must be one of: ${Object.keys(this.drivers).join(', ')}`);
    if (typeof d.host !== 'string' || !d.host.trim() || /[\s/]/.test(d.host)) {
      throw new DeviceValidationError('host is required (hostname or IP address, no scheme)');
    }
    const desc = driver.mod.describe ? driver.mod.describe() : {};
    const port = d.port === undefined || d.port === null || d.port === '' ? desc.defaultPort : Number(d.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DeviceValidationError('port must be 1-65535');

    // A profile instance stores only its own poll groups (may be none: the profile's apply).
    const rawGroups = Array.isArray(d.pollGroups) && d.pollGroups.length ? d.pollGroups : profile ? [] : [{ id: 'default', intervalMs: 1000 }];
    const pollGroups = checkPollGroups(rawGroups);

    const tags = profile ? profilesModel.ownTags(d.tags) : Array.isArray(d.tags) ? d.tags : [];
    const options = d.options && typeof d.options === 'object' ? d.options : {};
    const params = d.params && typeof d.params === 'object' && !Array.isArray(d.params) ? d.params : undefined;

    // Protocol-specific top-level fields (unitId, rack, slot, ...) pass through;
    // the driver validates them again when it is created in the host process.
    const { status: _status, ownTags: _own, paramValues: _pv, profileErrors: _pe, ...rest } = d;
    const device = {
      ...rest,
      id: id || d.id || randomUUID(),
      name: String(d.name || d.host).slice(0, 120),
      protocol,
      enabled: d.enabled !== false,
      host: d.host.trim(),
      port,
      options,
      limits: d.limits && typeof d.limits === 'object' ? d.limits : {},
      pollGroups,
      tags
    };
    if (profile) {
      device.profileId = profile.id;
      device.params = params || {};
    } else {
      delete device.profileId;
      delete device.params;
    }

    // Validate what the driver will actually run: the effective device.
    const { device: eff, errors } = profilesModel.effectiveDevice(device, profile);
    const details = errors.map((e) => ({ key: e.key ?? null, error: e.error }));
    if (eff.tags.length > MAX_TAGS_PER_DEVICE) throw new DeviceValidationError(`at most ${MAX_TAGS_PER_DEVICE} tags per device`);
    if (profile) checkPollGroups(eff.pollGroups);
    const groupIds = new Set(eff.pollGroups.map((g) => g.id));
    for (const r of this.validateTags(protocol, eff.options, eff.tags)) {
      if (!r.ok && !details.some((x) => x.key === r.key && x.error === r.error)) details.push({ key: r.key, error: r.error });
    }
    for (const tag of eff.tags) {
      if (tag?.pollGroup && !groupIds.has(tag.pollGroup)) {
        details.push({ key: tag.key ?? null, error: `unknown poll group "${tag.pollGroup}"` });
      }
    }
    if (details.length) throw new DeviceValidationError(`${details.length} invalid tag(s)`, details);
    return device;
  }

  // ---- device profiles ---------------------------------------------------------

  listProfiles() {
    const instances = new Map();
    for (const d of this.profiles.listIn('devices')) {
      if (!d.profileId) continue;
      if (!instances.has(d.profileId)) instances.set(d.profileId, []);
      instances.get(d.profileId).push({ id: d.id, name: d.name });
    }
    return this.profiles.listIn('deviceProfiles').map((p) => ({ ...p, instances: instances.get(p.id) || [] }));
  }

  instancesOf(profileId) {
    return this.profiles.listIn('devices').filter((d) => d.profileId === profileId);
  }

  /** Normalize a profile; static checks only (instances are checked in saveProfile). */
  normalizeProfile(input, id) {
    const p = input || {};
    const driver = this.drivers[p.protocol];
    if (!driver) throw new DeviceValidationError(`protocol must be one of: ${Object.keys(this.drivers).join(', ')}`);
    const paramError = profilesModel.validateParamDecls(p.params);
    if (paramError) throw new DeviceValidationError(paramError);
    const params = (p.params || []).map((x) => ({
      name: x.name,
      ...(x.default !== undefined && x.default !== null && x.default !== '' ? { default: x.default } : {}),
      ...(x.description ? { description: String(x.description).slice(0, MAX_META_TEXT) } : {})
    }));
    const pollGroups = checkPollGroups(Array.isArray(p.pollGroups) && p.pollGroups.length ? p.pollGroups : [{ id: 'default', intervalMs: 1000 }]);
    const tags = profilesModel.ownTags(p.tags).map(({ origin: _o, ...t }) => t);
    if (tags.length > MAX_TAGS_PER_DEVICE) throw new DeviceValidationError(`at most ${MAX_TAGS_PER_DEVICE} tags per profile`);
    const options = p.options && typeof p.options === 'object' ? p.options : {};
    const declared = new Set(params.map((x) => x.name));
    const defaults = Object.fromEntries(params.filter((x) => x.default !== undefined).map((x) => [x.name, x.default]));
    const details = [];
    const groupIds = new Set(pollGroups.map((g) => g.id));
    const seenKeys = new Set();
    // Tags whose placeholders all have defaults are validated with the driver now;
    // the rest are validated per instance (saveProfile / device save).
    const checkable = [];
    for (const t of tags) {
      if (!t || typeof t.key !== 'string' || !t.key) {
        details.push({ key: t?.key ?? null, error: 'key is required' });
        continue;
      }
      if (seenKeys.has(t.key)) {
        details.push({ key: t.key, error: 'duplicate key' });
        continue;
      }
      seenKeys.add(t.key);
      const used = new Set();
      for (const f of ['key', 'address', 'property']) for (const n of profilesModel.placeholders(t[f])) used.add(n);
      const unknown = [...used].filter((n) => !declared.has(n));
      if (unknown.length) {
        details.push({ key: t.key, error: `undeclared parameter(s): ${unknown.map((n) => `{${n}}`).join(', ')}` });
        continue;
      }
      if (t.pollGroup && !groupIds.has(t.pollGroup)) details.push({ key: t.key, error: `unknown poll group "${t.pollGroup}"` });
      if ([...used].every((n) => Object.hasOwn(defaults, n))) checkable.push(t);
    }
    if (checkable.length) {
      const { tags: expanded } = profilesModel.expandProfileTags({ tags: checkable }, defaults);
      for (const r of this.validateTags(p.protocol, options, expanded)) if (!r.ok) details.push({ key: r.key, error: r.error });
    }
    if (details.length) throw new DeviceValidationError(`${details.length} invalid profile tag(s)`, details);
    return {
      id: id || p.id || randomUUID(),
      name: String(p.name || 'Profile').slice(0, 120),
      protocol: p.protocol,
      ...(p.description ? { description: String(p.description).slice(0, MAX_META_TEXT) } : {}),
      options,
      pollGroups,
      params,
      tags
    };
  }

  /**
   * Create or edit a profile. An edit is applied to every instance at once: all
   * instances are validated against the new profile first, and if any would
   * become invalid nothing is stored and the per-instance errors are returned.
   */
  async saveProfile(input, id) {
    const profile = this.normalizeProfile(input, id);
    const failures = [];
    for (const d of this.instancesOf(profile.id)) {
      try {
        this.normalize(d, d.id, { profileOverride: profile });
      } catch (error) {
        failures.push({ deviceId: d.id, name: d.name, error: error.message, details: error.details });
      }
    }
    if (failures.length) {
      throw new DeviceValidationError(`profile change would invalidate ${failures.length} device instance(s); nothing was saved`, failures);
    }
    const saved = this.profiles.upsertIn('deviceProfiles', profile.id, profile);
    await this.apply();
    return saved;
  }

  async removeProfile(id) {
    if (!this.profiles.getIn('deviceProfiles', id)) return false;
    const used = this.instancesOf(id);
    if (used.length) {
      throw new DeviceConflictError(
        `Profile is used by ${used.length} device(s): ${used.slice(0, 10).map((d) => d.name || d.id).join(', ')}. Delete them first.`,
        used.map((d) => ({ id: d.id, name: d.name }))
      );
    }
    this.profiles.removeIn('deviceProfiles', id);
    return true;
  }

  /** Create a device from a profile: body { name, host, port?, params, ...protocol fields }. */
  async instantiate(profileId, body) {
    if (!this.profiles.getIn('deviceProfiles', profileId)) throw new DeviceValidationError('device profile not found');
    const { id: _ignored, tags, ...rest } = body || {};
    return this.save({ ...rest, tags: Array.isArray(tags) ? tags : [], profileId });
  }

  /** Devices with their EFFECTIVE tags (profile + ad-hoc); `ownTags` lists the ad-hoc ones of a profile instance. */
  list() {
    const status = this.supervisor.getStatus();
    const eff = this.effective();
    return this.profiles.listIn('devices').map((device) => {
      const e = eff.get(device.id);
      const tags = e ? e.device.tags : device.tags || [];
      const out = { ...device, tags, status: this.statusOf({ ...device, tags }, status) };
      if (device.profileId) {
        out.ownTags = device.tags || [];
        out.profileErrors = e?.errors || [];
      }
      return out;
    });
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

  /** Browse the controller's own tags (e.g. EtherNet/IP symbol list). */
  browse(id, node) {
    const device = this.profiles.getIn('devices', id);
    if (!device) throw new DeviceValidationError('device not found');
    const caps = this.protocols().find((p) => p.id === device.protocol)?.capabilities;
    if (!caps?.browse) throw new DeviceValidationError(`${device.protocol} devices cannot be browsed; enter tags manually or import a CSV`);
    return this.supervisor.browse(id, node || undefined, 20000);
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
    // Batch boundary: everything above came from one poll-group cycle.
    this.emit('batch-end', { sourceType: 'device', sourceId: deviceId });
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

module.exports = { DeviceManager, DeviceValidationError, DeviceConflictError, DRIVER_MODULES, tagMetaError };
