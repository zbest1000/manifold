# Changelog

All notable changes to Manifold are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Southbound device drivers, read-only.** Modbus TCP, Siemens S7 (S7comm) and
  EtherNet/IP (Logix) devices can be polled directly. **S7 and EtherNet/IP are
  experimental**: they were checked only against in-process simulators written
  with the drivers, and each has a "verify on real hardware" checklist
  (`server/drivers/s7/NOTES.md`, `server/drivers/eip/NOTES.md`). All three are
  our own implementations on `node:net` with no new dependency. Each driver
  runs in a supervised child process (restart with backoff, crash-loop parking,
  heartbeat); each device keeps one connection, reconnects forever with
  jittered backoff, skips and counts overrunning poll cycles, slows an
  overrunning group down, bisects and quarantines permanently failing tags, and
  trips a per-unit breaker for Modbus gateways. Every driver builds all outgoing
  frames through one allowlisted encoder, so no write service can reach a
  device; tests assert it.
- **Devices page and API.** `GET/POST /api/devices`, `PUT/DELETE
  /api/devices/:id`, `POST /api/devices/test`, `POST /api/devices/validate-tags`,
  `POST /api/devices/:id/probe`, `GET /api/devices/:id/browse` (EtherNet/IP
  controller tags), `GET /api/devices/:id/values`. The page has a tag table
  (spreadsheet paste, CSV import, inline validation), a connection test, per-group
  cycle times and overruns, quarantine and last-error display, and a probe that
  decodes raw registers under all four Modbus byte/word orders. Modbus accepts
  `holding:100` and Modicon `40001` / `400001`.
- **Tag sources and bindings v2.** Bindings consume pluggable tag sources
  (device drivers, OPC UA) emitting normalized `sample` / `source-state` events.
  Change detection keys on (value, quality); a source going offline publishes one
  Bad envelope per tag and a retained `<path>/_status` document
  (`statusTopic: false` to disable); Sparkplug targets use the real tag type and
  get DDEATH / DBIRTH on loss and recovery; `rbe.heartbeatMs` republishes
  unchanged tags.
- **Accessible tag tree and a bind wizard** with a live preview of the resolved
  topic, a filter box, and keyboard navigation (arrows, Space, Enter).
- **Demo stack: simulated devices.** `server/tools/simulators.js` runs the Modbus,
  S7 and EtherNet/IP test simulators with changing values; the compose file gains
  a `device-sim` service, and the demo seed includes three devices and a binding
  that publishes the Modbus device to `demo/plant1/pump1/`. See DOCKER.md.
- **Historian outbox:** segmented spill with an atomic cursor, a dead-letter file
  for permanently rejected points, and strict oldest-first delivery that live
  traffic cannot overtake.
- **Profile store:** fsynced writes, rotating backups (`profiles.json.bak.1` to
  `.5`), and recovery from the newest valid backup. Config export and import now
  cover devices and device profiles, and import is validated whole.
- **Audit log rotation** (`MANIFOLD_AUDIT_MAX_BYTES`, `MANIFOLD_AUDIT_KEEP`).
- **New settings:** `MANIFOLD_ALLOW_LOOPBACK_DEVICES`, `MANIFOLD_METRICS_PUBLIC`,
  `MANIFOLD_AUDIT_MAX_BYTES`, `MANIFOLD_AUDIT_KEEP`, `MANIFOLD_SPARKPLUG_QUEUE_MAX`,
  `MANIFOLD_SPARKPLUG_QUEUE_BYTES`, `MANIFOLD_TOPIC_IDLE_TTL_MS`,
  `MANIFOLD_MAX_MSG_PROPS`.
- Optional idle-topic eviction, a `topic-cap-reached` event, and a
  `sparkplugCoalesced` broker metric.
- New wiki pages **Devices and Drivers** and **Mapping to the UNS**, and a design
  document for the drivers (`docs/design/southbound-drivers.md`, partly
  implemented).

- **System (Health) page.** Renders Manifold's own Prometheus `/metrics` in the
  browser — process health (uptime, memory, event-loop delay), per-broker
  ingest rate and topic counts, and every engine counter — each with a rolling
  sparkline and amber thresholds.
