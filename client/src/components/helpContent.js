/**
 * All in-app help content in one place: getting-started overview, task guides,
 * glossary, and the keyboard shortcut list. Rendered by HelpCenter.jsx.
 *
 * Body strings support a tiny markup: blank-line paragraph breaks, **bold**,
 * and `code`. Keep entries short and task-shaped — this is a field manual, not
 * a spec. Every claim here must match what the UI actually does; when a page
 * changes, update its entry.
 */

export const HELP_SECTIONS = [
  { id: 'start', label: 'Start here' },
  { id: 'guides', label: 'Guides' },
  { id: 'glossary', label: 'Glossary' },
  { id: 'shortcuts', label: 'Shortcuts' }
];

export const HELP_TOPICS = [
  // ── Start here ─────────────────────────────────────────────────────────────
  {
    id: 'what-is-manifold',
    section: 'start',
    title: 'What is Manifold?',
    keywords: 'about overview intro purpose',
    body:
      'Manifold is a live explorer and control room for industrial data. It connects to the systems a plant already runs — **MQTT** brokers (including **Sparkplug B**), **OPC UA** servers and **i3X** servers — and shows everything as one browsable, chartable, alertable namespace.\n\n' +
      'Nothing here is simulated: every node in every graph is a real topic or tag that produced real data.'
  },
  {
    id: 'tour-observe',
    section: 'start',
    title: 'Observe — watch the estate',
    keywords: 'topics uns flows trends alerts pages navigation',
    body:
      '**Topics** — a live graph of one broker’s topic tree. Click any node to inspect payloads, history and rates; publish test messages from the detail pane.\n\n' +
      '**UNS** — your unified namespace: every broker plus mounted OPC UA / i3X sources merged into a single tree, with structure linting.\n\n' +
      '**Flows** — who is producing and consuming what: Sparkplug groups, nodes and devices, and broker client sessions.\n\n' +
      '**Trends** — time-series charts over recorded data. Pick a source (recording or historian), search tags, and chart them together.\n\n' +
      '**Alerts** — the alarm center: rules that watch the namespace (silence, thresholds, new topics), a live feed of firings, and per-rule webhooks.'
  },
  {
    id: 'tour-build',
    section: 'start',
    title: 'Build — work on the stream',
    keywords: 'pipelines tags pages navigation dataops',
    body:
      '**Pipelines** — the DataOps hub. Route and transform live messages, write them to **historians** (file, InfluxDB, Timebase, TimescaleDB), record & replay traffic, and enforce **schema contracts** on payloads.\n\n' +
      '**Tags** — bridge non-MQTT data in: bind OPC UA and other external tags onto MQTT topics, and run Manifold as a **Sparkplug primary host**.'
  },
  {
    id: 'tour-connect',
    section: 'start',
    title: 'Connect — add data sources',
    keywords: 'brokers opcua i3x discovery pages navigation',
    body:
      '**MQTT Brokers** — connect any broker (TLS, auth, multiple at once). **OPC UA** — browse address spaces, monitor values, manage certificate trust. **i3X** — browse i3X namespaces and history.\n\n' +
      '**Discovery** — scan a network range for listening MQTT / OPC UA / i3X endpoints and connect what it finds in one click.'
  },
  {
    id: 'tour-system',
    section: 'start',
    title: 'System — health & configuration',
    keywords: 'health settings metrics pages navigation',
    body:
      '**Health** — the server’s own vitals: ingest rates per broker, pipeline/recorder/outbox counters, memory, and Prometheus metrics.\n\n' +
      '**Settings** — auth, audit trail, config export/import (everything as one JSON), and instance-wide options.'
  },

  // ── Guides ────────────────────────────────────────────────────────────────
  {
    id: 'guide-first-broker',
    section: 'guides',
    title: 'Connect your first broker',
    keywords: 'mqtt connect broker add subscribe',
    body:
      '1. Go to **Connect → MQTT Brokers** and add your broker’s host and port (default `1883`, TLS `8883`).\n\n' +
      '2. Manifold subscribes to `#` by default, so the topic tree fills as messages arrive. Retained messages appear immediately.\n\n' +
      '3. Open **Topics** and pick your broker — the graph builds itself live. If nothing shows, check the broker allows your credentials and that something is publishing.'
  },
  {
    id: 'guide-explore-topics',
    section: 'guides',
    title: 'Explore the topic graph',
    keywords: 'topics graph click node inspect payload publish 3d tree',
    body:
      'Click any node to open its detail pane: latest payload, message history, rate sparkline and actions (publish, expand branch, jump to UNS).\n\n' +
      'The toolbar switches renderers — **tree**, **2D graph**, **3D** — and toggles flow animation, value labels and the minimap. Use the search box to jump to a topic by name.\n\n' +
      'The **replay scrubber** (bottom bar) seeks back through buffered messages: drag it, or focus it and use ←/→, Home/End, and Space to play.'
  },
  {
    id: 'guide-uns',
    section: 'guides',
    title: 'Build a unified namespace',
    keywords: 'uns mount opcua i3x lint namespace merge',
    body:
      'The **UNS** page merges every connected broker into one tree. Mount external sources (OPC UA, i3X) under a chosen prefix so they appear alongside MQTT data — use **Mounts** in the UNS toolbar.\n\n' +
      'Run **Lint** to check the namespace against UNS conventions (consistent depth, no mixed leaf/branch topics, payload hygiene). Each finding explains what to fix and why it matters.'
  },
  {
    id: 'guide-alarm',
    section: 'guides',
    title: 'Set up an alarm',
    keywords: 'alerts alarm rule threshold silent webhook notify',
    body:
      'Open **Alerts** and create a rule:\n\n' +
      '**Branch silent** — fires when nothing under a path publishes for N seconds (a dead line). **Topic silent** — the same for one exact topic. **New topic** — fires when unexpected topics appear under a prefix. **Value threshold** — fires when a numeric payload (or a `field.path` into JSON) crosses a limit; supports a sustain time and a clear-value deadband so a noisy sensor doesn’t flap.\n\n' +
      'Firings appear live in the bell menu and the Alerts feed, and can POST to a **webhook** (Slack, Teams, PagerDuty bridge — any HTTP endpoint).'
  },
  {
    id: 'guide-record-replay',
    section: 'guides',
    title: 'Record, replay & chart data',
    keywords: 'recorder replay trends chart historian record',
    body:
      'On **Pipelines**, create a **recording** with a topic filter — matching messages append to a rolling capture file (oldest data rotates out at the size cap).\n\n' +
      'Chart it on **Trends**: pick the recording (or a historian), search for numeric tags, and add them to the chart.\n\n' +
      'Replay a capture from the **Topics** page scrubber to watch old traffic flow through the graph again.'
  },
  {
    id: 'guide-historian',
    section: 'guides',
    title: 'Pipe data to a historian',
    keywords: 'historian influxdb timebase timescale pipeline route write',
    body:
      'On **Pipelines**, add a **historian** (InfluxDB, Timebase, TimescaleDB — or the zero-config built-in file historian), then create a **route**: a topic filter plus optional transforms that writes matching values to the historian.\n\n' +
      'Delivery is buffered through an outbox — if the historian goes down, data spools to disk and drains when it returns. Watch write/spill counters on **System → Health**.'
  },
  {
    id: 'guide-contracts',
    section: 'guides',
    title: 'Enforce payload contracts',
    keywords: 'schema contract validation violations governance',
    body:
      'On **Pipelines → Contracts**, point at a topic and **infer** a schema from its live payloads, then save it as a contract. Non-conforming messages are recorded as violations with the exact field that broke.\n\n' +
      'Contracts are how you stop a firmware update from silently renaming `temp` to `temperature` and breaking every consumer downstream.'
  },
  {
    id: 'guide-discovery',
    section: 'guides',
    title: 'Discover devices on the network',
    keywords: 'discovery scan network cidr find brokers',
    body:
      'On **Connect → Discovery**, enter a CIDR range (e.g. `192.168.1.0/24`) and scan. Manifold probes for MQTT (1883/8883), OPC UA (4840/50000) and i3X endpoints, then verifies each with a real protocol handshake — no guesses.\n\n' +
      'Private ranges need `MANIFOLD_ALLOW_PRIVATE_TARGETS=1` on the server (a safety rail so the scanner can’t be abused for network recon).'
  },
  {
    id: 'guide-sparkplug',
    section: 'guides',
    title: 'Work with Sparkplug B',
    keywords: 'sparkplug birth death metrics host flows',
    body:
      'Sparkplug traffic is decoded automatically — **Flows** shows the group → edge node → device hierarchy with live metric values, birth/death state and message rates.\n\n' +
      'On **Tags**, Manifold can act as the **primary host application**: it publishes `STATE` online/offline (with a Last Will) so edge nodes know when the host is watching.'
  },

  // ── Glossary ──────────────────────────────────────────────────────────────
  {
    id: 'g-mqtt',
    section: 'glossary',
    title: 'MQTT',
    keywords: 'protocol broker publish subscribe',
    body: 'A lightweight publish/subscribe protocol — the backbone of most IIoT data movement. Clients publish messages to **topics** on a **broker**; other clients subscribe to the topics they care about. Nobody talks to anybody directly.'
  },
  {
    id: 'g-topic',
    section: 'glossary',
    title: 'Topic & wildcards (+, #)',
    keywords: 'topic path wildcard plus hash filter',
    body: 'A topic is a `/`-separated path like `plant/line1/temp`. Subscriptions can use wildcards: `+` matches exactly one level (`plant/+/temp` = every line’s temp), `#` matches everything below (`plant/#` = the whole plant).'
  },
  {
    id: 'g-retained',
    section: 'glossary',
    title: 'Retained message',
    keywords: 'retain last value store',
    body: 'A message the broker keeps and hands to every new subscriber immediately — the "last known value" of a topic. Retained messages are why a fresh Manifold connection can show a populated tree before anything new publishes.'
  },
  {
    id: 'g-qos',
    section: 'glossary',
    title: 'QoS (0 / 1 / 2)',
    keywords: 'quality of service delivery guarantee',
    body: 'MQTT’s delivery guarantee per message: **0** — at most once (fire and forget), **1** — at least once (may duplicate), **2** — exactly once (slowest). Telemetry is usually QoS 0; commands and state usually QoS 1.'
  },
  {
    id: 'g-lwt',
    section: 'glossary',
    title: 'Last Will (LWT)',
    keywords: 'last will testament offline death',
    body: 'A message a client registers when connecting that the **broker** publishes on its behalf if it dies unexpectedly. It’s how MQTT systems announce "this device just went offline" without the device having to say so.'
  },
  {
    id: 'g-sparkplug',
    section: 'glossary',
    title: 'Sparkplug B',
    keywords: 'sparkplug birth death dbirth ddata nbirth ndata state',
    body: 'A specification on top of MQTT that adds structure: a fixed topic namespace (`spBv1.0/group/MESSAGE_TYPE/node/device`), binary payloads with typed named **metrics**, and a state model. **NBIRTH/DBIRTH** announce a node/device and declare all its metrics; **NDATA/DDATA** carry value changes; **NDEATH/DDEATH** announce loss. Manifold decodes all of it automatically.'
  },
  {
    id: 'g-primary-host',
    section: 'glossary',
    title: 'Primary host application',
    keywords: 'sparkplug host state scada',
    body: 'The one SCADA/consumer a Sparkplug edge node treats as authoritative. It publishes `STATE` birth/death; edge nodes buffer or re-birth based on it. Manifold can act as primary host from the **Tags** page.'
  },
  {
    id: 'g-uns',
    section: 'glossary',
    title: 'UNS (Unified Namespace)',
    keywords: 'unified namespace single source truth',
    body: 'An architecture where every system publishes its state into one shared, hierarchical, semantically-organized namespace (usually MQTT), instead of point-to-point integrations. The namespace itself becomes the source of truth: anything can subscribe to exactly the slice it needs.'
  },
  {
    id: 'g-isa95',
    section: 'glossary',
    title: 'ISA-95 hierarchy',
    keywords: 'isa95 enterprise site area line cell',
    body: 'The conventional levels for structuring a UNS: **Enterprise → Site → Area → Line → Cell**. A topic like `acme/dallas/packaging/line4/filler/temp` walks that hierarchy. Manifold’s UNS lint checks your namespace keeps a consistent shape.'
  },
  {
    id: 'g-opcua',
    section: 'glossary',
    title: 'OPC UA',
    keywords: 'opc ua server nodeid address space',
    body: 'The dominant industrial interoperability standard: servers expose a typed, browsable **address space** of nodes; clients browse, read, write and subscribe. Every node has a **NodeId** like `ns=2;s=Machine1.Temperature`. Manifold browses, monitors and can mount OPC UA data into the UNS.'
  },
  {
    id: 'g-i3x',
    section: 'glossary',
    title: 'i3X',
    keywords: 'i3x api contextualized data',
    body: 'An open REST/WebSocket API for exchanging contextualized industrial data — namespaces of typed objects with values and history. Manifold connects as an i3X client and can mount i3X objects into the UNS.'
  },
  {
    id: 'g-historian',
    section: 'glossary',
    title: 'Historian',
    keywords: 'historian time series database influx timebase',
    body: 'A time-series database tuned for process data: append-heavy writes, range queries, downsampling. Manifold routes live values into InfluxDB, Timebase, TimescaleDB or its built-in file historian, and charts any of them on Trends.'
  },
  {
    id: 'g-pipeline',
    section: 'glossary',
    title: 'Pipeline (route)',
    keywords: 'pipeline route transform filter map',
    body: 'A server-side rule: match messages by topic filter, optionally transform them (rename, scale, reshape, drop), then deliver to a target — a historian, another topic, or both. Runs on the ingest path with per-route counters.'
  },
  {
    id: 'g-contract',
    section: 'glossary',
    title: 'Schema contract',
    keywords: 'contract schema validation shape',
    body: 'A saved expectation of a topic’s payload shape (field names, types, ranges). Messages that break the contract are logged as violations. Infer one from live traffic on the Pipelines page rather than writing JSON Schema by hand.'
  },
  {
    id: 'g-broker',
    section: 'glossary',
    title: 'Broker',
    keywords: 'broker server mosquitto emqx hivemq',
    body: 'The MQTT server every client connects to — it receives every published message and fans it out to matching subscribers. Mosquitto, EMQX, HiveMQ and NanoMQ are common; Manifold connects to any of them, several at once.'
  },

  // ── Shortcuts ─────────────────────────────────────────────────────────────
  {
    id: 'sc-global',
    section: 'shortcuts',
    title: 'Global',
    keywords: 'keyboard shortcut keys',
    body: '`?` — open this help panel\n\n`[` — collapse / expand the sidebar\n\n`Esc` — close any dialog, panel or selection'
  },
  {
    id: 'sc-graph',
    section: 'shortcuts',
    title: 'Topic graph',
    keywords: 'keyboard shortcut graph search',
    body: '`Enter` in graph search — jump to the first match\n\nClick a node — open its detail pane\n\nDrag empty space — pan · scroll — zoom'
  },
  {
    id: 'sc-replay',
    section: 'shortcuts',
    title: 'Replay scrubber (when focused)',
    keywords: 'keyboard shortcut replay seek',
    body: '`←` / `→` — seek backward / forward\n\n`Home` / `End` — jump to oldest / newest\n\n`Space` or `Enter` — play / pause'
  }
];
