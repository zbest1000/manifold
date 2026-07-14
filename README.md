# Manifold

**One live map of your industrial data — UNS, MQTT, OPC UA, CESMII, i3X.**

Like its namesake, Manifold joins many pipes into one system: it connects to
MQTT brokers and OPC UA servers, streams their data in real time, and renders
it as a live **Unified-Namespace topology**, interactive **node graphs** of
every namespace and address space, and **Flows** — producer → topic → consumer
lineage with wildcard subscriptions resolved against reality. On top of that
sits an industrial **DataOps layer**: pipelines, contextualization models,
historians with store-and-forward, recording/replay, schema contracts, and tag
bindings with a spec-respecting Sparkplug B publisher. It ships with a **Model
Context Protocol (MCP) server** so AI assistants and agents can drive the same
backend programmatically.

*(Formerly "Topic Canvas" — renamed as the tool outgrew topic visualization.)*

There is no built-in "AI assistant" chat and no mock data — the app does real
protocol work and exposes it cleanly. If you want AI in the loop, point any
MCP-capable client at the included MCP server.

---

## What it does

### Explore

- **Live MQTT exploration** — connect to any broker (TCP or TLS) and watch
  topics populate. JSON, plain-text, binary and **Sparkplug B** payloads are
  detected and decoded. Intake subscribes at **QoS 1 by default** (configurable
  per broker) so the broker retransmits unacked messages; if a broker refuses
  the wildcard grant, intake automatically falls back to QoS 0 and says so.
  *Note:* stock EMQX **silently** denies `#` at QoS 1+ (default ACL with
  `deny_action=ignore`) — allow it in the broker ACL, or set intake QoS 0.
- **Three views of every broker** — a collapsible **topic tree** (live values
  with change-flash, retained flags, per-branch counts, publish with
  QoS/retain, clear-retained, inline plot), an interactive 2D **node graph**,
  and a **3D graph** you orbit with the mouse. Six visual styles, live physics
  layouts plus server-computed layouts (Graphviz `dot`/`sfdp`/`twopi`/`circo`,
  Cytoscape `fcose`).
- **Show-all at massive scale** — a WebGL renderer draws every topic as a node
  (verified at 63k+, responsive pan/zoom) with viewport-culled zoom-aware
  labels and a server-side force layout at up to 30k nodes. The 3D and WebGL
  renderers load as **lazy chunks** — they cost nothing until opened.
- **OPC UA browsing** — walk the address space as a graph, read attributes,
  monitor live variable values.
- **Message history that survives restarts + payload diff** — per-broker
  recent-message rings snapshot to disk and restore on boot; pick two messages
  in any topic's history to see a structural JSON diff of what changed.
- **Honest network discovery** — TCP probing across a CIDR range, every hit
  verified with a real protocol handshake. No fabricated results.

### UNS — the living namespace

- **Live ISA-95 topology** — the whole namespace as a hierarchy (Namespace →
  Business Unit → Site → Area → Line → Cell) with expand/collapse, drag to
  rearrange, and edges that animate green while data actually publishes
  through a branch. Built entirely from observed traffic. The draw loop
  throttles itself to ~8fps when the namespace is quiet and nothing is being
  touched — full 60fps the moment traffic or interaction returns.
- **A live dashboard, not just a map** — leaf badges show each topic's latest
  value, branch badges show per-branch msg/s, and every leaf gets **staleness
  detection calibrated to its own publish cadence** (inter-arrival EMA):
  green = fresh, amber = overdue (3× its typical interval), red = dead (10×).
- **Lint** — scores the namespace 0–100 and lists structural findings (mixed
  naming conventions among siblings, payloads on branch nodes, empty segments,
  whitespace in names, redundant single-child chains, uneven leaf depth) with
  jump-to-node.
- **Events** — a feed of namespace changes: new topics appearing, Sparkplug
  BIRTH/DEATH lifecycle including cascaded device deaths.
- **Editable level ladder & mounts** — rename/add/remove ISA-95 levels
  (persisted), and graft non-MQTT sources — an OPC UA address space or the i3X
  object graph — into the same namespace forest.

### Flows — who talks to whom