- **Trends from local recordings.** The Trends page can chart a file recording
  directly (server-side downsampling), with no external historian required.
- **Egress guard.** One chokepoint for the network scanner and the outbound
  HTTP clients (i3X, CESMII, broker admin): loopback, cloud-metadata
  link-local, multicast, and reserved ranges are always blocked; RFC1918/LAN
  targets require `MANIFOLD_ALLOW_PRIVATE_TARGETS=1`.
- **Security headers and a general rate limit** (`helmet` + `express-rate-limit`)
  on the API, plus `GET /api/whoami` so the UI can show a read-only badge.

### Changed

**Operator-visible behaviour changes**

- **A viewer token alone now enables auth**, which leaves no admin: also set
  `MANIFOLD_AUTH_TOKEN` or an admin entry in `MANIFOLD_TOKENS`.
- **Unknown roles in `MANIFOLD_TOKENS` are rejected** instead of becoming admin.
  A token containing `:` needs an explicit role (`name:ab:cd:viewer`). If tokens
  are configured but all rejected, auth stays on and every request is 401.
- **`/metrics` requires a bearer token** (any role) when auth is on. Set
  `MANIFOLD_METRICS_PUBLIC=1` to keep it open for an anonymous scraper.
- **Alert webhooks pass the egress guard.** Webhooks to `localhost`, link-local
  and (without `MANIFOLD_ALLOW_PRIVATE_TARGETS=1`) private addresses are refused.
- **Viewers** can call a short list of read-only POSTs (historian query, pipeline
  preview, subscription resolve, schema inference, device tag validation, i3X
  reads) and no longer see alert webhook URLs.
- **Device targets** pass the egress guard: private ranges need
  `MANIFOLD_ALLOW_PRIVATE_TARGETS=1`, loopback needs
  `MANIFOLD_ALLOW_LOOPBACK_DEVICES=1`.
- **Sparkplug messages are delivered in order and un-coalesced** (bounded queue,
  overflow counted). They reach consumers at flush cadence, up to 100 ms later.
- **Bindings publish more:** a quality-only change publishes (envelope format),
  an offline source publishes Bad, and `<path>/_status` is retained. The bind
  wizard now leaves **retain off** by default.
- **Historian spill layout changed** to segment files plus a cursor under
  `outbox/`. A legacy `<id>.jsonl` is still read first and drained; no conversion
  is needed. Permanently rejected points go to `<id>.deadletter.jsonl`.
- **InfluxDB value typing is stricter:** only real numbers (and plain decimal
  strings) write `value`; booleans and everything else write `raw` as text
  (booleans were `1`/`0` before); `null` is skipped and counted; names with
  control characters are rejected. InfluxDB stores no quality, so it is not
  offered for device data.
- **Pipeline and historian timestamps and quality** come from the payload when it
  carries them (TVQ envelope `t`/`q`, Sparkplug timestamps and the metric
  `Quality` property) instead of always being arrival time and Good.
- **OPC UA:** a lost or never-established saved connection is retried forever
  (1 s to 60 s, jittered) and monitors are rebuilt; socket value updates are
  coalesced to 100 ms; `publish-success` socket events are summarized (a leading event, then at most
  one summary per broker per second).
- **Audit:** rejected requests (401, 403, 429) are recorded, query strings are
  dropped from paths, and the file rotates by size.
- `profiles.json` is written asynchronously (coalesced) with fsync; pending
  writes flush on shutdown.
- A subscribe that fails for a reason other than a SUBACK refusal is retried
  (three times, exponential backoff).

**Other**

- **Fail closed by default.** With no auth token, the server now binds
  `127.0.0.1` only; exposing an unauthenticated instance off-host requires
  `MANIFOLD_HOST=0.0.0.0`. The Docker demo maps to host loopback only.
- Socket.IO auth now shares the REST brute-force throttle and audit trail (both
  entry points enforce auth and rate-limit failures identically).
- Per-topic MQTT payloads are capped (`MANIFOLD_MAX_PAYLOAD_BYTES`, default
  256 KB); the live socket stream is backpressure-safe; historian HTTP calls
  have a hard timeout; Postgres/Timescale TLS verifies certificates by default.
- The built client is served whenever `client/dist` exists (no longer gated on
  `NODE_ENV=production`).

