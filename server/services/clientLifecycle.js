'use strict';

/**
 * Client lifecycle timeline — "why is this client flapping?" answered from
 * whatever the broker can actually tell us. Brokers differ, so this adapts
 * per capability instead of assuming one vendor:
 *
 *  - EMQX publishes structured JSON on
 *    `$SYS/brokers/<node>/clients/<id>/connected|disconnected` (its
 *    subscribable system topics; the similarly-named `$events/#` tree is
 *    rule-engine-only and also probed in case a rule republishes there).
 *    Subscription is free to attempt anywhere: non-EMQX brokers simply never
 *    deliver on those topics.
 *  - Mosquitto (with `log_dest topic`) publishes human-readable notices on
 *    `$SYS/broker/log/#` — "New client connected from … as <id> …",
 *    "Client <id> disconnected", "Socket error on client <id>". Parsed here.
 *  - Everything else still yields the passive layer: Sparkplug NBIRTH/NDEATH/
 *    DBIRTH/DDEATH announce edge node/device lifecycles on any broker.
 *
 * Events land in a bounded per-broker ring; the route adds a per-client
 * rollup (connects/disconnects/flap detection) on read.
 */

const RING_MAX = 500;
const SUBSCRIBE_EVERY_MS = 60_000;

// EMQX event + system topics plus the Mosquitto log tree. Subscribing to a
// topic a broker never publishes is harmless — that IS the capability probe.
const SUB_FILTERS = [
  '$events/client_connected',
  '$events/client_disconnected',
  '$SYS/brokers/+/clients/+/connected',
  '$SYS/brokers/+/clients/+/disconnected',
  '$SYS/broker/log/#'
];

// $SYS/brokers/<node>/clients/<clientid>/connected|disconnected (EMQX).
const EMQX_SYS_CLIENT = /^\$SYS\/brokers\/[^/]+\/clients\/(.+)\/(connected|disconnected)$/;