- **Producers** — Sparkplug publishing endpoints (Group → Edge Node → Device)
  reconstructed from BIRTH/DEATH certificates with live online/offline state,
  per-endpoint metric sets, and a broker `$SYS` health panel.
- **Consumers, with wildcards resolved** — per-client subscriptions from a
  broker admin API (EMQX v5 / HiveMQ Enterprise REST) are **resolved against
  the actually-observed topic set** with a server-side trie: exact match
  counts, covering subtree roots, drill-down to concrete topics, proper MQTT
  semantics (`+`/`#`, `$`-topic exclusion, `$share` groups). Dormant filters
  are flagged — dead wiring is a finding. Coverage paints onto the topic map.
- **Consumer rates** — EMQX's cumulative per-client counters are diffed into
  live per-client msg/s in/out.
- **Honesty** — MQTT exposes only aggregates without an admin API, and the UI
  says so plainly. Mosquitto has no per-client subscription API, so observed-
  traffic resolution is the ceiling there — stated, not papered over.

### DataOps — shape the namespace

- **Pipelines** — routes consume a topic filter, run an ordered transform
  chain (**repath** with `{n}` segment templates, **pick/rename/set**,
  **scale**, **numeric**, **Sparkplug flatten** with honest `is_null` → null
  propagation, **TVQ envelope** `{v,t,q}`), and deliver to a broker or a
  historian. Every route gets a **trie-backed dry-run** against your live
  namespace before you enable it. Loops are blocked twice: statically (output
  re-matching the route's own source) and dynamically (a hop-count guard that
  catches A→B→A cycles across routes and brokers).
- **Models** — bind attributes from many raw topics (across brokers, a field
  plucked from each payload) into **one merged object at a clean UNS path**,
  on change or on an interval. Ten raw topics become one `Pump-7`.
- **Historians, four backends** — **InfluxDB v2** (line protocol; numeric
  samples write `value=`, non-numeric write `raw="…"`, so a type-flapping
  topic can never poison a shard), **TimescaleDB / PostgreSQL** (batched
  parameterized inserts, table auto-created and promoted to a hypertable when
  Timescale is present, bounded connect/query timeouts), **Timebase historian
  (Flow Software)** (TVQ writes into datasets on `:4511`; also ingests
  MQTT/Sparkplug natively, which is an equally supported path), and **FINOS
  TimeBase CE** (JSON rows via the TimebaseWS gateway on `:8099`, optional
  Deltix HMAC-SHA384 signing). Per-connection test-write button; secrets
  stored server-side only.
- **Store-and-forward** — every historian point goes through a persistent
  outbox: failed writes spill to disk, survive restarts, and drain
  oldest-first on recovery. At the spill cap a per-historian **drop policy**
  chooses which end goes: keep the outage start (default) or drop oldest to
  keep the newest data. All bounds are explicit and *reported* (queue depth,
  spill bytes, drop counts) — an outage delays data, it doesn't delete it.
- **Recorder + Replay** — capture everything under a filter to an append-only
  file or a historian, then replay onto a broker with original relative timing
  (speed factor, loop, topic prefix). Real traffic becomes a test fixture.
- **Schema contracts** — lock a topic's inferred JSON shape and get violations
  the moment a publisher drifts: missing fields, new fields, type changes,
  with exact paths.

### Tags — from device browse to UNS

- **Unified tag browser** over the drivers Manifold already speaks: the OPC UA
  address space (lazy, node-class aware), the Sparkplug device registry, and
  the MQTT topic trie. Tick tags, hit *Add to UNS*, and a wizard binds them to
  plain MQTT topics (raw or TVQ envelope) or a proper **Sparkplug B device**.
- **Report-by-exception** — absolute deadband and per-binding sampling for
  OPC UA sources; OPC UA status codes map to real quality (Good 192 /
  Uncertain 64 / Bad 0). **CSV import** takes Kepware/Ignition-style
  `nodeId,name` exports. Bindings are read-only by design — Manifold monitors
  and republishes, it never writes to a device.
- **Spec-respecting Sparkplug B publisher** — dedicated session per (broker,
  group, edge node): CONNECT with an NDEATH will carrying bdSeq, NBIRTH seq 0
  with `Node Control/Rebirth`, DBIRTH before any DDATA, seq mod 256, rebirth
  on NCMD, clean DDEATH/NDEATH on shutdown. Verified frame-by-frame against a
  real broker in CI.

