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
 * broker passwords, profiles do). Running host and edge-node sessions follow
 * edits and removals of their broker profile on their own (checkProfiles):
 * clean offline STATE / DDEATH+NDEATH on the old connection, then the new one.
 */

/**
 * Connection URL + options for a broker profile, matching what the intake
 * connection uses: TLS material, WebSocket path and MQTT version included.
 */
function connectTarget(cfg) {
  const protocol = cfg.protocol || 'mqtt';
  const isWs = protocol === 'ws' || protocol === 'wss';
  const port = Number(cfg.port) || (protocol === 'mqtts' ? 8883 : 1883);
  const url = `${protocol}://${cfg.host}:${port}${isWs ? cfg.wsPath || '/mqtt' : ''}`;
  const options = {
    username: cfg.username || undefined,
    password: cfg.username ? cfg.password || '' : cfg.password || undefined,
    rejectUnauthorized: cfg.rejectUnauthorized !== false
  };
  if (Number(cfg.mqttVersion) === 5) options.protocolVersion = 5;
  if (protocol === 'mqtts' || protocol === 'wss') {
    for (const k of ['ca', 'cert', 'key']) if (cfg[k]) options[k] = cfg[k];
  }
  return { url, options };
}

/** Changes whenever anything that affects the connection changes. */
function configSignature(cfg) {
  return JSON.stringify(
    ['protocol', 'host', 'port', 'wsPath', 'mqttVersion', 'username', 'password', 'rejectUnauthorized', 'ca', 'cert', 'key'].map((k) => cfg[k] ?? null)
  );
}

