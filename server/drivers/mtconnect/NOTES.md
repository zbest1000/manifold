# MTConnect driver: notes and hardware checklist

Status: **experimental** (`describe().experimental === true`). Tested only against
`server/test/support/mtconnectSimulator.js` and documents written from the public MTConnect Standard
(Parts 1, 2 and 4) and the reference agent's published examples. Not run against a real agent or machine.

Protocol id `mtconnect`. Code: `index.js` (driver and stream follower), `document.js` (header, probe,
observations), `xml.js` (the tolerant XML reader), `../common/httpClient.js` (HTTP client shared with
http-json).

## What it does

1. `connect()`: `GET /probe` (device model) then `GET /current` (first snapshot, `instanceId`,
   `nextSequence`). Either failing fails the connection with the agent's reason.
2. Each poll: `GET /sample?from=<nextSequence>&count=N` (N = `options.sampleCount`, default 1000), repeated
   while the agent reports more (`nextSequence <= lastSequence`), at most 20 pages per poll and within the
   request deadline. The cursor is the header's `nextSequence` of the last answer, kept as BigInt (agents
   use 64-bit counters).
3. **Resynchronise** with `/current` (and `/probe` after a restart) when:
   - the `instanceId` in a `/sample` header differs from the one we know (the agent restarted; sequences
     start over and the device model may have changed);
   - the agent answers an `OUT_OF_RANGE` error (our sequence left its buffer; HTTP 404 and 400 are both
     seen in the wild, the error document is what is read);
   - the header's `firstSequence` is beyond our cursor, or `nextSequence` is below it, without an error
     (agents that clamp `from` silently, or a counter that went backwards).
4. **A truncated or malformed answer never moves the cursor**, so the same range is asked again on the next
   poll and no observation is lost. The XML reader rejects a document that ends inside an element.
5. One poll serves every tag: `plan()` returns a single request.

Only GET `/probe`, `/current` and `/sample` are sent (with an optional `/<device>` prefix). The tests assert
the exact URL set, that no request has a body and that no `interval=` is ever requested.

### Values

- **Tags** address a data item by `dataItemId`, or `device/dataItemId` (device name or uuid; checked against
  the probe, a mismatch is Bad). `options.device` restricts the driver to one device (`/<device>/probe`
  and so on).
- **SAMPLE**: numeric text. **EVENT**: string. `UNAVAILABLE` is Bad with reason `unavailable` (also for a
  condition `Unavailable`). A SAMPLE that is not numeric is Bad `not-numeric` for a number tag; a string
  tag returns the text. Three-space-vectors such as `1 2 3` therefore read as strings only.
- **CONDITION**: normal, warning or fault, with the native code, native severity, qualifier and text.
  Several conditions can be active on one data item (distinguished by native code): a Normal with a native
  code clears that one, a Normal without one clears all, `Unavailable` clears and marks unavailable. The
  value is the highest-severity active state (fault over warning over normal; the later sequence wins a
  tie). A `string` tag reads `normal`/`warning`/`fault`, a `number` tag 0/1/2, a `bool` tag "is anything
  active". The tag field `field` selects `nativeCode`, `text`, `severity`, `qualifier` or `type` instead.
  At most 256 active conditions are kept per data item (the oldest is evicted), and observations are
  kept only for data items the agent declared in `/probe`, so a hostile agent cannot grow the state.
- **Source timestamp** (`tSource`) is the observation's own `timestamp` (fractional seconds to six digits
  are accepted; milliseconds are kept). **Units** come from `/probe` (`units`, shown as a symbol) and are
  offered as the tag's `unit` when importing from the agent (browse); the driver does not scale values.
- **Time series** (`sampleCount` attribute / `representation="TIME_SERIES"`) and **data set / table**
  (`Entry`/`Cell` children, `DATA_SET`/`TABLE`) are not supported: the tag is Bad
  `unsupported-representation (<kind>)`, and browse shows those items as not selectable with the reason.
- A data item not in `/probe` is Bad `unknown-data-item`; one not yet reported is Bad `no-data`.

### Document handling (`xml.js`)

- Versions 1.3 to 2.x: default namespace, prefixed (`m:`) and no namespace, `xsi` attributes, comments,
  processing instructions, CDATA, BOM, DOCTYPE (skipped; **entity declarations are never expanded**, only the
  five predefined entities and numeric references), unquoted attribute values, stray or misnested end tags.
- Bounded: nesting depth 64, 2,000,000 elements, and the response size cap (`options.maxResponseBytes`,
  default 8 MiB for `/probe` of large machines, at most 256 MiB; larger answers abort and the tags go Bad
  `too-large`). A whole answer is held and parsed in memory, so one driver process can use that much for
  a hostile agent: an accepted limit (`docs/KNOWN-ISSUES.md`).
- Observations are the children of `Samples`, `Events` and `Condition` inside a `ComponentStream`, with a
  `dataItemId`; the element name is the type (any type, including unknown ones from newer versions).

### Failure behaviour

Error documents, non-2xx answers, garbage, truncated bodies: all Bad `agent-error (...)` with the cause,
device stays online. Three timeouts in a row, refused or dropped connections: offline, reconnect with
backoff (`connect()` loads `/probe` and `/current` again). Redirects follow the same rules as http-json
(same host only). Authentication, TLS options and address pinning are the same as http-json (for an agent
behind a reverse proxy).

## Not supported

- **Multipart streaming** (`/sample?interval=...`, `/current?interval=...`): this driver polls. Polling at
  the poll-group interval loses nothing (the sequence cursor sees every observation still in the buffer),
  but latency is the interval, and an agent whose buffer turns over faster than the poll interval reports a
  gap (OUT_OF_RANGE) and the intermediate values are lost; raise the buffer or poll faster.
- Time series and data set representations (above); Assets (`/assets`), `/current?at=`,
  `/sample?path=` / XPath filters and `heartbeat`.
- JSON or other non-XML agent output (MTConnect 2.x JSON-cppagent), SHDR, MQTT or WebSocket transports.
- Writing anything to a machine: MTConnect agents are read-only and so is this driver; there is no code
  path for another method.
- Duplicate `dataItemId` across devices without a `device/` qualifier (the first is used; the standard says
  ids are unique within a document).
- Condition `statistic`, `compositionId` and `resetTriggered` semantics are not interpreted.

## To confirm on real hardware before this leaves experimental

1. A real cppagent (and at least one commercial agent) on a machine tool: `/probe` documents with
   Compositions, Configuration and the Agent device parse and browse correctly.
2. Behaviour at `from == nextSequence` (some agents answer OUT_OF_RANGE: the driver then resyncs on every
   poll, correct but heavy).
3. The HTTP status the agent uses for OUT_OF_RANGE and INVALID_REQUEST, and `Content-Type` variants.
4. Agent restart: instanceId change observed in `/sample`, and `/probe` unchanged versus changed.
5. UNAVAILABLE handling for conditions after a controller disconnect.
6. Very large `/current` documents (thousands of data items): size cap and request deadline.
7. Time zones and clock skew between the agent and Manifold (the observation timestamp is used as sent).
