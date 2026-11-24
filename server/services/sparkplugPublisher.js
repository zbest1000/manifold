'use strict';

const mqtt = require('mqtt');
const { encodePayload } = require('./sparkplugEncoder');

/**
 * Sparkplug B edge-node publisher — Manifold as a spec-respecting publisher,
 * not just an eavesdropper.
 *
 * One dedicated MQTT connection per (broker, group, edge node) session, with
 * the lifecycle the spec demands:
 * - CONNECT carries an NDEATH will with the session's bdSeq, so the broker
 *   announces our death for us.
 * - NBIRTH on connect (seq 0, bdSeq metric, `Node Control/Rebirth`).
 * - DBIRTH per device (full metric set) before any DDATA for it.
 * - DDATA on value changes; seq increments mod 256 across ALL node messages.
 * - NCMD `Node Control/Rebirth` → full rebirth (NBIRTH + all DBIRTHs).
 * - stop() publishes DDEATH/NDEATH cleanly.
 *
 * The dedicated connection matters: the will payload must carry THIS session's
 * bdSeq, which the shared explorer connection can't provide.
 *
 * Optionally, Manifold can also act as a Sparkplug HOST APPLICATION: a
 * dedicated connection per (broker, host id) whose CONNECT carries a retained
 * JSON will `{ online: false, timestamp }` on spBv1.0/STATE/{hostId}, and which
 * publishes retained `{ online: true, timestamp }` on every (re)connect — per
 * spec the reborn host must republish its STATE with a fresh timestamp.
 *
 * Connection config comes from the profile store (the manager doesn't retain
 * broker passwords, profiles do).
 */

class SparkplugPublisher {
  constructor({ profiles }) {
    this.profiles = profiles;
    this.sessions = new Map(); // `${brokerId} ${group} ${edge}` -> session
    this.hostSessions = new Map(); // `${brokerId} ${hostId}` -> host session
  }

  _brokerConfig(brokerId) {
    const entry = this.profiles.brokers().find((b) => b.config?.id === brokerId);
    if (!entry) throw new Error(`broker ${brokerId} has no saved profile (needed for a dedicated Sparkplug connection)`);
    return entry.config;
  }

  _session(brokerId, group, edge) {
    const key = `${brokerId} ${group} ${edge}`;
    let s = this.sessions.get(key);
    if (s) return s;

    const cfg = this._brokerConfig(brokerId);
    const bdSeq = Math.floor(Math.random() * 256);
    s = {
      key,
      brokerId,
      group,
      edge,
      bdSeq,
      seq: 0,
      online: false,
      devices: new Map(), // deviceId -> { metricNames: Set, lastValues: Map }
      stats: { published: 0, errors: 0, rebirths: 0, lastError: null },
      client: null
    };

    const url = `${cfg.protocol || 'mqtt'}://${cfg.host}:${Number(cfg.port) || 1883}`;
    s.client = mqtt.connect(url, {
      clientId: `manifold_spb_${edge}_${Date.now().toString(36)}`,
      username: cfg.username || undefined,
      password: cfg.password || undefined,
      clean: true,
      reconnectPeriod: 5000,
      will: {
        topic: `spBv1.0/${group}/NDEATH/${edge}`,
        payload: encodePayload({ metrics: [{ name: 'bdSeq', value: bdSeq, isBdSeq: true }], seq: null }),
        qos: 0,
        retain: false
      }
    });

    s.client.on('connect', () => {
      s.online = true;
      this._birth(s);
      s.client.subscribe(`spBv1.0/${group}/NCMD/${edge}`, { qos: 0 });
    });
    s.client.on('message', (topic) => {
      // Any NCMD is treated as a rebirth request — we expose no other node
      // commands, and per spec an unknown command must not crash the node.
      if (topic === `spBv1.0/${group}/NCMD/${edge}`) {
        s.stats.rebirths++;
        this._birth(s);
      }
    });
    s.client.on('error', (error) => {
      s.stats.errors++;
      s.stats.lastError = error.message;
    });
    s.client.on('close', () => {
      s.online = false;
    });

    this.sessions.set(key, s);
    return s;
  }

  _nextSeq(s) {
    const v = s.seq;
    s.seq = (s.seq + 1) % 256;
    return v;
  }

