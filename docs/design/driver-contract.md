# Device drivers: the contract and how to add one

For contributors who change a driver under `server/drivers/` or add a new protocol. How the
drivers run (host processes, supervisor, the per-device runtime, metrics) is described in
[ARCHITECTURE.md: Southbound device drivers](../../ARCHITECTURE.md#southbound-device-drivers); how
users configure them is in the wiki page [Devices and Drivers](../wiki/Devices-and-Drivers.md).
This document covers what a driver module must provide, the rules every driver keeps, and why.

## Contents

- [Design rules](#design-rules)
- [Scope: what the drivers do not do](#scope-what-the-drivers-do-not-do)
- [The driver module](#the-driver-module)
- [Results and samples](#results-and-samples)
- [Read-only by construction](#read-only-by-construction)
- [Targets, secrets and shared clients](#targets-secrets-and-shared-clients)
- [Adding a driver: checklist](#adding-a-driver-checklist)
- [Why it is built this way](#why-it-is-built-this-way)

## Design rules

Each rule answers a failure that is common in industrial data collection. The runtime
(`server/drivers/runtime/deviceRuntime.js`) already enforces the ones marked *runtime*; a driver
must not work around them.

| Failure seen in the field | Rule |
|---|---|
| A frozen value keeps Good quality after updates stop | Quality is part of every sample and of change detection. When the connection is lost every tag goes Bad (`disconnected`) — *runtime* |
| A late reply is matched to the next request, so values are silently wrong | After a timeout the socket is destroyed, never reused. A driver validates every reply against its request (Modbus transaction id, unit and function code; S7 PDU reference; CIP sender context; BACnet invoke id and source; SNMP request id) and reports a mismatch as fatal |
| A driver crash takes the host application down | Drivers run in child processes; the main server never loads driver code — *runtime* |
| Reconnect that never recovers after a power cycle or download | One connection state machine per device: jittered backoff from 1 s to 60 s, no retry cap — *runtime* |
| Too many connections exhaust the PLC | Exactly one connection per device, shared by all poll groups, closed in order (Forward Close before FIN for CIP) |
| Polling faster than the device can answer | One cycle per poll group at a time and one request in flight; an overrun is skipped and counted, never queued; repeated overruns slow the group down and say so — *runtime* |
| One bad item fails a whole batch | `execute` returns per-item status. A permanent refusal of a batch is bisected to the offending tag, which is quarantined and retried every minute — *runtime*, using the driver's `bisect` |
| One dead unit behind a gateway stalls the others | Per-unit circuit breakers for requests that carry a `unitId` — *runtime* |
| Decoding errors that look like data (word order, 0/1-based addresses, packed BOOLs) | Nothing is inferred: register table, wire offset, byte order and word order are separate fields, and `probe` shows the raw bytes with the candidate decodings. Structured types come from the device's own description (a Logix template), never from summed member sizes |
| A tag dump: raw PLC addresses as UNS topics | The device address and the UNS name are separate; the mapping editor never proposes an address as a name and flags names that look like one |

## Scope: what the drivers do not do

- **Writes.** No driver can encode a write (see [Read-only by construction](#read-only-by-construction)).
  Adding writes would be a separate, explicitly enabled feature with its own review.
- **S7CommPlus** (optimized/symbolic access on S7-1200/1500): proprietary and TLS-wrapped; users
  with optimized blocks are pointed to the PLC's OPC UA server.
- CIP class 1 implicit I/O, CIP Security, PCCC, Modbus RTU serial, Modbus/TCP Security, BACnet COV
  subscriptions and segmentation, CoAP over DTLS, SNMP Set and traps.

Protocol-by-protocol deviations, unsupported features and the hardware checklist are in each
driver's `NOTES.md` (`server/drivers/<driver>/NOTES.md`).

## The driver module

A driver is a CommonJS module at `server/drivers/<name>/index.js` that exports
`{ protocol, describe, validateTag, createDriver }`. `server/drivers/modbus/index.js` is the
smallest complete example; `server/test/support/fakeDriver.js` is the minimum the host accepts.

### `describe()`

A static description. `GET /api/devices` returns it (normalised by `protocols()` in
`server/services/deviceManager.js`) and the device form is rendered from it, so most of the UI
needs no code for a new driver.

| Field | Meaning |
|---|---|
| `protocol`, `label` | Id stored on the device (`modbus-tcp`) and the name shown |
| `readOnly` | Always `true` |
| `experimental` | Shows the *Experimental* badge; every driver except Modbus TCP sets it until verified on real hardware |
| `defaultPort`, `transport` | Form defaults (`transport: 'udp'` for datagram drivers) |
| `options`, `limits` | Default protocol options and `{ requestDeadlineMs, connectTimeoutMs, interRequestDelayMs }`. A device saved without limits runs with these |
| `capabilities` | `{ browse, subscribe, maxInFlight }`; `browse` enables the **Import from ...** dialog, `subscribe` the push path below |
| `deviceFields`, `optionFields` | Form fields: `name` (or `key`), `label`, `type` (`number`, `select`, `boolean`, `password`, anything else renders as text), `default`, `options`, `help`, `optional`, `advanced`, `showWhen`. A field of `type: 'presets'` becomes one-click value sets (S7 rack and slot) |
| `secretFields` | Extra secret field names besides `password` fields (see [Targets, secrets and shared clients](#targets-secrets-and-shared-clients)) |
| `tagTypes` | Type names, or objects `{ name, ... }` whose details reach the client as `tagTypeInfo` |
| `tagTypeOptional` | The device reports the type (EtherNet/IP, SNMP, the bridge servers), so a tag may omit it |
| `addressHelp`, `addressForms` | Examples shown beside the address field |
| `browseNoun` | The word used in shared copy: `controller`, `agent`, `server`, `device` |
| `prerequisites` | Text the form shows before the first connect: what to enable on the device and what the protocol's security implies |

### `validateTag(tag, options)`

A pure function: `{ ok: true, normalized }` or `{ ok: false, error }`. It parses and normalises the
address and the decode options. The device manager calls it on every save, on CSV import and from
`POST /api/devices/validate-tags`; tag keys themselves (`[A-Za-z0-9_.\-:[\]]{1,128}`, unique, at
most 20,000 per device) are checked by the device manager.

### `createDriver(device)`

Called inside the host process with the **effective** device (profile tags merged, `{param}`
placeholders substituted, default limits applied, `device.pinned` set). It validates the whole
configuration and throws an `Error` with `details: [{ key, error }]` when anything is wrong. It
returns an object with:

| Member | Contract |
|---|---|
| `capabilities` | As in `describe()` |
| `connect()` | Opens the device's one connection; resolves with what it learned (negotiated limits, identity) or rejects. The runtime bounds it with `connectTimeoutMs` |
| `isConnected()` | Optional; checked right after `connect()` |
| `plan(keys)` | Pure: packs the given tag keys into requests within the device's limits. Each request has an `id` and `items: [{ key, ... }]`, and a `unitId` when it addresses a unit behind a gateway |
| `execute(request, deadlineMs)` | Sends one request. Never throws for device or transport problems; returns a result (next section) |
| `bisect(request)` | Splits a multi-item request into smaller ones (usually halves) for the runtime to retry after a permanent refusal |
| `probe(args)` | Reads one address and returns the raw bytes and candidate decodings for the probe panel |
| `browse(node)` | Only with `capabilities.browse`: children of `node` (root when absent) as `{ id, name, kind, address, meta }` |
| `subscribe({ onSamples, onLost })` | Only with `capabilities.subscribe` (the Matter and Z-Wave bridge drivers): push value changes between poll cycles with `onSamples([{ key, v, type, q, qReason? }])`, and call `onLost(reason)` when the connection drops |
| `close()` | Releases the connection in order. Must be safe to call twice |

The runtime serialises every call on the device's connection (`plan` aside), so a driver never
sees two requests at once.

## Results and samples

`execute` resolves with one of:

```js
{ ok: true, results: [{ key, v, type, q, qReason?, tSource? }] }
{ ok: false, kind: 'exception', code, name?, classification, message }   // the device refused
{ ok: false, kind: 'timeout' | 'mismatch' | 'framing' | 'transport', fatal: true, message }
```

- `q` is `192` (Good), `64` (Uncertain) or `0` (Bad). A Bad item names why in `qReason`; the
  runtime itself uses `disconnected`, `quarantined`, `unit-down` and `device-exception`, and drivers
  add their own (`decode`, `unavailable`, `stale`, `layout`, ...).
- `classification` steers the runtime: `permanent` (bisect, then quarantine), `unit-down` or
  `gateway` (counts toward the unit's breaker), anything else is a transient error for this cycle.
  The message is what the operator reads in `lastError` (`tag <key>: <message>`), so translate
  protocol codes into causes (an S7 refusal names PUT/GET or optimized block access).
- A fatal result, a thrown error or a malformed result makes the runtime close the connection,
  mark every tag Bad and reconnect with backoff.
- `tRead` is added by the runtime; polled protocols have no device timestamp. Set `tSource`
  (milliseconds) only when the device supplies one (MTConnect).
- 64-bit integers are returned as strings (JSON IPC cannot carry `bigint`).

## Read-only by construction

Every outgoing frame goes through one encoder per driver with an allowlist of request types; the
list per driver is in [SECURITY.md](../../SECURITY.md) ("Read-only guarantees, per driver"). The
driver's tests try every refused service and assert that nothing reaches the socket, and the
simulators count writes so integration tests can assert zero. Discovery probes build their frames
with the same encoders (`server/services/deviceIdentify.js`).

## Targets, secrets and shared clients

- **Connect to the pinned address.** The main process resolves a hostname, checks it against the
  egress guard and passes the validated addresses as `device.pinned`. Use `connectAddress(device)`
  from `server/drivers/runtime/pinnedAddress.js` for TCP and `UdpTransport`
  (`server/drivers/runtime/udpTransport.js`) for UDP, which refuses a hostname and re-checks the
  address. Never resolve `device.host` yourself.
- **HTTP and WebSocket devices** use the shared clients in `server/drivers/common/`
  (`httpClient.js` for GET-only HTTP with same-origin redirects and a response size cap,
  `urlTarget.js` for the URL field model: `scheme`, `path`, `authToken`, TLS CA and fingerprint;
  `wsClient.js` and `wsJsonSession.js` for the bridge servers).
- **Secrets.** A `deviceFields` entry of `type: 'password'` (plus any name in `secretFields`) is
  stored with the device, passed to the driver and answered as `null` by every API call; an edit
  that leaves it blank keeps it, and a change of host, port or scheme without a new secret is
  refused. Export `activeSecretFields(device)` from the module when some secrets apply only to some
  settings, so unused ones are dropped.
- **Bound everything a device sends.** Response sizes, nesting depth, fragment counts, paging and
  queued replies all have caps; a hostile device must not be able to exhaust a driver process.

## Adding a driver: checklist

1. `server/drivers/<name>/index.js` with `describe`, `validateTag` and `createDriver`, a pure
   planner and an allowlisted encoder. No new runtime dependency without a reason recorded in the
   driver's `NOTES.md`.
2. Register the module in `DRIVER_MODULES` in `server/services/deviceManager.js`.
3. A simulator in `server/test/support/` and a `server/test/<name>-driver.test.js` covering the
   encoder allowlist (nothing refused reaches the socket), reply validation, timeouts, reconnect,
   per-item errors and every bound. (Host and supervisor behaviour is already covered with a fake
   driver in `server/test/driver-robustness.test.js` and `driver-supervisor.test.js`.)
4. `server/drivers/<name>/NOTES.md`: deviations from the specification, what is not supported and
   what to check on real hardware.
5. Client spots that are still protocol-specific: address placeholders and probe forms in
   `client/src/pages/devices/model.js`, the connection summary in
   `client/src/pages/devices/DeviceList.jsx`.
6. Optional Discovery probe: a read-only identification exchange in
   `server/services/deviceIdentify.js` (TCP) or an entry in `UDP_PROBES` in
   `server/services/discovery.js` (UDP), plus `client/src/lib/discoveryDevices.js`.
7. Documentation: the driver's section in [Devices and Drivers](../wiki/Devices-and-Drivers.md),
   its row in the read-only table of [SECURITY.md](../../SECURITY.md), its steps in
   [Verifying on real hardware](../wiki/Verifying-on-Real-Hardware.md) and the CHANGELOG.
8. Set `experimental: true` until someone has run the checklist against real devices.

## Why it is built this way

- **Own protocol clients, not libraries.** The failures that matter (late replies, reconnects,
  timeouts) are exactly where the common Node libraries had open bugs, and the runtime owns those
  concerns anyway. The read-only subsets are small, and an encoder we write can enforce an
  allowlist. The EtherNet/IP evaluation of existing libraries is recorded in
  `server/drivers/eip/NOTES.md`. GPL-licensed libraries cannot be linked into this MIT project.
- **One process per protocol, not per device.** A process costs tens of megabytes, too much for a
  site with hundreds of devices; `isolate: true` gives one device its own process when it needs
  it. Worker threads were rejected because an uncaught error in a thread still ends the process.
- **IPC in batches.** One message per poll cycle, so a 2,000-tag device at 1 s costs one message
  per second.
- **A pure `plan`.** Read packing is where protocol libraries have had their bugs; a pure planner
  is unit-tested without a device.
- **Broker first.** A mapping always publishes to the broker so every consumer sees the same data;
  the direct historian target is opt-in for history that must survive a broker outage.
