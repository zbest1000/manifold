# EtherNet/IP (Logix) driver: decision record and hardware checklist

Status: **experimental** (`describe().experimental === true`). Tested only
against `server/test/support/eipSimulator.js`. The same person wrote the
simulator and the driver, so the tests show the two agree with each other.
They do not show that either one matches real firmware.

## Decision: our own read-only CIP client on `node:net`, no library

The design doc (section 5.3) said to wrap an existing library. The spike
checked both candidates against the hard requirements for this task. Both
are MIT licensed. Source was inspected from `npm pack`.

| Requirement | `ethernet-ip` 2.0.0 | `st-ethernet-ip` 2.7.5 |
|---|---|---|
| (a) every outgoing frame passes through one function we control | Partly. `TCPTransport.write` is a single sink and the transport can be replaced. But the CIP encoders (`plc/*.js`, write services included) build raw bytes, so an allowlist would have to re-parse them after the fact. `doUnregisterSession` also writes to the transport directly. | No. `ENIP extends net.Socket`, and writes happen through `this.write` in several places (`connect`, `write_cip`, `destroy`). |
| (b) per-request deadline, socket destroyed on timeout, no hidden retries | **Fails.** On timeout, `RequestPipeline` rejects the request and moves straight on to the next one on the same socket. `handleData` then hands *any* complete packet to whichever request is pending, with no session, context or sequence check. A late reply is therefore matched to the next request: failure #2 in the design doc. A built-in `Reconnector` also runs exponential-backoff reconnects (on by default). The port is hard-coded to 44818 (`EIP_PORT`), so it cannot be pointed at a simulator. | **Fails.** `promiseTimeout` rejects but does not destroy the socket. Replies are dispatched as events keyed by service code, so a late reply resolves the next request with the same service. `ControllerManager` has its own `setTimeout` reconnect loop. |
| (c) per-item status for Multiple Service Packet | Yes | Partly. `readTagGroup` rejects the whole group. |
| (d) no uncaught exceptions on socket errors | `SessionManager` re-emits `'error'`, which is fatal if nobody listens | `throw` inside async event handlers |
| (e) licence | MIT | MIT. Pulls in 4 dependencies (`task-easy`, `int64-buffer`, ...). |

Neither library meets (a) to (d) cleanly. The failure under (b) is exactly
the bug the runtime is designed to prevent. Wrapping either one would mean
replacing its transport, its pipeline and its matching, which is most of the
code. So we implemented the read-only subset ourselves, about 2,600 lines
including symbol and template browsing. It has no new npm dependency.

Module map (`server/drivers/eip/`):

- `cip.js`: constants, status codes, EPATH segment encoders and the route path.
- `frame.js`: **the choke point.** `encodeFrame` is the only function that
  produces outgoing bytes. It accepts structured requests only. Its
  `assertCipAllowed` is keyed on (service, target class): 0x4E is Forward
  Close only on the Connection Manager, and 0x52 is Unconnected Send only on
  the Connection Manager. Every inner service of a Multiple Service Packet and
  the message inside an Unconnected Send are checked too. Before `socket.write`,
  the client also re-parses each buffer with `inspectOutgoingFrame`, a
  byte-level check.
- `address.js`: tag address parser and symbolic path encoder.
- `decode.js`: atomic types, parsing of templates from the controller, and
  decoding of structures and STRINGs from those templates.
- `planner.js`: pure packing of reads into Multiple Service Packets, plus
  fragmented reads and bisect.
- `client.js`: session, Forward Open (Large first, then 504), connected and
  unconnected messaging, strict reply matching, deadlines, and
  Forward Close, UnRegisterSession and FIN on close.
- `symbols.js`: Get Instance Attribute List on the Symbol class, and
  template attributes plus Read Template.
- `index.js`: `describe`, `validateTag`, `createDriver`.

## Contract notes and deviations

