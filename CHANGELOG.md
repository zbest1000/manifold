# Changelog

All notable changes to Manifold are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Concurrent edits are no longer last-write-wins.** Every stored object has a `rev` and `updatedAt`; a save that
  sends `rev` (body field or `If-Match`) against a newer stored object gets `409 { code: "stale", current }`
  (secrets redacted); no `rev` keeps the old behaviour. Devices, profiles, brokers, routes, models, historians,
  recordings, contracts and alert rules show a *changed elsewhere* dialog (Keep mine / Take theirs / Cancel).
- **DNS re-resolution window for device targets closed.** The validated address is passed to the driver host and
  connected to directly; names are re-validated on host restart and every 30 s, and a name that turns blocked
  takes the device offline with the reason.
- **Pipeline counters no longer lie for historian targets.** Routes report routed, delivered, pending and rejected
  (also on `/metrics` and in the engine-metrics payload); the Routes and Historians tabs explain the split.
- **Duplicate broker connections** are refused with a `409` naming the existing one (identity: protocol, host,
  port, WebSocket path, user, subscribe filter).
- **Dangling references** are rejected on save (`400`), deleting a used broker is refused (`409` naming the users),
  and objects with a lost reference show as *Broken reference*.
- **Alert rules expose real state** (`idle | breached | firing | disabled | broken`, countdown to firing, value,
  last transition, webhook health) instead of the UI guessing from events.
- Driver-host robustness is covered by tests (synchronous `createDriver` throw, a `connect()` that never settles,
  SIGKILL mid-request, isolated devices, staggered connects, no child left after shutdown); a parked host now says so
  on each of its devices.

### Added

- **OPC UA is tested against a real server.** `node-opcua` (devDependency only) backs
  `server/test/support/opcuaTestServer.js`: every scalar type, arrays, structures, engineering units and ranges,
  controllable status codes and source timestamps, None/Sign/SignAndEncrypt with anonymous and user name logins,
  restarts, outages, server-side session close and subscription deletion, slow reads, session limits and certificate
  rejection both ways. Integration tests cover the manager, the tag bindings (envelope quality, Bad on loss, Good on
  recovery, typed Sparkplug metrics), the HTTP routes, UNS mounts and discovery; the UI e2e drives the OPC UA page, the
  trust step, a server restart, mapping from the Tags page and a UNS mount live.


- **A new design system and a rebuilt interface.** Semantic colour tokens for a **light, dark and system theme**
  (the choice is stored in the browser and applied before the first paint), IBM Plex type, and shared primitives
  in `client/src/components/ui`. Every page was rebuilt on it: Overview (needs attention, sources, data flow,
  connections, latest values), MQTT Brokers, **Devices** (a sortable, filterable table with a detail drawer
  (Overview, Tags, Probe) and a full-page form with Connection, Protocol options, Polling, Tags and Advanced
  sections), Profiles, Discovery, **Tags** (a two-tab workspace and the Mappings table), Pipelines (five tabs, a
  route editor with a reorderable transform chain and a dry run), OPC UA, CESMII SMIP, i3X, Settings (General with
  Session, Theme, Topic graph and MCP; Alert rules; Configuration; Audit trail), the unlock screen, and Topics,
  UNS, Flows, Trends and Health with canvases themed from the same tokens. See `docs/design/ui-design-system.md`
  and the wiki's *User interface* page (themes, shortcuts, deep links, what accessibility testing covers).
- **The mapping editor** replaces the three-step wizard: one sheet with Mapping, What, Where, Tags, Context,
  Payload and Delivery sections and a live server preview (topics, payload, `_meta`, changes, collisions). The UI
  says *mapping* for what the API calls a binding.
