# 🏷️ Tags and Sparkplug

> **Goal:** from "browse a device's tags" to "they live in the UNS" in one
> wizard — with report-by-exception and real quality codes on the way.

## The tag browser

**Tags** unifies every source Manifold already speaks:

| Source | What you browse |
|---|---|
| 🔧 Devices | the tags you defined on the [Devices page](Devices-and-Drivers) (Modbus TCP, S7, EtherNet/IP), grouped by poll group |
| 🖧 OPC UA | the address space of any connected server, loaded lazily |
| ⚡ Sparkplug | the device registry (Group → Edge → Device → metrics) rebuilt from BIRTH certificates |
| 📡 MQTT | the observed topic trie |

Tick tags, hit **Add to UNS**, and the wizard does the right thing per
source: MQTT selections compile into a pipeline route; device, OPC UA and
Sparkplug selections become **bindings**. The wizard previews the resolved
topic for every tag, and **retain is off by default** (a retained value
outlives a dead device). The tree is keyboard accessible (arrow keys to move,
Space to select) and has a filter box.

For the full story on device tags (path versus address, quality, the `_status`
topic, heartbeat, historians) see [Mapping to the UNS](Mapping-to-the-UNS).

## How a binding flows

```mermaid
flowchart LR
    DEV[device tag, OPC UA<br/>monitored item,<br/>or Sparkplug metric] --> RBE{value or quality changed,<br/>beyond the deadband?}
    RBE -->|no| SUP[suppressed<br/>counted, not sent]
    RBE -->|yes| FMT{format}
    FMT -->|plain| P1[raw value to MQTT topic]
    FMT -->|envelope| P2["{v, t, q} with real quality"]
    FMT -->|sparkplug| P3[DDATA on a proper<br/>Sparkplug B device]
```

- **Report by exception** — an absolute deadband suppresses numeric noise;
  non-numeric values publish on change only. Change detection keys on
  **(value, quality)**, so Good to Bad with an unchanged value is still
  published (in the envelope format). An optional **heartbeat** republishes
  unchanged tags so "unchanged" can be told from "dead".
- **Quality is honest** — OPC UA status codes map to Good 192 / Uncertain 64 /
  Bad 0 and travel inside the envelope. When a source goes offline (a device
  loses its connection, an OPC UA session drops) every known tag of its
  bindings gets one Bad publish, and a retained `_status` document says why.
  Sparkplug targets get DDEATH instead.
- **Types survive** — Sparkplug targets use the tag's real type (Int16, Float,
  Boolean, ...) rather than sending everything as Double.
- **Read-only by design** — bindings never write toward a device. There is no
  write path in the engine, and the device drivers' frame encoders refuse
  every write service (see [Devices and Drivers](Devices-and-Drivers#the-read-only-guarantee-and-its-limits)).

## Sparkplug messages are delivered in order, none dropped

NDATA and DDATA carry only the metrics that **changed**, so keeping just the
latest message per topic would lose data. Sparkplug topics are therefore
handled differently from ordinary MQTT topics at intake: **every message is
delivered, in arrival order**, to the registry, bindings, pipelines and
historian targets (the UI still shows the latest per topic). The queue that
makes this possible is bounded per 100 ms flush (5,000 messages or 8 MiB by
default; `MANIFOLD_SPARKPLUG_QUEUE_MAX` and `MANIFOLD_SPARKPLUG_QUEUE_BYTES`).
Past the bound a topic falls back to latest-wins for the rest of that window
and the broker's `sparkplugCoalesced` counter increments, so loss is never
silent. The defaults admit on the order of 50,000 Sparkplug messages per
second per broker.

## CSV import

Tag exports from Kepware/Ignition-style tools drop straight into the
selection:

```csv
nodeId,name
ns=2;s=Channel1.Device1.Temperature,Temperature
ns=2;s=Channel1.Device1.Pressure,Pressure
```

> For **device tags**, import and edit tags on the Devices page instead
> (`key,address,type,pollGroup,scale,...`); see
> [Devices and Drivers](Devices-and-Drivers).

## The Sparkplug B publisher

Bindings that target Sparkplug get a dedicated session per (broker, group,
edge node) implementing the specification's full lifecycle — consumers with
Sparkplug state management (Ignition, HiveMQ extensions, Timebase collectors)
see Manifold as a first-class edge node:

```mermaid
sequenceDiagram
    participant M as Manifold edge node
    participant B as Broker

    M->>B: CONNECT (will = NDEATH with bdSeq)
    M->>B: NBIRTH seq 0 (Node Control/Rebirth)
    M->>B: DBIRTH per device
    loop values
        M->>B: DDATA (seq mod 256)
    end
    B->>M: NCMD Rebirth
    M->>B: NBIRTH (new cycle)
    Note over M,B: shutdown: DDEATH per device, then NDEATH,<br/>closed gracefully so both frames flush
```

A device whose source goes offline gets a **DDEATH** (sequence-numbered), and a
**DBIRTH** with the last known values when it recovers, before any further
DDATA.

> ✅ This lifecycle is exercised frame-by-frame against a real broker in CI —
> BIRTH ordering, sequence numbering, and death certificates included.

## Host application STATE

Sparkplug host applications announce themselves on retained
`spBv1.0/STATE/{host_id}` topics. Manifold works with STATE in both
directions:

- **Tracking** — every STATE message folds into the registry: host
  online/offline status appears in the Tags page and in the UNS event feed
  (`host-online` / `host-offline`). Because STATE is retained, status is
  correct immediately after connecting.
- **Publishing** — the *Primary host STATE* panel on the Tags page starts a
  dedicated session that publishes retained `{ "online": true, ... }` for a
  host ID of your choice, with a matching last-will. Edge nodes configured to
  wait for a primary host (a common Ignition/edge gateway setting) then see
  one and start publishing.

> 💡 Only run one primary host per host ID on a broker — that is the
> specification's whole point. Manifold refuses nothing here; the convention
> is yours to keep.