  _publish(s, topic, payloadOpts) {
    try {
      s.client.publish(topic, encodePayload(payloadOpts), { qos: 0 }, (error) => {
        if (error) {
          s.stats.errors++;
          s.stats.lastError = error.message;
        } else {
          s.stats.published++;
        }
      });
    } catch (error) {
      s.stats.errors++;
      s.stats.lastError = error.message;
    }
  }

  _birth(s) {
    s.seq = 0;
    this._publish(s, `spBv1.0/${s.group}/NBIRTH/${s.edge}`, {
      seq: this._nextSeq(s),
      metrics: [
        { name: 'bdSeq', value: s.bdSeq, isBdSeq: true },
        { name: 'Node Control/Rebirth', value: false }
      ]
    });
    for (const [deviceId, d] of s.devices) if (!d.offline) this._deviceBirth(s, deviceId, d);
  }

  _deviceBirth(s, deviceId, d) {
    this._publish(s, `spBv1.0/${s.group}/DBIRTH/${s.edge}/${deviceId}`, {
      seq: this._nextSeq(s),
      // Metadata (engUnit, engLow/engHigh, description) travels in BIRTH only.
      metrics: [...d.lastValues.entries()].map(([name, v]) => ({
        name,
        value: v.value,
        ts: v.ts,
        type: d.types.get(name),
        properties: d.props?.get(name)
      }))
    });
    d.birthed = true;
  }

  /**
   * Update a device's metrics. New metric names trigger a fresh DBIRTH (the
   * spec requires DBIRTH to declare every metric DDATA will carry); otherwise
   * changed values go out as DDATA.
   */
  updateDevice({ brokerId, group, edge, device, metrics }) {
    const s = this._session(brokerId, group, edge);
    let d = s.devices.get(device);
    if (!d) {
      d = { metricNames: new Set(), lastValues: new Map(), types: new Map(), props: new Map(), birthed: false };
      s.devices.set(device, d);
    }
    if (!d.props) d.props = new Map();
    d.offline = false;
    let needsBirth = !d.birthed;
    for (const m of metrics) {
      if (!d.metricNames.has(m.name)) {
        d.metricNames.add(m.name);
        needsBirth = true;
      }
      // Changed metadata (e.g. a unit edited on the tag) needs a new BIRTH to reach hosts.
      if (m.properties !== undefined) {
        const prevProps = d.props.get(m.name);
        if (JSON.stringify(prevProps) !== JSON.stringify(m.properties)) {
          if (d.props.has(m.name)) needsBirth = true;
          d.props.set(m.name, m.properties);
        }
      }
      // The datatype is pinned at first sight so BIRTH and DATA always agree.
      if (!d.types.has(m.name)) d.types.set(m.name, m.type);
      d.lastValues.set(m.name, { value: m.value, ts: m.ts || Date.now() });
    }
    if (!s.online) return; // values retained in lastValues; birth flows on connect

    if (needsBirth) {
      this._deviceBirth(s, device, d);
    } else {
      this._publish(s, `spBv1.0/${s.group}/DDATA/${s.edge}/${device}`, {
        seq: this._nextSeq(s),
        metrics: metrics.map((m) => ({ name: m.name, value: m.value, ts: m.ts || Date.now(), type: d.types.get(m.name) }))
      });
    }
  }

  /**
   * Source went offline/online: DDEATH (seq-numbered, only for a birthed
   * device) or DBIRTH with the last known values. Never opens a session by
   * itself; returns true if something was published.
   */
  setDeviceOnline({ brokerId, group, edge, device, online }) {
    const s = this.sessions.get(`${brokerId} ${group} ${edge}`);
    const d = s?.devices.get(device);
    if (!s || !d || !s.online) return false;
    if (!online) {
      if (!d.birthed) return false;
      d.birthed = false; // next update re-issues DBIRTH before any DDATA
      d.offline = true;
      this._publish(s, `spBv1.0/${s.group}/DDEATH/${s.edge}/${device}`, { seq: this._nextSeq(s), metrics: [] });
      return true;
    }
    d.offline = false;
    if (d.birthed || !d.lastValues.size) return false;
    this._deviceBirth(s, device, d);
    return true;
  }

