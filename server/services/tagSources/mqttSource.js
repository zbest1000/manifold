'use strict';

const { EventEmitter } = require('events');
const { filterCovers } = require('../bindingMqtt');

/**
 * Source adapter for MQTT-topic mappings. Values do not come through here: TagBindings reads them
 * from the manager's coalesced message tap (one lookup per tapped message). This adapter supplies
 * what a tag source owes the binding engine besides samples:
 *
 *   - 'source-state' { sourceType: 'mqtt', sourceId: <brokerId>, state, reason } for every broker a
 *     mapping reads from, on change (polled once a second; MqttManager reports connection changes
 *     to the socket, not to engines);
 *   - ensureMonitored(brokerId, topicOrFilter): makes sure the broker session subscribes to what a
 *     mapping reads (the intake subscription usually covers it already; otherwise one extra
 *     subscription per filter). Throws while the broker is not connected (retried by the engine).
 */
class MqttSource extends EventEmitter {
  constructor(mqttManager, { pollMs = 1000 } = {}) {
    super();
    this.manager = mqttManager;
    this.pollMs = pollMs;
    this.watched = new Map(); // brokerId -> last reported state key
    this.timer = null;
  }

  _stateOf(brokerId) {
    const c = this.manager.getConnection?.(brokerId);
    if (!c) return { state: 'offline', reason: 'broker not configured (removed?)' };
    if (c.status === 'connected') return { state: 'online', reason: 'connected' };
    return { state: 'offline', reason: c.lastError ? `broker ${c.status}: ${c.lastError}` : `broker ${c.status || 'not connected'}` };
  }

  _poll() {
    for (const [brokerId, last] of this.watched) {
      const st = this._stateOf(brokerId);
      const key = `${st.state} ${st.reason}`;
      if (key === last) continue;
      this.watched.set(brokerId, key);
      this.emit('source-state', { sourceType: 'mqtt', sourceId: brokerId, state: st.state, reason: st.reason });
    }
  }

  watch(brokerId) {
    if (!brokerId || this.watched.has(brokerId)) return;
    this.watched.set(brokerId, null);
    if (!this.timer) {
      this.timer = setInterval(() => this._poll(), this.pollMs);
      this.timer.unref?.();
    }
    queueMicrotask(() => this._poll());
  }

  /** Forget brokers no mapping reads any more. */
  retain(brokerIds) {
    for (const id of [...this.watched.keys()]) if (!brokerIds.has(id)) this.watched.delete(id);
  }

  async ensureMonitored(brokerId, filter) {
    this.watch(brokerId);
    if (this._stateOf(brokerId).state !== 'online') throw new Error(`broker ${brokerId} is not connected`);
    const subs = this.manager.getSubscriptions?.(brokerId) || [];
    if (subs.some((s) => filterCovers(String(s), filter))) return;
    this.manager.subscribe?.(brokerId, filter, 0);
  }

  close() {
    clearInterval(this.timer);
    this.timer = null;
    this.watched.clear();
  }
}

module.exports = { MqttSource };