- **Selective mapping and tag context (server and editor).** Per-entry `enabled`; `source.select` rules (include and
  exclude globs on key and property, poll groups, types, has-a-property) so tags added to a device later are
  picked up; `source.overrides` and per-tag overrides of name, displayName, description, unit, range, dataType,
  scale, offset, precision, states, statesMode, limits, deadband and context; `target.context` with placeholders
  (`{device}`, `{deviceId}`, `{protocol}`, `{host}`, `{param:x}`), `target.contextMode` (`meta`, `payload`,
  `none`), `target.fields`, `target.metaFields`; `GET /api/tags/bindings/schema`, `POST /api/tags/bindings/suggest`;
  preview additions (`previewTags`, per-field origins, selection rows) and `option-ignored` warnings. A mapping
  that uses none of it publishes byte for byte what it did before.
- **Canvas rendering overhaul.** One shared kit (`client/src/graph/canvasKit.js`) for DPR-correct sizing, one camera
  transform for drawing and picking, a frame scheduler that idles at about one frame per second and stops while
  hidden, label level of detail, WebGL context-loss recovery; canvas themes derived from the tokens and switched in
  place; a validated ten-colour data palette; graph styles Standard, Schematic and Monochrome; deep links
  `/uns?broker=&path=` and `/topics?broker=&topic=` that select and centre reliably.
- **Read-only sessions** show disabled controls with the reason and a short note instead of 403s; Settings has a
  Session card with **Sign out / use a different token**.
- **`POST /api/devices/bulk`** creates up to 200 devices all-or-nothing; the profile bulk table and Discovery's
  **Add all** use it. The device form's **Advanced** section edits Modbus unmapped register ranges and per-device
  process isolation. Recordings can be paused and resumed.
- **UI test suite and linting.** Playwright projects desktop, hidpi (device pixel ratio 2) and mobile; every route is
  loaded in both themes at 1440 and 390 px and fails on serious or critical axe findings, horizontal overflow and
  console errors; functional specs for devices, profiles, outage and recovery, mapping, pipelines, settings, auth and
  OPC UA. ESLint runs for server, client and mcp in CI.

- **Functional QA pass over Tags, Devices, Discovery, Pipelines, OPC UA, CESMII, i3X and Settings.**
  `POST /api/devices/bulk` creates devices all-or-nothing (every row validated first, per-row errors
  on failure) and both bulk dialogs use it; device names are unique; a device the driver could never
  run (bad options, S7 without rack/slot) is refused at save time; the device form has an Advanced
  section for Modbus unmapped register ranges and per-device process isolation; Tags says plainly
  that MQTT-topic tags become pipeline routes; a historian route from a `{v,t,q}` topic offers the
  numeric-on-`v` transform; bindings link to the UNS page (`/uns?broker=&path=`); viewer sessions
  see disabled controls with the reason instead of 403s; Settings shows the session and can sign out.
  Fixes: historians still used by a route, recording or binding can no longer be deleted; pipeline,
  model and recorder topics are validated; a stale inferred contract could be locked under another
  topic; the OPC UA form left a ghost "connecting" row after a refused connection; Discovery offered
  to connect brokers that were already connected; importing the same config file twice did nothing.

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
  controller tags), `GET /api/devices/:id/values`. The page has generic forms
  for all three protocols with presets, an **Experimental** badge and the
  driver's prerequisites text, a tag table (spreadsheet paste, CSV import,
  inline validation), a connection test, polling health (per-group cycle times
  and overruns, quarantine reasons, last error with its time), **Import from
  controller** for EtherNet/IP, and a probe that decodes raw registers under all
  four Modbus byte/word orders. Modbus accepts `holding:100` and Modicon
  `40001` / `400001`. The device status gained `quarantineReasons` and
  `lastErrorAt`; driver descriptors are uniform (`tagTypeInfo`,
  `tagTypeOptional`).
