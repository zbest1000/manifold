# Changelog

All notable changes to Manifold are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

#### Drivers and devices

- **HTTP/JSON and MTConnect device drivers (read-only; experimental — not verified on real hardware).** HTTP/JSON polls a device's REST endpoints with
  GET only and picks values with a small JSONPath (`$.a.b[0]`, `['key']`, `[?(@.id=="x")]`), one request per path per
  cycle, ETag support, clear Bad-quality reasons (HTTP status, timeout, not JSON, no match, too large), basic, bearer or
  custom-header authentication kept out of the API and exports, TLS verified by default with CA, fingerprint pin and
  explicit opt-out, same-host redirects only and address pinning. MTConnect reads an agent (`/probe`, `/current`, then
  `/sample` from the next sequence) without gaps, resynchronises after an agent restart or buffer overflow, reads
  conditions as normal/warning/fault with native codes and uses each observation's own timestamp; no multipart
  streaming. Both can be browsed (**Import from device** / **Import from agent**) and tested from the device form.
  Drivers may now report a per-sample source timestamp, and a descriptor field of type `password` is stored, masked
  and kept on edit.
- **Matter and Z-Wave through their bridge servers (read-only; experimental — not verified on real hardware).** Two read-only subscription drivers: `matter-server`
  reads the open-source Matter Server (python-matter-server / matter.js server, `ws://host:5580/ws`) and `zwave-js`
  reads Z-Wave JS Server (`ws://host:3000`). Values are pushed as the server streams changes, with a periodic resync;
  browse lists nodes, endpoints, clusters and attributes (Matter, with names, units and scaling for the common clusters)
  or nodes, command classes and values (Z-Wave, from the value metadata). Manifold never commissions, includes,
  controls or writes anything, and the Z-Wave driver only reads the server's cache, so battery devices are never
  woken; only allow-listed read commands can be encoded and tests assert nothing else is sent. Unavailable/dead nodes
  read Bad, sleeping Z-Wave nodes keep their last value. `ws://` and `wss://` (certificate verified unless
  explicitly turned off per device), optional bearer token stored and masked like other secrets. Not verified against
  real hardware.
- **Device runtime: subscription drivers.** A driver with `capabilities.subscribe` can push samples between poll
  cycles and report a lost connection; connection state, backoff and Bad-on-disconnect stay with the runtime. A
  hand-written WebSocket client (RFC 6455, no new dependency) with frame and message caps, keepalive and no
  compression is shared by the bridge drivers.