  // ---- host application STATE sessions -----------------------------------------

  _stateTopic(hostId) {
    return `spBv1.0/STATE/${hostId}`;
  }

  _publishState(h, online) {
    const payload = JSON.stringify({ online, timestamp: Date.now() });
    return new Promise((resolve) => {
      h.client.publish(this._stateTopic(h.hostId), payload, { qos: 1, retain: true }, (error) => {
        if (error) {
          h.stats.errors++;
          h.stats.lastError = error.message;
        } else {
          h.stats.published++;
          h.stats.lastStateTs = Date.now();
        }
        resolve();
      });
    });
  }

  /** Start (or return) a host-application session for (brokerId, hostId). */
  startHost({ brokerId, hostId }) {
    const key = `${brokerId} ${hostId}`;
    let h = this.hostSessions.get(key);
    if (h) return h;

    const cfg = this._brokerConfig(brokerId);
    h = {
      key,
      brokerId,
      hostId,
      online: false,
      stats: { published: 0, errors: 0, lastError: null, lastStateTs: null },
      client: null
    };

    const url = `${cfg.protocol || 'mqtt'}://${cfg.host}:${Number(cfg.port) || 1883}`;
    h.client = mqtt.connect(url, {
      clientId: `manifold_host_${hostId}_${Date.now().toString(36)}`,
      username: cfg.username || undefined,
      password: cfg.password || undefined,
      clean: true,
      reconnectPeriod: 5000,
      will: {
        topic: this._stateTopic(hostId),
        payload: JSON.stringify({ online: false, timestamp: Date.now() }),
        qos: 1,
        retain: true
      }
    });

    // Fires on every (re)connect: the spec requires the reborn host to
    // republish its online STATE with a fresh timestamp.
    h.client.on('connect', () => {
      h.online = true;
      this._publishState(h, true);
    });
    h.client.on('error', (error) => {
      h.stats.errors++;
      h.stats.lastError = error.message;
    });
    h.client.on('close', () => {
      h.online = false;
    });

    this.hostSessions.set(key, h);
    return h;
  }

  /** Publish a clean retained offline STATE, then end the connection. */
  async stopHost(brokerId, hostId) {
    const key = `${brokerId} ${hostId}`;
    const h = this.hostSessions.get(key);
    if (!h) return false;
    this.hostSessions.delete(key);
    if (h.online) await this._publishState(h, false);
    // Graceful end so the offline STATE flushes instead of the will firing.
    await new Promise((resolve) => (h.client ? h.client.end(false, {}, resolve) : resolve()));
    return true;
  }

  getStatus() {
    const out = {};
    for (const [key, s] of this.sessions) {
      out[key] = { online: s.online, devices: s.devices.size, seq: s.seq, bdSeq: s.bdSeq, ...s.stats };
    }
    out.hosts = {};
    for (const [key, h] of this.hostSessions) {
      out.hosts[key] = { brokerId: h.brokerId, hostId: h.hostId, online: h.online, ...h.stats };
    }
    return out;
  }

  async stop() {
    const closing = [];
    for (const [, h] of this.hostSessions) {
      closing.push(
        (h.online ? this._publishState(h, false) : Promise.resolve()).then(
          () => new Promise((resolve) => (h.client ? h.client.end(false, {}, resolve) : resolve()))
        )
      );
    }
    this.hostSessions.clear();
    for (const s of this.sessions.values()) {
      if (s.online) {
        for (const deviceId of s.devices.keys()) {
          this._publish(s, `spBv1.0/${s.group}/DDEATH/${s.edge}/${deviceId}`, { seq: this._nextSeq(s), metrics: [] });
        }
        this._publish(s, `spBv1.0/${s.group}/NDEATH/${s.edge}`, {
          seq: null,
          metrics: [{ name: 'bdSeq', value: s.bdSeq, isBdSeq: true }]
        });
      }
      // Graceful end: the death certificates above must FLUSH before the socket
      // closes, or the broker-side will fires instead and the seq story lies.
      closing.push(new Promise((resolve) => (s.client ? s.client.end(false, {}, resolve) : resolve())));
    }
    await Promise.all(closing);
    this.sessions.clear();
  }
}

module.exports = SparkplugPublisher;
