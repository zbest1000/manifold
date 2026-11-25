# Manifold architecture

This document describes how Manifold is built: the system layout, the message
hot path, each subsystem, the API surface, protocol behavior worth knowing,
the client, and the testing strategy. The README stays short; the details live here.

**Terminology.** The UI says **mapping** for what the API, the stored configuration and this
document's server sections call a **binding** (`/api/tags/bindings`, `source`, `target`, `rbe`).
They are the same object. User-facing guides use "mapping"; this document uses "binding" when it
means the stored record or the engine (`tagBindings`, `bindingModel`) and "mapping" for what a
person does in the editor.

## System overview

```mermaid
flowchart LR
    subgraph sources [Data sources]
        B[MQTT brokers]
        O[OPC UA servers]
        C[CESMII SMIP]
        I[i3X servers]
        PLC[PLCs and devices<br/>Modbus TCP, S7, EtherNet/IP]
    end

    subgraph hosts [driver host processes - one per protocol]
        DH[modbus / s7 / eip<br/>runtime + driver]
    end

    subgraph server [server/ - Node.js]
        M[mqttManager<br/>ingest + coalesce<br/>Sparkplug queue]
        OM[opcuaManager<br/>supervised reconnect]
        SUP[driverSupervisor]
        DM[deviceManager]
        T[TopicTrie]
        P[pipelineEngine]
        MD[modelEngine]
        R[recorder / replayer]
        SC[schemaContracts]
        TB[tagBindings<br/>tag sources, RBE, quality]
        SP[sparkplugPublisher]
        OB[historianOutbox]
        H[historians<br/>influx / timescale / timebase]
        AL[alertEngine]
        AU[auditLog]
        MX[metricsExporter]
    end

    subgraph clients [Consumers]
        UI[client/ - React]
        MCP[mcp/ - MCP server]
        PROM[Prometheus]
        HIST[(Historian databases)]
    end

    B --> M
    O --> OM
    PLC <-- read-only --> DH
    DH -- IPC: samples, state --> SUP --> DM
    M --> T
    M -- message tap --> P & R & SC & TB & AL
    OM -- OpcuaSource: samples + state --> TB
    DM -- samples + state --> TB
    P --> OB
    R --> OB
    OB --> H --> HIST
    TB --> SP --> B
    TB -- mqtt publish, _status --> B
    P -- publish --> B
    M -- Socket.IO --> UI
    DM -- Socket.IO --> UI
    MCP -- REST --> server
    MX --> PROM
```