- **BACnet/IP driver (read-only; experimental — not verified on real hardware).** Protocol `bacnet-ip`, read-only by
  construction: only unicast Who-Is, ReadProperty and ReadPropertyMultiple can be encoded (no WriteProperty, no COV
  subscriptions, no broadcast). Addresses such as `analog-input:3`, `analog-value:7/units` or
  `device:1234/object-list[0]`; every application tag decoded; quality from status-flags, reliability and
  out-of-service; requests sized to the device's max APDU without segmentation; automatic fallback to ReadProperty;
  devices behind BACnet routers (network number + MAC); devices that answer Who-Is only by broadcast or from another
  port; classified Error/Reject/Abort messages; **Import from device** over the object list with object names and
  unit text. Discovery gains an opt-in BACnet/IP probe (`bacnetPorts`). See the
  [Devices and Drivers](docs/wiki/Devices-and-Drivers.md#bacnetip) page and `server/drivers/bacnet/NOTES.md`.
- **CoAP driver (read-only; experimental — not verified on real hardware).** Poll or observe constrained IoT sensors over CoAP/UDP (port 5683): confirmable
  GET with the RFC 7252 retransmission, separate responses, deduplication, Reset handling, block-wise responses (RFC 7959),
  Observe (RFC 7641) with in-order notifications and re-registration, text, JSON, CBOR, SenML (JSON and CBOR, with units)
  and link-format bodies, tag addresses of the form `[observe:]/path[?query][#selector]`, and browsing of
  `/.well-known/core`. Only GET is ever sent. **DTLS (`coaps://`) is not supported** and is refused with that reason.
  Discovery gains an opt-in CoAP probe (one unicast GET `/.well-known/core` per address). Verified only against a
  simulator; see `server/drivers/coap/NOTES.md`.
- **SNMP driver (read-only; experimental — not verified on real hardware).** Read-only SNMP v1, v2c and v3 (USM) over UDP 161,
  BER and USM written in-house with Node's built-in crypto: authentication MD5, SHA-1, SHA-224/256/384/512,
  privacy DES and AES-128, engine-ID discovery, boots/time synchronisation with the time-window check, and named
  errors for every USM report (unknown user, wrong digest, decryption error, unsupported level). Only Get, GetNext and
  GetBulk exist; a SetRequest cannot be encoded. Tags are numeric OIDs or well-known names (`sysUpTime.0`,
  `ifHCInOctets.1`, `hrProcessorLoad.N`, UPS-MIB ...); every SMI type is decoded (Counter64 as a decimal string,
  OctetString as text or hex, Opaque float/double), the v2 exceptions are Bad with the reason, and `rate: true` turns a
  counter into a per-second rate with wrap and agent-restart handling. Requests are batched by count and estimated
  response size, split on tooBig (the size is remembered), and v1 error-index answers drop only the failing OID.
  **Import from agent** walks a subtree with GetBulk, bounded in rows and time. The community and v3 passwords
  are stored server-side and never returned by the API (blank on edit keeps them; switching version drops unused ones); export and the audit log redact
  them. Discovery gains an opt-in **SNMP agents** probe (one v2c `public` Get per address). The UDP socket lives in
  `server/drivers/runtime/udpTransport.js`: pinned literal address only, the egress policy re-checked in the driver
  process, answers from other addresses refused unless allowed per device. Docs:
  [Devices and Drivers](docs/wiki/Devices-and-Drivers.md#snmp), `server/drivers/snmp/NOTES.md`.
- **`POST /api/devices/bulk`** creates up to 200 devices all-or-nothing; the profile bulk table and Discovery's
  **Add all** use it. The device form's **Advanced** section edits Modbus unmapped register ranges and per-device
  process isolation. Recordings can be paused and resumed.
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
- **Device metrics on `/metrics`:** `manifold_device_up`,
  `manifold_device_connects_total`, `manifold_device_requests_total`,
  `manifold_device_timeouts_total`, `manifold_device_exceptions_total`,
  `manifold_device_cycle_ms`, `manifold_device_overruns_total`,
  `manifold_device_quarantined_tags`, `manifold_driver_host_up`,
  `manifold_driver_host_restarts_total`, plus
  `manifold_binding_suppressed_total` and `manifold_binding_errors_total`.
- **Demo stack: simulated devices.** `server/tools/simulators.js` runs the Modbus,
  S7 and EtherNet/IP test simulators with changing values; the compose file gains
  a `device-sim` service, and the demo seed includes three devices and two
  bindings for the Modbus device: per-tag topics under `demo/plant1/pump1/` (a
  legacy `pathTemplate`) and one object under `demo/plant1/pump1-object`
  (`assetPath` with `object-per-asset`). See DOCKER.md.

#### IoT over MQTT

- **IoT devices over MQTT** (Devices → IoT over MQTT; experimental — not verified on real hardware): Zigbee2MQTT, Z-Wave JS UI, Home Assistant MQTT discovery,
  Tasmota, Shelly (Gen1 and Gen2+), ChirpStack v4 and The Things Stack v3 traffic on a connected broker shows up as
  devices with named tags, units, types, ranges and allowed values instead of raw topics, labelled by convention and
  "via broker". Detection is opt-in per broker and convention, with suggestions when matching traffic is seen.
  Values carry quality (offline availability -> Bad, missing attribute -> Uncertain) and the payload's source time.
  The devices are a mapping source in the Tags workspace (`source.type: "iot"`) with the metadata pre-filled; renames
  keep identity where the convention has a stable id. Home Assistant value templates go through a small safe
  evaluator (no code is executed). Read-only by construction: Manifold never publishes to these ecosystems' command,
  set or downlink topics, and does not pair or control devices. Bounded (devices/tags per broker, payload size, JSON
  depth); hostile payloads are counted and skipped. Not verified against real hardware: tested against a simulator
  (`server/test/support/iotMqttSimulator.js`). API `/api/iot/*`, MCP `iot_devices`. See the wiki page
  [IoT devices over MQTT](docs/wiki/IoT-Devices-over-MQTT.md).

#### Alerts

- **Alerts page** (Observe → Alerts): active alarms, their history, and the alert rules in one place.
  - **Active**: everything firing now (one alarm per concrete topic for wildcard value rules) and value rules
    breached inside their sustain time, sortable, with severity and a duration that ticks. **Acknowledge** one
    alarm or several at once, with an optional note; the acknowledgement records who (the token's name, or
    `operator` on an open server) and when, holds until the alarm clears and never silences a new occurrence.
    The sidebar item counts unacknowledged critical alarms. Phone layout uses cards.
  - **History**: every firing, resolution, acknowledgement and end, kept across restarts in
    `data/alerts.jsonl` (two size-capped segments, `MANIFOLD_ALERT_HISTORY_MAX_BYTES`, default 8 MiB; written in
    the background; a line torn by a crash is skipped). Filters for text, rule, state, severity and time range,
    paged, CSV export of every match.
  - **Rules** moved here from Settings (Settings links to them; `/settings?tab=alerts` redirects). Rules gain a
    **severity** (info, warning, critical).
  - The Overview's Needs attention links each firing or breached rule to its alarm.
- `GET /api/alerts/active`, `POST /api/alerts/ack`, `GET /api/alerts/history` (cursor, filters, `format=csv`).
  MCP: `alerts_active` and `alert_history`; `alert_rule_save` takes `severity` and value-threshold rules.
- Prometheus: `manifold_alerts_active{state,severity}`, `manifold_alerts_unacknowledged{severity}`,
  `manifold_alert_transitions_total{state,severity}`, `manifold_alert_history_bytes`,
  `manifold_alert_history_write_errors_total`.

#### Brokers and MQTT

- **Broker canary (opt-in).** A per-broker round-trip probe: Manifold publishes a small, never-retained message
  to a canary topic (default `manifold/canary/<id>`, QoS configurable), receives it through its own subscription
  and measures publish-to-deliver latency. Success rate, p50/p95 and time since the last success over a rolling
  window; states ok, slow, failing and not permitted (the broker refused the canary subscribe or publish, and the
  details say which). **Off by default and the form says it publishes.** Shown in the broker list and a new broker
  details drawer, in `/metrics` (`manifold_broker_canary_*`), in Overview "Needs attention" when failing or not
  permitted, and by the MCP tool `mqtt_broker_canary`. Canary traffic is taken out before the topic store, so it
  never reaches the topic tree, UNS, recordings, pipelines, mappings, alerts or message counters. It follows broker
  edits and is removed with the broker.
- **Security posture per broker.** A read-only assessment from what Manifold already knows (nothing is probed):
  TLS and certificate verification, certificate days left, anonymous or authenticated, password over plaintext, a
  root wildcard subscription, MQTT version, client-id collisions and reconnect storms, `$SYS` readable. Findings
  are listed worst first with severity, an explanation and what to change; no score. A compact summary in the
  broker list, details in the broker drawer, `GET /api/mqtt/brokers/:id/posture`, `manifold_broker_posture_findings`
  in `/metrics`, and the MCP tool `mqtt_broker_posture`.
- **Public test-broker presets** in "Connect a broker" (EMQX public with and without TLS, HiveMQ public, Mosquitto
  test) with a plain warning that they are public (host names and ports written from memory, not checked against the operators' current documentation). They subscribe to `testtopic/#`, not `#`. When a broker's ACL
  refuses a root wildcard, the intake now falls back `#` to `+/#` to `+/+/#` and reports what was granted (log,
  toast, the Subscription column and the details). `mqtt_list_brokers` carries `posture`, `canaryState` and
  `intake`; new MCP tool `mqtt_broker_presets`.
- Optional idle-topic eviction, a `topic-cap-reached` event, and a
  `sparkplugCoalesced` broker metric.

#### Codecs

- **Payload codecs for MQTT.** Non-JSON payloads are decoded on ingest, so topics, Trends, mappings, routes and
  recordings see values: hand-written CBOR (RFC 8949), MessagePack (timestamp extension included) and SenML
  JSON/CBOR (RFC 8428, resolved into records), plus Protobuf and Avro against a schema you attach to a topic filter
  (Protobuf decoded through protobufjs reflection, never generated code; Avro binary decoded by hand with logical
  types and an optional single-object header). Binary CBOR and MessagePack without a binding are auto-detected only
  when the bytes leave no doubt; text, JSON and undecodable binary stay exactly as before. A new **Codecs** tab under
  Pipelines lists the bindings with decoded and failed counters, compiles schemas on save (clear parser errors, 128 KiB
  cap), and has a test box; the topic details name the codec that decoded a payload. Decoding is bounded (256 KiB,
  32 levels, 100,000 items) and a failure never blocks ingest. 64-bit integers stay exact (decimal strings).
  API `/api/codecs`; MCP `codecs_list` and `codec_test`. See [Pipelines and Models](docs/wiki/Pipelines-and-Models.md#codecs--payloads-that-are-not-json).

#### Trends and historians

- **Trends CSV export** of the shown tags and range, as charted (bucketed) or raw samples: ISO 8601 UTC times, a value
  column per tag with its unit and a quality column, gaps and Bad samples kept, the mode stated in the file name and
  header comments. Streamed from the server (`GET /api/trends/export.csv`) for recordings, historians (TimescaleDB,
  InfluxDB, Timebase) and the live buffer, with a row cap.
- **Historian outbox:** segmented spill with an atomic cursor, a dead-letter file
  for permanently rejected points, and strict oldest-first delivery that live
  traffic cannot overtake.
- **Trends from local recordings.** The Trends page can chart a file recording
  directly (server-side downsampling), with no external historian required.

#### Mappings and tags

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
- **MQTT topics as a mapping source** (`source.type: 'mqtt'`): picked topics or every topic under a filter
  (include / exclude rules, topics that appear later picked up, at most 2000), one value per topic from a field path
  or a `{v,t,q,u}` / `{value,timestamp,quality,unit}` envelope read automatically, names that keep the topic levels,
  the broker connection as source state, per-topic staleness (`staleAfterMs`: Bad with reason `stale` once), the
  newest stored message published when a mapping starts, and every mapping feature (asset path, per-tag settings,
  context, `_meta`, `_status`, quality, deadband, Sparkplug or historian output, preview, suggest, schema). **Loop
  safety**: a target that could match the source on the same broker is refused at save (shown in the editor),
  `loop-risk` warns about cycles across mappings, and at run time a mapping ignores its own publications and a
  hop guard shared with the pipeline engine stops mapping and pipeline cycles.
- **Migration of old topic routes**: routes the old Tags page created for MQTT topics are listed with the equivalent
  mapping and what changes (`GET /api/tags/bindings/migrations`) and replaced after review
  (`POST /api/tags/bindings/migrate { routeId, mapping, route: 'disable' | 'delete' }`).
- **Retained cleanup that survives restarts**: the retained topics each mapping owns are recorded in
  `<data dir>/binding-retained.json` (atomic, corruption tolerant, bounded, not in the config export); orphans are
  cleared once their broker is connected, also after a crash or an edit made while the server was down.
  `GET` (dry run) / `POST { dryRun: false }` `/api/tags/bindings/cleanup-retained` and **Clear orphaned retained
  topics** on the Mappings tab, which shows what it would clear first.
- **Why is nothing publishing?** `GET /api/tags/bindings` returns `health` per mapping (state and plain-language
  reasons with fixes); the Mappings table shows it, including **Source missing** when the device, profile, OPC UA
  connection or broker is gone.
- **Mapping editor**: payload field order (arrow buttons, keyboard on the handle, drag; reflected in the preview and
  saved); CSV import of mapping rows for every source (template download, per-line errors) and CSV export; the
  stale-edit dialog (keep mine, take theirs, cancel) and a warning when the mapping is open in another tab;
  disambiguating paths for same-named tags in the selection and the table; tag details take where a value comes
  from from the server's preview; a save asked for during the server check goes ahead when it answers.

#### UNS and canvases

- **UNS map Expand all / Collapse all** (breadth first, one page per long branch, capped at 2,500 nodes on the map) and a
  **search box whose results can be picked** with the keyboard (arrows, Enter, Escape; announced to screen readers) to
  select and reveal a node, on the UNS map and on the Topics, OPC UA and i3X graphs.
- **Canvas rendering overhaul.** One shared kit (`client/src/graph/canvasKit.js`) for DPR-correct sizing, one camera
  transform for drawing and picking, a frame scheduler that idles at about one frame per second and stops while
  hidden, label level of detail, WebGL context-loss recovery; canvas themes derived from the tokens and switched in
  place; a validated ten-colour data palette; graph styles Standard, Schematic and Monochrome; deep links
  `/uns?broker=&path=` and `/topics?broker=&topic=` that select and centre reliably.

#### Discovery

- **Discovery of devices (opt-in).** The scan can look for Modbus TCP (502), S7
  (102) and EtherNet/IP (44818) devices (`includeDevices: true`, or explicit
  `modbusPorts`, `s7Ports`, `eipPorts`). Each port gets one read-only
  identification probe built with the drivers' own frame encoders; the Discovery
  page has "Find devices" and "Add as device". Loopback targets are always
  refused by the scan.

#### Interface

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
- **Read-only sessions** show disabled controls with the reason and a short note instead of 403s; Settings has a
  Session card with **Sign out / use a different token**.
- **Functional QA pass over Tags, Devices, Discovery, Pipelines, OPC UA, CESMII, i3X and Settings.**
  `POST /api/devices/bulk` creates devices all-or-nothing (every row validated first, per-row errors
  on failure) and both bulk dialogs use it; device names are unique; a device the driver could never
  run (bad options, S7 without rack/slot) is refused at save time; the device form has an Advanced
  section for Modbus unmapped register ranges and per-device process isolation; Tags says plainly
  that MQTT-topic tags become pipeline routes (since superseded: MQTT topics now create mappings, see the mapping entries above); a historian route from a `{v,t,q}` topic offers the
  numeric-on-`v` transform; bindings link to the UNS page (`/uns?broker=&path=`); viewer sessions
  see disabled controls with the reason instead of 403s; Settings shows the session and can sign out.
  Fixes: historians still used by a route, recording or binding can no longer be deleted; pipeline,
  model and recorder topics are validated; a stale inferred contract could be locked under another
  topic; the OPC UA form left a ghost "connecting" row after a refused connection; Discovery offered
  to connect brokers that were already connected; importing the same config file twice did nothing.
- **UI shell.** A navigation drawer below the `md` breakpoint, AA contrast
  tokens, a global focus ring, shared dialog, table and form primitives, lazy
  routes with a skeleton fallback (smaller initial bundle), an ESLint config for
  the client, a dark UNS canvas with the Sparkplug namespace labelled as such,
  one topic counter and one ingest-rate source for Overview, Topics and UNS.

#### Platform, security and operations

- **CPU and host metrics** in `/metrics`: `manifold_process_cpu_seconds_total` (user/system),
  `manifold_host_load_average`, `manifold_host_cpus` and `manifold_host_memory_bytes` (carried over from PR #45).
- **Profile store:** fsynced writes, rotating backups (`profiles.json.bak.1` to
  `.5`), and recovery from the newest valid backup. Config export and import now
  cover devices and device profiles, and import is validated whole.
- **Audit log rotation** (`MANIFOLD_AUDIT_MAX_BYTES`, `MANIFOLD_AUDIT_KEEP`).
- **New settings:** `MANIFOLD_ALLOW_LOOPBACK_DEVICES`, `MANIFOLD_METRICS_PUBLIC`,
  `MANIFOLD_AUDIT_MAX_BYTES`, `MANIFOLD_AUDIT_KEEP`, `MANIFOLD_SPARKPLUG_QUEUE_MAX`,
  `MANIFOLD_SPARKPLUG_QUEUE_BYTES`, `MANIFOLD_TOPIC_IDLE_TTL_MS`,
  `MANIFOLD_MAX_MSG_PROPS`.
- **System (Health) page.** Renders Manifold's own Prometheus `/metrics` in the
  browser — process health (uptime, memory, event-loop delay), per-broker
  ingest rate and topic counts, and every engine counter — each with a rolling
  sparkline and amber thresholds.
- **Egress guard.** One chokepoint for the network scanner and the outbound
  HTTP clients (i3X, CESMII, broker admin): loopback, cloud-metadata
  link-local, multicast, and reserved ranges are always blocked; RFC1918/LAN
  targets require `MANIFOLD_ALLOW_PRIVATE_TARGETS=1`.
- **Security headers and a general rate limit** (`helmet` + `express-rate-limit`)
  on the API, plus `GET /api/whoami` so the UI can show a read-only badge.

#### Testing

- **OPC UA is tested against a real server.** `node-opcua` (devDependency only) backs
  `server/test/support/opcuaTestServer.js`: every scalar type, arrays, structures, engineering units and ranges,
  controllable status codes and source timestamps, None/Sign/SignAndEncrypt with anonymous and user name logins,
  restarts, outages, server-side session close and subscription deletion, slow reads, session limits and certificate
  rejection both ways. Integration tests cover the manager, the tag bindings (envelope quality, Bad on loss, Good on
  recovery, typed Sparkplug metrics), the HTTP routes, UNS mounts and discovery; the UI e2e drives the OPC UA page, the
  trust step, a server restart, mapping from the Tags page and a UNS mount live.
- **UI test suite and linting.** Playwright projects desktop, hidpi (device pixel ratio 2) and mobile; every route is
  loaded in both themes at 1440 and 390 px and fails on serious or critical axe findings, horizontal overflow and
  console errors; functional specs for devices, profiles, outage and recovery, mapping, pipelines, settings, auth and
  OPC UA. ESLint runs for server, client and mcp in CI.

#### Docs

- **Documentation screenshots are generated.** `npm run docs:shots` (in `client/`, after `npm run build`) starts a demo
  plant from the test simulators and the real backend, seeds it through the API and captures every image in
  `docs/wiki/images/` (and the copies in `site/assets/`) with Chromium; `--only`, `--out`, `--serve` and `--attach`
  re-capture single images. All images were regenerated from the current UI, and the OPC UA page has a new one
  (`opcua.png`).
- New wiki pages **Devices and Drivers**, **Mapping to the UNS** and **Verifying
  on real hardware** (one ordered checklist for Modbus, S7 and EtherNet/IP), and
  a design document for the drivers (`docs/design/southbound-drivers.md`).
- **Documentation for the new drivers, IoT over MQTT, alerts, broker tools and codecs.** Devices and Drivers is one
  table of every driver, a common section and one section per driver in the same shape; Matter and Z-Wave have their
  own page (Bridge servers); Verifying on real hardware has a checklist per driver and for the IoT conventions;
  Troubleshooting covers the new drivers, IoT detection, codecs and the canary. The screenshot script seeds the new
  simulators, a facilities broker with IoT traffic, codec payloads and firing, acknowledged and cleared alarms; new
  images `alerts`, `alerts-history`, `broker-details`, `codecs`, `iot-devices` and `uns-search`, all others regenerated.

### Changed

#### Drivers and devices

- **A device saved without limits runs with its driver's default limits** (`describe().limits`), not the runtime's
  generic 2 s request deadline: CoAP needs 10 s for its retransmissions, BACnet/IP its APDU timeout times retries.
  Devices stored earlier get the same defaults when they start.
- **One rule for device secrets, for every driver.** A secret is a descriptor field of type `password` (HTTP/JSON and
  MTConnect passwords and tokens, the SNMP community and v3 passwords). The API answers a stored secret as `null`
  (it used to be `********` for the HTTP drivers), in every device answer including the `409` conflict body; an edit
  that leaves it out, blank or `null` keeps the stored value (same protocol only), and a secret the settings no longer
  use is dropped. Conditional fields use one `showWhen: { field: [values] }` form.
- **One URL-device model** for the HTTP (HTTP/JSON, MTConnect) and WebSocket (Matter Server, Z-Wave JS) drivers:
  the same fields `scheme`, `path` (the HTTP drivers' `basePath` is now `path`), `authToken` for a bearer token and
  `tlsInsecure` / `tlsCa` / `tlsFingerprint256`, and one helper for the pinned address, Host/SNI and TLS options
  (`server/drivers/common/urlTarget.js`). The bridge drivers gain certificate fingerprint pinning.
- Pasting a URL such as `ws://ha.local:5580/ws` or `https://meter.local:8443/api` into **Host** fills scheme, host,
  port and path for URL-based drivers. **Test connection** shows readable labels (*Nodes*, *API schema*) instead of
  field names.
- The device page's import button names what it reads: **Import from controller** (EtherNet/IP), **Import from
  device** (HTTP/JSON, BACnet/IP, CoAP), **Import from agent** (MTConnect, SNMP), **Import from server** (Matter, Z-Wave).
- **Device live values** reach the browser as **one `device-values` Socket.IO event per 250 ms flush** carrying every
  touched device (`{ batch: [{ deviceId, values }] }`), delivered reliably when the flush contains a quality change.
  Per-device volatile emits delivered only the first device's values.
- *Operator-visible:* **Device targets** pass the egress guard: private ranges need
  `MANIFOLD_ALLOW_PRIVATE_TARGETS=1`, loopback needs
  `MANIFOLD_ALLOW_LOOPBACK_DEVICES=1`.

#### Alerts

- **Alarms active when the server stops are closed as "Ended by restart"** on the next start, and fire again from
  live data if the condition still holds (the engine re-derives state from live data; nothing is restored as
  firing). Deleting or disabling a rule ends its active alarms immediately instead of leaving them open.
- Acknowledgements and restart bookkeeping are not sent to rule webhooks; firings and resolutions still are.
- *Operator-visible:* **Alert webhooks pass the egress guard.** Webhooks to `localhost`, link-local
  and (without `MANIFOLD_ALLOW_PRIVATE_TARGETS=1`) private addresses are refused.

#### Brokers and MQTT

- The `$SYS/#` subscription no longer reports a refusal as an error (public and managed brokers commonly refuse it).
- *Operator-visible:* A subscribe that fails for a reason other than a SUBACK refusal is retried
  (three times, exponential backoff).
- Per-topic MQTT payloads are capped (`MANIFOLD_MAX_PAYLOAD_BYTES`, default
  256 KB); the live socket stream is backpressure-safe; historian HTTP calls
  have a hard timeout; Postgres/Timescale TLS verifies certificates by default.

#### Trends and historians

- *Operator-visible:* **Historian spill layout changed** to segment files plus a cursor under
  `outbox/`. A legacy `<id>.jsonl` is still read first and drained; no conversion
  is needed. Permanently rejected points go to `<id>.deadletter.jsonl`.
- *Operator-visible:* **InfluxDB value typing is stricter:** only real numbers (and plain decimal
  strings) write `value`; booleans and everything else write `raw` as text
  (booleans were `1`/`0` before); `null` is skipped and counted; names with
  control characters are rejected. InfluxDB stores no quality, so it is not
  offered for device data.

#### Pipelines

- *Operator-visible:* **Pipeline, recorder and historian timestamps and quality** come from the
  payload when it carries them (TVQ envelope `t`/`q`, Sparkplug timestamps and
  the metric `Quality` property) instead of always being arrival time and Good.
  Pipelines and the recorder ignore a source time before 2000-01-01 or more than
  24 hours ahead and use arrival time. Sparkplug-source bindings use the metric's
  own time and quality without that window.

#### Mappings and tags

- The MCP `binding_save` tool accepts `device` and `device-profile` sources and the new selection and context options.
- A failed retained `_meta` or `_status` publish is retried on a 15 s timer; a plain mapping with a direct historian
  target records the Bad sample on source loss; Sparkplug-source mappings use the timestamp plausibility window.
- *Operator-visible:* **Bindings publish more:** a quality-only change publishes (envelope format),
  an offline source publishes Bad, and `<path>/_status` is retained. The bind
  wizard now leaves **retain off** by default.

#### OPC UA

- *Operator-visible:* **OPC UA:** a lost or never-established saved connection is retried forever
  (1 s to 60 s, jittered) and monitors are rebuilt; socket value updates are
  coalesced to 100 ms; `publish-success` socket events are summarized (a leading event, then at most
  one summary per broker per second).

#### Discovery

- **One UDP mechanism for discovery.** BACnet/IP (`bacnetPorts`) and CoAP (`coapPorts` / `includeCoap`) probes share
  one design: each UDP kind is opt-in on its own (`includeDevices` never adds one), unicast only, one job per
  host, port and kind under the same concurrency and per-host limits, cancellable, and counted in the plan's worst case
  with its own bounded wait. Plans and scan events report `udpPorts` (and `tcpPorts` in the plan); `ports` lists every
  port number. A configured device marks a result as already added only on the same transport (UDP or TCP).
- The SNMP discovery probe (`snmpPorts` / `includeSnmp`) is the third kind of the shared UDP discovery mechanism.

#### Sparkplug

- *Operator-visible:* **The Sparkplug publisher honours the broker profile:** TLS material
  (`ca`, `cert`, `key`, `rejectUnauthorized`), WebSocket path, MQTT version and
  credentials, and an edge-node session is rebuilt when its broker profile is
  edited.
- *Operator-visible:* **Sparkplug messages are delivered in order and un-coalesced** (bounded queue,
  overflow counted). They reach consumers at flush cadence, up to 100 ms later.

#### Platform, security and operations

- **Saving is stricter.** Device names are unique and may not contain control or bidi characters; a device the
  driver could never run (bad options, S7 without rack and slot) is refused at save time; pipeline source filters and
  `repath` targets, model targets and recorder filters are validated as MQTT topics; a historian that a route,
  recording or mapping uses cannot be deleted (409 naming them).
- **Viewers** may also call mapping preview, name suggestions and CESMII history (read-only POSTs).
- *Operator-visible:* **A viewer token alone now enables auth**, which leaves no admin: also set
  `MANIFOLD_AUTH_TOKEN` or an admin entry in `MANIFOLD_TOKENS`.
- *Operator-visible:* **Unknown roles in `MANIFOLD_TOKENS` are rejected** instead of becoming admin.
  A token containing `:` needs an explicit role (`name:ab:cd:viewer`). If tokens
  are configured but all rejected, auth stays on and every request is 401.
- *Operator-visible:* **`/metrics` requires a bearer token** (any role) when auth is on. Set
  `MANIFOLD_METRICS_PUBLIC=1` to keep it open for an anonymous scraper.
- *Operator-visible:* **Imported configuration applies immediately** (bindings are reconciled and
  devices re-applied) instead of at the next restart.
- *Operator-visible:* **Viewers may call the binding preview** (a read-only POST) and still cannot
  see alert webhook URLs in the rule listing.
- *Operator-visible:* **Viewers** can call a short list of read-only POSTs (historian query, pipeline
  preview, subscription resolve, schema inference, device tag validation, i3X
  reads) and no longer see alert webhook URLs.
- *Operator-visible:* **Audit:** rejected requests (401, 403, 429) are recorded, query strings are
  dropped from paths, and the file rotates by size.
- *Operator-visible:* `profiles.json` is written asynchronously (coalesced) with fsync; pending
  writes flush on shutdown.
- **Fail closed by default.** With no auth token, the server now binds
  `127.0.0.1` only; exposing an unauthenticated instance off-host requires
  `MANIFOLD_HOST=0.0.0.0`. The Docker demo maps to host loopback only.
- Socket.IO auth now shares the REST brute-force throttle and audit trail (both
  entry points enforce auth and rate-limit failures identically).
- The built client is served whenever `client/dist` exists (no longer gated on
  `NODE_ENV=production`).

### Fixed

- **Topics graph: a drag no longer drops when data changes underneath it.** A new topic arriving mid-drag rebuilt the
  layout with fresh node objects, so the node stopped following the pointer and lost its pin; and a refresh in the
  drag's first frame left the layout stopped for the whole drag. The drag now follows the node by id and the layout
  stays warm while it lasts.
- **UI audit:** a wildcard alert rule firing on several topics reads "Firing on N topics · M unacknowledged" on the
  Overview; IoT detection collapses to one line once set up so the device list is on the first screen; text fields show
  one focus ring instead of two; Active alarms fit at 1440 px and use cards below 1280 px; closed tooltips no longer
  widen tables into a sideways scroll; long IoT device names truncate on phones; state words are in sentence case
  everywhere; optional-field labels read "(advanced, optional)"; two accessibility defects (a control nested in a sort
  button, a button whose name did not match its text) are fixed.

#### Drivers and devices

- **DNS re-resolution window for device targets closed.** The validated address is passed to the driver host and
  connected to directly; names are re-validated on host restart and every 30 s, and a name that turns blocked
  takes the device offline with the reason.
- Driver-host robustness is covered by tests (synchronous `createDriver` throw, a `connect()` that never settles,
  SIGKILL mid-request, isolated devices, staggered connects, no child left after shutdown); a parked host now says so
  on each of its devices.
- A tag going Bad could be dropped by a lagging client and leave a stale Good in the UI (the flush now goes reliable).
- A refused or quarantined device tag now reaches the device status: `lastError`
  reads `tag <key>: <reason>` (for an S7 CPU with PUT/GET off, the PUT/GET hint),
  `quarantineReasons` lists code, message and time per tag, and `lastErrorAt` is
  set. Before, only Probe showed the cause.
- Controller browse returns an address for folder nodes, and an EtherNet/IP
  STRING is browsed as a value, not as members.

#### Alerts

- **Alert rules expose real state** (`idle | breached | firing | disabled | broken`, countdown to firing, value,
  last transition, webhook health) instead of the UI guessing from events.
- Alert webhooks no longer follow redirects unchecked, and IPv6 forms that embed
  an IPv4 address are classified by the embedded address.
- Wildcard value-threshold alerts keep independent state per concrete topic
  (a normal reading on one topic no longer suppresses a real breach on another).
- **Alerts History fits at 1440 px.** A long acknowledgement note pushed the Detail column out of view behind a
  horizontal scroll and squeezed rule names; the detail now wraps to two lines.

#### Brokers and MQTT

- **Duplicate broker connections** are refused with a `409` naming the existing one (identity: protocol, host,
  port, WebSocket path, user, subscribe filter).
- The MQTT 5 property table and topic slots are bounded; `monitor()` no longer
  creates duplicate OPC UA subscriptions under concurrent calls.

#### Trends and historians

- InfluxDB line protocol: a newline or trailing backslash in a topic can no
  longer inject or escape lines, and `""` / `null` no longer write `value=0`.
- A permanently rejected historian batch no longer blocks the spill head-of-line;
  the spill is no longer rewritten non-atomically or read whole per batch, and a
  crash mid-write no longer loses it.
- Edited credentials take effect: the PostgreSQL pool cache is keyed by the whole
  connection config. `updateBroker` validates before tearing the old connection
  down.

#### Pipelines

- **Pipeline counters no longer lie for historian targets.** Routes report routed, delivered, pending and rejected
  (also on `/metrics` and in the engine-metrics payload); the Routes and Historians tabs explain the split.

#### Mappings and tags

- Mappings: a Sparkplug-source mapping ignored DEATH certificates (the tags kept their last good value, no
  `_status`), and per-metric quality from the `Quality` property was taken only when it was exactly 0 or 64; the
  editor computed where a tag setting comes from on the client (capped preview); MQTT-topic selections bypassed the
  mapping engine entirely.
- A binding created or edited while its source is already online now publishes
  `_status` immediately instead of at the next state change.
- A Good-to-Bad quality change with an unchanged value is no longer suppressed,
  and Sparkplug numbers are no longer all encoded as Double.
- **IoT mappings name their source.** The Mappings table showed an IoT-over-MQTT mapping's raw device id and
  "(not connected)" while it was publishing.
- The Tags hint reads "add to UNS" (it lowercased the whole button label), and the mapping editor's Limits helper
  no longer says Manifold raises no alarms: Manifold's alert rules exist and do not read limits.

#### OPC UA

- **OPC UA library updated to 2.187** (was held at 2.182). Newer servers answer an untrusted client certificate
  with the generic `BadSecurityChecksFailed`; that error now says the server most likely does not trust
  Manifold's client certificate and what to do about it.
- **Reopening an OPC UA mapping shows the server's unit, description and range.** The tag details said *from server*
  over empty fields because a stored OPC UA mapping keeps no browse metadata; the placeholders now take the values the
  server's preview reports for the tag.
- **OPC UA discovery is verified.** A scan answers an OPC UA candidate with a real GetEndpoints over a security
  None channel (no session, bounded, cancellable) and reports the application name and URI and the security modes,
  policies and user tokens offered. A listener that does not answer the UA-TCP Hello is no longer a result; one that
  answers the Hello but not GetEndpoints shows as *Not confirmed* with the reason.
- **OPC UA units, ranges, descriptions and types reach mappings.** Read from the server once per connect (bounded,
  batched, off the sample path) and merged below the mapping's own settings; `_meta` and Sparkplug BIRTH are
  republished when they change; the preview reports origin `server` (*from server* in the editor); the Tags browse
  shows type and unit for OPC UA variables.
- **Exact duplicate OPC UA connections are refused** (`409 { code: "duplicate", existing }`; identity: normalised
  endpoint URL, security mode and policy, user name), inline in the connection form. `PUT /api/opcua/connections/:id`
  honours `rev` / `If-Match` with the shared conflict dialog. A refused first connect is reported once (no second
  toast). The connection list refreshes from the store on reconnect, monitor and error events.
- **UNS mounts of an OPC UA server** are walked on the server (`GET /api/uns/mounts/:id/tree`): one batched browse per
  level, at most 50 children per node, 400 nodes and 8 s, instead of one browser request per node.
- **OPC UA against a real server**: node-opcua's implicit session repair fought the supervisor after a server-side
  session close, so values arrived twice; stopping a value on the OPC UA page (or just selecting another node) deleted
  the monitored item a tag binding depended on; the certificate to trust never appeared in the connection form after a
  refused secure connect; trust errors named REST endpoints instead of what to do. The page now shows which values are
  still monitored and when they are stale, names instead of truncated node ids, and Bad quality on the tree nodes.
- OPC UA bindings no longer go silent after a restart, an edit or a delete, and a
  dropped OPC UA connection is no longer given up on after a few retries.

#### UNS and canvases

- **A slow double-tap on the UNS map** no longer selects the node (and opens the details panel) between the taps.
- Canvas defects: canvases sized in px stopped their flex container from shrinking; the UNS ran at 60 frames per
  second forever; the Topics graph re-heated its layout on every click; WebGL had no context-loss handling and drew a
  2,000-child branch as a giant disc; the 3D camera sat inside the layout; charts drew outages as straight lines and
  clipped y labels; deep-link centring drifted as topics streamed in.
- The graph auto-fits to the viewport on first load; canvas interaction no
  longer captures stale callbacks after switching servers or styles.
- **UNS node details stay current.** The panel kept the node of the moment of selection, so a node selected by a deep
  link right after load showed its first, smaller topic count.

#### Sparkplug

- **Sparkplug sessions follow broker profile edits**: a running host STATE session was only rebuilt when `startHost`
  was called again, and an edited edge-node session was dropped without NDEATH. Both now publish a clean offline STATE
  or DDEATH/NDEATH on the old connection and reconnect with the new settings on their own; a removed profile ends them
  cleanly.
- Sparkplug DATA messages are no longer lost to per-flush coalescing (the
  registry, bindings, pipelines and historian targets see every message).
- Sparkplug alias-only DATA metrics resolve to their BIRTH names instead of
  collapsing into an empty-name key; the registry is bounded against untrusted
  traffic.

#### Interface

- **Overview Connections and Pipelines Routes fit at 1440 px.** The Connections table cut off its State column
  and the Routes table hid its row actions behind a horizontal scroll; both now fit, truncating long names.
- **Overview "Needs attention"** lists routes and historians with rejected points or a growing backlog, alert rules
  firing or breached, mappings that are not publishing (with the reason) and broken references
  (`GET /api/system/broken-references`), each linking to the fix.
- The **Tailwind compatibility layer is removed**: only the semantic tokens exist, and a unit test fails on legacy
  class names.
- A stale inferred contract could be locked under another topic; the OPC UA form left a ghost "connecting" row after a
  refused connection; Discovery offered to connect brokers that were already connected; importing the same config file
  twice did nothing.
- A bare `#` topic filter now matches every topic in the UI (Consumer coverage).

#### Platform, security and operations

- **Concurrent edits are no longer last-write-wins.** Every stored object has a `rev` and `updatedAt`; a save that
  sends `rev` (body field or `If-Match`) against a newer stored object gets `409 { code: "stale", current }`
  (secrets redacted); no `rev` keeps the old behaviour. Devices, profiles, brokers, routes, models, historians,
  recordings, contracts and alert rules show a *changed elsewhere* dialog (Keep mine / Take theirs / Cancel).
- **Dangling references** are rejected on save (`400`), deleting a used broker is refused (`409` naming the users),
  and objects with a lost reference show as *Broken reference*.
- Config export no longer blanks device tag keys: arrays named `tags` and
  `ownTags` keep their `key` identifiers, while a secret inside a tag or a key
  anywhere else is still masked.
- Config export no longer leaks webhook URLs; `cert` fields are redacted from the
  audit log.
- `profiles.json` is no longer rewritten without fsync, and a corrupt file is
  recovered from a backup instead of starting empty.

#### Carried over from older pull requests

- **Fixes carried over from the older pull requests #62 and #45**, re-applied on the current code:
  - **Sparkplug signed integers** (Int8/16/32/64) are read back from their unsigned two's-complement wire form
    instead of arriving as huge positive numbers (-5 was 4294967291), in metrics, properties and DataSet cells. DATA
    messages that omit the datatype (as Sparkplug 3.0 recommends) take the one their BIRTH declared.
  - **File recordings roll over at their size cap** (two segments, newest kept) instead of stopping for good; reads,
    Trends series and replay span both segments. An empty payload no longer records as 0.
  - **Alerts:** a firing value alarm dropped at the 5000-topic tracking cap is resolved (with the reason) instead of
    left as a phantom.
  - **Schema contracts** check own properties: keys such as `toString` or `__proto__` no longer escape drift checks.
  - **MQTT 5:** a publish without a properties block clears the topic's previous properties.
  - **Models:** the TVQ envelope (`envelope`, `staleMs`) is persisted by `POST /api/models` and offered in the model
    editor and the MCP `model_save` tool; the engine supported it but the option could not be switched on.
  - **Discovery** probes OPC UA port 50000 (opc-plc) as well as 4840 by default.
  - **2D graph:** nodes can be dragged again (zoom swallowed the press), clicking a node no longer re-heats the
    layout, big graphs (over 4000 nodes) draw their edges, and a refresh during the initial layout no longer freezes
    it half-spread. Flows: clicking a device or client opens its detail card. Topics: the details panel's Location
    chips bring the target into view.
  - **Pipelines:** the pick and rename transform fields keep what is typed (commas, half-typed pairs).
  - **Client:** `usePolled` applies only the newest response (a slow reply for the previous OPC UA connection or a
    racing refresh can no longer overwrite fresher data); QoS downgrades and contract violations are logged and
    toasted; Trends says "No samples in this range" for a recording or historian with nothing for the chosen tags.
  - **Dependencies:** server lockfile moves to express 4.22.3 / qs 6.16.2 (moderate qs advisories).

### Security

- **A long wildcard pattern could freeze the server.** Mapping select patterns were turned into regular expressions
  that backtrack catastrophically (a 25-character pattern blocked the server for over a minute, and a viewer could send
  one through the preview endpoint). They are now matched in linear time.
- **Web pages can no longer drive an open local instance.** The socket refuses foreign `Origin`s, and an instance with
  no token bound to loopback refuses requests whose `Host` is not a loopback name (or listed in
  `MANIFOLD_ALLOWED_HOSTS`), which closes cross-site WebSocket hijacking and DNS rebinding.
- **Secrets in URLs no longer leak.** Passwords embedded in historian and broker-admin URLs are masked in every API
  answer and stripped from error messages; a timed-out alert webhook no longer shows its URL (the path is the
  credential for chat webhooks) to viewers.
- CSV exports of device tags and mapping rows neutralise spreadsheet formulas; a Trends export comment can no longer
  be broken onto a new line by a crafted name.
- The built client is served with a Content-Security-Policy.
- `GET /api/system/status` reports `degraded` when the configuration store or the alert journal cannot be written
  (saves used to answer OK while the change existed only in memory).
- The CI workflow runs with a read-only token.

- **Hostile devices and bridge servers can no longer exhaust a driver's memory or stall it** (found by review, each
  proven with a failing test first): the WebSocket client caps fragments per message and replies queued for a peer that
  does not read; S7 caps empty transport fragments per PDU; MTConnect keeps only data items the agent declared and at
  most 256 active conditions each; EtherNet/IP symbol paging must advance and is capped; CoAP refuses CBOR bignums wider
  than 64 bytes; BACnet values nested deeper than 32 levels are refused; a device's CA certificate field is capped at
  64 KiB (an oversized value could freeze the server on save).
- SNMP request ids, the SNMPv3 privacy salt and BACnet invoke ids now start from a cryptographic random source.

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
- The same holds for the newer drivers: BACnet/IP (Who-Is, ReadProperty, ReadPropertyMultiple), SNMP (Get, GetNext,
  GetBulk), HTTP/JSON and MTConnect (GET without a body), CoAP (GET) and the two bridge servers (allow-listed read
  commands) cannot encode anything else; BACnet/IP, SNMP v1/v2c, plain CoAP and the bridge servers do not
  authenticate the client either. Stored device secrets are answered as `null` by every API call. IoT detection never
  publishes, and the broker canary publishes only when turned on for a broker.

### Known issues

- **No driver and no IoT convention was verified on real hardware.** Every driver (Modbus TCP, S7, EtherNet/IP,
  BACnet/IP, SNMP, HTTP/JSON, MTConnect, CoAP, Matter Server, Z-Wave JS Server) was checked only against in-process
  simulators written with it, and the IoT-over-MQTT conventions only against a simulator of the projects' documented
  messages. Every driver except Modbus TCP is experimental. The ordered procedure for engineers with real devices is
  [Verifying on real hardware](docs/wiki/Verifying-on-Real-Hardware.md).
- **OPC UA was verified only against node-opcua's server.** Kepware, Siemens S7-1500, Ignition, Prosys and other
  servers, their security policies and quirks, and tens of thousands of monitored items are unverified.
- **CoAP over DTLS (`coaps://`) is not supported**, and the HTTP drivers do not implement digest authentication.
- **The public test-broker presets were written from memory**: their host names and ports were not checked against
  the operators' current documentation.
- **The Timebase REST API reference could not be read**, so ordering of old
  samples, the shape of a Bad sample without a value, the 500 ms resolution,
  quality codes, batch limits and tokens are unconfirmed for the direct historian
  target and for pipeline writes.
- **A pipeline historian target on an envelope topic stores the envelope as JSON
  text.** Add a `numeric` transform with `field: "v"` (the route editor offers it
  in one click). A mapping's direct historian target is not affected.
- **Retained cleanup is bounded.** At most 20,000 recorded topics per broker; what does not fit is counted and not
  cleaned automatically.
- **MQTT, OPC UA and historian endpoints are outside the egress guard**, by
  decision (see Security above).
- WebGL and 3D were only run on a software renderer; accessibility is checked
  automatically (axe, both themes) but not audited by hand or with a screen reader.
- See `docs/REVIEW-2026-11.md` for the full list, including defects seen while
  capturing the documentation screenshots and still open: an overflowing large float in the device
  drawer (S1); a reopened OPC UA mapping's tag table leaves Unit and Description blank (S8); a wildcard value rule is
  one Overview line naming one topic, possibly an acknowledged one (S14); the IoT detection panel fills the first
  screen when every convention is on (S15); two focus indicators in search boxes (S16); S7 advanced field labels with
  two parenthesised suffixes (S17).

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