// Mosquitto notice lines (after the "<epoch>: " prefix).
const MOSQ_CONNECTED = /^New client connected from ([\d.:a-fA-F[\]]+) as (.+?) \(/;
const MOSQ_DISCONNECTED = /^Client (.+?) (?:disconnected|closed its connection)/;
const MOSQ_SOCKET_ERR = /^Socket error on client (.+?),/;

const SP_LIFECYCLE = /^spBv1\.0\/([^/]+)\/([ND])(BIRTH|DEATH)\/([^/]+)(?:\/(.+))?$/;

class ClientLifecycle {
  constructor({ mqttManager, intervalMs = SUBSCRIBE_EVERY_MS }) {
    this.manager = mqttManager;
    this.intervalMs = intervalMs;
    this.rings = new Map(); // brokerId -> events[] (newest last)
    this.capability = new Map(); // brokerId -> { emqxEvents, brokerLog, sparkplug }
    this.timer = null;
    this.tapping = false;
    this.onMessage = this.onMessage.bind(this);
  }

  start() {
    if (!this.tapping && this.manager?.on) {
      this.manager.on('message', this.onMessage);
      this.tapping = true;
    }
    if (this.timer) return;
    this.subscribeAll();
    this.timer = setInterval(() => this.subscribeAll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.tapping) {
      this.manager?.off?.('message', this.onMessage);
      this.tapping = false;
    }
  }

  // Re-asserted on an interval so broker reconnects (which drop our
  // subscriptions) heal themselves — same pattern as the canary.
  subscribeAll() {
    for (const c of this.manager.getConnections?.() || []) {
      if (c.status !== 'connected') continue;
      for (const f of SUB_FILTERS) {
        try {
          // quiet: a refusal IS the capability answer on brokers that don't
          // support (or don't permit) the topic — not an error to toast.
          this.manager.subscribe(c.id, f, 0, { quiet: true });
        } catch {
          // connection raced away — next round
        }
      }
    }
  }

  _cap(brokerId) {
    let c = this.capability.get(brokerId);
    if (!c) {
      c = { emqxEvents: false, brokerLog: false, sparkplug: false };
      this.capability.set(brokerId, c);
    }
    return c;
  }

  _push(brokerId, evt) {
    let ring = this.rings.get(brokerId);
    if (!ring) {
      ring = [];
      this.rings.set(brokerId, ring);
    }
    ring.push(evt);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  }

  onMessage(msg, now = Date.now()) {
    const { brokerId, topic } = msg;

    if (topic === '$events/client_connected' || topic === '$events/client_disconnected') {
      const p = typeof msg.payload === 'object' && msg.payload !== null ? msg.payload : null;
      if (!p || !p.clientid) return;
      this._cap(brokerId).emqxEvents = true;
      this._push(brokerId, {
        ts: now,
        type: topic === '$events/client_connected' ? 'connected' : 'disconnected',
        clientId: String(p.clientid),
        username: p.username || null,
        ip: p.ipaddress || null,
        reason: p.reason || null,
        source: 'emqx-events'
      });
      return;
    }

    const emqxSys = EMQX_SYS_CLIENT.exec(topic);
    if (emqxSys) {
      const p = typeof msg.payload === 'object' && msg.payload !== null ? msg.payload : {};
      this._cap(brokerId).emqxEvents = true;
      this._push(brokerId, {
        ts: now,
        type: emqxSys[2],
        clientId: String(p.clientid || emqxSys[1]),
        username: p.username || null,
        ip: p.ipaddress || null,
        reason: p.reason || null,
        source: 'emqx-sys'
      });
      return;
    }

    if (topic.startsWith('$SYS/broker/log/')) {
      const line = String(typeof msg.payload === 'string' ? msg.payload : '').replace(/^\d+:\s*/, '');
      let m;
      if ((m = MOSQ_CONNECTED.exec(line))) {
        this._cap(brokerId).brokerLog = true;
        this._push(brokerId, { ts: now, type: 'connected', clientId: m[2], ip: m[1], reason: null, source: 'broker-log' });
      } else if ((m = MOSQ_SOCKET_ERR.exec(line))) {
        this._cap(brokerId).brokerLog = true;
        this._push(brokerId, { ts: now, type: 'disconnected', clientId: m[1], ip: null, reason: 'socket error', source: 'broker-log' });
      } else if ((m = MOSQ_DISCONNECTED.exec(line))) {
        this._cap(brokerId).brokerLog = true;
        this._push(brokerId, { ts: now, type: 'disconnected', clientId: m[1], ip: null, reason: null, source: 'broker-log' });
      }
      return;
    }

    const sp = SP_LIFECYCLE.exec(topic);
    if (sp) {
      this._cap(brokerId).sparkplug = true;
      const [, group, kind, phase, node, device] = sp;
      this._push(brokerId, {
        ts: now,
        type: phase === 'BIRTH' ? 'birth' : 'death',
        clientId: device ? `${group}/${node}/${device}` : `${group}/${node}`,
        ip: null,
        reason: kind === 'D' ? 'device' : 'edge node',
        source: 'sparkplug'
      });
    }
  }

  /** Events + per-client rollup for one broker (route shape). */
  report(brokerId, { limit = 200, flapWindowMs = 10 * 60_000 } = {}, now = Date.now()) {
    const ring = this.rings.get(brokerId) || [];
    const clients = new Map();
    for (const e of ring) {
      let c = clients.get(e.clientId);
      if (!c) {
        c = { clientId: e.clientId, connects: 0, disconnects: 0, recentConnects: 0, lastType: null, lastTs: 0, lastIp: null, source: e.source };
        clients.set(e.clientId, c);
      }
      if (e.type === 'connected' || e.type === 'birth') {
        c.connects++;
        if (now - e.ts <= flapWindowMs) c.recentConnects++;
      } else {
        c.disconnects++;
      }
      c.lastType = e.type;
      c.lastTs = e.ts;
      if (e.ip) c.lastIp = e.ip;
    }
    const rollup = [...clients.values()]
      .map((c) => ({ ...c, flapping: c.recentConnects >= 3 }))
      .sort((a, b) => Number(b.flapping) - Number(a.flapping) || b.lastTs - a.lastTs);
    return {
      capability: this._cap(brokerId),
      events: ring.slice(-limit).reverse(),
      clients: rollup
    };
  }
}

module.exports = { ClientLifecycle };