- **Device profiles and instances.** `GET/POST /api/devices/profiles`,
  `GET/PUT/DELETE /api/devices/profiles/:id`, `POST
  /api/devices/profiles/:id/instantiate`. A profile holds protocol, options,
  poll groups, `params[]` and tags whose `key`, `address` and `property` may use
  `{param}` placeholders; a device references it with `profileId` and `params`.
  Editing a profile re-applies it to every instance atomically (400 listing the
  instances that would break); deleting one is refused (409) while a binding
  uses it. The **Profiles** tab creates a profile (or one from an existing
  device), creates a device from it, and **bulk-creates** devices from a pasted
  table or CSV (one request per row; each row's result is shown).
- **Mapping to the UNS: asset paths, objects and metadata.** A binding's
  `target.assetPath` (ISA-95, no placeholders) replaces the `pathTemplate`
  (still accepted); the topic is `<assetPath>/<property>`. Envelopes carry the
  engineering unit as `u`. `layout: 'object-per-asset'` publishes one JSON
  object per asset (`{ t, values: { <property>: { v, q, u? } } }`), capped by
  `target.maxObjectBytes` (default 64 KB, at most 1 MB) and rejected at save
  time when the worst case would exceed it. A retained `<asset>/_meta` document
  (`target.metaTopic: false` to disable) lists each property's type, unit,
  description, range and source; Sparkplug targets carry unit, description and
  range as metric properties in the BIRTH. A percent deadband
  (`rbe.deadband: { type: 'percent', value }`) is of the tag's range, or of the
  last published value when it has none. Profile bindings (`source.type:
  'device-profile'`, `target.assetPathTemplate` such as `acme/{site}/{device}`
  or an explicit `assetPaths` map) publish one unit per instance of a profile,
  including instances added later.
- **Retained cleanup.** Retained topics a binding owns (`_status`, `_meta`,
  retained values) are cleared with an empty retained publish when a binding is
  deleted, disabled, renamed (path or broker) or has retain switched off, or a
  profile instance goes away.
- **Direct historian target** on a binding (`target.historian.historianId`):
  each published sample goes to the store-and-forward outbox with its read
  timestamp and quality. Timebase and TimescaleDB only; InfluxDB is rejected at
  save time because its writer drops quality.
- **Binding preview and save-time warnings.** `POST /api/tags/bindings/preview`
  (open to viewers) resolves topics and example payloads for up to 50 tags (or
  the first 50 objects), flags topics another binding already publishes and
  names that look like raw device addresses. `POST /api/tags/bindings` returns
  the same non-blocking `warnings` with the saved binding. The namespace lint
  also flags topic leaves that look like raw device addresses and no longer
  applies hierarchy rules under `spBv1.0`.
- **Discovery of devices (opt-in).** The scan can look for Modbus TCP (502), S7
  (102) and EtherNet/IP (44818) devices (`includeDevices: true`, or explicit
  `modbusPorts`, `s7Ports`, `eipPorts`). Each port gets one read-only
  identification probe built with the drivers' own frame encoders; the Discovery
  page has "Find devices" and "Add as device". Loopback targets are always
  refused by the scan.
- **Device metrics on `/metrics`:** `manifold_device_up`,
  `manifold_device_connects_total`, `manifold_device_requests_total`,
  `manifold_device_timeouts_total`, `manifold_device_exceptions_total`,
  `manifold_device_cycle_ms`, `manifold_device_overruns_total`,
  `manifold_device_quarantined_tags`, `manifold_driver_host_up`,
  `manifold_driver_host_restarts_total`, plus
  `manifold_binding_suppressed_total` and `manifold_binding_errors_total`.
- **UI shell.** A navigation drawer below the `md` breakpoint, AA contrast
  tokens, a global focus ring, shared dialog, table and form primitives, lazy
  routes with a skeleton fallback (smaller initial bundle), an ESLint config for
  the client, a dark UNS canvas with the Sparkplug namespace labelled as such,
  one topic counter and one ingest-rate source for Overview, Topics and UNS.
- **Tag sources and bindings v2.** Bindings consume pluggable tag sources
  (device drivers, OPC UA) emitting normalized `sample` / `source-state` events.
  Change detection keys on (value, quality); a source going offline publishes one
  Bad envelope per tag and a retained `<path>/_status` document
  (`{ online, since, reason }`; `statusTopic: false` to disable; also published
  when a binding is created while its source is already online); Sparkplug
  targets use the real tag type and get DDEATH / DBIRTH on loss and recovery;
  `rbe.heartbeatMs` republishes unchanged tags.
- **Accessible tag tree and a three-step bind wizard** (target, naming, options; **superseded by the mapping editor above**):
  an asset-path picker over the live UNS tree, the layout choice, units, deadband
  type, heartbeat, the historian target, profile bindings, and a topic and
  payload preview computed by the server. The tree has a filter box and keyboard
  navigation (arrows, Space, Enter).
- **Demo stack: simulated devices.** `server/tools/simulators.js` runs the Modbus,
  S7 and EtherNet/IP test simulators with changing values; the compose file gains
  a `device-sim` service, and the demo seed includes three devices and two
  bindings for the Modbus device: per-tag topics under `demo/plant1/pump1/` (a
  legacy `pathTemplate`) and one object under `demo/plant1/pump1-object`
  (`assetPath` with `object-per-asset`). See DOCKER.md.
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
- New wiki pages **Devices and Drivers**, **Mapping to the UNS** and **Verifying
  on real hardware** (one ordered checklist for Modbus, S7 and EtherNet/IP), and
  a design document for the drivers (`docs/design/southbound-drivers.md`).

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
- **Choose what to map (server API).** Binding tag entries take
  `enabled: false` (kept, but not monitored, published, listed in `_meta` or
  retained; turning one off clears its retained topic). `tags: "all"` on device
  and profile sources takes `source.select` rules (include/exclude globs on key
  and property, poll groups, types, with/without property), picks up matching
  tags added later, and `source.overrides` gives rule-selected tags per-tag
  settings. `target.fields` chooses the envelope / object-member fields
  (`v t q u name src ctx`; dropping `q` warns) and `target.metaFields` the
  `_meta` fields (e.g. keep source addresses off the broker).
- **Context on tags (server API).** Per-tag overrides with device fallback:
  name, displayName, description, unit, range, `dataType` cast, `scale`/`offset`,
  `precision`, `states` (label field or replace), `limits` (metadata only, no
  alarm engine), per-tag `deadband` and free-form `context`. A failed scale or
  cast publishes Bad quality with a `reason`, never a wrong value. Asset-level
  `target.context` with `{device}`, `{deviceId}`, `{protocol}`, `{host}` and
  `{param:<name>}` placeholders; `target.contextMode` `meta` (default, in
  `_meta`), `payload` (also `ctx` in payloads, 1 KB cap) or `none`. Device tags
  may carry `context`, `displayName`, `states` and `limits`. Sparkplug targets
  send displayName, limits and context as BIRTH metric properties and re-BIRTH
  when metadata changes. Context keys are validated (charset, 32 keys, 256-char
  values, 4 KB); credential-like keys warn.
- **Mapping API for the wizard.** `GET /api/tags/bindings/schema`,
  `POST /api/tags/bindings/suggest` (read-only name and context suggestions),
  and a richer preview: effective metadata with the origin of each field,
  selection result per tag, per-tag warnings, payload sizes. Bindings that use
  none of the new options publish byte-for-byte what they did before.

### Changed

- **Device live values** reach the browser as **one `device-values` Socket.IO event per 250 ms flush** carrying every
  touched device (`{ batch: [{ deviceId, values }] }`), delivered reliably when the flush contains a quality change.
  Per-device volatile emits delivered only the first device's values.
- **Saving is stricter.** Device names are unique and may not contain control or bidi characters; a device the
  driver could never run (bad options, S7 without rack and slot) is refused at save time; pipeline source filters and
  `repath` targets, model targets and recorder filters are validated as MQTT topics; a historian that a route,
  recording or mapping uses cannot be deleted (409 naming them).
- **Viewers** may also call mapping preview, name suggestions and CESMII history (read-only POSTs).
- The MCP `binding_save` tool accepts `device` and `device-profile` sources and the new selection and context options.
- A failed retained `_meta` or `_status` publish is retried on a 15 s timer; a plain mapping with a direct historian
  target records the Bad sample on source loss; Sparkplug-source mappings use the timestamp plausibility window.

**Operator-visible behaviour changes**

- **A viewer token alone now enables auth**, which leaves no admin: also set
  `MANIFOLD_AUTH_TOKEN` or an admin entry in `MANIFOLD_TOKENS`.
- **Unknown roles in `MANIFOLD_TOKENS` are rejected** instead of becoming admin.
  A token containing `:` needs an explicit role (`name:ab:cd:viewer`). If tokens
  are configured but all rejected, auth stays on and every request is 401.
- **`/metrics` requires a bearer token** (any role) when auth is on. Set
  `MANIFOLD_METRICS_PUBLIC=1` to keep it open for an anonymous scraper.
- **Imported configuration applies immediately** (bindings are reconciled and
  devices re-applied) instead of at the next restart.
- **Viewers may call the binding preview** (a read-only POST) and still cannot
  see alert webhook URLs in the rule listing.
- **Alert webhooks pass the egress guard.** Webhooks to `localhost`, link-local
  and (without `MANIFOLD_ALLOW_PRIVATE_TARGETS=1`) private addresses are refused.
- **Viewers** can call a short list of read-only POSTs (historian query, pipeline
  preview, subscription resolve, schema inference, device tag validation, i3X
  reads) and no longer see alert webhook URLs.
- **Device targets** pass the egress guard: private ranges need
  `MANIFOLD_ALLOW_PRIVATE_TARGETS=1`, loopback needs
  `MANIFOLD_ALLOW_LOOPBACK_DEVICES=1`.
- **The Sparkplug publisher honours the broker profile:** TLS material
  (`ca`, `cert`, `key`, `rejectUnauthorized`), WebSocket path, MQTT version and
  credentials, and an edge-node session is rebuilt when its broker profile is
  edited.
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
- **Pipeline, recorder and historian timestamps and quality** come from the
  payload when it carries them (TVQ envelope `t`/`q`, Sparkplug timestamps and
  the metric `Quality` property) instead of always being arrival time and Good.
  Pipelines and the recorder ignore a source time before 2000-01-01 or more than
  24 hours ahead and use arrival time. Sparkplug-source bindings use the metric's
  own time and quality without that window.
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

- **OPC UA against a real server**: node-opcua's implicit session repair fought the supervisor after a server-side
  session close, so values arrived twice; stopping a value on the OPC UA page (or just selecting another node) deleted
  the monitored item a tag binding depended on; the certificate to trust never appeared in the connection form after a
  refused secure connect; trust errors named REST endpoints instead of what to do. The page now shows which values are
  still monitored and when they are stale, names instead of truncated node ids, and Bad quality on the tree nodes.
- **Sparkplug sessions follow broker profile edits**: a running host STATE session was only rebuilt when `startHost`
  was called again, and an edited edge-node session was dropped without NDEATH. Both now publish a clean offline STATE
  or DDEATH/NDEATH on the old connection and reconnect with the new settings on their own; a removed profile ends them
  cleanly.

- Canvas defects: canvases sized in px stopped their flex container from shrinking; the UNS ran at 60 frames per
  second forever; the Topics graph re-heated its layout on every click; WebGL had no context-loss handling and drew a
  2,000-child branch as a giant disc; the 3D camera sat inside the layout; charts drew outages as straight lines and
  clipped y labels; deep-link centring drifted as topics streamed in.
- A tag going Bad could be dropped by a lagging client and leave a stale Good in the UI (the flush now goes reliable).
- A stale inferred contract could be locked under another topic; the OPC UA form left a ghost "connecting" row after a
  refused connection; Discovery offered to connect brokers that were already connected; importing the same config file
  twice did nothing.

- Config export no longer blanks device tag keys: arrays named `tags` and
  `ownTags` keep their `key` identifiers, while a secret inside a tag or a key
  anywhere else is still masked.
- A refused or quarantined device tag now reaches the device status: `lastError`
  reads `tag <key>: <reason>` (for an S7 CPU with PUT/GET off, the PUT/GET hint),
  `quarantineReasons` lists code, message and time per tag, and `lastErrorAt` is
  set. Before, only Probe showed the cause.
- A binding created or edited while its source is already online now publishes
  `_status` immediately instead of at the next state change.
- Controller browse returns an address for folder nodes, and an EtherNet/IP
  STRING is browsed as a value, not as members.
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

- Viewer sessions can use mapping preview, name suggestions and CESMII history (read-only POSTs); the allowlist is
  `VIEWER_READ_ONLY_POSTS` in `server/services/authConfig.js`. The UI shows read-only sessions as disabled controls.
- Egress guard: alert webhooks (with redirect re-validation and connect-time
  address pinning), device targets and every Discovery scan candidate now pass
  it. It deliberately does **not** cover MQTT broker hosts, OPC UA endpoints or
  historian/database URLs: a broker or historian on `localhost` or the LAN is the
  standard setup, and an admin configures these by hand. The residual risk is
  that an admin token can make the server connect to any host it can reach
  through those three paths, internal services included; protect admin tokens and
  use network policy.
- Discovery's device probes send read-only identification requests only (Modbus
  function 3 on one register, an S7 COTP connection request, an EtherNet/IP
  ListIdentity), are opt-in, and are built with the drivers' allowlisted encoders.
  Scanning an OT network is still intrusive.
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

