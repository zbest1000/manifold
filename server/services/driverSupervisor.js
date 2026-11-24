'use strict';

/**
 * DriverSupervisor (main process): forks and watches driver host processes
 * (server/drivers/host.js), one per protocol (or per isolated device), and
 * relays their samples and device states. See
 * docs/design/southbound-drivers.md section 4.2.
 */

const { EventEmitter } = require('events');
const path = require('path');
const childProcess = require('child_process');
const { isDeepStrictEqual } = require('util');

const DEFAULT_HOST_PATH = path.join(__dirname, '..', 'drivers', 'host.js');
const START_GRACE_MS = 5000;
const SHUTDOWN_KILL_MS = 3000;

class DriverSupervisor extends EventEmitter {
  constructor(opts) {
    super();
    const o = opts || {};
    this.drivers = Object.assign({}, o.drivers || {});
    this.hostPath = o.hostPath || DEFAULT_HOST_PATH;
    this._fork = o.fork || childProcess.fork;
    this._backoff = Object.assign({ initialMs: 500, maxMs: 30000 }, o.backoff || {});
    this._crashLoop = Object.assign({ max: 5, windowMs: 60000 }, o.crashLoop || {});
    this._heartbeatMs = o.heartbeatMs || 5000;
    this._requestTimeoutMs = o.requestTimeoutMs || 10000;
    this._killAfterMs = o.shutdownKillMs || SHUTDOWN_KILL_MS;

    this._hosts = new Map(); // hostId -> host
    this._transient = new Set(); // one-off hosts for testConnection
    this._devices = new Map(); // deviceId -> { device, hostId }
    this._deviceState = new Map(); // deviceId -> last device-state event
    this._deviceStatus = new Map(); // deviceId -> last status from host
    this._pending = new Map(); // reqId -> { resolve, reject, timer, host }
    this._reqSeq = 0;
    this._pingSeq = 0;
    this._closing = false;
  }

  // ------------------------------------------------------------ events

  _emit(name, payload) {
    try {
      this.emit(name, payload);
    } catch (_) {
      /* listeners must not break the supervisor */
    }
  }

  _setDeviceState(evt) {
    const last = this._deviceState.get(evt.deviceId);
    if (last && last.state === evt.state) {
      // Keep the freshest phase/reason for getStatus, but emit nothing.
      this._deviceState.set(evt.deviceId, Object.assign({}, last, { phase: evt.phase, reason: evt.reason }));
      return;
    }
    const full = {
      deviceId: evt.deviceId,
      state: evt.state,
      phase: evt.phase || null,
      reason: evt.reason || null,
      since: evt.since || Date.now()
    };
    this._deviceState.set(evt.deviceId, full);
    this._emit('device-state', full);
  }

  _setHostState(host, state, reason) {
    host.state = state;
    host.reason = reason || null;
    if (host.transient) return;
    this._emit('host-state', {
      hostId: host.id,
      protocol: host.protocol,
      state,
      pid: host.child ? host.child.pid : null,
      restarts: host.restarts,
      reason: host.reason
    });
  }

  // ------------------------------------------------------------ configuration

