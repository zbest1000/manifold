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
 * - `value-threshold`: fires when a numeric payload value (optionally a
 *   dot-path `field` into a JSON payload) crosses `value` per `op`. Evaluated
 *   on the manager's live message tap (not the 15s poll) so alerts land at
 *   message latency. Supports `sustainMs` (condition must hold continuously
 *   before firing) and `clearValue` hysteresis (for '>' rules, resolve only
 *   once the value falls back to <= clearValue — no flapping in the deadband).
 *   `topic` may be exact or an MQTT filter with +/#.
 *
 * A breached value rule that holds still (a retained or change-only value, so no
 * further messages arrive) still fires once `sustainMs` has elapsed: a per-state
 * timer promotes it, the next message is not needed.
 *
 * Per-rule state (`getRuleState`) is what GET /api/alerts/rules shows:
 * idle | breached | firing | disabled | broken, plus when it began, the current
 * value, the time left until it fires, the last transition and webhook health.
 * State changes are pushed on the socket as `alert-state`.
 *
 * Every firing is emitted on the socket (`alert`), kept in a bounded history
 * ring (GET /api/alerts/events), and optionally POSTed to the rule's
 * `webhookUrl` (5s timeout, failures logged and swallowed — a dead webhook
 * must never break evaluation).
 *
 * Alarms. A firing rule (per concrete topic, for wildcard value rules) is an
 * active alarm (GET /api/alerts/active). Every rule has a `severity` (info |
 * warning | critical, default warning). An operator can acknowledge a firing
 * alarm (POST /api/alerts/ack): the acknowledgement records who and when (and
 * an optional note), holds until the alarm clears, and is dropped when it
 * clears, so the next firing is a new, unacknowledged occurrence.
 * Acknowledging never suppresses anything: a later firing always fires.
 *
 * Durable history. With a `journal` (services/alertHistory.js) every event,
 * acknowledgements included, is appended to data/alerts.jsonl, and the ring is
 * reloaded from it on start, so GET /api/alerts/history survives restarts.
 */

const { matchParts, compiledView } = require('./mqttMatch');
const { guardedFetch } = require('./egressGuard');
const { brokenRefs } = require('./references');
const { stripUrlCredentials } = require('./secrets');
const { parseQuery, queryEvents } = require('./alertHistory');

const EVAL_MS = 15_000;
const HISTORY_MAX = 500;
const WEBHOOK_TIMEOUT_MS = 5_000;

// Webhook delivery goes through the egress guard (SSRF: private/metadata targets,
// redirects and DNS rebinding are blocked). An injected `fetchImpl` is a TEST SEAM
// and bypasses the guard — production wiring never passes one.
const guardedWebhookFetch = (url, opts) => guardedFetch(url, opts, WEBHOOK_TIMEOUT_MS);
// A wildcard value-threshold rule keeps one state machine PER concrete topic it
// matches; bound that fan-out so a rule over a huge namespace can't grow state
// without limit. Oldest-inserted topic is evicted past the cap.
const VALUE_STATE_MAX_TOPICS = 5000;

const RULE_TYPES = ['branch-silent', 'topic-silent', 'new-topic', 'value-threshold'];
const SEVERITIES = ['info', 'warning', 'critical'];
const DEFAULT_SEVERITY = 'warning';
const severityOf = (rule) => (SEVERITIES.includes(rule?.severity) ? rule.severity : DEFAULT_SEVERITY);
const ACK_NOTE_MAX = 500;
// Statuses that reach a rule's webhook. Acknowledgements and restart bookkeeping stay in the history.
const WEBHOOK_STATUSES = new Set(['firing', 'resolved', 'event']);

const VALUE_OPS = ['>', '>=', '<', '<=', '==', '!='];
const OPS = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b
};

/**
 * Pull the numeric value a value-threshold rule watches out of a tapped
 * message payload. `fieldParts` is the pre-split dot-path (null = the payload
 * itself). Returns a finite number or null (null = "not our kind of message",
 * never an error — namespaces mix types on the same branch all the time).
 */
