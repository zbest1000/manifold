'use strict';

const { LIMITS, BAD, typeOf } = require('./limits');

/**
 * The device registry of ONE broker: devices the enabled conventions found, their tags (with
 * metadata) and each tag's latest value. Conventions write to it; the IoT manager reads it and
 * turns changes into binding-engine samples.
 *
 *   device: { id, convention, stableId, name, manufacturer, model, description, details,
 *             availability: 'online'|'offline'|'unknown', availabilityReason, lastSeen,
 *             dynamicTags, tags: Map(key -> tag) }
 *   tag:    { key, name, type, unit?, range?, enum?, description?, deviceClass?, stateClass?,
 *             diagnostic?, topic, selector, unsupported?, value, q, reason?, t, rx }
 *
 * Caps: LIMITS.maxDevicesPerBroker devices, LIMITS.maxTagsPerDevice tags per device and
 * LIMITS.maxTagsPerBroker tags in all. Past a cap a device / tag is refused and counted, never
 * stored.
 */
const META_KEYS = ['name', 'type', 'unit', 'range', 'enum', 'presets', 'description', 'deviceClass', 'stateClass', 'diagnostic', 'topic', 'selector', 'unsupported', 'format'];

class IotRegistry {
  constructor(brokerId, { onSample = () => {}, onState = () => {}, onMeta = () => {} } = {}) {
    this.brokerId = brokerId;
    this.devices = new Map();
    this.tagCount = 0;
    this.refused = { devices: 0, tags: 0 };
    this.info = {}; // convention -> { ...status details (bridge state, versions) }
    this.cb = { onSample, onState, onMeta };
  }

  setConventionInfo(convention, info) {
    this.info[convention] = { ...(this.info[convention] || {}), ...info };
  }

  get(id) {
    return this.devices.get(id) || null;
  }

  isDynamic(id) {
    return Boolean(this.devices.get(id)?.dynamicTags);
  }

  _tagFrom(def, old) {
    const t = {};
    for (const k of META_KEYS) if (def[k] !== undefined && def[k] !== null && def[k] !== '') t[k] = def[k];
    t.key = String(def.key);
    t.name = t.name || t.key;
    t.type = t.type || 'unknown';
    t.value = old ? old.value : null;
    t.q = old ? old.q : null;
    t.reason = old ? old.reason : undefined;
    t.t = old ? old.t : null;
    t.rx = old ? old.rx : null;
    return t;
  }

  /** Insert or update a device; `tags` (when given) replaces its tag set, keeping values of kept keys. false when refused (cap). */
  upsertDevice(d) {
    let dev = this.devices.get(d.id);
    if (!dev) {
      if (this.devices.size >= LIMITS.maxDevicesPerBroker) {
        this.refused.devices++;
        return false;
      }
      dev = { id: d.id, tags: new Map(), availability: 'unknown', availabilityReason: null, lastSeen: null };
      this.devices.set(d.id, dev);
    }
    const before = this._sig(dev);
    for (const k of ['convention', 'stableId', 'name', 'manufacturer', 'model', 'description', 'details', 'dynamicTags']) if (d[k] !== undefined) dev[k] = d[k];
    if (Array.isArray(d.tags)) {
      const next = new Map();
      for (const def of d.tags) {
        if (!def || def.key === undefined || next.has(String(def.key))) continue;
        if (next.size >= LIMITS.maxTagsPerDevice) {
          this.refused.tags++;
          break;
        }
        const old = dev.tags.get(String(def.key));
        if (!old && this.tagCount + next.size - dev.tags.size >= LIMITS.maxTagsPerBroker) {
          this.refused.tags++;
          continue;
        }
        next.set(String(def.key), this._tagFrom(def, old));
      }
      this.tagCount += next.size - dev.tags.size;
      dev.tags = next;
    }
    if (this._sig(dev) !== before) this.cb.onMeta(this.brokerId, dev);
    return true;
  }

  _sig(dev) {
    const tags = [];
    for (const t of dev.tags.values()) tags.push([t.key, ...META_KEYS.map((k) => t[k])]);
    return JSON.stringify([dev.name, dev.manufacturer, dev.model, tags]);
  }

  removeDevice(id) {
    const dev = this.devices.get(id);
    if (!dev) return;
    this.tagCount -= dev.tags.size;
    this.devices.delete(id);
    this.cb.onMeta(this.brokerId, dev, { removed: true });
  }

  removeWhere(pred) {
    for (const dev of [...this.devices.values()]) if (pred(dev)) this.removeDevice(dev.id);
  }

  setAvailability(id, state, reason) {
    const dev = this.devices.get(id);
    if (!dev) return;
    if (dev.availability === state && dev.availabilityReason === reason) return;
    const changed = dev.availability !== state;
    dev.availability = state;
    dev.availabilityReason = reason || null;
    if (changed) this.cb.onState(this.brokerId, dev);
  }

  touch(id, msg) {
    const dev = this.devices.get(id);
    if (dev) dev.lastSeen = msg ? Date.parse(msg.timestamp) || Date.now() : Date.now();
  }

  /**
   * Store a tag value: { v, q, reason?, t? (source time) }. `def` creates the tag when the device
   * builds its tags from what it publishes (dynamicTags); otherwise unknown keys are ignored.
   */
  setValue(id, key, s, def = null) {
    const dev = this.devices.get(id);
    if (!dev) return;
    let tag = dev.tags.get(key);
    if (!tag) {
      if (!def) return;
      if (dev.tags.size >= LIMITS.maxTagsPerDevice || this.tagCount >= LIMITS.maxTagsPerBroker) {
        this.refused.tags++;
        return;
      }
      tag = this._tagFrom({ key, ...def, type: def.type || typeOf(s.v) }, null);
      dev.tags.set(key, tag);
      this.tagCount++;
      this.cb.onMeta(this.brokerId, dev);
    } else if (def && dev.dynamicTags && ((def.unit ?? undefined) !== tag.unit || (def.type && def.type !== tag.type && s.v !== null))) {
      // Tags built from payloads follow what the device says now (e.g. Tasmota TempUnit C -> F).
      if (def.unit) tag.unit = def.unit;
      else delete tag.unit;
      if (def.type && s.v !== null) tag.type = def.type;
      this.cb.onMeta(this.brokerId, dev);
    }
    const now = Date.now();
    tag.value = s.v === undefined ? null : s.v;
    tag.q = s.q;
    tag.reason = s.reason;
    tag.t = s.t || null;
    tag.rx = now;
    dev.lastSeen = now;
    this.cb.onSample(this.brokerId, dev, tag);
  }

  /** Effective quality of a tag: an offline device makes every value Bad. */
  static effective(dev, tag) {
    if (dev.availability === 'offline') return { q: BAD, reason: dev.availabilityReason || 'device offline' };
    return { q: tag.q, reason: tag.reason };
  }

  clear() {
    for (const id of [...this.devices.keys()]) this.removeDevice(id);
  }
}

module.exports = { IotRegistry, META_KEYS };