  setDevices(devices) {
    if (this._closing) return;
    const desired = new Map(); // hostId -> { protocol, devices[] }
    const all = new Map();
    for (const d of Array.isArray(devices) ? devices : []) {
      if (!d || !d.id || d.enabled === false) continue;
      if (!this.drivers[d.protocol]) {
        this._setDeviceState({
          deviceId: d.id,
          state: 'offline',
          phase: 'stopped',
          reason: 'unknown protocol',
          since: Date.now()
        });
        continue;
      }
      const hostId = d.isolate ? `${d.protocol}:${d.id}` : d.protocol;
      if (!desired.has(hostId)) desired.set(hostId, { protocol: d.protocol, devices: [] });
      desired.get(hostId).devices.push(d);
      all.set(d.id, { device: d, hostId });
    }
    const present = new Set(
      (Array.isArray(devices) ? devices : []).filter((d) => d && d.id && d.enabled !== false).map((d) => d.id)
    );
    for (const id of Array.from(this._deviceState.keys())) {
      if (!present.has(id)) {
        this._deviceState.delete(id);
        this._deviceStatus.delete(id);
      }
    }
    this._devices = all;

    for (const [hostId, h] of Array.from(this._hosts)) {
      if (!desired.has(hostId)) this._retireHost(h);
    }
    for (const [hostId, want] of desired) {
      let host = this._hosts.get(hostId);
      if (!host) {
        host = this._newHost(hostId, want.protocol);
        this._hosts.set(hostId, host);
      }
      host.devices = want.devices;
      if (host.state === 'parked') {
        host.crashes = [];
        host.attempt = 0;
        this._spawn(host);
      } else if (!host.child && host.state !== 'backoff') {
        this._spawn(host);
      } else if (host.child) {
        this._sendConfigure(host);
      }
      // 'backoff': the restart timer will pick up host.devices.
    }
  }

  unpark(hostId) {
    const host = this._hosts.get(hostId);
    if (!host || host.state !== 'parked' || this._closing) return false;
    host.crashes = [];
    host.attempt = 0;
    this._spawn(host);
    return true;
  }

  _newHost(id, protocol) {
    return {
      id,
      protocol,
      devices: [],
      child: null,
      state: 'stopped',
      reason: null,
      restarts: 0,
      crashes: [],
      attempt: 0,
      lastExit: null,
      lastPong: 0,
      hbTimer: null,
      restartTimer: null,
      killTimer: null,
      exited: null,
      intentional: false,
      transient: false,
      sentConfig: null
    };
  }

  // ------------------------------------------------------------ child lifecycle

  _spawn(host) {
    if (this._closing) return;
    clearTimeout(host.restartTimer);
    host.restartTimer = null;
    host.intentional = false;
    this._setHostState(host, 'starting');
    let child;
    try {
      child = this._fork(this.hostPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    } catch (e) {
      host.child = null;
      this._onHostDown(host, null, null, `fork failed: ${e && e.message}`);
      return;
    }
    host.child = child;
    host.sentConfig = null;
    host.lastPong = Date.now();
    host.startedAt = Date.now();
    host.ready = false;
    let settle;
    host.exited = new Promise((r) => {
      settle = r;
    });
    let done = false;
    const onGone = (code, signal, why) => {
      if (done) return;
      done = true;
      settle();
      if (host.child === child) this._onHostDown(host, code, signal, why);
    };
    child.on('message', (m) => this._onMessage(host, child, m));
    child.on('error', (e) => {
      // 'error' without a pid means spawn failed; with one it is an IPC/kill hiccup.
      if (!child.pid) onGone(null, null, `spawn error: ${e && e.message}`);
    });
    child.on('exit', (code, signal) => onGone(code, signal));
    this._send(host, { t: 'init', drivers: this.drivers });
    this._sendConfigure(host);
    host.hbTimer = setInterval(() => this._heartbeat(host), this._heartbeatMs);
    if (host.hbTimer.unref) host.hbTimer.unref();
  }

  _send(host, msg) {
    const c = host.child;
    if (!c || !c.connected) return false;
    try {
      c.send(msg);
      return true;
    } catch (_) {
      return false;
    }
  }

  _sendConfigure(host) {
    if (!host.child) return;
    const devices = host.devices;
    if (host.sentConfig && isDeepStrictEqual(host.sentConfig, devices)) return;
    if (this._send(host, { t: 'configure', devices })) host.sentConfig = JSON.parse(JSON.stringify(devices));
  }

  _heartbeat(host) {
    if (!host.child) return;
    const limit = host.ready ? this._heartbeatMs * 3 : Math.max(START_GRACE_MS, this._heartbeatMs * 3);
    if (Date.now() - host.lastPong > limit) {
      host.killReason = 'heartbeat timeout';
      try {
        host.child.kill('SIGKILL');
      } catch (_) {
        /* ignore */
      }
      return;
    }
    this._send(host, { t: 'ping', n: ++this._pingSeq });
  }

  _onMessage(host, child, m) {
    if (!m || typeof m !== 'object' || host.child !== child) return;
    host.lastPong = Date.now();
    try {
      switch (m.t) {
        case 'ready':
          host.ready = true;
          this._setHostState(host, 'running');
          break;
        case 'samples':
          this._emit('samples', { deviceId: m.deviceId, group: m.group, tRead: m.tRead, samples: m.samples });
          break;
        case 'state':
          if (this._devices.has(m.deviceId)) {
            this._setDeviceState({
              deviceId: m.deviceId,
              state: m.state,
              phase: m.phase,
              reason: m.reason,
              since: m.since
            });
          }
          break;
        case 'status':
          for (const [id, st] of Object.entries(m.devices || {})) {
            if (this._devices.has(id)) this._deviceStatus.set(id, st);
          }
          break;
        case 'device-error':
          this._emit('device-error', { deviceId: m.deviceId, error: m.error, details: m.details });
          if (this._devices.has(m.deviceId)) {
            this._setDeviceState({
              deviceId: m.deviceId,
              state: 'offline',
              phase: 'stopped',
              reason: `device error: ${m.error}`,
              since: Date.now()
            });
          }
          break;
        case 'result': {
          const p = this._pending.get(m.reqId);
          if (p) {
            this._pending.delete(m.reqId);
            clearTimeout(p.timer);
            if (m.ok) p.resolve(m.data);
            else p.reject(new Error(m.error || 'request failed'));
          }
          break;
        }
        default:
          break;
      }
    } catch (_) {
      /* never throw from IPC handlers */
    }
  }

  _rejectPending(host, why) {
    for (const [id, p] of Array.from(this._pending)) {
      if (p.host === host) {
        this._pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new Error(why));
      }
    }
  }