The backend owns all live state. The client is a real-time view over
Socket.IO plus REST for configuration. The MCP server is a stateless bridge
over the same REST API, so a browser user and an MCP agent see identical
data. Device drivers are the one part that does not run in the server
process: each protocol's driver runs in a supervised child process, and the
server only ever sees its IPC messages (see
[Southbound device drivers](#southbound-device-drivers)).

## Repository layout

```
server/   Express + Socket.IO backend; protocol managers and engines
  drivers/    southbound device drivers (modbus, s7, eip), the shared runtime
              (runtime/deviceRuntime.js) and the child-process entry (host.js)
  services/   managers, engines, tagSources/ (tag-source adapters)
  tools/      runnable simulators for the demo stack (simulators.js)
  test/       node:test suites; test/support/ holds the device simulators
client/   React 18 + Vite + Tailwind; design system (src/components/ui), pages,
          canvas renderers (src/graph), Zustand store; e2e/ holds the Playwright suite
mcp/      MCP server (stdio), forwards to the backend REST API
native/   Rust/napi hot-path experiment, kept as a reproducible benchmark
docker/   Demo stack: app, mosquitto, OPC PLC simulator, traffic generator,
          simulated Modbus / S7 / EtherNet/IP devices (docker-compose.yml)
docs/     design notes (docs/design/), the review, the UI backlog and the wiki
          sources (docs/wiki/); site/ is the static landing page
```

## Message hot path

The server is built to survive high publish rates. The design rule: per-message
work is minimal and allocation-free; everything expensive is deferred to a
coalesced flush that is bounded by *topics touched*, not messages received.
Sparkplug is the one deliberate exception, described below.

```mermaid
sequenceDiagram
    participant Broker
    participant handleMessage
    participant TopicStore
    participant Flush as flushBroker (100ms timer)
    participant Consumers as socket + tap engines

    Broker->>handleMessage: publish (topic, payload)
    handleMessage->>TopicStore: ingest - store latest payload, mark dirty
    Note over handleMessage,TopicStore: no JSON parse, no uuid,<br/>no message object allocation
    Flush->>TopicStore: drain dirty rows
    Flush->>Flush: buildMessage once per touched topic<br/>(parse, type cache)
    Flush->>Consumers: one batch: socket emit + engine tap
    Note over TopicStore,Flush: Sparkplug topics additionally keep every payload<br/>in a bounded queue, drained in arrival order
```

Key mechanics:

- **TopicStore** (`server/services/topicStore.js`) is a struct-of-arrays: one
  `Map(topic → slot)` plus parallel typed arrays, with the latest payload kept
  as a latin1 string (one byte per char in V8, lossless for arbitrary bytes).
  Capped at 2M topics per broker (reaching the cap raises a
  `topic-cap-reached` event and a log warning; new topics are dropped and
  counted). Slots are normally never freed; setting
  `MANIFOLD_TOPIC_IDLE_TTL_MS` turns on an incremental background sweep that
  frees topics idle for longer than the TTL. At 1M topics this measured 425 MB RSS versus
  532 MB for a Map-of-objects; the Rust store measured 380 MB but lost on
  FFI round-trip cost (see `native/README.md` for the full benchmark).
- **Coalescing**: a topic published 10,000 times inside one 100 ms window
  produces one forwarded update. Per-flush forwarding is capped
  (`FORWARD_CAP`), with counts always exact server-side. This applies to every
  topic **except Sparkplug**.
- **Sparkplug is not coalesced.** NDATA/DDATA carry only the metrics that
  changed, so latest-wins would lose data that the registry, Sparkplug-source
  bindings, pipelines and historian targets need. The store classifies each
  topic once per slot (`queueClassifier`); Sparkplug topics also append every
  payload to a per-flush queue that is drained in arrival order. Each queued
  message is decoded and delivered, in order, to the registry and the engine
  tap; the UI batch still carries only the latest message per topic. The queue
  is bounded (`MANIFOLD_SPARKPLUG_QUEUE_MAX`, default 5,000 messages, and
  `MANIFOLD_SPARKPLUG_QUEUE_BYTES`, default 8 MiB, per flush). Past a bound a
  message is not queued, the broker's `sparkplugCoalesced` metric increments,
  and that topic falls back to latest-wins for the rest of the window (its
  latest payload is appended at drain, so it is never lost or reordered).
  Messages therefore reach consumers at flush cadence (up to 100 ms later),
  in order, not synchronously.
- **Per-slot type cache**: a topic's classification (telemetry/alarm/…,
  Sparkplug or not) is a pure function of the topic string, so it is computed
  once per slot, not per flush.
- **Single topic split**: the flush splits each topic once and passes
  `topicParts` to every tap consumer (pipelines, recorder, contracts,
  bindings).
- **Zero-listener guard**: the socket batch is not serialized when no client
  is connected (headless or MCP-only deployments).
- Intake subscribes at QoS 1 by default (configurable per broker). If the
  broker refuses the wildcard grant (SUBACK 0x80), the manager emits
  `subscription-downgraded` and retries at QoS 0. `$SYS/#` stays at QoS 0.
  A subscribe that fails for another reason (a timeout, a busy client) is
  retried with exponential backoff, at most three times, before an error is
  surfaced.
- **Source time and quality** travel with the message when the payload has
  them: a TVQ envelope's `t` and `q`, a Sparkplug message and metric
  timestamp, and a metric's `Quality` property. `timestamp` stays arrival
  time; `sourceTimestamp` and `quality` are set only when present, and the
  pipeline engine and historian targets prefer them.
- Other growth is bounded too: the MQTT 5 property side table is capped
  (`MANIFOLD_MAX_MSG_PROPS`), `publish-success` socket emits are folded into
  at most one summary per broker per second, and branch-silent alert rules read
  an activity cache updated in O(depth) per touched topic instead of walking
  the trie every interval.

## MQTT transports and versions

A broker connection is `mqtt`, `mqtts`, `ws`, or `wss`. WebSocket transports
require an explicit path (`wsPath`, default `/mqtt`) because there is no
universal convention (Mosquitto listens on 9001, reverse proxies on 443).

`mqttVersion` is 4 (MQTT 3.1.1, default) or 5 per broker. On v5 sessions,
inbound user properties, content type, response topic, and correlation data
are decoded onto the message (correlation data as base64), and the publish
API takes `properties` (`userProperties`, `contentType`, `responseTopic`) on
`POST /publish`. Properties are silently dropped on v4 sessions — mqtt.js
errors if they are sent there.

The intake subscription itself is configurable per broker (`subscribeFilter`,
default `#`), including shared subscriptions: `$share/<group>/<filter>` works
unchanged because messages still arrive on the real topic, so nothing
downstream cares. Use it to split intake load across multiple Manifold
instances or to scope intake to a namespace.

## Wildcard resolution

A subscription filter is a query, not a destination. `TopicTrie` indexes every
observed topic; filters (`+`, `#`, `$share` groups, `$`-topic exclusion rules)
resolve to exact match counts, covering subtree roots, and concrete leaf
topics. The trie builds lazily on first resolve and indexes incrementally
afterward. Flows uses this to show what each consumer actually receives;
pipeline previews and alert rules run on the same index.

## UNS derivation

The UNS view is derived entirely from observed traffic — there is no separate
registration step. The client keeps per-path activity, value, and rate maps
fed by the message stream, aggregated up the ancestor chain. Staleness is
per-topic: an EMA of inter-arrival gaps means a topic publishing every 500 ms
is flagged *overdue* seconds after it stops, while a daily report topic is not
flagged for hours. Server-side, `getUnsTree` returns a depth- and node-capped
skeleton with exact subtree counts, and the lint pass scores structural
conformance (naming-convention mixes, payloads on branches, empty segments,
single-child chains, depth variance).

The topology canvas paints through the shared frame scheduler
(`createFrameScheduler` in `client/src/graph/canvasKit.js`): about one frame per
second when there is no traffic and no interaction (to keep staleness and rate
captions honest), full frame rate while data flows or the user interacts, and
nothing at all while the tab is hidden or the canvas is scrolled out of view.

## Pipelines

```mermaid
flowchart LR
    SRC[broker filter match] --> TR[transform chain]
    TR -->|null| DROP[dropped by filter transform]
    TR --> TGT{target}
    TGT -->|mqtt| LG{loop guards}
    LG -->|static: output re-matches own source| BLOCK[blocked + counted]
    LG -->|hop count > 4 within 10s| BLOCK
    LG -->|ok| PUB[publish to broker]
    TGT -->|historian| OB[outbox enqueue]
```

- The route table is **compiled**: filters pre-split, disabled routes
  excluded, rebuilt only when the profile store revision changes. Steady-state
  per-message cost is array walks against pre-split segments.
- Transforms: `repath` (with `{n}` / `{n-}` / `{topic}` segment templates),
  `pick`, `rename`, `set`, `scale`, `numeric` (drop non-numeric; with `field`
  it also unwraps a JSON field, e.g. `v` of an envelope), `sparkplugFlatten`
  (`is_null` metrics propagate as explicit nulls), `envelope` (TVQ `{v,t,q}`;
  `t` and `q` come from the source payload when it carries them, else arrival
  time and Good).
- Loop protection is two-layer because repath templates defeat static
  analysis: outputs matching the route's own source are blocked outright, and
  a short-lived hop counter on published (broker, topic) pairs catches
  indirect A→B→A cycles across routes and brokers.
- Every route can be dry-run against the observed topic set before enabling:
  the trie resolves the source filter, each sample's latest payload runs
  through the transform chain, and the in→out mapping is reported without
  publishing.

## Historians and store-and-forward

Three backends share one write interface (`writePoints`):

| Backend | Wire format | Notes |
|---|---|---|
| InfluxDB v2 | line protocol | real numbers write `value=`, everything else (including booleans, as `"true"`/`"false"`) writes `raw="…"`, so a topic that alternates types cannot cause field-type conflicts in a shard. `null` is skipped and counted; names with control characters are rejected so a topic cannot inject lines. **No quality is stored**, which is why it is not offered for device data |
| TimescaleDB / PostgreSQL | batched parameterized INSERT | table auto-created, promoted to hypertable when the extension exists; stores `quality`; identifier allow-list; pooled connections with bounded connect/query timeouts; the pool is keyed by the whole connection config, so an edited password or TLS setting takes effect |
| Timebase (Flow Software) | TVQ REST on `:4511` | datasets auto-create; write path overridable per instance; quality is carried (Bad is preserved), each tag's samples are sent oldest-first; Timebase's native MQTT/Sparkplug ingestion is an equally valid path |

Delivery always goes through the **outbox** — engines never call a historian
directly:

```mermaid
stateDiagram-v2
    [*] --> Queue: enqueue
    Queue --> Written: flush ok
    Queue --> Spill: write failed (retryable) / memory cap
    Queue --> DeadLetter: rejected for good (4xx, SQL data error)
    Spill --> Written: drained oldest-first, ahead of live data
    Spill --> DeadLetter: rejected for good while draining
    Spill --> Dropped: spill at cap
    note right of Dropped
        drop policy per historian:
        newest (default, keeps outage start)
        or oldest (keeps latest data)
    end note
```

**Ordering.** Delivery per historian is strictly oldest-first, because Timebase
may ignore a point older than a tag's newest. While a spill backlog exists,
live points are never sent ahead of it: if the backlog cannot be drained they
are appended behind it on disk. A memory overflow spills the oldest queued
points, and points that overflow while a live batch is in flight are held back
so a failed batch is re-spilled in front of them.

**Spill format** (per historian, under `<MANIFOLD_DATA_DIR>/outbox/`):

| File | Contents |
|---|---|
| `<id>.<seq>.seg` | append-only JSONL segments, one point per line, rotated at 4 MiB; `<seq>` is a monotonic 13-digit number |
| `<id>.cursor` | `{seg, offset}`: bytes already delivered from the oldest segment, written temp + fsync + rename, so a crash either keeps the old offset (a re-send, so delivery is **at-least-once**) or the new one, never a lost or half-written spill |
| `<id>.deadletter.jsonl` | points the historian permanently rejected; capped at 5 MiB and counted |
| `<id>.jsonl` | **legacy** single-file spill from older versions: read as the oldest segment and drained first, never appended to, so upgrading needs no conversion |

Draining reads each segment once, forward (O(n)); all disk writes are
asynchronous and serialized per historian. The in-memory queue holds 5,000
points, the live spill is capped at 20 MiB (the drop policy decides which end
goes beyond it), and each flush sends batches of 1,000.

**Poison batches.** A batch the historian *permanently* rejects (HTTP 4xx except
408/429 and the credential errors 401/403; PostgreSQL data or integrity errors)
is bisected, with a bounded number of extra requests, to isolate the bad points.
Those move to the dead-letter file; the rest is delivered and draining
continues. Credential errors are different: the backlog waits for the operator
to fix the token rather than being discarded. All bounds are explicit and
reported (queue depth, spill bytes, written/spilled/dropped counts on `/metrics`;
dead-letter counts in the outbox stats).

### Read-back (Trends)

The write path has a read counterpart: `queryTags` lists distinct stored
topics and `querySeries` reads downsampled series for up to 10 tags over a
time range (`GET /api/historians/:id/tags`, `POST /api/historians/:id/query`).

```mermaid
flowchart LR
    UI[Trends page] --> API[POST /api/historians/:id/query]
    API --> F{backend}
    F -->|influxdb| FLUX[Flux aggregateWindow mean]
    F -->|timescaledb| TB[time_bucket avg]
    F -->|timebase| TVQ[GET dataset data, bucket-averaged locally]
    FLUX --> S[series of tag, points]
    TB --> S
    TVQ --> S
    S --> CH[SVG chart, 30s auto-refresh]
```

- Downsampling happens in the database: the requested range is bucketed to at
  most `maxPoints` (default 1000) buckets, so a month of 1 Hz data comes back
  as ~1000 averaged points, not 2.6M rows.
- Flux has no parameter binding over the raw `/query` endpoint, so tag names
  are strictly validated and quoted rather than interpolated cleverly;
  TimescaleDB queries are parameterized.
- Timebase read-back uses the same documented dataset GET the CI integration
  test exercises; the API returns raw TVQs, so downsampling happens locally.
  Tag listing has no Timebase endpoint — Trends falls back to manual entry.
- **Unverified Timebase behaviour.** The REST API reference could not be read
  when the device work was written. Not confirmed: that a point older than a
  tag's newest is ignored (the outbox is ordered as if it were), the shape
  Timebase accepts for a Bad sample with no value (Manifold sends `v: null`
  with the quality), whether samples closer than its advertised 500 ms
  resolution are kept, and its quality-code semantics. CI runs against
  `timebase/historian:1.3.4`; 2.x is current. See
  [`docs/design/southbound-drivers.md`](docs/design/southbound-drivers.md) §11.

## Alerting

Four rule types share one engine (`server/services/alertEngine.js`), with two
evaluation paths:

- **Silence and appearance rules** (`branch-silent`, `topic-silent`,
  `new-topic`) evaluate on a 15 s interval against the topic index.
- **Value rules** (`value-threshold`) ride the live message tap: a dot-path
  `field` into the JSON payload (or the payload itself) is compared against
  `value` with one of `>`, `>=`, `<`, `<=`, `==`, `!=` — at message latency,
  not poll latency. The rule table is compiled (filters and field paths
  pre-split, disabled rules excluded, rebuilt only on profile revision
  change — the same pattern as the pipeline engine), so steady-state
  per-message cost is an integer compare plus array walks.

Value-rule state machine:

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Breached: condition true
    Breached --> Idle: condition false before sustainMs
    Breached --> Firing: held for sustainMs
    Firing --> Idle: cleared (clearValue hysteresis)
```

`sustainMs` requires the condition to hold continuously before firing;
`clearValue` adds hysteresis (a `>` rule resolves only at
`value <= clearValue`, a `<` rule only at `value >= clearValue`) so a signal
hovering at the threshold cannot flap. Non-numeric payloads are ignored, not
errors.

Rules fire on transitions and can POST each event to a webhook (5 s timeout).
Webhook failures do not kill the engine, but they are not silent either:
`webhookFailures` and `lastWebhookError` are reported on
`GET /api/alerts/rules`. Webhook delivery goes through the egress guard
(`guardedFetch`), so a webhook to loopback, link-local or, by default, a private
address is refused; viewers see only `hasWebhook`, never the URL.

## Tag sources, bindings and the Sparkplug publisher

### The tag-source abstraction

A binding no longer knows about OPC UA. `TagBindings` consumes **tag sources**:
adapters registered with `registerSource(type, adapter)` that emit two
normalized events (`server/services/tagSources/`):

```js
// one reading
'sample'       { sourceType, sourceId, address, v, type, q, qReason?, tSource?, tRead }
// the source as a whole
'source-state' { sourceType, sourceId, state: 'online' | 'offline', reason }
// optional: the end of one batch of samples (the device manager sends it per poll-group cycle)
'batch-end'    { sourceType, sourceId }
```

`type` is a normalized name (`bool`, `int8` ... `uint64`, `float32`, `float64`,
`string`, `datetime`); `q` is **192 Good / 64 Uncertain / 0 Bad**; `tSource` is
the source's own timestamp when it has one (OPC UA does, polled protocols do
not) and `tRead` is when the value was read. An adapter also implements
`ensureMonitored(sourceId, address, intervalMs)`. There are two adapters: the
OPC UA adapter (`OpcuaSource`, wrapping the manager's `value` and
`connection-state` events and mapping OPC UA status codes to quality) and the
device manager (`source type 'device'`, fed by the driver supervisor). Sparkplug
sources are not adapters: they read the decoded message tap directly.
MQTT-source selections still compile into pipeline routes instead.

### Bindings

A binding is `{ source, target, rbe }`. The pure half (validation, expansion into
publishing units, topic and payload shapes, the retained-topic set, warnings and
the preview) is `services/bindingModel.js`; `services/tagBindings.js` is the run
time on top of it.

```js
source: { type: 'device', deviceId, tags: [{ address: <tagKey>, name? }] | 'all' }
      | { type: 'device-profile', profileId, tags: [<profile tag key>] | 'all' }
      | { type: 'opcua', connectionId, samplingInterval?, tags: [{ address: <nodeId>, name }] }
      | { type: 'sparkplug', brokerId, group, edge, device?, metrics? }
target: { mode: 'mqtt', brokerId,
          assetPath                       // 'acme/dallas/line4/filler' (no placeholders)
          | pathTemplate                  // legacy 'site/area/{name}'
          | assetPathTemplate | assetPaths // device-profile only: 'acme/{site}/{device}' | { deviceId: path }
          layout?: 'topic-per-tag' | 'object-per-asset', maxObjectBytes?,   // default 64 KB, 1 KB..1 MB
          format: 'plain' | 'envelope',   // object layout always carries quality
          qos?, retain?, statusTopic?, metaTopic?,   // false opts out of <asset>/_status, <asset>/_meta
          historian?: { historianId } }   // direct store-and-forward target (Timebase, TimescaleDB)
      | { mode: 'sparkplug', brokerId, group, edge, device /* profile: may use {device}, {param} */, historian? }
rbe:    { heartbeatMs?, deadband?: { type: 'absolute' | 'percent', value } }   // legacy target.deadband = absolute

// Choosing what to map and adding context (all optional; services/bindingContext.js):
tags[i]:  <address> | { address, name?, enabled? /* default true */, ...overrides }
source:   { ..., select?: { include?, exclude?, pollGroups?, types?, withProperty? },   // tags: 'all' only
                 overrides?: { <tagKey>: overrides } }
overrides: { name, displayName, description, unit, range, dataType, scale, offset, precision,
             states, statesMode, limits, deadband, context, enabled }
target:   { ..., fields?: ['v','t','q','u','name','src','ctx'], metaFields?: [...],
                 context?: { key: value /* {device} {deviceId} {protocol} {host} {param:x} */ },
                 contextMode?: 'meta' | 'payload' | 'none' }
```

**Choosing what to map.** A tag entry with `enabled: false` stays in the stored
binding but is dropped at expansion, so it is not monitored, published, counted,
listed in `_meta` or part of the retained set (turning it off clears its retained
topic through the normal retained-set diff). `source.select` filters
`tags: 'all'` per unit against the effective (profile-substituted) tags: include
globs on key and property, then pollGroups/types/withProperty, then exclude
globs; because units are re-expanded on every profile-store revision, a tag
added to the device later joins automatically. `source.overrides[key]` gives
rule-selected tags per-tag settings; an entry's own keys win over it.

**Adding context.** Each override falls back to the device tag (devices and
profile tags may carry `context`, `displayName`, `states` and `limits`, which the
device API stores as given). Context objects merge key by key: asset
(`target.context`, placeholders resolved per unit), then device tag, then
mapping. The value pipeline is read, device decode, scale/offset, cast, deadband
(per-tag override or the binding's), then the published form (precision,
states); a failed scale or cast publishes `q: 0`, `v: null` and a `reason`
(not published at all in `plain`). `contextMode: 'meta'` (default) puts context
in `_meta` (`{ context, properties: { name: { ..., displayName, limits, states,
statesMode, context } }, updatedAt }`), `'payload'` also adds `ctx` (capped at
1024 bytes per tag, counted toward `maxObjectBytes`), `'none'` drops it.
`target.fields` picks envelope / object-member fields (`v` required, dropping `q`
warns); `target.metaFields` picks `_meta` fields. Sparkplug targets put
displayName, limits (`limitLoLo`..`limitHiHi`) and context (String properties)
into BIRTH; `reconcile()` compares each unit's BIRTH properties and calls
`SparkplugPublisher.refreshMetadata`, which re-issues DBIRTH for a born, online
device with the normal seq rules. With none of these options a binding's topics,
payloads and `_meta` are byte-for-byte what they were
(`test/fixtures/mapping-legacy.json`).

**Compiled publish plan.** The compiled index (rebuilt on profile-store
revision) holds per unit the field lists and a `tagByName` map whose tags carry
their transform plan, labels map, precision, per-tag deadband, frozen merged
context and precomputed Sparkplug properties. The hot path does one map lookup
per sample (as before) and reuses a single transform scratch object; tags that
use none of the options take the legacy payload path unchanged.

**Units.** A binding expands into **units**, one per (source, asset) pair: a plain
binding is one unit; a `device-profile` binding is one unit per instance of the
profile (unit id `<bindingId>#<deviceId>`), re-expanded whenever devices or the
profile change, so instances added later are picked up. A unit whose asset path
cannot be resolved is skipped and reported as a warning.

**Names and topics.** The published name of a device tag is the binding entry's
`name`, else the tag's `property`, else its key; the device address never becomes
a topic by itself. The topic is `<assetPath>/<slugged name>` (slug: whitespace,
`/`, `+`, `#` to `_`). An asset path has no empty segments, wildcards, braces or
segment starting with `$`, and is at most 512 characters. In a profile template
`{device}` is the device name, `{deviceId}` its id, and any other placeholder a
profile parameter with that instance's value; an unknown placeholder fails at
save time.

**Payloads (mqtt).** `plain` is the bare value. `envelope` is `{ v, t, q }` plus
`u` when the tag has a unit; `t` is the source time when there is one, else the
read time, and stays the time of the last change on a heartbeat repeat.
`object-per-asset` publishes one object to the asset path itself,
`{ t, values: { <name>: { v, q, u? } } }`, at the end of a source batch (or after
a 50 ms timer, whichever comes first) when some member changed, plus the
heartbeat. It is rejected at save time when tags times the worst-case member size
(by type) could exceed the cap, and an object that is over the cap at run time is
not published and counted as an error. `<asset>/_status` is the retained QoS 1
document `{ online, since, reason }`; `<asset>/_meta` is the retained QoS 1
document `{ properties: { <name>: { type?, unit?, description?, range?,
source: { deviceId | connectionId, address, profileId? } } }, updatedAt }`,
published when its content changes. Sparkplug targets carry unit, description
and range as metric properties (`engUnit`, `description`, `engLow`, `engHigh`) in
the BIRTH instead of `_meta`.

Semantics (covered by `bindings-v2.test.js`, `mapping-phase4.test.js`,
`mapping-routes.test.js`, `devices-int.test.js` and the OPC UA integration test):

- **Report-by-exception on (value, quality).** An **absolute** deadband
  suppresses numeric changes smaller than the band. A **percent** deadband is that
  percentage of the tag's `range` (max minus min) when it defines one, otherwise
  of the magnitude of the **last published** value (so from 0 any change
  publishes); a change equal to the band publishes. Other values publish on
  change; structures compare by bounded JSON. A quality change is always a change
  (Good to Bad with the same value publishes), but only the `envelope` format and
  the object layout can express it, so for `plain` and Sparkplug targets a
  quality-only change is counted as suppressed.
- **Bad on source loss.** When a source goes `offline` (a device loses its
  connection, its driver host dies, an OPC UA session drops) every known tag
  of that source's bindings gets one Bad publish: the last value with `q: 0`
  in an `envelope` binding, and every member `q: 0` in one object publish.
  `plain` cannot carry quality, so there only the status document changes.
  Recovery republishes as Good. The heartbeat continues to republish an offline
  envelope or object binding's last values with `q: 0` and skips offline `plain`
  bindings so stale values do not masquerade as live.
- **`_status` topic.** Published whenever the source reports a state, and also
  when a binding is created or edited while its source is already online
  (`_publishStatusForNewUnits`; without it the topic would not exist until the
  next transition). `statusTopic: false` turns it off. No MQTT last-will covers
  it, so it keeps its last value if Manifold itself stops.
- **Typed Sparkplug metrics.** The sample's `type` selects the Sparkplug
  datatype (Int8 ... UInt64, Float, Double, Boolean, String, DateTime). The
  datatype is pinned the first time a metric is seen so BIRTH and DATA agree,
  and a value that cannot be represented as it is sent as `is_null`. An unknown
  type keeps the old by-value encoding. Sparkplug metrics do not carry
  per-metric quality; a device going offline is a **DDEATH** (sequence-numbered,
  only for a device that has been birthed) and recovery is a **DBIRTH** with the
  last values before any further DDATA.
- **Heartbeat.** `rbe.heartbeatMs` (at least 1000 when set through the API,
  swept once a second) republishes unchanged tags (or the whole object) at least
  that often. Heartbeat repeats are not sent to a historian target.
- **Retained cleanup.** `retainedTopics()` derives from configuration the set of
  retained topics a binding owns (`_status`, `_meta`, and value or object topics
  when `retain` is on); `reconcile()` keeps the previous set in memory and
  publishes an empty retained message (QoS 1) to every topic that left it
  (binding deleted, disabled, path or broker changed, retain off, instance
  removed). The set is rebuilt at start, so an edit made while the server was
  down is not cleaned up; Sparkplug-source value topics are not derivable; a
  clear sent to a disconnected broker is dropped.
- **Direct historian target.** `target.historian.historianId` enqueues each
  published sample, after report-by-exception, to the outbox as `{ tag: <resolved
  topic>, ts, value, quality }` (object layout: the per-member topic; Sparkplug:
  `group/edge/device/metric`). `validateBinding` accepts only `timebase` and
  `timescaledb` historians and rejects InfluxDB (its writer stores no quality).
  A quality change a `plain` or Sparkplug target suppresses never reaches the
  outbox either. The Bad sample on source loss is enqueued for envelope, object
  and plain bindings (plain cannot carry it on the wire, history can), but not
  for Sparkplug targets.
- **Mapping API for the editor.** `GET /api/tags/bindings/schema` (option
  catalogue: fields, override keys with types and limits, select rules,
  placeholders, context limits) and the read-only
  `POST /api/tags/bindings/suggest { source }` (names from `property`, else a
  cleaned key; raw addresses get none; device context). The preview adds, per
  tag, the effective metadata with the origin of each field (`device`,
  `mapping`, `default`), the selection result per candidate tag, per-tag
  warnings and payload sizes.
- **Preview and warnings.** `bindingModel.previewBinding` and
  `POST /api/tags/bindings/preview` resolve topics and example payloads from the
  latest known values without storing or publishing anything; `bindingWarnings`
  (also returned by the save) reports names that look like raw device addresses,
  topics another enabled binding on the same broker already publishes, unresolvable
  instance paths, duplicate published names, overrides that name no tag, device
  context keys that are invalid, and **`option-ignored`** (for example
  `contextMode: 'payload'` on a plain-format mapping, or `metaFields` on a Sparkplug
  target), at most 50, never blocking. The preview returns 50 tag rows by default;
  `previewTags` (up to 2,000) asks for more.
- **Lifecycle.** When a source comes (back) online its monitored items are
  re-requested; a failed monitor request retries on a slow timer; editing or
  deleting a binding resets its state (`reconcile`), which is also called after
  a profile edit and after a config import. The old defect where OPC UA bindings
  went silent after a restart, an edit or a delete is gone.
- **Time and quality of Sparkplug-source bindings** are the metric's own
  timestamp and quality; unlike pipelines and the recorder (`messageTime`: a
  source time before 2000-01-01 or more than 24 h ahead is replaced by arrival
  time) they apply no plausibility window.

**Bindings never write toward devices**, and this is enforced where the bytes
are built, not by the binding engine's good manners: the engine has no write
path at all, and every device driver builds all outgoing frames through one
encoder with an allowlist (Modbus function codes 1 to 4; S7 setup communication,
Read Var and SZL reads; CIP session and connection management, Read Tag,
Read Tag Fragmented, Multiple Service Packet with every inner service checked,
and attribute and template reads). A forbidden service throws before any socket
write, and the EtherNet/IP client re-parses each buffer once more before
`socket.write`. Each allowlist has tests that attempt every refused service
against a simulator that counts writes it receives. This is a guarantee about
Manifold's code; it says nothing about what else on the network can write to
the same PLC (see [Security model](#security-model)).

### The Sparkplug publisher

Sparkplug output runs one session per (broker, group, edge node) with the
lifecycle the specification requires:

```mermaid
sequenceDiagram
    participant P as sparkplugPublisher
    participant B as Broker

    P->>B: CONNECT (will = NDEATH with bdSeq)
    P->>B: NBIRTH seq 0 (Node Control/Rebirth metric)
    P->>B: DBIRTH per device (before any data)
    loop value updates
        P->>B: DDATA (seq mod 256 across all node messages)
    end
    B->>P: NCMD Node Control/Rebirth
    P->>B: NBIRTH (new seq cycle)
    Note over P,B: shutdown: DDEATH per device, then NDEATH,<br/>connection closed gracefully so both frames flush
```

### Sparkplug host application STATE

The registry also folds `spBv1.0/STATE/{host}` messages: each host
application's online/offline status (JSON `{online, timestamp}` per Sparkplug
3.0, with legacy `ONLINE`/`OFFLINE` strings accepted) is tracked, shown in the
UI, and emitted as `host-online` / `host-offline` events. STATE is retained,
so a new subscriber replays the current status immediately.

Manifold can act as a primary host itself: `POST /api/tags/sparkplug/state`
starts a dedicated session that publishes retained STATE for a chosen host ID
with a matching last-will, so edge nodes waiting on a primary host see one. A session
records a signature of its broker's connection settings; asking for it to start again
after the broker profile was edited reconnects with the new settings (no stop needed).
Nothing re-checks the signature on its own, so an edit alone does not move a running
host session.

## Southbound device drivers

Read-only polling of Modbus TCP, Siemens S7 (S7comm) and EtherNet/IP (Logix)
devices, with tags landing in the same binding engine as OPC UA. The design is
in [`docs/design/southbound-drivers.md`](docs/design/southbound-drivers.md)
(status: implemented, S7 and EtherNet/IP experimental, nothing verified on real
hardware); this section describes what exists.

```mermaid
flowchart LR
    API[routes/devices.js] --> DM[deviceManager<br/>validate, egress check,<br/>latest values]
    DM -- desired device set --> SUP[driverSupervisor<br/>fork, heartbeat,<br/>backoff, crash-loop park]
    SUP -- fork + JSON IPC --> HOST[drivers/host.js]
    HOST --> RT1[DeviceRuntime per device]
    RT1 --> DRV[driver: plan, execute, bisect,<br/>probe, browse, close]
    DRV <--> PLC[(PLC)]
    RT1 -- sample batches, state --> HOST -- IPC --> SUP
    SUP --> DM
    DM -- 'sample', 'source-state' --> TB[tagBindings]
    DM -- device-values, device-state --> IO[Socket.IO]
```

**Process model.** `driverSupervisor` forks one host (`drivers/host.js`) per
protocol, or one per device that sets `isolate: true`. The main process never
loads driver code. IPC is JSON; 64-bit integers cross as strings. One message per
poll cycle carries a batch of samples. The supervisor pings each host,
SIGKILLs one that stops answering, and restarts a dead one with exponential
backoff (0.5 s doubling to 30 s). After more than five crashes in a minute the
host is **parked** (surfaced on the Devices page, retried when the device set
is saved again) and its devices report offline. An uncaught error inside a host
is fatal on purpose: log, exit, be restarted. `testConnection` uses a
transient host if none is running.

**Runtime** (`drivers/runtime/deviceRuntime.js`) is protocol-agnostic and owns
everything that must not be reimplemented per driver. Per device:

- A **connection state machine** (`connecting`, `online`, `backoff`,
  `stopped`) with jittered exponential backoff from 1 s to 60 s and no retry
  cap. Any fatal transport result (timeout, response that does not match its
  request, framing error) destroys the socket, marks every tag Bad
  (`disconnected`) and reconnects. A socket is never reused after a timeout, so
  a late reply cannot be matched to the next request.
- A **scheduler**: tags belong to poll groups with an interval (at least
  100 ms). One cycle per group at a time and one request in flight on the
  device's single connection across all groups. An overrun is skipped and
  counted, never queued. After five overrunning cycles in a row the effective
  interval doubles (up to 8x) and is reported; it halves again after 20 clean
  cycles.
- **Deadlines** on every request plus a watchdog around the driver call.
- **Bisect and quarantine.** A permanent request failure (Modbus exception 02,
  an S7 or CIP refusal) is bisected to the offending tag, which is quarantined
  (Bad, `quarantined`) and retried every minute while the rest keep polling.
- **Per-unit circuit breakers** for Modbus gateways: three gateway exceptions
  (0A/0B) open a unit's breaker (Bad, `unit-down`); it is probed every 30 s.
- A device status (state, phase, connects, requests, timeouts, exception counts,
  quarantined keys, `quarantineReasons` (per key: code, message, since; at most
  100), `lastError` and `lastErrorAt`, per-group cycle times, overruns) that the
  supervisor relays. Quarantining a tag sets `lastError` to `tag <key>:
  <message>`.

**Driver contract.** A driver module exports `describe()` (static description:
fields, types, prerequisites, `experimental`, `readOnly`, capabilities),
`validateTag(tag, options)` (a pure validator that normalizes the address) and
`createDriver(device)` returning `{ connect, plan, execute, bisect, probe,
browse?, close }`. `plan` is a pure function packing tags into requests within
the device's limits (Modbus blocks with a default max gap of 0; S7 reads within
the negotiated PDU, at most 20 items; CIP Multiple Service Packets);
`execute` never throws for device or transport problems and returns per-item
status; drivers hold exactly one connection. All three are our own
implementations on `node:net`, with no new dependency; the EtherNet/IP
decision record (`drivers/eip/NOTES.md`) explains why the candidate libraries
were rejected.

**Device manager.** Owns the stored configuration (profile-store collections
`devices` and `deviceProfiles`), validates it with each driver's validators (tag keys `[A-Za-z0-9_.\-:[\]]{1,128}`, at most 20,000
tags per device), applies the egress guard (`assertAllowedDeviceTarget`), pushes
the desired set to the supervisor, keeps the latest value per tag, and emits the
tag-source events above. A device whose target is refused is reported Stopped
with the reason instead of being started. Live values reach the UI as one coalesced
`device-values` event per 250 ms window carrying every touched device, plus `device-state`
events (contract and delivery rules in [Socket.IO events](#socketio-events)).

**Device profiles.** `services/deviceProfiles.js` is the pure half: a profile
(`protocol`, `options`, `pollGroups`, `params`, `tags` with `{param}` placeholders
in `key`, `address` and `property`) merged with a device instance (`profileId`,
`params`, own tags) into the **effective device** the drivers see. Options
override by key, poll groups by id; the instance's own tag with the same key as a
profile tag is an error; effective profile tags carry `origin: 'profile'` so a
client that echoes `GET /api/devices` into a `PUT` does not turn them into ad-hoc
tags. `deviceManager` validates every instance against the driver and applies a
profile edit to all instances atomically (a 400 lists the instances that would
break); deleting a profile with instances or bindings is a 409. Saves are validated
against the driver at save time (options, limits, S7 rack and slot), and device names
must be unique and free of control and bidi-override characters. `POST /api/devices/bulk`
creates up to 200 devices **all-or-nothing**: every row is validated first and, if any
row fails, nothing is created and each row reports its own error. `POST
/api/devices/profiles/:id/instantiate` creates one instance.

**Discovery.** `services/deviceIdentify.js` holds the read-only identification
probes the CIDR scan uses when device ports are requested (`includeDevices` or
`modbusPorts` / `s7Ports` / `eipPorts`): one TCP connection, one request, one
bounded reply (4 KB, 3 s), closed. The requests are built with the drivers' own
frame encoders: Modbus `encodeRequest` with function 3 for one register at
address 0, unit 1 (the encoder throws for anything but functions 1 to 4); S7
`encodeConnectRequest`, a COTP Connection Request only, no S7 setup or job;
EtherNet/IP `encodeFrame` with the ListIdentity command. A port that does not
answer the protocol is not reported; a result carries the protocol, the decoded
identity and a `suggestedDevice` body for `POST /api/devices`. Every candidate
address goes through `isAllowedAddress` first, so loopback and link-local are
always refused and private ranges need `MANIFOLD_ALLOW_PRIVATE_TARGETS=1`.

**Metrics.** `metricsExporter.renderDevices` renders, per device (name,
`device_id`, protocol): `manifold_device_up`, `_connects_total`,
`_requests_total`, `_timeouts_total`, `_exceptions_total` (by code),
`_cycle_ms` and `_overruns_total` (per poll group) and `_quarantined_tags`; per
driver host: `manifold_driver_host_up` and `_restarts_total`; and per binding
`manifold_binding_published_total`, `_suppressed_total`, `_errors_total`. Series
are capped (500 devices, bindings and hosts; 16 groups and 16 exception codes per
device).

**Samples.** A sample is `{ key, v, type, q, qReason?, tRead }`; `qReason` is one
of `disconnected`, `quarantined`, `unit-down`, `device-exception`, `decode`,
`unavailable`. Polled protocols have no device timestamp, so `tRead` is the
honest timestamp.

**Refusal reasons.** A tag that a device refuses (an S7 CPU with PUT/GET off or
optimized access, a Modbus exception, a CIP status) is quarantined with the
driver's message, which reaches the device status as above and the Devices page.
The exception counter still reads `33028` (0x8104) for a whole-request S7
refusal. `lastError` holds the most recent quarantined tag's reason, not a list.

## OPC UA security

OPC UA connections accept `securityMode` (`None`, `Sign`, `SignAndEncrypt`)
and `securityPolicy`. Secure modes run through a shared application PKI
rooted at `<MANIFOLD_DATA_DIR|server/data>/pki` in the standard node-opcua
layout:

```
pki/
  own/certs/client_certificate.pem   Manifold's application certificate
  own/private/                       private key
  trusted/certs/                     server certificates we accept
  rejected/                          server certificates seen but not trusted
  issuers/                           CA material
```

The self-signed application certificate is created on first use; the URI
baked into it must match the client's application URI (node-opcua checks the
two on every secure connect). `GET /api/opcua/certificate` returns it in PEM
form so it can be trusted on the server side.

Trust is explicit in both directions:

```mermaid
flowchart LR
    C[secure connect] --> V{server certificate known?}
    V -->|trusted| OK[session established]
    V -->|unknown| REJ[lands in rejected/]
    REJ --> T1[POST /api/opcua/trust with thumbprint]
    REJ --> T2[reconnect with trustServer true]
    T1 --> OK
    T2 --> OK
```

Unknown server certificates are never auto-accepted: they land in
`rejected/`, listed by `GET /api/opcua/trust`, and are promoted by thumbprint
(`POST /api/opcua/trust`) or by an explicit trust-on-first-connect flag on
the connection. A trust failure produces an actionable error naming both
paths instead of a bare `BadSecurityChecksFailed`.

`POST /api/opcua/discover` asks an endpoint URL for its available endpoints
(security mode/policy combinations), so the right mode can be picked before
connecting.

### Supervised reconnect

A connection that has been established and then drops is retried **forever**
with jittered exponential backoff (1 s to 60 s): node-opcua's own short retry
is only the first line, and when it gives up the manager's supervisor takes
over. Saved connections are restored at startup with `supervise: true`
(lightly staggered, 100 ms apart), so one that is unreachable when Manifold
starts keeps retrying instead of being logged once and forgotten. A first
connect started from the API that fails is reported to the caller and not kept.
The manager emits a `connection-state` event (`online` / `offline`, with a
reason) that the OPC UA tag source turns into `source-state`, which is what
drives Bad-on-loss and re-monitoring in bindings. After any reconnect, the
subscription and every monitored item are rebuilt from the recorded
(nodeId, samplingInterval) pairs, serialized per connection so concurrent
`monitor()` calls cannot create duplicate subscriptions — the UI never shows a
live-looking value that stopped updating. Value updates to socket clients are
coalesced (100 ms); the in-process tap used by bindings stays immediate.

## Client architecture

`client/` is a React 18 single-page app built with Vite (route-level code splitting: every page in
`client/src/pages/` is a lazy chunk, so the main bundle carries only the shell, store and shared
primitives; `@` aliases `client/src`). The UI language is specified in
[`docs/design/ui-design-system.md`](docs/design/ui-design-system.md); this section is how it is wired.

```mermaid
flowchart LR
    CSS["index.css<br/>custom properties per theme<br/>(--bg, --panel, --accent, ...)"] --> TW["tailwind.config.js<br/>rgb(var(--token) / alpha)<br/>bg-panel, text-fg, border-line ..."]
    TW --> UI["components/ui/*<br/>Button, Field, Table, Dialog, Drawer,<br/>Banner, Stat, Meter, Tabs ..."]
    UI --> PAGES["pages/*<br/>(one lazy chunk per route)"]
    CSS --> CT["graph/canvasTokens.js<br/>reads the tokens once per theme change"]
    CT --> UT["unsTheme.js<br/>UNS map"]
    CT --> GS["graphStyles.js<br/>Topics 2D, WebGL, 3D"]
    CT --> CH["chartTheme.js<br/>uPlot charts"]
    DP["dataPalette.js<br/>10 series colours per theme"] --> UT & GS & CH
    SOCK["lib/socket.js + store/store.js<br/>Socket.IO to Zustand"] --> PAGES
    API["lib/api.js<br/>REST"] --> PAGES
```

**Design tokens, Tailwind, primitives.** Every colour is a CSS custom property holding an RGB
triplet, defined in `src/index.css` for the dark theme (default) and, under
`[data-theme="light"]`, for the light theme. `tailwind.config.js` exposes them as semantic classes
(`bg-app`, `bg-panel`, `bg-raised`, `bg-overlay`, `border-line`, `text-fg`, `text-muted`,
`text-subtle`, `text-accent-text`, `text-good`/`warn`/`bad`/`info`) with opacity modifiers working.
The primitives live in `src/components/ui/` (`controls`, `display`, `overlay`, `table`, `tooltip`,
re-exported from `components/ui.jsx`): buttons, form fields, `SegmentedControl`, `Tabs`, `Panel`,
`Stat`, `Meter`, `Banner`, `Dialog`, `Drawer`, `ConfirmDialog`, `Table`. A compatibility layer in
the Tailwind config still remaps the old raw-palette class names (`slate-*`, `surface-*`,
`white/x`) onto the tokens; three shared components still use those names (see the migration
status in the design-system document).

**Theme bootstrapping.** The preference (`system`, `light`, `dark`) is stored in `localStorage`
under `tc.theme`. `public/theme-init.js` is loaded synchronously from `index.html`, so
`<html data-theme>` is correct before the first paint (no flash). `src/lib/theme.js` keeps it
current at runtime: preference changes, the OS `prefers-color-scheme` while on `system`, and
`storage` events from another tab. It also toggles the `dark` class and `color-scheme`.

**Store slices.** One Zustand store (`src/store/store.js`) fed by one socket
(`src/lib/socket.js`): connection and role (`connected`, `authRole` from `/api/whoami`); brokers and
OPC UA connections; discovery state; the topic index and live message buffers (kept outside React
state, with `dataTick` and per-broker `topicVersion` as change signals so high-rate data does not
re-render everything); device `deviceStates` and `deviceValues` (fed by `device-state` and
`device-values`, seeded from REST) and `devicesVersion` (bumped by `devices-changed`); OPC UA
values; the log buffer behind the Logs drawer; and persisted view preferences (`tc.graphStyle`,
`tc.graphLayout`, `tc.flowEnabled`, `tc.activitySize`, `tc.showValues`, `tc.showMinimap`,
`tc.navCollapsed`). Configuration screens fetch over REST (`src/lib/api.js`, page-local `api`
modules) and poll with `usePolled`; they use the store only for live data. `useReadOnly()` (from
`authRole`) disables mutating controls and `ReadOnlyNote` explains why.

**Canvas rendering (`src/graph/canvasKit.js`).** One module shared by every canvas and WebGL
renderer, unit-tested once (`test/canvasKit.test.js`): integer backing-store size
`round(CSS size x devicePixelRatio)` kept in sync by a `ResizeObserver` and a
`(resolution: Ndppx)` media query (DPR changes when a window moves monitors or the page is
zoomed, without a resize event); one camera transform used by both drawing and picking
(`screenToWorld`, `worldToScreen`, `zoomAround`, `wheelFactor`, pinch zoom); `fitBounds`;
measured label ellipsis and a label collision grid (label level of detail); `sanitizePositions`
(no NaN or coincident nodes reach a draw); and the **frame scheduler**
(`createFrameScheduler`): `requestAnimationFrame` coalescing that never runs while the tab is
hidden or the canvas is scrolled out of view, honours reduced motion, and has an
animate-while-active mode with an idle cadence. The UNS map uses `idleMs: 1000`, so it repaints
about once a second with no traffic and no interaction (to keep staleness and rate captions
honest), at full frame rate while data flows or the user interacts, and not at all when hidden.
WebGL renderers handle `webglcontextlost` / `webglcontextrestored`, release their GL objects on
unmount, and the three.js 3D view is a lazy chunk. Deep links
(`/uns?broker=&path=` and `/topics?broker=&topic=`) are a small state machine stepped by the
scheduler: *pending* (the node is not laid out yet or the canvas is not sized) then *following*
(glide to the centre, re-centring whenever the node's position or the canvas size changes) then
*done* after 1.5 s of stillness; any user camera input cancels it. If the node does not exist an
inline note says so.

**Canvas themes derive from tokens.** `graph/canvasTokens.js` reads the design-system custom
properties once per theme change from the computed style of `<html>` (a canvas cannot use
`rgb(var(--token))`), converts them to hex and caches a frozen snapshot;
`useCanvasTokens()` re-renders on change (theme switch, `prefers-contrast`,
`prefers-color-scheme`, `storage`). Three theme objects are derived from that one snapshot plus
the data palette: `buildUnsTheme` (`graph/unsTheme.js`, the UNS map), `resolveGraphStyle`
(`graph/graphStyles.js`, the Topics 2D, WebGL and 3D renderers: presets Standard, Schematic,
Monochrome) and `buildChartTheme` (`components/chartTheme.js`, uPlot charts). A theme switch
repaints in place: the same canvas, camera and selection (2D redraws, WebGL rewrites only its
colour buffer, three.js updates its background, lights and materials, uPlot redraws with
function-valued strokes). `src/test/canvasTheme.test.js` asserts the fallback tokens equal
`index.css` and that the palette meets its contrast and colour-vision constraints.

**Test hooks.** `window.__manifoldTest` is a registry the canvases fill (camera transform,
selection, hit-test and frame counters, the deep-link phase) **only** when the URL has `?e2e=1`
or `localStorage['manifold.e2e'] = '1'`; production pages never expose it. The canvas e2e specs
use it to assert crispness, hit-testing at two zoom levels, that no frames run when idle or after
unmount, and WebGL context-loss recovery.

### Graph rendering and layout

All graph rendering and layout is client-side; the server ships data, not
coordinates.

- **Force layout** runs d3-force in a Web Worker
  (`client/src/graph/forceLayoutWorker.js`, 30k-node cap) so layout ticks
  never block the UI thread.
- **3D** (`ForceGraph3D.jsx`) is real three.js: nodes are one `InstancedMesh`
  of low-poly spheres, smooth at 50k nodes, with analytic ray-sphere picking
  instead of triangle raycasting. three.js is a lazy chunk loaded only when
  the 3D view opens.
- **WebGL 2D** remains the renderer for very large namespaces (60k+ topics).
- **Icons**: the UNS topology uses a curated ~130-icon industrial subset
  imported individually from lucide (tree-shaken; the full ~2,000-icon
  library stays out of the main bundle and loads on demand in the picker).
  User-defined single-path SVG icons are stored server-side
  (`/api/uns/icons`) and resolve like built-ins.

## Security model

**Authentication and roles**

- `MANIFOLD_AUTH_TOKEN` (admin), `MANIFOLD_VIEWER_TOKEN` (read-only) and
  `MANIFOLD_TOKENS` (`name:token[:role]`, named and individually revocable, with
  per-token audit identity) gate the REST API and the socket handshake. **Any of
  the three turns auth on**; a viewer token alone leaves nobody with admin.
- Roles **fail closed** (`services/authConfig.js`): an unrecognised role in
  `MANIFOLD_TOKENS` rejects that entry with a startup error rather than granting
  admin, and a token containing `:` needs an explicit role. If tokens were
  configured but every entry was rejected, auth stays on and everything is 401.
- A **viewer** may use `GET`, `HEAD` and `OPTIONS` plus an explicit allowlist of
  read-only POSTs (`VIEWER_READ_ONLY_POSTS` in `services/authConfig.js`; paths relative
  to `/api`):

  | Pattern | Why it is a read |
  | --- | --- |
  | `/historians/:id/query` | historian trend query |
  | `/pipelines/preview` | pipeline dry run |
  | `/mqtt/brokers/:id/subscriptions/resolve` | wildcard to concrete topics |
  | `/devices/validate-tags` | device tag validation |
  | `/tags/bindings/preview` | mapping dry run (publishes nothing) |
  | `/tags/bindings/suggest` | name and context suggestions |
  | `/contracts/infer` | schema inference from a payload |
  | `/i3x/related`, `/i3x/value`, `/i3x/history` | i3X reads |
  | `/cesmii/history` | SMIP time-series read (a GraphQL query) |

  Everything else non-GET, over HTTP or the socket, is refused (the socket answers with
  an `error-message` event). Alert webhook URLs are hidden from viewers, and `/api/audit`
  is admin only. The UI mirrors this: with a viewer token `useReadOnly()` is true, every
  mutating control is disabled with the reason, and Settings shows the session.
- Failed authentication is rate-limited per IP (20 failures/minute, then 429),
  on both the REST and the socket paths.
- `/metrics` requires a bearer token (any role) when auth is on, because broker
  ids and route names are reconnaissance; `MANIFOLD_METRICS_PUBLIC=1` opts out.
  `/health` stays open.
- CORS is locked to `CLIENT_URL` (default `http://localhost:3000`); a blanket
  `cors()` would let any website script an authenticated browser.

**Egress guard** (`services/egressGuard.js`). One chokepoint for connections the
caller could not make directly. Two tiers: *always blocked* (loopback,
link-local including cloud metadata `169.254.169.254`, multicast, reserved and
carrier-grade-NAT space, and IPv6 forms that embed an IPv4 address, which are
classified by the embedded address) and *blocked unless
`MANIFOLD_ALLOW_PRIVATE_TARGETS=1`* (RFC1918, IPv6 ULA). Coverage differs by
path and the differences matter:

| Path | How it is checked |
|---|---|
| Network scanner (including the device probes) | each candidate address through `isAllowedAddress`: loopback, link-local and reserved always refused, private ranges only with `MANIFOLD_ALLOW_PRIVATE_TARGETS=1`; `MANIFOLD_ALLOW_LOOPBACK_DEVICES` does not apply |
| i3X, CESMII, broker admin, alert webhooks | `guardedFetch`: check before the request, a connect-time `lookup` that pins the checked address (closes DNS rebinding), manual redirects (at most 5, each hop re-checked, `Authorization`/cookies dropped across origins), one overall deadline |
| Device drivers | `assertAllowedDeviceTarget` when a device is saved, tested or applied. The hostname is resolved in the main process (`deviceManager._pinned`), the validated addresses travel to the driver host as `device.pinned.addresses` and each client connects to that IP (the hostname is kept for display); the supervisor re-validates through its `revalidate` hook before restarting a host and `deviceManager` re-checks running devices every 30 s, taking a device offline with the reason when the name turns blocked. Optimistic concurrency lives in `profileStore` (`rev`, `updatedAt`, `expectRev` on every upsert, error code `stale`) and `services/revision.js` (route side); references are checked by `services/references.js`. Loopback is additionally allowed when `MANIFOLD_ALLOW_LOOPBACK_DEVICES=1` |
| MQTT brokers, OPC UA endpoints, historian and database URLs | **not checked, by decision**: admin-configured connections that the libraries open themselves. A broker or historian on `localhost` or the LAN is the normal setup, so guarding them by default would break it. Residual risk: an admin token can make the server connect to any host it can reach through these three paths; protect admin tokens and use network policy |

**Audit** (`services/auditLog.js`). The middleware is mounted *before* auth so
rejected requests (401, 403, 429) are recorded even when they are GETs. Mutations
are always recorded, with role, token *name* (never the token), IP, route
without its query string, outcome, and a redacted body summary. Redaction is one
shared rule (`services/secrets.js`: field names matching `pass`, `token`,
`secret`, `key`, `credential`, `cert`, `authorization`, `webhook`, `ca`, `pfx`,
and passwords in URLs), also used by config export. The file rotates by size
(`MANIFOLD_AUDIT_MAX_BYTES`, `MANIFOLD_AUDIT_KEEP`); lines are written
synchronously, so nothing is buffered across a crash.

**Config export and import.** Export strips secrets by the shared name rule and
includes devices and device profiles. Import is validated whole before anything
is applied (ids, sizes, depth, prototype-polluting keys) and keeps stored
secrets where the import carries null. The name rule matches `key`, so
`redactSecrets` keeps `key` only inside arrays named `tags` or `ownTags` (device
and profile tag identifiers, strings or numbers); a secret nested in a tag, or a
`key` anywhere else (a TLS private key), is still masked. A tag list under any
other property name would lose its keys. Import applies immediately (bindings
reconciled, devices re-applied).

**Profile store durability** (`services/profileStore.js`). The in-memory view
updates synchronously; the disk write is coalesced (one per tick) and goes temp
file, `fsync`, rename, directory `fsync`, so a crash leaves a complete old or
new file. Rotating backups `profiles.json.bak.1` to `.5` are cut from the
previous good file at most once per minute; a corrupt or missing file on startup
is recovered from the newest valid backup, loudly. Pending writes are flushed on
shutdown and on process exit. Ids are checked against prototype-polluting names
and looked up with `Object.hasOwn`.

**Secrets and files.** Secrets (broker passwords, historian tokens, admin API
keys) are stored server-side only: never echoed by the API, redacted from audit
entries, and stripped from config exports. `server/data/` is written mode
0600/0700. It is not encrypted: without a real key-management story,
at-rest encryption of a file the server must read on boot adds no protection, so
the honest measure is file permissions plus host security.

**Devices.** Creating or editing a device is admin-only and audited. The drivers
are read-only by construction (see
[Tag sources, bindings and the Sparkplug publisher](#tag-sources-bindings-and-the-sparkplug-publisher)),
but Modbus TCP, S7comm and plain EtherNet/IP do not authenticate the client:
anything that can reach the PLC can also write to it. Enabling PUT/GET on an S7
CPU makes its data blocks writable by any peer. Restrict the network path (a
firewall rule or a data diode) where a stronger guarantee than software is
required.

**Outbound HTTP** (historian writes and queries, alert webhooks, broker admin
APIs) uses bounded timeouts (`services/httpTimeout.js`), so a hung remote
endpoint cannot pin a request handler forever.

## Protocol notes

Observed behavior that shapes the implementation:

- **EMQX default ACL and QoS 1 wildcards.** Stock EMQX denies `#`
  subscriptions at QoS 1+ from non-localhost clients, and its default
  `deny_action = ignore` makes the denial silent: the SUBACK reports success
  and the subscription simply never exists. No client-side logic can detect
  this. The QoS-0 fallback covers brokers that refuse loudly per spec;
  for EMQX, either grant the permission in the broker ACL or configure
  intake at QoS 0. CI's EMQX container authorizes wildcard intake the way a
  production deployment backing a UNS platform would.
- **Mosquitto has no per-client subscription API.** `mosquitto_ctrl` manages
  accounts and ACLs, not live subscriptions, so consumer resolution against
  mosquitto is limited to observed traffic. The UI states this rather than
  implying MQTT exposes more than it does.
- **Sparkplug edge death cascades to devices**, per specification, and the
  registry applies this when an NDEATH arrives.
- **Sparkplug DATA is a delta.** Only changed metrics are sent, which is why
  Sparkplug intake queues every message instead of coalescing.
- **InfluxDB field types are fixed per shard.** The first write wins; later
  writes with a different type are rejected. Splitting numeric (`value=`) and
  string (`raw=`) fields at the client makes this failure mode impossible.
- **pg defaults block forever.** `connectionTimeoutMillis` defaults to 0; an
  unreachable database turns into a hung process rather than an error. All
  pools set bounded connect/query timeouts and `allowExitOnIdle`.

## HTTP API

Every route below is mounted under `/api` except `/health` and `/metrics`. Auth, roles and the
viewer allowlist are described in [Security model](#security-model); a viewer may call every `GET`
and the POSTs marked *viewer*. Regenerate this table with
`grep -n "router\.\(get\|post\|put\|delete\)" server/routes/*.js` plus the routes declared in
`server/index.js`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Liveness (open, no auth) |
| `GET` | `/metrics` | Prometheus text; needs a bearer token when auth is on unless `MANIFOLD_METRICS_PUBLIC=1` |
| `GET` | `/api/whoami` | `{ authEnabled, role, tokenName? }` for the current token |
| `GET` | `/api/audit` | Recent audit events (`?limit=`, at most 500); admin only |
| `GET` | `/api/system/status` | Overall status |
| `POST` | `/api/system/discovery/start` | Start a network scan (`range`, `mqttPorts`, `opcuaPorts`, `i3xPorts`; device probes only with `includeDevices` or `modbusPorts` / `s7Ports` / `eipPorts`) |
| `POST` | `/api/system/discovery/stop` | Stop the running scan |
| `GET` | `/api/system/discovery/results` | Candidates found by the last scan |
| `GET` | `/api/system/config/export` | Config as code (secrets stripped; devices and profiles included) |
| `POST` | `/api/system/config/import` | Import a config, validated whole before it is applied (merge by id) |
| `GET` | `/api/mqtt/brokers` | List broker connections |
| `POST` | `/api/mqtt/brokers` | Connect (and persist) a broker |
| `GET` | `/api/mqtt/brokers/:brokerId` | One broker |
| `PUT` | `/api/mqtt/brokers/:brokerId` | Edit in place (reconnects) |
| `DELETE` | `/api/mqtt/brokers/:brokerId` | Disconnect and remove |
| `GET` | `/api/mqtt/brokers/:brokerId/topics` | Observed topic list |
| `GET` | `/api/mqtt/brokers/:brokerId/messages` | Recent messages |
| `GET` | `/api/mqtt/brokers/:brokerId/sparkplug` | Sparkplug topology from BIRTH/DEATH certificates and host STATE |
| `GET` | `/api/mqtt/brokers/:brokerId/sys` | `$SYS` summary |
| `GET` | `/api/mqtt/brokers/:brokerId/admin` | Broker admin API settings (secrets redacted) |
| `POST` | `/api/mqtt/brokers/:brokerId/admin` | Set the broker admin API connection |
| `DELETE` | `/api/mqtt/brokers/:brokerId/admin` | Remove it |
| `GET` | `/api/mqtt/brokers/:brokerId/admin/pubsub` | Per-client subscriptions from the broker admin API |
| `POST` | `/api/mqtt/brokers/:brokerId/subscriptions/resolve` | Resolve wildcard filters against observed topics (*viewer*) |
| `GET` | `/api/mqtt/brokers/:brokerId/topictree` | One tree level with subtree counts |
| `GET` | `/api/mqtt/brokers/:brokerId/uns/tree` | UNS skeleton (depth- and node-capped, exact counts) |
| `GET` | `/api/mqtt/brokers/:brokerId/uns/lint` | Namespace lint report |
| `GET` | `/api/mqtt/brokers/:brokerId/uns/events` | UNS event feed |
| `POST` | `/api/mqtt/brokers/:brokerId/subscribe` | Add an intake subscription |
| `POST` | `/api/mqtt/brokers/:brokerId/unsubscribe` | Remove one |
| `POST` | `/api/mqtt/brokers/:brokerId/publish` | Publish (MQTT 5 `properties` on v5 sessions) |
| `GET` | `/api/uns/mounts` | UNS mounts (OPC UA / i3X sources) |
| `POST` | `/api/uns/mounts` | Add a mount |
| `DELETE` | `/api/uns/mounts/:id` | Remove a mount |
| `GET` | `/api/uns/icons` | Custom UNS icons |
| `POST` | `/api/uns/icons` | Add or replace an icon (single-path SVG, upsert by name) |
| `DELETE` | `/api/uns/icons/:id` | Remove an icon |
| `GET` | `/api/alerts/rules` | Alert rules, rule types, webhook health (webhook URLs hidden from viewers) |
| `POST` | `/api/alerts/rules` | Create or edit a rule (upsert by id) |
| `DELETE` | `/api/alerts/rules/:id` | Delete a rule |
| `GET` | `/api/alerts/events` | Recent firings |
| `GET` | `/api/pipelines` | Routes, live metrics, outbox health, transform types |
| `POST` | `/api/pipelines` | Create or edit a route (upsert by id); the source filter and `repath` targets are validated as MQTT topics |
| `DELETE` | `/api/pipelines/:id` | Delete a route |
| `POST` | `/api/pipelines/preview` | Dry-run an unsaved route against observed topics (*viewer*) |
| `GET` | `/api/historians` | Historian connections (secrets redacted) and supported types |
| `POST` | `/api/historians` | Create or edit (upsert by id; a stored secret is kept when omitted) |
| `DELETE` | `/api/historians/:id` | Delete; 409 naming the routes, recordings and mappings that still write to it |
| `POST` | `/api/historians/:id/test` | Test write |
| `GET` | `/api/historians/:id/tags` | Stored tags |
| `POST` | `/api/historians/:id/query` | Downsampled series (*viewer*) |
| `GET` | `/api/models` | Contextualization models |
| `POST` | `/api/models` | Create or edit a model (target topic validated) |
| `DELETE` | `/api/models/:id` | Delete a model |
| `GET` | `/api/recorder` | Recordings with status |
| `POST` | `/api/recorder` | Create or edit a recording (upsert by id; `enabled: false` pauses it, `true` resumes it); the filter is validated |
| `DELETE` | `/api/recorder/:id` | Delete the recording and its data file |
| `GET` | `/api/recorder/:id/data` | Bounded read-back of recorded messages |
| `GET` | `/api/recorder/:id/series` | Downsampled numeric series for Trends |
| `GET` | `/api/recorder/:id/tags` | Topics present in the recording |
| `POST` | `/api/recorder/replay` | Start a replay |
| `DELETE` | `/api/recorder/replay` | Stop it |
| `GET` | `/api/contracts` | Schema contracts |
| `POST` | `/api/contracts/infer` | Infer a schema from an observed payload (*viewer*) |
| `POST` | `/api/contracts` | Lock (create or edit) a contract |
| `DELETE` | `/api/contracts/:id` | Delete a contract |
| `GET` | `/api/contracts/violations` | Recent violations |
| `GET` | `/api/tags/sources` | What can be browsed right now (devices, OPC UA, Sparkplug, MQTT) |
| `GET` | `/api/tags/browse` | One level of children under a node (`type`, `id`, `node`) |
| `GET` | `/api/tags/bindings` | Mappings (stored as bindings) with run-time status |
| `POST` | `/api/tags/bindings` | Create or edit a mapping; returns it plus non-blocking `warnings` |
| `POST` | `/api/tags/bindings/preview` | Dry run of a draft: topics, example payloads, `_meta`, selection result, warnings, collisions; `previewTags` raises the number of rows returned (*viewer*) |
| `GET` | `/api/tags/bindings/schema` | Option catalogue the editor renders from (override keys with types and limits, select rules, placeholders) |
| `POST` | `/api/tags/bindings/suggest` | Suggested names and context for a source; stores nothing (*viewer*) |
| `DELETE` | `/api/tags/bindings/:id` | Delete a mapping (clears its retained topics) |
| `POST` | `/api/tags/sparkplug/state` | Start or stop a Sparkplug host STATE session |
| `GET` | `/api/devices` | Devices with live status, driver host states and the driver descriptors |
| `POST` | `/api/devices` | Create a device (validated, egress-checked, applied live) |
| `POST` | `/api/devices/bulk` | Create up to 200 devices all-or-nothing (every row validated first; per-row errors) |
| `POST` | `/api/devices/test` | One-off connect with an unsaved config: identity and negotiated limits, or the error |
| `POST` | `/api/devices/validate-tags` | Validate and normalize tags for a protocol (*viewer*) |
| `GET` | `/api/devices/profiles` | Device profiles with their instances |
| `POST` | `/api/devices/profiles` | Create a profile |
| `GET` | `/api/devices/profiles/:id` | One profile |
| `PUT` | `/api/devices/profiles/:id` | Edit; re-applied to every instance atomically (400 lists the instances that would break) |
| `DELETE` | `/api/devices/profiles/:id` | Delete; 409 while a device or a mapping uses it |
| `POST` | `/api/devices/profiles/:id/instantiate` | Create a device from a profile |
| `PUT` | `/api/devices/:id` | Edit in place |
| `DELETE` | `/api/devices/:id` | Delete; 409 while a mapping uses it |
| `POST` | `/api/devices/:id/probe` | Read raw bytes at one address and return every candidate decoding |
| `GET` | `/api/devices/:id/browse` | The controller's own tag list (drivers with `browse`; EtherNet/IP) |
| `GET` | `/api/devices/:id/values` | Latest value, type, quality and read time per tag |
| `GET` | `/api/opcua/connections` | OPC UA connections |
| `POST` | `/api/opcua/connections` | Connect |
| `PUT` | `/api/opcua/connections/:connectionId` | Edit in place (reconnects) |
| `DELETE` | `/api/opcua/connections/:connectionId` | Disconnect |
| `GET` | `/api/opcua/connections/:connectionId/browse` | Browse the address space (`nodeId`) |
| `GET` | `/api/opcua/connections/:connectionId/read` | Read a node (`nodeId`) |
| `POST` | `/api/opcua/connections/:connectionId/monitor` | Monitor a node |
| `POST` | `/api/opcua/connections/:connectionId/unmonitor` | Stop monitoring |
| `POST` | `/api/opcua/discover` | Endpoint discovery (security modes and policies) |
| `GET` | `/api/opcua/certificate` | Manifold's application certificate (PEM) |
| `GET` | `/api/opcua/trust` | Trusted and rejected server certificates |
| `POST` | `/api/opcua/trust` | Trust a rejected certificate by thumbprint |
| `GET` | `/api/cesmii/status` | CESMII SMIP connection status |
| `POST` | `/api/cesmii/config` | Configure and validate (persisted) |
| `DELETE` | `/api/cesmii/config` | Clear the stored configuration |
| `GET` | `/api/cesmii/equipment` · `/places` · `/attributes` | Inventory reads |
| `POST` | `/api/cesmii/history` | Time series (*viewer*) |
| `POST` | `/api/cesmii/query` | Raw GraphQL passthrough |
| `GET` | `/api/i3x/status` | i3X connection status |
| `POST` | `/api/i3x/connect` | Verify and store a server |
| `POST` | `/api/i3x/probe` | Check whether a URL is an i3X server (no state change) |
| `DELETE` | `/api/i3x/connect` | Disconnect |
| `GET` | `/api/i3x/namespaces` · `/objecttypes` · `/objects` · `/graph` | Inventory reads |
| `POST` | `/api/i3x/related` · `/value` · `/history` | Reads (*viewer*) |

Device errors map to HTTP codes: validation 400 (with per-tag `details`), egress refusal 403, a
driver or device failure 502.

## Socket.IO events

The browser holds one Socket.IO connection (same origin as the API; the handshake carries the
token when auth is on). Regenerate this list with
`grep -rn "io\.emit\|\.emit('" server/ --include=*.js` (outside `test/`). "Volatile" means the
server emits through `io.volatile`: a lagging client may miss the packet, and the next one
supersedes it.

**Server to client**

| Event | Payload | Delivery |
| --- | --- | --- |
| `state-snapshot` | `{ mqtt: [connection], opcua: [connection], discovery: { scanning, results } }`, sent to a client on connect | reliable |
| `mqtt-messages` | array of messages `{ id, brokerId, topic, payload, payloadFormat, qos, retain, timestamp, size, type, ... }`, one per touched topic per 100 ms flush | volatile |
| `broker-stats` | array of `{ brokerId, status, metrics, lastActivity }` | reliable |
| `mqtt-connection-attempt` / `mqtt-connected` | `{ brokerId, connection }` | reliable |
| `mqtt-offline` / `mqtt-disconnected` | `{ brokerId }` | reliable |
| `mqtt-reconnecting` | `{ brokerId, attempt }` | reliable |
| `mqtt-error` | `{ brokerId?, error }` | reliable |
| `subscription-success` | `{ brokerId, topic, qos, granted }` | reliable |
| `subscription-downgraded` | `{ brokerId, topic, from, to, reason }` | reliable |
| `subscription-error` / `unsubscription-error` | `{ brokerId, topic, error, attempts? }` | reliable |
| `unsubscription-success` | `{ brokerId, topic }` | reliable |
| `publish-success` | `{ brokerId, topic, count, timestamp }`; the first publish of a window is sent at once with `count: 1`, the rest are folded into one summary per window | reliable (leading), volatile (summary) |
| `publish-error` | `{ brokerId, topic, error }` | reliable |
| `opcua-value` | one event per changed monitored item, coalesced per 100 ms | volatile |
| `opcua-connection-attempt` / `opcua-connected` | `{ connectionId, connection }` | reliable |
| `opcua-reconnecting` / `opcua-disconnected` | `{ connectionId }` | reliable |
| `opcua-error` | `{ connectionId, error }` | reliable |
| `opcua-monitor-started` / `opcua-monitor-stopped` | `{ connectionId, nodeId, samplingInterval? }` | reliable |
| `discovery-started` | `{ range, ports, totalProbes, blockedHosts }` | reliable |
| `discovery-result` | one candidate | reliable |
| `discovery-progress` / `discovery-complete` / `discovery-error` | progress counters, summary, `{ error }` | reliable |
| `alert` | an alert event | reliable |
| `contract-violation` | a contract violation event | reliable |
| `devices-changed` | no payload; the device set or a driver host changed, refetch `GET /api/devices` | reliable |
| `device-state` | `{ deviceId, state, phase, reason, since }` | reliable |
| `device-values` | `{ batch: [{ deviceId, values: { <tagKey>: { v, type, q, qReason, tRead } } }] }` | volatile, **reliable when the flush carries a quality change** |
| `engine-metrics` | `{ pipelines, outbox, bindings, sparkplug, contracts }` every 2 s, only while a client is connected | reliable |
| `error-message` | `{ error }`, sent to a viewer whose socket command was refused | reliable |

**Client to server**: `connect-mqtt` (with an ack), `disconnect-mqtt`, `subscribe-topic`,
`unsubscribe-topic`, `publish-message`, `start-discovery`, `stop-discovery`, `opcua-monitor`,
`opcua-unmonitor`. A viewer's attempt to send any of them is refused with `error-message`.

**Device live values.** The device manager keeps the latest value per tag and marks touched tags
dirty; one timer (`VALUE_FLUSH_MS`, 250 ms) turns everything dirty across all devices into a
single `device-values` event. It is one event, not one per device, because Socket.IO drops a
volatile packet whenever the transport is still busy with the previous one, so a loop of
per-device volatile emits delivered only the first device's values. A flush that contains a
quality transition (a tag going Bad or recovering is reported once by the runtime) is sent on the
reliable path so a lagging client cannot be left showing a stale Good. The client seeds its store
from `GET /api/devices/:id/values` and applies batches on top.

### Devices API

A device is stored and returned as:

```js
{
  id, name, enabled, protocol: 'modbus-tcp' | 's7' | 'ethernet-ip',
  host, port,                       // egress-checked on save
  unitId | rack, slot | slot, routePath,   // protocol-specific top-level fields
  options: { byteOrder, wordOrder, addressBase, maxRegisters, maxGap, ... },  // Modbus also unmapped: [{table, from, to}] (Advanced section)
  limits:  { requestDeadlineMs: 2000, connectTimeoutMs: 5000, interRequestDelayMs: 0 },
  pollGroups: [{ id, intervalMs }],           // intervalMs >= 100
  tags: [{ key, address, type, pollGroup?, unit?, description?, property?, ... }],
  isolate?: boolean,                          // own host process (Advanced section of the device form)
  profileId?, params?: { name: value }        // instance of a device profile
}
```

`GET /api/devices` adds `status` to each device (`state`, `phase`, `reason`,
`since`, `lastError`, `connects`, `requests`, `timeouts`, `exceptions` by code,
`quarantined` keys, `quarantineReasons`, `lastErrorAt`, `openUnits`, and per-poll-group `intervalMs`,
`effectiveIntervalMs`, `lastCycleMs`, `avgCycleMs`, `overruns`, `cycles`), the
driver host states, and the driver descriptors the UI builds its forms from
(`tagTypes` as plain names, `tagTypeInfo` for per-type detail, `tagTypeOptional`
where the device resolves the type, `experimental`, `prerequisites`,
`capabilities`). For a profile instance the listed `tags` are the **effective**
tags (profile tags marked `origin: 'profile'` plus its own) and `ownTags` lists
only the ad-hoc ones.
Saving a device returns the stored record; a device that fails validation
returns 400 with `details: [{ key, error }]`. Deleting a device that a binding
uses returns 409.

## MCP tools

75 tools, covering reads and mutations across the whole backend (there are no
device-specific tools yet; devices and profiles are managed through the REST API
and the UI; `binding_save` accepts `device`, `device-profile`, `opcua` and `sparkplug`
sources, with the selection rules, overrides, fields and context options passed
through). Mutating
tools say so in their descriptions, and every call goes through the same
authenticated REST API (and therefore the same audit log) as the UI.

| Group | Tools |
| --- | --- |
| System & config | `system_status` · `discover_scan` · `discover_results` · `discovery_stop` · `config_export` · `config_import` |
| MQTT | `mqtt_list_brokers` · `mqtt_connect` · `mqtt_disconnect` · `mqtt_list_topics` · `mqtt_get_messages` · `mqtt_sparkplug_topology` · `mqtt_sys_stats` · `mqtt_resolve_subscriptions` · `mqtt_topic_tree` · `mqtt_admin_pubsub` · `mqtt_subscribe` · `mqtt_publish` |
| UNS | `uns_tree` · `uns_lint` · `uns_events` · `mount_save` · `mount_delete` |
| Pipelines | `pipelines_list` · `pipeline_preview` · `pipeline_save` · `pipeline_delete` |
| Historians | `historians_list` · `historian_save` · `historian_delete` · `historian_test` |
| Contracts | `contracts_list` · `contract_infer` · `contract_lock` · `contract_delete` · `contracts_violations` |
| Models | `models_list` · `model_save` · `model_delete` |
| Tags & bindings | `tags_sources` · `tags_browse` · `bindings_list` · `binding_save` · `binding_delete` |
| Recorder & replay | `recorder_list` · `recorder_save` · `recorder_delete` · `recorder_data` · `replay_start` · `replay_stop` |
| Alerts & audit | `alert_rule_save` · `alert_rule_delete` · `alert_events` · `audit_recent` |
| OPC UA | `opcua_list_connections` · `opcua_connect` · `opcua_disconnect` · `opcua_browse` · `opcua_read` · `opcua_monitor` |
| CESMII SMIP | `cesmii_status` · `cesmii_configure` · `cesmii_list_equipment` · `cesmii_list_attributes` · `cesmii_history` · `cesmii_query` |
| i3X | `i3x_status` · `i3x_connect` · `i3x_probe` · `i3x_namespaces` · `i3x_object_types` · `i3x_graph` · `i3x_related` · `i3x_value` · `i3x_history` |

## Testing

**Server** (`cd server && npm test`) runs on `node:test` through a small serial runner
(`server/test/run.js`) that executes each file in-process. The stock `node --test` runner spawns
each file as a child and streams results over an IPC pipe whose framing corrupts intermittently
on CI runners ("Unable to deserialize cloned data"; observed on Node 20 and 22, including at
concurrency 1). Direct execution produces the same TAP output and exit semantics with no IPC.
There are 40 test files:

| Area | Files |
| --- | --- |
| Hot path, topics, UNS | `hotpath` (Sparkplug survives coalescing, bounded queue), `topicTrie`, `uns` (store, lint, events), `perf` (order-of-magnitude floors on ingest, trie, tapped routes; restart survival) |
| Transport and brokers | `integration` (in-process aedes: manager round trip, a pipeline end to end, Sparkplug NBIRTH, DBIRTH, DDATA, DDEATH and NDEATH with sequence assertions), `brokerAdmin` (fake EMQX REST), `sparkplug` |
| DataOps | `dataops` (every transform, both loop guards, filters, spill and drain, drop policies, historian wire formats), `historian-outbox`, `historian-delete`, `route-validation`, `alerts`, `unit` (discovery CIDR maths and helpers) |
| Mapping | `bindings-v2` (quality-aware change detection, Bad on loss, `_status`, typed Sparkplug metrics, heartbeat), `mapping-phase4` (asset paths, objects, `_meta`, profiles), `mapping-context` (selection, overrides, fields, context; compared byte for byte with `fixtures/mapping-legacy.json`), `mapping-routes`, `bindings-opcua-int` |
| Devices | `modbus-core`, `s7-core`, `eip-core` (framing, addressing, decode golden vectors, planner, read-only allowlist), `modbus-driver`, `s7-driver`, `eip-driver` (against the simulators with fault injection; each asserts no write service was ever sent), `driver-runtime`, `driver-supervisor` (crash, hang, crash-loop parking, real `host.js`), `devices-int` (HTTP API with a real child host) |
| OPC UA | `opcuasec` (PKI, trust API), `opcua-reconnect` |
| Security and platform | `auth`, `authConfig`, `rbac` (viewer allowlist), `socket` (handshake and viewer refusal), `egress`, `platform` (audit, rate limits), `configExport`, `profileStore`, `profileDurability` (crash, corrupt file, backups), `http` |
| Real services | `services-int` (EMQX, InfluxDB, TimescaleDB, Timebase; needs `INTEGRATION=1` and the containers, run by the CI `integration` job) |

The simulators (`server/test/support/modbusSimulator.js`, `s7Simulator.js`, `eipSimulator.js`)
implement write services on purpose and count them, so tests can prove none is ever sent. They
show that driver and simulator agree, not that either matches real firmware.
`node server/tools/simulators.js` runs the same three simulators with values that change over
time (the `docker-compose.yml` stack uses it); `docker/simulator/sim.js` publishes a plant
namespace and Sparkplug B traffic for the demo broker.

**Client unit tests** (`cd client && npm test`, Vitest, 21 files in `client/src/test/`) cover the
pure logic: topic matching, graph builders and coverage, UNS tree and helpers, payload diff,
`canvasKit` and `canvasTheme`, chart maths, device status, tag and profile models (including the
bulk CSV parser), the mapping model and preview model, and the Pipelines and Settings models.

**UI end to end** (`cd client && npm run build && npm run e2e`, Playwright). Global setup starts
an in-process MQTT broker with ticking topics, a Modbus simulator and the **real backend** on a
random port with a throwaway `MANIFOLD_DATA_DIR` and `MANIFOLD_ALLOW_LOOPBACK_DEVICES=1`, serving
the built client. Tests that need their own devices start the S7, EtherNet/IP or Modbus
simulators in-process (`e2e/support.js`), a Timebase stub, or a second backend with auth on. One
worker, serial, deterministic. Three projects (`playwright.config.js`):

- `desktop` (1440 x 900): the routes spec plus the functional specs: devices (protocol forms,
  lifecycle, bulk, outage and recovery), profiles, Tags mapping (`tags-binding`, `tags-extra`),
  pipelines, settings, auth (admin and viewer), OPC UA, and `canvas.spec.js`.
- `hidpi` (1440 x 900 at device pixel ratio 2): `canvas.spec.js` again, because backing-store
  size and hit-testing must hold on HiDPI.
- `mobile` (390 x 844, touch): the routes spec and `mobile-nav.spec.js` (opening the nav drawer
  by keyboard).

`routes.spec.js` loads **every route in both themes** (dark, then light) and fails on: any console
error or uncaught exception, any content that overflows the viewport horizontally outside a
scroller, and any **axe-core violation of impact serious or critical** (WCAG 2.0/2.1 A and AA and
best-practice tags). The per-route allowlist is empty on purpose. The canvas spec checks, for the
UNS map, the Topics graph and the 3D view: not blank, backing store matches size times DPR,
hit-testing, no render loop when idle or after unmount, WebGL context loss recovery, the deep
link, and an in-place recolour on theme switch. WebGL runs on a software renderer in this setup.

**CI** (`.github/workflows/ci.yml`, every push and PR, superseded runs cancelled): `server`
(lint and tests, Node matrix), `client` (lint, Vitest, production build), `integration` (real
EMQX 5 configured to authorize wildcard QoS 1 intake, InfluxDB 2, TimescaleDB, and a Timebase
container; service-wait fails by name; container logs dumped on failure), `mcp` (lint and a load
check), `e2e` (UI smoke and accessibility: builds the client, installs Chromium, `npm run e2e`, uploads the
report) and `audit` (`npm audit --omit=dev --audit-level=high` for server, client and mcp).
Version tags (`v*`) additionally build and publish the `ghcr.io/zbest1000/manifold` image
(`release.yml`); `pages.yml` publishes `site/`; `wiki.yml` mirrors `docs/wiki/` into the GitHub
wiki.

## Performance notes

The pure-JS hot path sustains ~4M messages/s ingest on commodity hardware. A
Rust/napi implementation of the same store was benchmarked (`native/`):
Rust wins when Rust owns the loop (12M/s) but loses through per-message or
batched FFI (2.8M/s and 1.4M/s) — the napi boundary costs more than the work
it saves. The struct-of-arrays JS store also recovered most of Rust's memory
advantage (425 MB vs 380 MB at 1M topics). The addon is kept as a
reproducible benchmark, not a dependency.
