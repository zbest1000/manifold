'use strict';

const { EventEmitter } = require('events');
const { matchFilter } = require('../../services/mqttMatch');

/**
 * An in-memory stand-in for MqttManager with just what the binding engine and the pipeline engine
 * use: publish (recorded; optionally echoed back into the message tap like a broker would),
 * connection state, subscriptions, observed topics (resolveSubscriptions) and latest rows.
 */
function fakeMqtt({ echo = false, brokers = ['b1'] } = {}) {
  const m = new EventEmitter();
  m.published = [];
  m.state = new Map(brokers.map((b) => [b, 'connected']));
  m.subs = new Map(brokers.map((b) => [b, new Set(['#'])]));
  m.latest = new Map(); // `${broker}\0${topic}` -> payload
  m.echo = echo;
  m.getConnection = (id) => (m.state.has(id) ? { id, status: m.state.get(id) } : null);
  m.getSubscriptions = (id) => [...(m.subs.get(id) || [])];
  m.subscribe = (id, f) => m.subs.get(id)?.add(f);
  m.resolveSubscriptions = (id, filters, { sampleLimit = 100 } = {}) => ({
    results: filters.map((f) => {
      const sample = [];
      for (const k of m.latest.keys()) {
        const [b, t] = k.split('\u0000');
        if (b === id && matchFilter(f, t) && sample.length < sampleLimit) sample.push({ topic: t });
      }
      return { sample, matchCount: sample.length };
    })
  });
  m.stores = {
    get: (id) => ({ getLatest: (topic) => (m.latest.has(`${id}\u0000${topic}`) ? { topic, payload: m.latest.get(`${id}\u0000${topic}`) } : null) })
  };
  m.buildMessage = (id, row) => message(id, row.topic, row.payload);
  m.publish = async (brokerId, topic, payload, opts = {}) => {
    if (m.state.get(brokerId) !== 'connected') throw new Error(`Broker ${brokerId} is not connected`);
    m.published.push({ brokerId, topic, payload, opts });
    if (opts.retain && payload === '') m.latest.delete(`${brokerId}\u0000${topic}`);
    if (m.echo && payload !== '') setImmediate(() => m.inject(brokerId, topic, typeof payload === 'string' ? safeParse(payload) : payload));
    return { brokerId, topic };
  };
  /** A message arriving from the broker (also becomes the topic's latest value). */
  m.inject = (brokerId, topic, payload) => {
    m.latest.set(`${brokerId}\u0000${topic}`, payload);
    m.emit('message', message(brokerId, topic, payload));
  };
  return m;
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function message(brokerId, topic, payload) {
  return { brokerId, topic, payload, payloadFormat: typeof payload === 'object' && payload !== null ? 'json' : 'text', timestamp: new Date().toISOString() };
}

function memoryProfiles(extra = {}) {
  const data = { devices: {}, bindings: {}, deviceProfiles: {}, historians: {}, pipelines: {}, ...extra };
  return {
    data,
    rev: 0,
    listIn: (c) => Object.values(data[c] || {}),
    getIn: (c, id) => (data[c] || {})[id] || null,
    upsertIn(c, id, obj) {
      data[c] ||= {};
      data[c][id] = { ...obj, id };
      this.rev++;
      return data[c][id];
    },
    removeIn(c, id) {
      if (!data[c]?.[id]) return false;
      delete data[c][id];
      this.rev++;
      return true;
    }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

module.exports = { fakeMqtt, memoryProfiles, sleep, until };