  _onHostDown(host, code, signal, why) {
    clearInterval(host.hbTimer);
    host.hbTimer = null;
    clearTimeout(host.killTimer);
    host.killTimer = null;
    const reason = why || host.killReason || (signal ? `killed by ${signal}` : `exit code ${code}`);
    host.killReason = null;
    host.child = null;
    host.ready = false;
    host.lastExit = { code, signal, at: Date.now(), reason };
    this._rejectPending(host, 'driver host down');
    if (host.transient) {
      this._transient.delete(host);
      return;
    }
    if (host.intentional || this._closing) {
      this._setHostState(host, 'stopped', 'stopped');
      return;
    }
    for (const d of host.devices) {
      this._setDeviceState({
        deviceId: d.id,
        state: 'offline',
        phase: 'backoff',
        reason: 'driver host down',
        since: Date.now()
      });
    }
    const now = Date.now();
    host.crashes = host.crashes.filter((t) => now - t < this._crashLoop.windowMs);
    host.crashes.push(now);
    if (host.crashes.length > this._crashLoop.max) {
      this._setHostState(host, 'parked', `crash loop: ${host.crashes.length} crashes in ${this._crashLoop.windowMs}ms (${reason})`);
      return;
    }
    const delay = Math.min(this._backoff.maxMs, this._backoff.initialMs * Math.pow(2, host.crashes.length - 1));
    host.restarts++;
    this._setHostState(host, 'backoff', reason);
    host.restartTimer = setTimeout(() => {
      host.restartTimer = null;
      if (!this._closing && this._hosts.get(host.id) === host) this._spawn(host);
    }, delay);
    if (host.restartTimer.unref) host.restartTimer.unref();
  }