### Fixed

- OPC UA bindings no longer go silent after a restart, an edit or a delete, and a
  dropped OPC UA connection is no longer given up on after a few retries.
- Sparkplug DATA messages are no longer lost to per-flush coalescing (the
  registry, bindings, pipelines and historian targets see every message).
- A Good-to-Bad quality change with an unchanged value is no longer suppressed,
  and Sparkplug numbers are no longer all encoded as Double.
- InfluxDB line protocol: a newline or trailing backslash in a topic can no
  longer inject or escape lines, and `""` / `null` no longer write `value=0`.
- A permanently rejected historian batch no longer blocks the spill head-of-line;
  the spill is no longer rewritten non-atomically or read whole per batch, and a
  crash mid-write no longer loses it.
- Edited credentials take effect: the PostgreSQL pool cache is keyed by the whole
  connection config. `updateBroker` validates before tearing the old connection
  down.
- Alert webhooks no longer follow redirects unchecked, and IPv6 forms that embed
  an IPv4 address are classified by the embedded address.
- Config export no longer leaks webhook URLs; `cert` fields are redacted from the
  audit log.
- `profiles.json` is no longer rewritten without fsync, and a corrupt file is
  recovered from a backup instead of starting empty.
- The MQTT 5 property table and topic slots are bounded; `monitor()` no longer
  creates duplicate OPC UA subscriptions under concurrent calls.
- Wildcard value-threshold alerts keep independent state per concrete topic
  (a normal reading on one topic no longer suppresses a real breach on another).
- Sparkplug alias-only DATA metrics resolve to their BIRTH names instead of
  collapsing into an empty-name key; the registry is bounded against untrusted
  traffic.
- A bare `#` topic filter now matches every topic in the UI (Consumer coverage).
- The graph auto-fits to the viewport on first load; canvas interaction no
  longer captures stale callbacks after switching servers or styles.

### Security

- Egress guard: alert webhooks (with redirect re-validation and connect-time
  address pinning) and device targets now pass it. It still does **not** cover
  MQTT broker hosts, OPC UA endpoints or historian/database URLs.
- Roles fail closed: unknown roles are rejected, never treated as admin; a failed
  token configuration keeps auth on.
- Viewer role: explicit allowlist of read-only POSTs, webhook URLs hidden.
- `/metrics` requires authentication when auth is on.
- Audit covers rejected requests; secrets are redacted by one shared rule used
  for both the audit log and config export; URL passwords are stripped.
- Config import is validated whole (ids, sizes, depth, prototype-polluting keys);
  profile-store ids are checked against prototype-polluting names.
- Device drivers are read-only by construction (allowlisted frame encoders).
  Modbus TCP, S7comm and plain EtherNet/IP do not authenticate the client, and
  enabling PUT/GET on an S7 CPU makes its data blocks writable by any peer:
  restrict the network path.

### Known issues

- Config export blanks each device tag's `key` (the secret-name rule matches
  `key`); do not use export/import to move devices until fixed.
- When an S7 CPU refuses reads (PUT/GET off, optimized access), the device stays
  Online with its tags quarantined and no `lastError`; the explanation is shown
  only by Probe.
- The Sparkplug publisher session still ignores a broker's TLS settings, `wsPath`
  and `mqttVersion`, and caches sessions across edits.
- Device metrics are not on `/metrics`; the Devices page and `GET /api/devices`
  carry them.

## [1.0.0] - 2026-07-15

First tagged release.

### Added

- **Value-threshold alert rules.** Watch a numeric payload — or a dot-path
  `field` inside a JSON payload — against `>`, `>=`, `<`, `<=`, `==`, `!=`.
  Evaluated at message latency on the live tap, not on a polling interval.
  Optional `sustainMs` (the condition must hold continuously before firing)
  and `clearValue` hysteresis (a `>` rule resolves only once the value falls
  back to the clear level — no flapping in the deadband).
- **Historian read-back and a Trends page.** `GET /api/historians/:id/tags`
  lists stored tags; `POST /api/historians/:id/query` reads downsampled
  series (InfluxDB via Flux `aggregateWindow`, TimescaleDB via
  `time_bucket`). The Trends page charts up to 10 series with a time-range
  picker and 30 s auto-refresh.