/** End an MQTT client gracefully (queued packets flush), forcibly after `ms`. */
function endClient(client, ms = 2000) {
  if (!client) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        client.end(true);
      } catch {
        /* already closed */
      }
      resolve();
    }, ms);
    timer.unref?.();
    try {
      client.end(false, {}, () => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

class SparkplugPublisher {
  /**
   * @param profiles   profile store (brokers(), rev)
   * @param watchMs    how often running sessions are checked against their
   *                   broker profile (edits and removals); 0 = only on use
   */
  constructor({ profiles, watchMs = 1000 }) {
    this.profiles = profiles;
    this.sessions = new Map(); // `${brokerId} ${group} ${edge}` -> session
    this.hostSessions = new Map(); // `${brokerId} ${hostId}` -> host session
    this._watchMs = watchMs;
    this._watchTimer = null;
    this._seenRev = undefined;
    this._switching = new Set(); // in-flight switch promises (stop() waits for them)
    this._stopped = false;
  }

  _brokerEntry(brokerId) {
    return this.profiles.brokers().find((b) => b.config?.id === brokerId) || null;
  }

  _brokerConfig(brokerId) {
    const entry = this._brokerEntry(brokerId);
    if (!entry) throw new Error(`broker ${brokerId} has no saved profile (needed for a dedicated Sparkplug connection)`);
    return entry.config;
  }

  // ---- following broker profile edits ----------------------------------------
  //
  // Every running edge-node and host session remembers the signature of the
  // broker settings it connected with. A cheap tick (and every use of a
  // session) compares it with the profile store once its revision moved: an
  // edited profile (host, port, credentials, TLS...) gets a clean offline
  // message on the OLD connection (DDEATH/NDEATH, or the retained offline
  // STATE) and only then a new connection with the new settings; a removed
  // profile gets the clean offline message and the session ends.

  _ensureWatch() {
    if (this._watchTimer || !this._watchMs || this._stopped) return;
    this._watchTimer = setInterval(() => this.checkProfiles(), this._watchMs);
    this._watchTimer.unref?.();
  }

  _stopWatchIfIdle() {
    if (this._watchTimer && this.sessions.size === 0 && this.hostSessions.size === 0) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
  }

  /** Compare running sessions with their broker profiles; switch or end the ones that changed. */
  checkProfiles() {
    const rev = this.profiles.rev;
    if (rev !== undefined && rev === this._seenRev) return;
    this._seenRev = rev;
    for (const session of [...this.sessions.values(), ...this.hostSessions.values()]) {
      if (session.switching || session.signature === undefined) continue; // not built from a profile (tests inject such)
      const entry = this._brokerEntry(session.brokerId);
      if (!entry) this._track(this._retire(session, null));
      else if (configSignature(entry.config) !== session.signature) this._track(this._retire(session, entry.config));
    }
    this._stopWatchIfIdle();
  }

  _track(promise) {
    this._switching.add(promise);
    promise.finally(() => this._switching.delete(promise));
    return promise;
  }

  /**
   * Take a session off its current connection with a clean offline message,
   * then reconnect it with `cfg` (edited profile) or drop it (cfg null).
   */
  async _retire(session, cfg) {
    const isHost = session.hostId !== undefined;
    const map = isHost ? this.hostSessions : this.sessions;
    session.switching = true;
    const client = session.client;
    const wasOnline = session.online;
    session.online = false;
    if (!cfg) map.delete(session.key);
    try {
      if (wasOnline && client) {
        if (isHost) await this._publishState(session, false, client);
        else this._deathCertificates(session, client);
      }
      await endClient(client);
    } finally {
      session.switching = false;
    }
    if (!cfg || this._stopped || map.get(session.key) !== session) return;
    if (isHost) this._connectHost(session, cfg);
    else this._connectEdge(session, cfg);
  }

  _deathCertificates(s, client) {
    for (const [deviceId, d] of s.devices) {
      if (!d.birthed) continue;
      d.birthed = false;
      this._publish(s, `spBv1.0/${s.group}/DDEATH/${s.edge}/${deviceId}`, { seq: this._nextSeq(s), metrics: [] }, client);
    }
    this._publish(s, `spBv1.0/${s.group}/NDEATH/${s.edge}`, { seq: null, metrics: [{ name: 'bdSeq', value: s.bdSeq, isBdSeq: true }] }, client);
  }

  // ---- edge-node sessions ------------------------------------------------------

  _session(brokerId, group, edge) {
    const key = `${brokerId} ${group} ${edge}`;
    const s = this.sessions.get(key);
    if (s) {
      // A moved revision may mean an edited or removed broker profile: switch
      // now instead of publishing one more message with the old settings.
      if (this.profiles.rev === undefined || this.profiles.rev !== this._seenRev) this.checkProfiles();
      if (this.sessions.get(key) === s) return s;
    }
    const cfg = this._brokerConfig(brokerId);
    const fresh = {
      key,
      brokerId,
      group,
      edge,
      bdSeq: 0,
      seq: 0,
      online: false,
      switching: false,
      devices: new Map(), // deviceId -> { metricNames: Set, lastValues: Map }
      stats: { published: 0, errors: 0, rebirths: 0, lastError: null },
      client: null
    };
    this.sessions.set(key, fresh);
    if (this._seenRev === undefined) this._seenRev = this.profiles.rev;
    this._connectEdge(fresh, cfg);
    this._ensureWatch();
    return fresh;
  }

  /** (Re)connect an edge-node session; a new connection is a new bdSeq session. */
  _connectEdge(s, cfg) {
    const { group, edge } = s;
    s.bdSeq = Math.floor(Math.random() * 256);
    s.signature = configSignature(cfg);
    s.online = false;
    for (const d of s.devices.values()) d.birthed = false; // births flow on connect
    const { url, options } = connectTarget(cfg);
    const client = mqtt.connect(url, {
      ...options,
      clientId: `manifold_spb_${edge}_${Date.now().toString(36)}`,
      clean: true,
      reconnectPeriod: 5000,
      will: {
        topic: `spBv1.0/${group}/NDEATH/${edge}`,
        payload: encodePayload({ metrics: [{ name: 'bdSeq', value: s.bdSeq, isBdSeq: true }], seq: null }),
        qos: 0,
        retain: false
      }
    });
    s.client = client;
    const mine = () => s.client === client && !s.switching;

    client.on('connect', () => {
      if (!mine()) return;
      s.online = true;
      this._birth(s);
      client.subscribe(`spBv1.0/${group}/NCMD/${edge}`, { qos: 0 });
    });
    client.on('message', (topic) => {
      // Any NCMD is treated as a rebirth request — we expose no other node
      // commands, and per spec an unknown command must not crash the node.
      if (mine() && topic === `spBv1.0/${group}/NCMD/${edge}`) {
        s.stats.rebirths++;
        this._birth(s);
      }
    });
    client.on('error', (error) => {
      if (s.client !== client) return;
      s.stats.errors++;
      s.stats.lastError = error.message;
    });
    client.on('close', () => {
      if (s.client === client) s.online = false;
    });
  }

  _nextSeq(s) {
    const v = s.seq;
    s.seq = (s.seq + 1) % 256;
    return v;
  }

  _publish(s, topic, payloadOpts, client = s.client) {
    try {
      client.publish(topic, encodePayload(payloadOpts), { qos: 0 }, (error) => {
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
   * Metadata (BIRTH properties) of known metrics changed - e.g. a unit, range,
   * limit or context edited on the binding or the device tag - while values may
   * not change for a while: re-issue DBIRTH with the last values so hosts see
   * it now. `properties` = { <metric name>: props | undefined } (undefined drops
   * them). Never opens a session or declares new metrics (updateDevice does
   * that). Only a birthed, online device is re-birthed; otherwise the new
   * properties are stored and travel with the next BIRTH. Same seq rules as
   * every other node message. Returns true if a DBIRTH was published.
   */
  refreshMetadata({ brokerId, group, edge, device, properties }) {
    const s = this.sessions.get(`${brokerId} ${group} ${edge}`);
    const d = s?.devices.get(device);
    if (!s || !d || !properties) return false;
    if (!d.props) d.props = new Map();
    let changed = false;
    for (const [name, p] of Object.entries(properties)) {
      if (!d.metricNames.has(name)) continue;
      if (JSON.stringify(d.props.get(name)) === JSON.stringify(p)) continue;
      if (p === undefined) d.props.delete(name);
      else d.props.set(name, p);
      changed = true;
    }
    if (!changed || !s.online || !d.birthed || d.offline) return false;
    this._deviceBirth(s, device, d);
    return true;
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

  _publishState(h, online, client = h.client) {
    const payload = JSON.stringify({ online, timestamp: Date.now() });
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000); // an unreachable broker must not hold a switch forever
      timer.unref?.();
      client.publish(this._stateTopic(h.hostId), payload, { qos: 1, retain: true }, (error) => {
        clearTimeout(timer);
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

  /**
   * Start (or return) a host-application session for (brokerId, hostId). A
   * running session follows edits and removals of its broker profile on its
   * own (see checkProfiles); calling startHost again is never required.
   */
  startHost({ brokerId, hostId }) {
    const key = `${brokerId} ${hostId}`;
    const existing = this.hostSessions.get(key);
    if (existing) {
      if (this.profiles.rev === undefined || this.profiles.rev !== this._seenRev) this.checkProfiles();
      if (this.hostSessions.get(key) === existing) return existing;
    }
    const cfg = this._brokerConfig(brokerId);
    const h = {
      key,
      brokerId,
      hostId,
      online: false,
      switching: false,
      stats: { published: 0, errors: 0, lastError: null, lastStateTs: null },
      client: null,
      signature: null
    };
    this.hostSessions.set(key, h);
    if (this._seenRev === undefined) this._seenRev = this.profiles.rev;
    this._connectHost(h, cfg);
    this._ensureWatch();
    return h;
  }

  _connectHost(h, cfg) {
    h.signature = configSignature(cfg);
    h.online = false;
    const { url, options } = connectTarget(cfg);
    const client = mqtt.connect(url, {
      ...options,
      clientId: `manifold_host_${h.hostId}_${Date.now().toString(36)}`,
      clean: true,
      reconnectPeriod: 5000,
      will: {
        topic: this._stateTopic(h.hostId),
        payload: JSON.stringify({ online: false, timestamp: Date.now() }),
        qos: 1,
        retain: true
      }
    });
    h.client = client;

    // Fires on every (re)connect: the spec requires the reborn host to
    // republish its online STATE with a fresh timestamp.
    client.on('connect', () => {
      if (h.client !== client || h.switching) return;
      h.online = true;
      this._publishState(h, true);
    });
    client.on('error', (error) => {
      if (h.client !== client) return;
      h.stats.errors++;
      h.stats.lastError = error.message;
    });
    client.on('close', () => {
      if (h.client === client) h.online = false;
    });
  }

  /** Publish a clean retained offline STATE, then end the connection. */
  async stopHost(brokerId, hostId) {
    const key = `${brokerId} ${hostId}`;
    const h = this.hostSessions.get(key);
    if (!h) return false;
    await this._track(this._retire(h, null));
    this._stopWatchIfIdle();
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
    this._stopped = true;
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
    const closing = [...this._switching];
    // Clean offline messages (retained STATE, DDEATH/NDEATH) flush before each
    // socket closes, or the broker-side will fires instead and the seq story lies.
    for (const session of [...this.hostSessions.values(), ...this.sessions.values()]) {
      if (!session.switching) closing.push(this._retire(session, null));
    }
    await Promise.all(closing);
    this.hostSessions.clear();
    this.sessions.clear();
  }
}

module.exports = SparkplugPublisher;