### Operate

- **Overview health cards** — pipelines, historians (store-and-forward state),
  tag bindings, and alerts at a glance, streamed over the socket.
- **Alert rules** — *branch silent*, *topic silent*, *new topic appears*;
  evaluated server-side against the same trie the UI reads, fire on
  transitions, optional per-rule webhooks.
- **Roles + audit trail** — `TC_AUTH_TOKEN` (admin) plus optional
  `TC_VIEWER_TOKEN` (read-only: GETs succeed, every mutation is refused).
  Every mutating API call and socket command lands in an audit log (role, IP,
  route, outcome; secrets redacted) — in the UI and append-only on disk.
- **Prometheus `/metrics`** — event-loop delay percentiles, per-broker ingest,
  per-route pipeline counters, outbox depth, contract violations, binding
  publishes. Live engine metrics also stream to the UI over the socket
  (hidden tabs don't poll at all).
- **Configuration as code** — export the entire DataOps setup as one JSON
  document with secrets stripped; import merges by id and keeps stored
  secrets. Reviewable in git, promotable between environments.

### Integrations

- **CESMII SMIP** — two-step JWT handshake server-side, equipment/attribute
  listing, historical time-series with inline sparkline.
- **i3X** — namespaces, object/relationship graph with live values and
  history; auto-detected during network discovery.
- **MCP server** — ~50 tools covering MQTT, UNS, Flows, DataOps, OPC UA,
  CESMII and i3X for Claude Desktop, IDE agents, or any MCP client.

---

## Architecture

```
Manifold
├── server/   Node.js + Express + Socket.IO backend
│             MQTT (mqtt.js) · OPC UA (node-opcua) · Sparkplug B · CESMII · i3X
│             pipelines · models · historians + outbox · recorder · contracts
│             tag bindings · alerts · audit · /metrics
├── client/   React + Vite + Tailwind frontend
│             canvas force-graph + lazy 3D/WebGL renderers, UNS topology,
│             style presets, live data panels
└── mcp/      Model Context Protocol server (stdio) bridging the backend REST API
```

The backend holds all live state and streams updates over Socket.IO. The hot
path is deliberately lean: a struct-of-arrays topic store (latest payload per
topic as a latin1 string), coalesced flushes bounded by *topics touched* rather
than publish rate, a compiled route table rebuilt only when config changes, and
one topic split per message shared by every engine. The client is a thin
real-time view. The MCP server is a stateless bridge over the backend's REST
API, so a human in the browser and an AI agent over MCP see the same data.

(A Rust/napi implementation of the hot path exists under `native/` as a
reproducible benchmark; pure JS won on round-trip cost — see its README.)

---

## Getting started

### Prerequisites

- Node.js ≥ 20 (the OPC UA dependency chain needs Node 20.19+ / 22+)

### Install & run

```bash
npm run install:all
npm run dev            # client on :3000, backend on :5000 (proxied)
```

### Production

```bash
npm run build          # builds the client into client/dist
npm start              # serves the API and the built client from the backend
```

Or use the Docker stack — broker, OPC UA simulator, and traffic generator
included: see **[DOCKER.md](DOCKER.md)**.

### Authentication & persistence

Manifold is a **control plane** — it can publish to brokers (including
Sparkplug commands that actuate equipment), disconnect connections, and start
network scans. Before exposing it beyond localhost:

```bash
TC_AUTH_TOKEN=$(openssl rand -hex 24) npm start
```

- With `TC_AUTH_TOKEN` set, every `/api` route and the Socket.IO handshake
  require `Authorization: Bearer <token>`; the web UI shows an unlock screen.
  `/health` stays open for liveness probes. Add `TC_VIEWER_TOKEN` for a
  read-only role. Without tokens the server runs open and warns loudly.
- **Connection profiles persist** to `server/data/profiles.json` (override the
  directory with `TC_DATA_DIR`; disable restore with `TC_NO_RESTORE=1`) and
  reconnect on startup. The file can contain credentials — that is the point
  of persistence — so it is written `0600`. Protect the host accordingly;
  encrypting it without a real key-management story would be theater, so we
  don't pretend to.
- The MCP server forwards the same token: set `TC_AUTH_TOKEN` in its
  environment when the backend runs authenticated.

---

## MCP server

1. Start the backend (`npm run dev` or `npm start`).
2. Add the server to your MCP client config:

```json
{
  "mcpServers": {
    "manifold": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/index.js"],
      "env": { "MANIFOLD_API_URL": "http://localhost:5000" }
    }
  }
}
```

(`TOPIC_CANVAS_API_URL` is still honored for existing setups.)

### Tools exposed

| Tool | Purpose |
| --- | --- |
| `system_status` | Backend status: connections and discovery state |
| `discover_scan` / `discover_results` | Scan a CIDR range for MQTT/OPC UA endpoints |
| `mqtt_connect` / `mqtt_disconnect` / `mqtt_list_brokers` | Manage broker connections |
| `mqtt_list_topics` / `mqtt_get_messages` | Read the topic tree and recent payloads |
| `mqtt_subscribe` / `mqtt_publish` | Subscribe to filters and publish messages |
| `mqtt_sparkplug_topology` / `mqtt_sys_stats` | Sparkplug device topology and broker `$SYS` health |
| `mqtt_resolve_subscriptions` / `mqtt_topic_tree` | Resolve wildcard filters against observed topics; walk the topic tree |
| `mqtt_admin_pubsub` | Per-client subscriptions from the broker admin API (optionally resolved) |
| `uns_tree` / `uns_lint` / `uns_events` | Nested UNS tree, conformance lint, namespace event feed |
| `pipelines_list` / `pipeline_preview` | DataOps routes with live metrics; dry-run a route |
| `historians_list` / `models_list` / `contracts_violations` | Historians, models, schema-drift events |
| `bindings_list` / `audit_recent` | Tag bindings with status; the audit trail |
| `opcua_connect` / `opcua_disconnect` / `opcua_list_connections` | Manage OPC UA connections |
| `opcua_browse` / `opcua_read` / `opcua_monitor` | Walk the address space, read and monitor nodes |
| `cesmii_configure` / `cesmii_status` | Configure and authenticate a CESMII SMIP instance |
| `cesmii_list_equipment` / `cesmii_list_attributes` | List SMIP equipment and attributes |
| `cesmii_history` / `cesmii_query` | Pull time-series history or run a raw GraphQL query |
| `i3x_connect` / `i3x_probe` / `i3x_status` | Connect to, probe, or inspect an i3X server |
| `i3x_namespaces` / `i3x_object_types` / `i3x_graph` | Discover namespaces, types, and the object graph |
| `i3x_related` / `i3x_value` / `i3x_history` | Navigate relationships and read current/historical values |

---

## HTTP API (selected)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/system/status` | Overall status |
| `POST` | `/api/system/discovery/start` | Start a network scan (`{ range?, mqttPorts?, opcuaPorts? }`) |
| `GET/POST` | `/api/mqtt/brokers` | List / connect brokers (`{ host, port?, username?, subscribeQos?, ... }`) |
| `GET` | `/api/mqtt/brokers/:id/topics` | Topic list with counts |
| `GET` | `/api/mqtt/brokers/:id/sparkplug` | Sparkplug device topology (Group → Edge → Device) |
| `GET` | `/api/mqtt/brokers/:id/sys` | Broker `$SYS` health summary |
| `POST` | `/api/mqtt/brokers/:id/subscriptions/resolve` | Resolve wildcard filters against observed topics |
| `GET` | `/api/mqtt/brokers/:id/topictree?prefix=` | One level of the observed topic tree with subtree counts |
| `GET` | `/api/mqtt/brokers/:id/admin/pubsub?resolve=1` | Per-client subscriptions from the broker admin API |
| `GET` | `/api/mqtt/brokers/:id/uns/tree` · `/uns/lint` · `/uns/events` | UNS skeleton, conformance report, event feed |
| `GET/POST/DELETE` | `/api/uns/mounts` | Mount OPC UA / i3X sources into the UNS view |
| `GET/POST/DELETE` | `/api/alerts/rules` · `GET /api/alerts/events` | Alert rules and recent firings |
| `GET/POST/DELETE` | `/api/pipelines` · `POST /preview` | DataOps routes + trie-backed dry-run |
| `GET/POST/DELETE` | `/api/historians` · `POST /:id/test` | Historians (InfluxDB / TimescaleDB / Timebase / TimeBase CE) + test write |
| `GET/POST/DELETE` | `/api/models` | Contextualization models |
| `GET/POST/DELETE` | `/api/recorder` · `GET /:id/data` · `POST/DELETE /replay` | Recording + bounded read-back + replay |
| `GET/POST/DELETE` | `/api/contracts` · `/infer` · `/violations` | Schema contracts: infer, lock, drift feed |
| `GET` | `/api/tags/sources` · `/browse` | Unified tag browser (OPC UA / Sparkplug / MQTT) |
| `GET/POST/DELETE` | `/api/tags/bindings` | Tag bindings into the UNS |
| `GET` | `/api/audit` | Audit trail of mutating actions (admin only) |
| `GET/POST` | `/api/system/config/export` · `/import` | Configuration as code |
| `GET` | `/metrics` | Prometheus metrics for Manifold itself |
| `POST` | `/api/mqtt/brokers/:id/publish` | Publish (`{ topic, payload, qos?, retain? }`) |
| `POST` | `/api/opcua/connections` | Connect (`{ endpointUrl, securityMode?, ... }`) |
| `GET` | `/api/opcua/connections/:id/browse?nodeId=` | Browse a node's children |
| `POST` | `/api/opcua/connections/:id/monitor` | Monitor a variable |
| `POST` | `/api/cesmii/config` · `/history` | Configure a SMIP instance; pull time-series |
| `POST` | `/api/i3x/connect` · `/probe` · `/value` · `/history` | i3X connect/probe and value reads |
| `GET` | `/api/i3x/objects` · `/graph` · `/namespaces` | i3X objects, graph, namespaces |
| `POST` | `/api/layout` · `GET /api/layout/engines` | Server-computed graph layouts |

Real-time updates (messages, broker stats, engine metrics, alerts, discovery
progress, OPC UA values) are delivered over Socket.IO.

---

## Tests & CI

- **Server** — 124 tests on Node's built-in `node:test`, executed by a small
  serial runner (`server/test/run.js`) that runs each file **in-process**
  rather than through `node --test`'s child-process IPC (whose message framing
  corrupts intermittently on CI runners):

  ```bash
  cd server && npm test
  ```

  Coverage spans the topic trie and wildcard semantics, UNS lint and feeds,
  broker-admin backends against fake REST servers, the alert engine, history
  snapshot/restore, auth and RBAC (admin + viewer boots with audit,
  `/metrics`, config round-trip), DataOps (transforms, hop-count loop guard,
  outbox spill/drain/drop-policy proven byte-for-byte on the spill file, all
  four historian wire formats against fakes), QoS-refusal fallback, and
  **real-broker integration** via in-process aedes — pipeline end-to-end plus
  the full Sparkplug NBIRTH → DBIRTH → DDATA → DDEATH/NDEATH lifecycle with
  seq assertions. A perf-smoke suite enforces order-of-magnitude floors
  (200k ingests, trie build, 50k pipeline dispatches).

- **Client** — Vitest over the pure logic modules (topic-filter matching,
  graph builders, UNS tree building, payload diff):

  ```bash
  cd client && npm test
  ```

- **GitHub Actions** (`.github/workflows/ci.yml`) — on every push and PR:
  server tests (Node 22), client tests + production build, an MCP load check,
  and an **integration job against real service containers** — EMQX 5
  (configured to authorize wildcard QoS-1 intake, as a production deployment
  would), InfluxDB 2 (line-protocol writes queried back via Flux), and
  TimescaleDB (rows queried back out of a genuine hypertable). Jobs carry hard
  timeouts, the wait step fails by service name instead of passing through a
  dead container, failures dump container logs, and a concurrency group
  cancels superseded runs.

---

## Tech stack

- **Backend:** Express, Socket.IO, `mqtt`, `node-opcua-client`, `protobufjs`,
  `pg` (TimescaleDB)
- **Frontend:** React 18, Vite, Tailwind CSS, `d3-force` / `d3-zoom` (canvas),
  Zustand, Framer Motion, lucide-react
- **MCP:** `@modelcontextprotocol/sdk`

## License

MIT