- **MQTT 5, opt-in per broker.** v5 user properties, content type, response
  topic, and correlation data are decoded on inbound messages; user
  properties, content type, and response topic can be set on publish.
- **MQTT over WebSocket.** `ws` and `wss` transports with a configurable
  path (default `/mqtt`).
- **Configurable intake filter.** The auto-subscribe filter is set per
  broker and accepts shared subscriptions (`$share/<group>/<filter>`).
- **Sparkplug B host application STATE.** The registry tracks
  `spBv1.0/STATE/{host}` messages (host online/offline in the UI and event
  feed), and Manifold can itself run a primary-host session publishing
  retained STATE with a matching will (`POST /api/tags/sparkplug/state`).
- **OPC UA security.** Application certificate manager under
  `<data dir>/pki` (self-signed client certificate created on first use),
  Sign and SignAndEncrypt connections, endpoint discovery
  (`POST /api/opcua/discover`), and certificate trust management
  (`GET /api/opcua/certificate`, `GET`/`POST /api/opcua/trust`) with
  optional trust-on-first-connect.
- **Edit in place everywhere.** Brokers (`PUT /api/mqtt/brokers/:id`) and
  OPC UA connections (`PUT /api/opcua/connections/:id`) update without
  delete/re-add; pipelines, historians, models, bindings, and alert rules
  upsert by id.
- **MCP server grew to 75 tools** — 29 new mutation and read tools:
  save/delete for pipelines, historians, models, bindings, recordings,
  contracts, mounts, and alert rules; historian test writes; recorder
  read-back; replay start/stop; subscribe/publish; config export/import.
- **Custom UNS icons.** Upload single-path SVG icons
  (`POST /api/uns/icons`) and assign them in the topology, alongside a
  curated set of roughly 130 industrial icons.
- **Named API tokens.** `MANIFOLD_TOKENS="name:token:role,..."` issues
  individually revocable admin/viewer tokens; the token name appears in the
  audit trail.
- **Global socket-disconnect banner** in the UI, so no panel silently shows
  stale data.
- **Docker image.** `ghcr.io/zbest1000/manifold`, published on `v*` tags;
  one container serves the API and the built UI.
- **CI** integration tests now include a Timebase historian container next
  to EMQX, InfluxDB, and TimescaleDB.

### Changed

- 3D topic graph rewritten on three.js: instanced sphere rendering handles
  50,000 nodes, and three.js loads as a lazy chunk only when the 3D view
  opens.
- Force-directed layout runs in a client Web Worker (d3-force, 30,000-node
  cap) — the UI thread never blocks on layout.
- The UNS icon set ships as a curated ~130-icon industrial subset; the full
  icon library loads on demand in the picker instead of weighing down the
  main bundle.
- All outbound HTTP calls (historian writes and queries, alert webhooks,
  broker admin APIs) carry bounded timeouts.
- The Bench page is development-only.

### Removed

- TimeBase CE historian backend. Three backends remain: InfluxDB v2,
  TimescaleDB/PostgreSQL, and Timebase (Flow Software).
- Server-side graph layout engines — layout is now entirely client-side in
  the Web Worker.

### Fixed

- A failed publish from a timer callback (replayer, model engine) could
  escape its error handler and crash the server; `publish()` now never
  throws synchronously.
- Message-history restore no longer races profile restore on boot — rings
  refill in order after connections are re-established.
- A corrupt profiles file no longer wipes saved connections silently: it is
  backed up to `profiles.json.bak` (mode 0600) so credentials can be
  recovered, and the server starts clean.
- OPC UA monitored items are rebuilt automatically after a reconnect, so
  live values resume without manual re-monitoring.
- Alert webhook delivery failures are counted and surfaced
  (`webhookFailures`, `lastWebhookError` on `/api/alerts/rules`) instead of
  disappearing into the log.

### Security

- CORS is locked to the configured client origin (`CLIENT_URL`, default
  `http://localhost:3000`) instead of allowing any origin.
- Failed authentication is rate-limited per IP: 20 failures per minute,
  then `429` responses.

[1.0.0]: https://github.com/zbest1000/manifold/releases/tag/v1.0.0