  /** Gracefully stop a host (no restart); resolves when the child is gone. */
  _stopChild(host) {
    host.intentional = true;
    clearTimeout(host.restartTimer);
    host.restartTimer = null;
    const child = host.child;
    if (!child) return Promise.resolve();
    this._send(host, { t: 'shutdown' });
    host.killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {
        /* ignore */
      }
    }, this._killAfterMs);
    return host.exited || Promise.resolve();
  }

  _retireHost(host) {
    this._hosts.delete(host.id);
    this._stopChild(host).then(() => {
      if (host.state !== 'stopped') this._setHostState(host, 'stopped', 'no devices');
    });
    if (!host.child) this._setHostState(host, 'stopped', 'no devices');
  }

  // ------------------------------------------------------------ requests

  _request(host, msg, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!host || !host.child) return reject(new Error('driver host is not running'));
      const reqId = `r${++this._reqSeq}`;
      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        reject(new Error('request timed out'));
      }, timeoutMs || this._requestTimeoutMs);
      if (timer.unref) timer.unref();
      this._pending.set(reqId, { resolve, reject, timer, host });
      if (!this._send(host, Object.assign({ reqId }, msg))) {
        this._pending.delete(reqId);
        clearTimeout(timer);
        reject(new Error('driver host is not running'));
      }
    });
  }

  probe(deviceId, args, timeoutMs) {
    const entry = this._devices.get(deviceId);
    if (!entry) return Promise.reject(new Error(`unknown device '${deviceId}'`));
    const host = this._hosts.get(entry.hostId);
    return this._request(host, { t: 'probe', deviceId, args }, timeoutMs);
  }

  /** Browse a running device's tag namespace (drivers with capabilities.browse). */
  browse(deviceId, node, timeoutMs) {
    const entry = this._devices.get(deviceId);
    if (!entry) return Promise.reject(new Error(`unknown device '${deviceId}'`));
    const host = this._hosts.get(entry.hostId);
    return this._request(host, { t: 'browse', deviceId, node }, timeoutMs);
  }

  async testConnection(device, timeoutMs) {
    if (this._closing) throw new Error('supervisor is shut down');
    if (!device || !this.drivers[device.protocol]) throw new Error('unknown protocol');
    const shared = this._hosts.get(device.protocol);
    if (shared && shared.child) return this._request(shared, { t: 'test', device }, timeoutMs);
    // No live host for this protocol: use a one-off host so testing never
    // changes the running configuration.
    const host = this._newHost(`${device.protocol}:test-${++this._reqSeq}`, device.protocol);
    host.transient = true;
    this._transient.add(host);
    this._spawn(host);
    try {
      return await this._request(host, { t: 'test', device }, timeoutMs);
    } finally {
      this._stopChild(host);
    }
  }

  // ------------------------------------------------------------ status / shutdown

  getStatus() {
    const hosts = {};
    for (const [id, h] of this._hosts) {
      hosts[id] = {
        protocol: h.protocol,
        state: h.state,
        pid: h.child ? h.child.pid : null,
        restarts: h.restarts,
        lastExit: h.lastExit,
        deviceIds: h.devices.map((d) => d.id)
      };
    }
    const devices = {};
    for (const [id, st] of this._deviceState) {
      devices[id] = Object.assign({}, this._deviceStatus.get(id) || {}, {
        state: st.state,
        phase: st.phase,
        reason: st.reason
      });
    }
    return { hosts, devices };
  }

  async shutdown() {
    this._closing = true;
    const all = [...this._hosts.values(), ...this._transient];
    const waits = all.map((h) => this._stopChild(h));
    await Promise.all(waits);
    for (const h of all) {
      clearInterval(h.hbTimer);
      clearTimeout(h.restartTimer);
      clearTimeout(h.killTimer);
      if (!h.transient && h.state !== 'stopped') this._setHostState(h, 'stopped', 'shutdown');
    }
    for (const [id, p] of Array.from(this._pending)) {
      this._pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error('supervisor shut down'));
    }
    this._hosts.clear();
    this._transient.clear();
  }
}

module.exports = { DriverSupervisor };