- A CIP error on a **single** item is returned per item (`ok:true`, `q:0`,
  `qReason`), so a single read never fails its request. The request-level
  `kind:'exception'` result is used only when a Multiple Service Packet as a
  whole fails, for example with 0x08 or 0x11. That is the case where the
  runtime should bisect.
- Extra fields on results: `message`, and `status` for CIP errors. Extra
  fields on browse nodes: `meta.dataType`, `dims`, `struct`, `templateId`,
  `hasChildren`, `externalAccess`, `accessible`, `offset`, `bit`.
- Browse ids: `controller`, `program:<Name>`, `types`, `type:<templateId>`,
  `tag:<address>`. A UDT instance is `kind:'tag'`, because it can be read
  whole, and has `meta.hasChildren:true`. Browse it again by id to list its
  members.
- Tag types are resolved from the controller at `connect()`. A declared
  `type` that disagrees with the controller makes the tag Bad
  (`qReason:'decode'`).
- `connect()` clears the symbol and template caches. They are also
  invalidated after statuses 0x04, 0x05 and 0x16, and when a structure handle
  does not match the cached template. Affected tags are Bad until the next
  operation re-resolves them.
- Every client operation (`execute`, `browse`, `probe`) is serialised on the
  one socket. The `execute` deadline starts when the operation begins, not
  when it is queued.
- No keepalive timer of its own. The Forward Open asks for a 2 s RPI with
  timeout multiplier code 5 (×128), which gives a CIP connection timeout of
  about 256 s. Poll traffic keeps the connection alive. A device that is
  idle for longer than that is caught by the next request failing, and the
  runtime reconnects.
- Not implemented: ListIdentity as a client call (it is on the allowlist but
  unused), PCCC, Micro800 and Omron specifics, writing, and change detection
  through the controller's "symbol table changed" attributes. The last item
  is design rule 9's "controller change detection". At the moment drift is
  detected only through path errors and structure-handle mismatches.

## Verify on real hardware

Each item below is a wire-format or behaviour detail that could **not** be
confirmed from a primary source. The Rockwell 1756-PM020 and ODVA
specifications were unreachable from the build environment, so these details
came from memory of the specs, the MIT pycomm3 source, and Wireshark
dissector field names. Capture with Wireshark (`enip || cip`) while running
each check.

1. **Large Forward Open (0x5B) parameters.** We send network connection
   parameters as a 32-bit word `0x42000FA2` (point-to-point, variable,
   size 4002), with priority/tick 0x0A and timeout ticks 0x0E. Check that a
   v20+ controller accepts it, and which status a pre-v20 controller or an
   ENBT returns. We fall back to 504 on **any** CIP error status.
2. **Small Forward Open.** Check that `0x43F8` (504 bytes) is accepted, and
   that "connection size" counts the 2-byte sequence count. The planner
   budget is the size minus 2.
3. **Forward Open RPI and multiplier.** Check that RPI 2,000,000 µs with
   multiplier code 5 is accepted, and how long the controller keeps an idle
   connection open.
4. **Forward Close.** Check that it is sent unwrapped through SendRRData to
   the local Connection Manager, with the connection path included. Confirm
   with a capture that the module's connection count drops (design 5.3 exit
   criterion).
5. **Unconnected Send wrapping** (identity reads use it only before a
   connection exists). Check the 0x0A/0x0E ticks, and the reply when routing
   fails (service 0xD2 with an error status).
6. **Get Instance Attribute List (0x55).** Check that attribute values come
   back in the order requested (1, 2, 8, 10), that attribute 10 (External
   Access) is one USINT with 0 = Read/Write, 2 = Read Only, 3 = None, and
   that pre-v18 firmware rejects attribute 10 with status 0x14, 0x09 or
   0x0A. On any of those we retry without it. Also check paging: status
   0x06, then continue at last instance + 1.