function extractValue(payload, fieldParts) {
  let v = payload;
  if (fieldParts) {
    for (const seg of fieldParts) {
      if (v === null || typeof v !== 'object') return null;
      v = v[seg];
    }
  }
  // Reject non-scalar shapes and JS coercion traps (Number('') === 0,
  // Number(true) === 1, Number([5]) === 5) — only real numbers alert.
  if (typeof v === 'object' || typeof v === 'boolean' || v === '' || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

class AlertEngine {
  constructor({ io, profiles, mqttManager, fetchImpl = guardedWebhookFetch, intervalMs = EVAL_MS, journal = null }) {
    this.io = io;
    this.journal = journal; // AlertHistory or null (in-memory only)
    this.seq = 0; // monotonic event number, continued from the journal on start
    this.transitions = new Map(); // `${status}|${severity}` -> count since start (Prometheus)
    this.knownRules = new Map(); // ruleId -> last seen rule, to close alarms of rules that were deleted
    this.restored = null; // { loaded, ended, tornLines } after start() read the journal
    this.profiles = profiles;
    this.manager = mqttManager;
    this.fetchImpl = fetchImpl;
    this.intervalMs = intervalMs;
    this.state = new Map(); // ruleId -> { firing, since, watermark } (silence/new-topic rules)
    this.valueState = new Map(); // ruleId -> Map(topic -> { firing, since, breachedSince, lastValue })
    this.history = []; // bounded ring, newest last
    this.timer = null;
    this.webhookFailures = 0;
    this.lastWebhookError = null;
    this.webhookStats = new Map(); // ruleId -> { ok, failures, lastError, lastAttemptAt, lastOkAt }
    this.tapping = false;
    this.onMessage = this.onMessage.bind(this);
    // Compiled value-rule table (filters and field paths pre-split, disabled
    // rules excluded), rebuilt only when the profile store's revision changes —
    // same pattern as the pipeline engine, so the steady-state per-message
    // cost is an integer compare plus array walks.
    this.valueTable = profiles
      ? compiledView(profiles, () =>
          (profiles.alertRules() || [])
            .filter((r) => r.type === 'value-threshold' && r.enabled !== false && r.brokerId && r.topic && OPS[r.op])
            .map((r) => ({
              rule: r,
              parts: String(r.topic).split('/'),
              fieldParts: r.field ? String(r.field).split('.') : null
            }))
        )
      : () => [];
  }

  start() {
    if (this.journal && !this.journal.loaded) this._restore();
    // Value rules ride the live message tap; silence rules keep the interval.
    if (!this.tapping && this.manager?.on) {
      this.manager.on('message', this.onMessage);
      this.tapping = true;
    }
    if (this.timer) return;
    this.timer = setInterval(() => this.evaluate(), this.intervalMs);
    this.timer.unref?.();
  }

  /**
   * Read the durable history back in, then settle alarms that were still firing when the server stopped.
   *
   * They are CLOSED with an explicit 'ended' event ("ended by restart"), not restored. The engine keeps no
   * state across a restart: it starts with every rule idle and derives state again from live data — silence
   * rules on their first evaluation pass (from the topics' last activity), value rules from the next message
   * per topic (a retained value arrives as soon as the broker reconnects). Restoring 'firing' on top of that
   * would be wrong both ways: a condition that still holds would fire a second time with no resolve in
   * between (a duplicate occurrence), and one that cleared while the server was down, or whose topic never
   * publishes again, would stay 'firing' for ever with nothing to resolve it. Closing the old occurrence
   * and letting live data re-fire it keeps the record honest; the re-fired alarm is a new, unacknowledged
   * occurrence (an acknowledgement belongs to the occurrence it was given for).
   */
  _restore(now = Date.now()) {
    let events = [];
    try {
      events = this.journal.load();
    } catch (error) {
      console.warn(`alertEngine: could not read alert history: ${error.message}`);
    }
    this.seq = Math.max(this.seq, this.journal.lastSeq());
    this.history = events.slice(-HISTORY_MAX);
    const open = new Map(); // alarm key -> its firing event
    for (const e of events) {
      if (e.status === 'firing') open.set(alarmKey(e.ruleId, e.topic), e);
      else if (e.status === 'resolved' || e.status === 'ended') open.delete(alarmKey(e.ruleId, e.topic));
    }
    const rules = new Map((this.profiles?.alertRules() || []).map((r) => [r.id, r]));
    for (const e of open.values()) {
      const rule = rules.get(e.ruleId) || { id: e.ruleId, name: e.ruleName, type: e.type, brokerId: e.brokerId, severity: e.severity };
      this._emit(
        rule,
        'ended',
        {
          ...(e.topic ? { topic: e.topic } : {}),
          since: e.ts,
          detail: 'Ended by restart: the server stopped while this alarm was active. It fires again if the condition still holds.'
        },
        { webhook: false, now }
      );
    }
    this.restored = { loaded: events.length, ended: open.size, tornLines: this.journal.stats.tornLines };
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const byTopic of this.valueState.values()) for (const s of byTopic.values()) this._clearTimer(s);
    if (this.tapping) {
      this.manager?.off?.('message', this.onMessage);
      this.tapping = false;
    }
  }

  /** One evaluation pass over all rules. Exposed for tests. */
  evaluate(now = Date.now()) {
    const rules = this.reconcileRules();

    for (const rule of rules) {
      try {
        if (rule.enabled === false) continue;
        if (rule.type === 'new-topic') this._evalNewTopic(rule);
        else if (rule.type === 'branch-silent' || rule.type === 'topic-silent') this._evalSilent(rule, now);
      } catch (error) {
        // One bad rule (e.g. broker gone) must not stop the rest.
        console.warn(`alertEngine: rule ${rule.id} (${rule.name || rule.type}): ${error.message}`);
      }
    }
  }

  /**
   * Drop the state of rules that were deleted, and of rules that were disabled, closing their active alarms
   * with an 'ended' event so the history never keeps an alarm open that nothing will resolve. Runs on every
   * evaluation pass and right after a rule is saved or deleted. Returns the current rules.
   */
  reconcileRules() {
    const rules = this.profiles?.alertRules() || [];
    const live = new Map(rules.map((r) => [r.id, r]));
    const close = (rule, topic, s, why) => {
      if (!s?.firing) return;
      s.firing = false;
      s.ack = null;
      this._emit(rule, 'ended', { ...(topic ? { topic } : {}), since: s.since, detail: why }, { webhook: false });
    };
    for (const [id, s] of this.state) {
      const rule = live.get(id);
      if (rule && rule.enabled !== false) continue;
      const known = rule || this.knownRules.get(id);
      if (known) close(known, null, s, rule ? 'Rule disabled while the alarm was active' : 'Rule deleted while the alarm was active');
      if (!rule) this.state.delete(id);
    }
    for (const [id, byTopic] of this.valueState) {
      const rule = live.get(id);
      if (rule && rule.enabled !== false) continue;
      const known = rule || this.knownRules.get(id);
      for (const [topic, s] of byTopic) {
        this._clearTimer(s);
        if (known) close(known, topic, s, rule ? 'Rule disabled while the alarm was active' : 'Rule deleted while the alarm was active');
      }
      this.valueState.delete(id);
      if (rule) this._pushState(rule);
    }
    this.knownRules = live;
    return rules;
  }

  _ruleState(rule) {
    let s = this.state.get(rule.id);
    if (!s) {
      // silence + new-topic rules only; value-threshold rules use _valueState.
      s = { firing: false, since: 0, armed: false, watermark: 0 };
      this.state.set(rule.id, s);
    }
    return s;
  }

  /**
   * Per-(rule, concrete topic) state for value-threshold rules. A wildcard rule
   * like `plant/+/temp` must track each pump independently — sharing one state
   * machine (the old bug) let a normal reading on one topic reset another's
   * sustain clock, suppressing a real breach, and made 'resolved' events cite
   * the wrong topic.
   */
  _valueState(rule, topic) {
    let byTopic = this.valueState.get(rule.id);
    if (!byTopic) {
      byTopic = new Map();
      this.valueState.set(rule.id, byTopic);
    }
    let s = byTopic.get(topic);
    if (!s) {
      if (byTopic.size >= VALUE_STATE_MAX_TOPICS) {
        const oldest = byTopic.keys().next().value; // evict oldest-inserted
        const victim = byTopic.get(oldest);
        this._clearTimer(victim);
        byTopic.delete(oldest);
        // Evicting a still-FIRING state silently would strand a phantom alarm:
        // clients that saw 'firing' never get a 'resolved', and the active set
        // (built from valueState) stops listing it. Resolve it, saying why.
        if (victim?.firing) {
          this._emit(rule, 'resolved', {
            topic: oldest,
            since: victim.since,
            detail: `stopped tracking ${oldest}: rule exceeded ${VALUE_STATE_MAX_TOPICS} concurrent topics`
          });
          this._pushState(rule);
        }
      }
      s = { firing: false, since: 0, breachedSince: 0, lastValue: null, timer: null };
      byTopic.set(topic, s);
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
      s.ack = null;
      this._emit(rule, 'firing', {
        silentForMs: last > 0 ? silentFor : null,
        lastActivity: last || null,
        detail: last > 0 ? `Silent for ${Math.round(silentFor / 1000)}s (threshold ${Math.round(threshold / 1000)}s)` : 'No data ever observed'
      });
      this._pushState(rule);
    } else if (!shouldFire && s.firing) {
      s.firing = false;
      s.ack = null;
      this._emit(rule, 'resolved', { lastActivity: last, since: s.since, detail: 'Data is flowing again' });
      this._pushState(rule);
    }
  }

  _evalNewTopic(rule) {
    const store = this.manager.stores.get(rule.brokerId);
    if (!store) return;
    const s = this._ruleState(rule);
    // Watermark on the store's monotonic event seq, not wall-clock time — two
    // events in the same millisecond would otherwise slip past a ts watermark.
    if (!s.armed) {
      s.armed = true;
      s.watermark = store.eventSeq; // pre-existing topics never fire
      return;
    }
    const prefix = rule.prefix || '';
    const fresh = store.events.filter(
      (e) => e.type === 'topic-added' && e.seq > s.watermark && (!prefix || e.topic.startsWith(prefix))
    );
    s.watermark = store.eventSeq;
    for (const e of fresh.slice(0, 20)) {
      this._emit(rule, 'event', { topic: e.topic, detail: `New topic appeared: ${e.topic}` });
    }
    if (fresh.length > 20) {
      this._emit(rule, 'event', { detail: `…and ${fresh.length - 20} more new topics in this window` });
    }
  }

  /**
   * Live-tap handler for value-threshold rules. Hot path: nothing allocates
   * until a rule's broker matches (topic split is lazy and reuses the
   * manager's pre-split parts when present), and the rule table is compiled.
   * `now` is injectable for deterministic sustain tests.
   */
  onMessage(msg, now = Date.now()) {
    const table = this.valueTable();
    if (!table.length) return;
    let topicParts = null;
    for (const entry of table) {
      if (entry.rule.brokerId !== msg.brokerId) continue;
      if (!topicParts) topicParts = msg.topicParts || msg.topic.split('/');
      if (!matchParts(entry.parts, topicParts)) continue;
      try {
        this._evalValue(entry, msg, now);
      } catch (error) {
        console.warn(`alertEngine: rule ${entry.rule.id} (${entry.rule.name || entry.rule.type}): ${error.message}`);
      }
    }
  }

  /**
   * Value-threshold state machine, per rule:
   *
   *   ok --breach--> breached (breachedSince set)
   *   breached --held for sustainMs--> FIRING (emit 'firing')
   *   breached --condition drops--> ok (sustain clock resets)
   *   FIRING --clear condition--> ok (emit 'resolved')
   *   FIRING --in hysteresis deadband--> FIRING (no flap, no re-emit)
   *
   * With sustainMs = 0 the breached state fires on the first breaching
   * message. The clear condition defaults to "op no longer true"; with
   * clearValue set, '>'/'>=' rules resolve only at value <= clearValue and
   * '<'/'<=' rules only at value >= clearValue.
   */
  _evalValue(entry, msg, now) {
    const rule = entry.rule;
    const v = extractValue(msg.payload, entry.fieldParts);
    if (v === null) return; // non-numeric payload/field — not ours to judge
    const s = this._valueState(rule, msg.topic);
    s.lastValue = v;
    const limit = Number(rule.value);
    const sustainMs = Number(rule.sustainMs) > 0 ? Number(rule.sustainMs) : 0;
    const breached = OPS[rule.op](v, limit);
    const label = rule.field || 'value';

    if (breached) {
      const began = !s.breachedSince;
      if (began) s.breachedSince = now;
      if (!s.firing && now - s.breachedSince >= sustainMs) {
        this._clearTimer(s);
        this._fireValue(rule, msg.topic, s, v, now);
      } else if (!s.firing) {
        if (began) this._pushState(rule);
        this._armTimer(rule, msg.topic, s, sustainMs - (now - s.breachedSince));
      }
    } else {
      const wasBreached = s.breachedSince > 0;
      s.breachedSince = 0; // sustain clock only counts continuous breach
      this._clearTimer(s);
      if (s.firing && this._isCleared(rule, v)) {
        s.firing = false;
        s.ack = null;
        this._emit(rule, 'resolved', {
          topic: msg.topic,
          value: v,
          since: s.since,
          detail: `${label} = ${v} back within limit on ${msg.topic}`
        });
        this._pushState(rule);
      } else if (wasBreached && !s.firing) {
        this._pushState(rule); // breach ended inside the sustain window: back to idle
      }
    }
  }

  _fireValue(rule, topic, s, v, now) {
    const limit = Number(rule.value);
    const sustainMs = Number(rule.sustainMs) > 0 ? Number(rule.sustainMs) : 0;
    s.firing = true;
    s.since = now;
    s.ack = null;
    this._emit(rule, 'firing', {
      topic,
      value: v,
      detail:
        `${rule.field || 'value'} = ${v} (${rule.op} ${limit}` +
        (sustainMs ? `, sustained ${Math.round(sustainMs / 1000)}s` : '') +
        `) on ${topic}`
    });
    this._pushState(rule);
  }

  // A breached state that is waiting out `sustainMs` gets a timer, so a value that simply stays
  // there (no new message) still fires on time. The timer re-reads the rule: an edit that
  // lengthened sustainMs re-arms it, one that disabled or removed the rule cancels it.
  _armTimer(rule, topic, s, delayMs) {
    this._clearTimer(s);
    s.timer = setTimeout(() => {
      s.timer = null;
      try {
        this._promote(rule.id, topic, s);
      } catch (error) {
        console.warn(`alertEngine: rule ${rule.id}: ${error.message}`);
      }
    }, Math.max(1, Math.ceil(delayMs)));
    s.timer.unref?.();
  }

  _clearTimer(s) {
    if (s && s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
  }

  _promote(ruleId, topic, s, now = Date.now()) {
    const rule = (this.profiles?.alertRules() || []).find((r) => r.id === ruleId);
    if (!rule || rule.enabled === false || !s.breachedSince || s.firing || s.lastValue === null) return;
    const sustainMs = Number(rule.sustainMs) > 0 ? Number(rule.sustainMs) : 0;
    const left = sustainMs - (now - s.breachedSince);
    if (left > 0) return this._armTimer(rule, topic, s, left);
    if (!OPS[rule.op]?.(s.lastValue, Number(rule.value))) return;
    this._fireValue(rule, topic, s, s.lastValue, now);
  }

  _pushState(rule) {
    this.io?.emit('alert-state', { ruleId: rule.id, ...this.getRuleState(rule) });
  }

  /**
   * What the engine believes about one rule right now:
   *   { state: 'idle'|'breached'|'firing'|'disabled'|'broken', since, value, topic, remainingMs,
   *     sustainMs, firingTopics, lastTransition: { status, ts }|null, broken?, webhook }
   * `since` is when the current state began (breach start, firing start). `remainingMs` is the time
   * left until a breached rule fires (0 once due). `webhook` carries health only, never the URL.
   */
  getRuleState(rule, now = Date.now()) {
    const events = this.history;
    let last = null;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].ruleId === rule.id) {
        last = events[i];
        break;
      }
    }
    const wh = this.webhookStats.get(rule.id);
    const out = {
      state: 'idle',
      since: null,
      value: null,
      topic: null,
      remainingMs: null,
      sustainMs: Number(rule.sustainMs) > 0 ? Number(rule.sustainMs) : 0,
      severity: severityOf(rule),
      firingTopics: 0,
      unacknowledged: 0,
      lastTransition: last ? { status: last.status, ts: last.ts } : null,
      webhook: {
        configured: Boolean(rule.webhookUrl),
        failures: wh?.failures || 0,
        lastError: wh?.lastError || null,
        lastAttemptAt: wh?.lastAttemptAt || null,
        lastOkAt: wh?.lastOkAt || null
      }
    };
    const missing = brokenRefs('alertRules', rule, { profiles: this.profiles, mqttManager: this.manager });
    if (missing.length) {
      out.state = 'broken';
      out.broken = missing;
      return out;
    }
    if (rule.enabled === false) {
      out.state = 'disabled';
      return out;
    }
    if (rule.type === 'value-threshold') {
      const byTopic = this.valueState.get(rule.id);
      let firing = null;
      let breached = null;
      let latest = null;
      for (const [topic, s] of byTopic || []) {
        if (s.firing) {
          out.firingTopics++;
          if (!s.ack) out.unacknowledged++;
          if (!firing || s.since < firing.s.since) firing = { topic, s };
        } else if (s.breachedSince && (!breached || s.breachedSince < breached.s.breachedSince)) breached = { topic, s };
        if (s.lastValue !== null) latest = { topic, s };
      }
      if (firing) {
        Object.assign(out, { state: 'firing', since: firing.s.since, value: firing.s.lastValue, topic: firing.topic });
      } else if (breached) {
        Object.assign(out, {
          state: 'breached',
          since: breached.s.breachedSince,
          value: breached.s.lastValue,
          topic: breached.topic,
          remainingMs: Math.max(0, out.sustainMs - (now - breached.s.breachedSince))
        });
      } else if (latest) {
        Object.assign(out, { value: latest.s.lastValue, topic: latest.topic });
      }
      return out;
    }
    const s = this.state.get(rule.id);
    if (s?.firing) Object.assign(out, { state: 'firing', since: s.since, unacknowledged: s.ack ? 0 : 1 });
    return out;
  }

  getRuleStates(now = Date.now()) {
    return Object.fromEntries((this.profiles?.alertRules() || []).map((r) => [r.id, this.getRuleState(r, now)]));
  }

  /** Hysteresis clear check — see the _evalValue state machine notes. */
  _isCleared(rule, v) {
    if (rule.clearValue === null || rule.clearValue === undefined || rule.clearValue === '') return true;
    const clear = Number(rule.clearValue);
    if (!Number.isFinite(clear)) return true;
    if (rule.op === '>' || rule.op === '>=') return v <= clear;
    if (rule.op === '<' || rule.op === '<=') return v >= clear;
    return true; // ==/!= have no meaningful deadband
  }

  _emit(rule, status, extra = {}, { webhook = true, now = Date.now() } = {}) {
    const severity = severityOf(rule);
    const evt = {
      seq: ++this.seq,
      ruleId: rule.id,
      ruleName: rule.name || rule.type,
      type: rule.type,
      brokerId: rule.brokerId,
      severity,
      status, // 'firing' | 'resolved' | 'event' | 'acknowledged' | 'ended'
      ts: now,
      ...extra
    };
    this.history.push(evt);
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
    this.journal?.append(evt);
    const tk = `${status}|${severity}`;
    this.transitions.set(tk, (this.transitions.get(tk) || 0) + 1);
    this.io?.emit('alert', evt);
    if (webhook && WEBHOOK_STATUSES.has(status) && rule.webhookUrl && typeof this.fetchImpl === 'function') {
      const wh = this.webhookStats.get(rule.id) || { failures: 0, lastError: null, lastAttemptAt: null, lastOkAt: null };
      this.webhookStats.set(rule.id, wh);
      wh.lastAttemptAt = Date.now();
      const fail = (message) => {
        this.webhookFailures++;
        wh.failures++;
        wh.lastError = message;
        this.lastWebhookError = `rule ${rule.id}: ${message}`;
      };
      const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) : undefined;
      // Failures are recorded, not console-logged: this fires from an async
      // callback, and stray console writes from library code are noise in the
      // server log and poison in test-runner child processes.
      this.fetchImpl(rule.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(evt),
        signal
      }).then(
        (r) => {
          if (r && r.ok === false) fail(`HTTP ${r.status}`);
          else {
            wh.lastOkAt = Date.now();
            wh.lastError = null;
          }
        },
        (error) => fail(error.message)
      );
    }
  }

  getEvents(limit = 200, { ruleId = null } = {}) {
    const list = ruleId ? this.history.filter((e) => e.ruleId === ruleId) : this.history;
    return list.slice(-limit).reverse();
  }

  /** One page of the durable history (the ring when there is no journal). See alertHistory.queryEvents. */
  queryHistory(query = {}, opts = {}) {
    const filters = parseQuery(query, opts);
    return queryEvents(this.journal ? this.journal.events() : this.history, filters);
  }

  /** The firing state objects of a rule as [topic|null, state] pairs (value rules: one per topic). */
  _firingStates(rule) {
    if (rule.type === 'value-threshold') return [...(this.valueState.get(rule.id) || [])].filter(([, s]) => s.firing);
    const s = this.state.get(rule.id);
    return s?.firing ? [[null, s]] : [];
  }

  /**
   * Active alarms, oldest first: every firing (rule, topic), plus value rules that are breached and waiting
   * out their sustain time (state 'breached', with `remainingMs`). Disabled and deleted rules have none.
   */
  getActive(now = Date.now()) {
    const out = [];
    for (const rule of this.profiles?.alertRules() || []) {
      if (rule.enabled === false) continue;
      const base = { ruleId: rule.id, ruleName: rule.name || rule.type, type: rule.type, brokerId: rule.brokerId, severity: severityOf(rule) };
      if (rule.type === 'value-threshold') {
        const sustainMs = Number(rule.sustainMs) > 0 ? Number(rule.sustainMs) : 0;
        const condition = `${rule.field || 'value'} ${rule.op} ${rule.value}`;
        for (const [topic, s] of this.valueState.get(rule.id) || []) {
          if (s.firing) {
            out.push({ ...base, id: alarmKey(rule.id, topic), topic, value: s.lastValue, since: s.since, state: 'firing', condition, acknowledged: Boolean(s.ack), ack: s.ack || null });
          } else if (s.breachedSince) {
            out.push({ ...base, id: alarmKey(rule.id, topic), topic, value: s.lastValue, since: s.breachedSince, state: 'breached', condition, remainingMs: Math.max(0, sustainMs - (now - s.breachedSince)), acknowledged: false, ack: null });
          }
        }
      } else {
        const s = this.state.get(rule.id);
        if (!s?.firing) continue;
        const scope = rule.type === 'topic-silent' ? rule.topic : rule.path || '';
        const threshold = Math.round((Number(rule.thresholdMs) || 60_000) / 1000);
        out.push({ ...base, id: alarmKey(rule.id, null), topic: scope || null, value: null, since: s.since, state: 'firing', condition: `silent > ${threshold}s`, acknowledged: Boolean(s.ack), ack: s.ack || null });
      }
    }
    return out.sort((a, b) => a.since - b.since);
  }

  /**
   * Acknowledge firing alarms: one ({ ruleId, topic }) or every firing alarm of a rule ({ ruleId, all: true }).
   * `by` is who acknowledged, `note` optional. `since`, when given, is the start of the occurrence the
   * operator saw: if the alarm cleared and fired again since, the request is refused ('stale') rather than
   * acknowledging an occurrence nobody has looked at. An alarm that is already acknowledged keeps its first
   * acknowledgement. Returns { acknowledged: [{ id, ruleId, topic, by, at, note }], already } or
   * { error: 'not-found' | 'not-firing' | 'stale' }.
   */
  acknowledge({ ruleId, topic = null, all = false, by = 'operator', note = null, since = null, now = Date.now() } = {}) {
    const rule = (this.profiles?.alertRules() || []).find((r) => r.id === ruleId);
    if (!rule) return { error: 'not-found' };
    const cleanNote = typeof note === 'string' && note.trim() ? stripUrlCredentials(note.trim()).slice(0, ACK_NOTE_MAX) : null;
    let targets = this._firingStates(rule);
    if (!all) {
      if (rule.type === 'value-threshold') targets = targets.filter(([t]) => t === topic);
      if (!targets.length) return { error: 'not-firing' };
      if (since !== null && since !== undefined && since !== '' && Number(since) !== targets[0][1].since) return { error: 'stale' };
    }
    const acknowledged = [];
    let already = 0;
    for (const [t, s] of targets) {
      if (s.ack) {
        already++;
        continue;
      }
      s.ack = { by: String(by || 'operator').slice(0, 120), at: now, note: cleanNote };
      acknowledged.push({ id: alarmKey(rule.id, t), ruleId: rule.id, topic: t, ...s.ack });
      this._emit(
        rule,
        'acknowledged',
        { ...(t ? { topic: t } : {}), since: s.since, ackBy: s.ack.by, ...(cleanNote ? { note: cleanNote } : {}), detail: `Acknowledged by ${s.ack.by}${cleanNote ? `: ${cleanNote}` : ''}` },
        { webhook: false, now }
      );
    }
    if (acknowledged.length) this._pushState(rule);
    return { acknowledged, already };
  }

  /** Counts for Prometheus: active alarms by state/severity/acknowledged, transitions, journal health. */
  getMetrics(now = Date.now()) {
    const active = {};
    for (const a of this.getActive(now)) {
      const k = `${a.state}|${a.severity}|${a.acknowledged}`;
      active[k] = (active[k] || 0) + 1;
    }
    return {
      active,
      transitions: Object.fromEntries(this.transitions),
      journal: this.journal ? { bytes: this.journal.bytes(), ...this.journal.stats } : null
    };
  }

  /** Write the queued history to disk (shutdown). */
  async flush() {
    await this.journal?.flush();
  }
}

/** Identity of one alarm: the rule plus, for value rules, the concrete topic. */
function alarmKey(ruleId, topic) {
  return `${ruleId}|${topic || ''}`;
}

module.exports = { AlertEngine, RULE_TYPES, VALUE_OPS, SEVERITIES, alarmKey };
