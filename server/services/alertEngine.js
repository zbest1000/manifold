'use strict';

/**
 * Alert engine — turns the namespace's passive observability into active
 * notification. Rules live in the profile store (they survive restarts) and are
 * evaluated on a fixed interval against the same structures the UI reads (topic
 * store, trie, event rings) — no extra ingest-path cost.
 *
 * Rule types:
 * - `branch-silent`: fires when nothing under `path` has published for
 *   `thresholdMs`. Stateful — fires on the silent transition, resolves on the
 *   first message back.
 * - `topic-silent`: same, for one exact topic.
 * - `new-topic`: fires once per new topic appearing under `prefix` (watermark
 *   over the store's topic-added event ring; not stateful).
 *
 * Every firing is emitted on the socket (`alert`), kept in a bounded history
 * ring (GET /api/alerts/events), and optionally POSTed to the rule's
 * `webhookUrl` (5s timeout, failures logged and swallowed — a dead webhook
 * must never break evaluation).
 */

const EVAL_MS = 15_000;
const HISTORY_MAX = 500;
const WEBHOOK_TIMEOUT_MS = 5_000;

const RULE_TYPES = ['branch-silent', 'topic-silent', 'new-topic'];

class AlertEngine {
  constructor({ io, profiles, mqttManager, fetchImpl = globalThis.fetch, intervalMs = EVAL_MS }) {
    this.io = io;
    this.profiles = profiles;
    this.manager = mqttManager;
    this.fetchImpl = fetchImpl;
    this.intervalMs = intervalMs;
    this.state = new Map(); // ruleId -> { firing, since, watermark }
    this.history = []; // bounded ring, newest last
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.evaluate(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** One evaluation pass over all rules. Exposed for tests. */
  evaluate(now = Date.now()) {
    const rules = this.profiles?.alertRules() || [];
    const liveIds = new Set(rules.map((r) => r.id));
    for (const id of this.state.keys()) if (!liveIds.has(id)) this.state.delete(id);

    for (const rule of rules) {
      try {
        if (rule.enabled === false) continue;
        if (rule.type === 'new-topic') this._evalNewTopic(rule, now);
        else if (rule.type === 'branch-silent' || rule.type === 'topic-silent') this._evalSilent(rule, now);
      } catch (error) {
        // One bad rule (e.g. broker gone) must not stop the rest.
        console.warn(`alertEngine: rule ${rule.id} (${rule.name || rule.type}): ${error.message}`);
      }
    }
  }

  _ruleState(rule) {
    let s = this.state.get(rule.id);
    if (!s) {
      s = { firing: false, since: 0, watermark: Date.now() };
      this.state.set(rule.id, s);
    }
    return s;
  }

  _evalSilent(rule, now) {
    const threshold = Number(rule.thresholdMs) || 60_000;
    let last;
    if (rule.type === 'topic-silent') {
      const store = this.manager.stores.get(rule.brokerId);
      if (!store) return; // broker unknown/not connected — nothing to say
      const row = store.getLatest(rule.topic);
      last = row ? row.ts : 0;
    } else {
      last = this.manager.branchLastActivity(rule.brokerId, rule.path || '');
    }
    if (last === null) return; // broker unknown/not connected — nothing to say

    const silentFor = last > 0 ? now - last : Infinity;
    const shouldFire = silentFor > threshold;
    const s = this._ruleState(rule);
    if (shouldFire && !s.firing) {
      s.firing = true;
      s.since = now;
      this._emit(rule, 'firing', {
        silentForMs: last > 0 ? silentFor : null,
        lastActivity: last || null,
        detail: last > 0 ? `Silent for ${Math.round(silentFor / 1000)}s (threshold ${Math.round(threshold / 1000)}s)` : 'No data ever observed'
      });
    } else if (!shouldFire && s.firing) {
      s.firing = false;
      this._emit(rule, 'resolved', { lastActivity: last, detail: 'Data is flowing again' });
    }
  }

  _evalNewTopic(rule, now) {
    const store = this.manager.stores.get(rule.brokerId);
    if (!store) return;
    const s = this._ruleState(rule);
    const prefix = rule.prefix || '';
    const fresh = store.events.filter(
      (e) => e.type === 'topic-added' && e.ts > s.watermark && (!prefix || e.topic.startsWith(prefix))
    );
    s.watermark = now;
    for (const e of fresh.slice(0, 20)) {
      this._emit(rule, 'event', { topic: e.topic, detail: `New topic appeared: ${e.topic}` });
    }
    if (fresh.length > 20) {
      this._emit(rule, 'event', { detail: `…and ${fresh.length - 20} more new topics in this window` });
    }
  }

  _emit(rule, status, extra = {}) {
    const evt = {
      ruleId: rule.id,
      ruleName: rule.name || rule.type,
      type: rule.type,
      brokerId: rule.brokerId,
      status, // 'firing' | 'resolved' | 'event'
      ts: Date.now(),
      ...extra
    };
    this.history.push(evt);
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
    this.io?.emit('alert', evt);
    if (rule.webhookUrl && typeof this.fetchImpl === 'function') {
      const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) : undefined;
      this.fetchImpl(rule.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(evt),
        signal
      }).catch((error) => {
        console.warn(`alertEngine: webhook for rule ${rule.id} failed: ${error.message}`);
      });
    }
  }

  getEvents(limit = 200) {
    return this.history.slice(-limit).reverse();
  }
}

module.exports = { AlertEngine, RULE_TYPES };