7. **Symbol type word.** Bits 13–14 hold the dimension count, bit 12 marks
   system symbols, and bit 15 marks a structure. Also check what a
   `Program:X` entry and the `Map:`, `Task:` and `Cxn:` entries look like.
   We hide every name that contains `:` or starts with `__`.
8. **BOOL arrays.** We assume the symbol type is BOOL (0xC1) with dims[0]
   equal to the number of bits. We also assume that reading element `n`
   sends element index `n >> 5` and gets back one DWORD (0xD3), from which
   bit `n & 31` is taken. **This is the item most likely to be wrong.** Some
   firmware may accept the bit index directly and return BOOL. Check with
   `BoolArr[37]`. Template members that are BOOL arrays are assumed to be
   type 0xD3 with `info` equal to the number of DWORDs.
9. **Template attributes and Read Template.** Byte count = attribute 4 × 4
   − 21 (pycomm3). 1756-PM020 is often quoted as − 23. The parser does not
   depend on which is right, because it reads by member count and
   NUL-separated names, but a controller might reject an over-long request.
   Also check that the first name is `NAME;...` and that the built-in STRING
   template is named `ASCIISTRING82`.
10. **Template member `info`.** We assume it holds the bit number for a
    BOOL member, the element count for an array member, and 0 for a scalar.
    We assume the hidden host member is named `ZZZZZZZZZZ<udt><n>`. Check
    with a UDT that has several BOOLs, an array member, and a nested UDT.
11. **Structure Read Tag reply.** Check that it starts with type word 0x02A0
    followed by the structure handle (template attribute 1). We treat a
    handle mismatch as layout drift. Also check that a BOOL member read by
    name (`Motor.Running`) returns 0xC1 with one byte.
12. **Read Tag Fragmented (0x52).** We assume every fragment repeats the
    type header (2 bytes, or 4 for a structure), that the offset counts
    value bytes only, and that a single Read Tag that is too large returns
    0x06 (we mark it Bad, but the planner should prevent it).
13. **Multiple Service Packet.** Check the general status (0x1E when an
    inner item fails), that offsets are measured from the count field, and
    the controller's real limits on packed requests and replies. Omron
    NJ/NX is reported to fail above about 1,900 bytes; use the
    `maxPacketBytes` option for it.
14. **Path errors after a download or online edit.** Check which status a
    deleted tag returns (we expect 0x04 or 0x05, sometimes 0x16), and that
    caches are rebuilt. Also run a download and a mode change while polling
    (design 5.3 exit criteria).
15. **Identity (Get_Attribute_All on class 1, instance 1, routed to the
    slot).** Check that it returns the controller rather than the
    communication module, and the field layout (revision bytes, SHORT_STRING
    name).
16. **Status 0x0F (privilege violation)** for tags with External Access
    None. The simulator returns it; real firmware may return something else.
17. **Route path parsing** with an extended link address (`1,2,2,10.0.0.5,1,0`)
    through a 1756-EN2T bridge.
18. **Throughput and latency.** Check that `TCP_NODELAY` removes the
    delayed-ACK floor reported for pycomm3.

## References

- ODVA, *The CIP Networks Library* Vol. 1 (Appendix B status codes, C-1.4
  segments, 3-5.5 Connection Manager) and Vol. 2 (ch. 2 encapsulation and
  CPF). Used through the field definitions in Wireshark's
  `packet-cip.c` / `packet-enip.c` dissectors. No dissector code was copied.
- Rockwell Automation, *Logix 5000 Controllers Data Access*, 1756-PM020.
  This was the intended primary source but could not be downloaded here.
- pycomm3 (MIT), `logix_driver.py` and `const.py`. Used for attribute
  numbers, the `- 21` template formula, template parsing behaviour, and the
  external access minimum version v18.
- libplctag wiki and issues #437 (Large Forward Open unsupported) and #454
  (Omron limit), as listed in the design doc. Used for behaviour only; no
  code was used.