- **OPC UA was verified only against node-opcua's server.** Kepware, Siemens S7-1500, Ignition, Prosys and other
  servers, their security policies and quirks, and tens of thousands of monitored items are unverified. Network
  discovery reports any open OPC UA port without an OPC UA handshake, and OPC UA units (EUInformation) do not yet reach
  `_meta` or the mapping editor automatically (the source adapter supplies them; the binding engine and the tag browser
  do not ask).

- **S7 and EtherNet/IP are experimental, and no driver was verified on real
  hardware.** Modbus TCP, S7 and EtherNet/IP were checked only against in-process
  simulators written with the drivers. The ordered procedure for engineers with
  a real PLC is [Verifying on real hardware](docs/wiki/Verifying-on-Real-Hardware.md).
- **The Timebase REST API reference could not be read**, so ordering of old
  samples, the shape of a Bad sample without a value, the 500 ms resolution,
  quality codes, batch limits and tokens are unconfirmed for the direct historian
  target and for pipeline writes.
- **A pipeline historian target on an envelope topic stores the envelope as JSON
  text.** Add a `numeric` transform with `field: "v"` (the route editor offers it
  in one click). A mapping's direct historian target is not affected.
- **Retained cleanup is best effort.** Edits made while the server is down are
  not cleaned up (the owned-topic set is rebuilt at start), a clear sent while
  the target broker is disconnected is dropped, and retained value topics of a
  Sparkplug-source mapping are not known in advance.
- **MQTT, OPC UA and historian endpoints are outside the egress guard**, by
  decision (see Security above).
- **The device egress check is check-only**: a hostname is re-resolved when the
  driver connects, so a small DNS-rebinding window remains (literal IPs have
  none).
- **MQTT-topic selections on the Tags page compile to pipeline routes**, not mappings:
  no asset path, `_status`, `_meta` or direct historian target for that path.
- **Concurrent edits are last-write-wins.** Two tabs editing the same item overwrite each other.
- **Field order inside a payload cannot be changed in the editor** (the API honours the order of `target.fields`).
- A Sparkplug **host-application STATE** session picks up an edited broker profile
  only when it is started again.
- WebGL and 3D were only run on a software renderer; accessibility is checked
  automatically (axe, both themes) but not audited by hand or with a screen reader.
- Three shared components (`JsonView`, `GraphLegend`, unused `ViewTab`) still use the
  legacy class names that the Tailwind compatibility layer maps to tokens.
- See `docs/REVIEW-2026-11.md` for the full list, including defects seen while
  capturing the documentation screenshots (an overflowing large float in the device
  drawer, Sparkplug payloads as base64 in the Overview's Latest values).

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
