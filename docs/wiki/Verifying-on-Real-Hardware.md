# ✅ Verifying on real hardware

> **Goal:** an ordered procedure for an engineer with a real PLC (or a real
> Modbus device, or a real Timebase historian) to confirm or refute what the
> device drivers assume, and to report back in a form that lets the code be
> fixed or the "experimental" label be lifted.

**State of play.** Nothing here has been verified on real hardware. Every
driver (Modbus TCP, S7, EtherNet/IP, BACnet/IP, SNMP, HTTP/JSON, MTConnect, CoAP,
Matter Server, Z-Wave JS Server) and every IoT-over-MQTT convention was checked
only against in-process simulators written by the people who wrote the drivers, so the tests show driver and
simulator agree, not that either matches real firmware. The Timebase REST
reference could not be read when the historian writer was built. This page
turns the checklists in
[`server/drivers/s7/NOTES.md`](https://github.com/zbest1000/manifold/blob/main/server/drivers/s7/NOTES.md)
(14 items) and
[`server/drivers/eip/NOTES.md`](https://github.com/zbest1000/manifold/blob/main/server/drivers/eip/NOTES.md)
(18 items) and the Modbus assumptions into one sequence. The Modbus items (M1 to
M9) and the Timebase items (T1 to T6) are **derived from what the code and
docs assume**; there is no separate NOTES file for them. The newer drivers' lists
(B, N, H, MT, CO, MS, ZW and I items below) come from each driver's `NOTES.md`; where a
NOTES file has no explicit checklist, the items are what it lists as unverified.

## Before you start

- **Permission and safety.** The drivers cannot write (every outgoing frame goes
  through an allowlisted encoder, and tests assert it), but they do open
  connections to a live controller and read from it. Use a test PLC or a
  maintenance window, tell the process owner, and start with slow poll
  intervals (1 s or more). None of these protocols authenticates the client.
- **Server settings.** `MANIFOLD_ALLOW_PRIVATE_TARGETS=1` for a plant network.
  Run Manifold from source or the image; note the commit or version.
- **Capture.** Run Wireshark (or `tcpdump -w`) on the Manifold host's interface
  for every step that says *capture*. Display filters: Modbus `mbtcp`, S7
  `s7comm || cotp`, EtherNet/IP `enip || cip`. Save one file per section.
- **Where to read results.** The Devices page shows state, last error and
  quarantine reasons. The same data over the API (use a token if auth is on):

  ```bash
  curl -s localhost:5000/api/devices | jq '.devices[] | {name, status}'
  curl -s localhost:5000/api/devices/<id>/values | jq
  curl -s -X POST localhost:5000/api/devices/<id>/probe \
       -H 'Content-Type: application/json' -d '{"address":"holding:0","count":2}'
  ```

- **Record the device.** Model, firmware version, the engineering software and
  version, the network path (direct, switch, gateway, bridge), and anything
  between Manifold and the device.

Each item below says what to do, what **confirms** and what **refutes** the
assumption, and what to **report**. "Item N" refers to the NOTES file's numbering.

## Common to every driver: connection behaviour

Do these once per protocol, with a device that has a few tags polling. For the UDP drivers (BACnet/IP, SNMP, CoAP) C1 means one socket to one address; for the bridge drivers (Matter, Z-Wave) one WebSocket.

| # | Check | Confirms | Refutes / report |
|---|---|---|---|
| C1 | **One connection.** With the device polling, look at the device's own connection diagnostics (or `netstat` on the PLC side, or the capture). Delete the device in Manifold and look again | Exactly one TCP connection (EtherNet/IP: one CIP connection) while polling; it disappears after delete (and a FIN or Forward Close is on the wire) | More than one, or a lingering one: report the count, and how long it took to release |
| C2 | **Reconnect.** Power-cycle the PLC (or pull its cable for a minute, or for S7/Logix do a download and a mode change). Watch the device row (State column) and the retained `_status` of a mapping | State goes Backoff with a reason, then Online by itself, no restart of Manifold; tags are Bad with `q: 0` while down, Good after. Backoff grows 1 s to 60 s | Never recovers, recovers only after a restart, or tags stay Good while down: report the sequence and the capture |
| C3 | **Timeout handling.** Black-hole the device (firewall drop) for one minute | Requests time out (default 2000 ms), the socket is destroyed and re-created, no value is ever matched to the wrong request | Wrong values after a timeout, or a hung state: report |
| C4 | **Overrun.** Set a group interval of 100 ms with many tags on a slow device | Cycles are skipped and counted; after five in a row the interval doubles and the poll-cycle status says *Slowed to ...*; it recovers after 20 clean cycles | Queued requests, growing latency, or the PLC scan time visibly stretching: report PLC scan time before and during |
| C5 | **Quarantine.** Add a tag that cannot be read (see M5, S3, E4) | Only that tag is Bad (`quarantined`) with the device's reason shown; the rest keep polling; the tag is retried about once a minute | The whole device goes bad, or the reason is missing: report |

## Modbus TCP (M1 to M9)

Use a device whose registers you can also read from its own display or another
tool.

**M1. Unit ID.** Create the device with the default unit ID **255**, **Test
connection**, then Probe `holding:0` (or a documented register). If it times
out, try `1`, then `0`. *Confirms:* 255 answers a direct TCP device (the
assumption). *Refutes:* your device needs a specific value. *Report:* the unit
ID that works, vendor and model.

**M2. Address base and Modicon forms.** Pick a register whose value you know
(say register 100 as the manual numbers it). Probe `holding:100` with **Address
base** 0, then 1, then Modicon `400101` and `40101`. *Confirms:* exactly one base
gives the displayed value, and Modicon forms (always 1-based) agree with the
matching `holding:` form. *Refutes:* none do, or both do (a shifted block of
identical values). *Report:* which base the manual's numbering needs.

**M3. Byte and word order.** Probe two registers that hold a known float32 (a
temperature you can see). The four decodings are shown side by side. *Confirms:*
one row (ABCD, CDAB, BADC or DCBA) shows the right number. *Report:* that order,
and whether the device's int32/float64 values follow the same order.

**M4. Block size and gaps.** Read blocks of increasing size with **Max
registers** at 125 and then lower, with **Max gap** 0. Then declare two tags with
an unmapped register between them and set Max gap above the gap. *Confirms:* the
device accepts what you configured, and answers a read over an unmapped
register with an error rather than zeros (the reason the default gap is 0).
*Report:* the largest block the device accepts, and whether a gap read works or
returns zeros (a silent wrong value is the dangerous case).

**M5. Exception behaviour.** Add a tag at an address the device does not have.
*Confirms:* exception 02 appears in the status exception counter, the tag is
quarantined with reason "illegal data address", the other tags are unaffected
and good, and the capture shows retries about once a minute. *Refutes:* the
device times out or closes the socket instead (then the whole device reconnects).
*Report:* what the device does, and any other exception codes seen (04, 05, 06).

**M6. Sentinels.** Where the device uses a fixed "no value" register (for
example `-32768`), add `sentinels` to the tag and force the condition. *Confirms:*
the tag is Bad with reason `unavailable` instead of publishing the number.

**M7. Gateway (TCP to RTU) behind which several slaves sit; skip if none.**
Put two unit IDs behind one gateway address and disconnect one slave.
*Confirms:* after three gateway exceptions (0A or 0B) that unit's tags go Bad with
reason `unit-down`, the other slave keeps polling at its rate, and the dead unit
is probed about every 30 s. *Report:* the exception code the gateway returns,
the gateway's serial timeout, and whether the default 2000 ms **request
deadline** is enough (the design wants the deadline at least the gateway's
serial timeout; there is no warning in the UI, so check by hand).

**M8. Connection limit.** Some devices accept only a few TCP connections.
*Confirms:* Manifold uses one (C1). *Report:* how many your device allows, and
what a second client sees while Manifold is connected.

**M9. Discovery probe (optional).** With **Modbus TCP** ticked in Discovery,
scan only the device's address. The probe is a Read Device Identification
(FC 43 / MEI 14) and, if the device refuses or ignores it, one Read Holding
Registers request for one register at address 0, unit 1. *Confirms:* the device
is reported (an identification, register or exception reply all count), and
whether it answered FC 43. *Report:* whether the device logged
the request, answered at all, or reacted badly. Do not scan a production range.

## Siemens S7 (S7 items 1 to 14)

Prerequisites on the CPU, in this order: a **global** DB (not an instance DB),
**Optimized block access** off, compile and download; CPU properties, Protection
& Security, Connection mechanisms, **Permit access with PUT/GET** on. Then add the
device with the right rack and slot and tags such as `DB10.DBD4` with `REAL`.
The CPU families to cover: S7-300/400 if you have one, and S7-1200 and S7-1500
(note firmware).

**S1. Connect and negotiate (items 7, 8, 10).** *Capture.* Connect with the
default preset (S7-1200/1500: rack 0, slot 1; S7-300/400: rack 0, slot 2).
*Confirms:* COTP Connection Request with TPDU size 1024 (parameter 0x0A) and a
Connection Confirm; the remote TSAP is `0x0100 | rack*0x20 + slot`; Setup
Communication asks max AmQ 1/1 and the CPU grants a PDU size. *Report:* the CPU
model and firmware, the negotiated PDU (expected 240 on S7-300 and some S7-1200,
480 on S7-400, 960 on S7-1500, depending on firmware), whether the CC TPDU size
differs, whether any CPU splits an S7 PDU across several COTP data frames, and
for LOGO! or a drive the raw TSAP that works.

**S2. Refusal with PUT/GET off (item 6).** Turn PUT/GET off on the CPU (S7-1200
and S7-1500, one at a time) and connect. *Capture.* *Confirms:* the CPU answers
with ack-data error class 0x81, code 0x04 (shown as `0x8104` / 33028) and
Manifold shows the PUT/GET hint as the device's last error and tag reason.
*Report:* whether the refusal comes at Setup Communication or only at the first
Read Var, and the exact bytes if it differs.

**S3. Item return codes (item 5).** Read, one at a time: (a) a DB that does not
exist, (b) a read past the end of a DB, (c) a DB with optimized access on, (d)
with a protection level that blocks reads. *Confirms:* the mapping Manifold
uses, `0x05` → "DB shorter than the requested range", `0x0A` → "DB does not
exist", `0x03` → PUT/GET, optimized access or protection. *Refutes:* a different
code for any case. *Report:* the return code seen per case and the text
Manifold showed.

**S4. Read sizing (items 1 to 4).** *Capture.* Configure tags so one request is
planned to the exact limit: one 222-byte item at PDU 240; 19 items at PDU 240;
then 20 items at PDU 240, which should be refused. *Confirms:* the exact-limit
requests are accepted, the 20-item one is refused; S7-1200 and S7-1500 accept 20
items per request; items of odd length are followed by one fill byte except
after the last; the CPU answers data transport size 0x04 to byte requests.
*Report:* the largest accepted request per CPU family and any lower item limit.

**S5. Decoding (items 11, 12, 13).** Read a STRING with a character from 0x80 to
0x9F (the Windows-1252 range), a DATE_AND_TIME and a DTL against a CPU whose
clock you know, and a value larger than one PDU while the PLC changes it.
*Confirms:* latin1 decoding differs from the engineering station's code page for
0x80 to 0x9F (known limitation); dates decode right; a multi-PDU value can tear
(not atomic, known). *Report:* the code page in use and any wrong date.

**S6. Identity (item 9).** Use Test connection and read the identity. *Confirms:*
which of SZL 0x011C, 0x0111 and 0x0424 the CPU answers, and that the fields
(system name, module name, serial, order code, firmware, CPU mode) are right. The
CPU mode byte offset is the least certain item. *Report:* the SZLs answered and
which fields were wrong.

**S7. Connection resources (item 14).** In the CPU's connection diagnostics,
confirm one PG or OP resource is in use while polling and that it is released
after you delete the device (FIN) and after a timeout (the release may lag).
*Report:* the resource type and the release delay.

## EtherNet/IP, Logix (items 1 to 18)

Cover a CompactLogix or ControlLogix with firmware v20 or later, a pre-v20 one if
you have it, and, if possible, a communication module in the path (1756-EN2T).
Prepare tags: a DINT, a REAL, a BOOL, an array, a UDT with BOOL, array and nested
members, a STRING, a BOOL array, and a tag with External Access set to None.

**E1. Forward Open (items 1, 2, 3).** *Capture.* Connect with connection size
**auto**. *Confirms:* the Large Forward Open (0x5B, parameters `0x42000FA2`, size
4002) is accepted on v20 or later; the fallback to a small Forward Open
(`0x43F8`, 504 bytes) happens on any CIP error; RPI 2,000,000 µs with timeout
multiplier code 5 is accepted. *Report:* the status returned by a pre-v20
controller or an ENBT, how long the controller keeps an idle connection, and
whether the module's connection count rises by one.

**E2. Forward Close (item 4).** *Capture.* Delete the device. *Confirms:* a
Forward Close (sent unwrapped through SendRRData to the local Connection Manager,
with the connection path) and the module's connection count dropping. *Report:*
the count before and after.

**E3. Unconnected Send and identity (items 5, 15).** *Capture.* Test connection
on a device with a route path. *Confirms:* Unconnected Send ticks and the reply
on a routing failure (service 0xD2 with an error status); Get_Attribute_All on
class 1 instance 1 returns the **controller**, not the communication module, with
the expected field layout (revision bytes, SHORT_STRING name).

**E4. Symbol list and External Access (items 6, 7, 16).** Open **Import from
controller**. *Capture.* *Confirms:* Get Instance Attribute List (0x55) returns
attributes in the order requested (1, 2, 8, 10); attribute 10 is one USINT with
0 = Read/Write, 2 = Read Only, 3 = None; pre-v18 firmware rejects attribute 10
(status 0x14, 0x09 or 0x0A) and Manifold retries without it; paging works on a
large project (status 0x06, then continue at the last instance + 1); the symbol
type word (bits 13 to 14 dimensions, bit 12 system, bit 15 structure) and the
`Program:X`, `Map:`, `Task:` and `Cxn:` entries look as assumed. Read the tag with
External Access None: *confirms* status 0x0F (privilege violation) and an
"inaccessible" marker, *refutes* any other status. *Report:* anything different.

**E5. Templates and structures (items 9, 10, 11).** Browse a UDT with several
BOOLs, an array member and a nested UDT, and read a whole UDT and a member.
*Confirms:* the template's byte count formula does not matter (reads go by member
count and names), the first name is `NAME;...`, the built-in STRING template is
`ASCIISTRING82`; member `info` holds the bit number for a BOOL, the element count
for an array and 0 for a scalar; the hidden host member is named
`ZZZZZZZZZZ<udt><n>`; a structure Read Tag reply starts with type 0x02A0 and the
structure handle; `Motor.Running` returns 0xC1 with one byte. *Report:* any
member decoded wrongly, with the UDT definition.

**E6. BOOL arrays (item 8), the item most likely to be wrong.** *Capture.* Read
`BoolArr[37]` and a few other elements, and a UDT member that is a BOOL array.
*Confirms:* the driver sends element index `n >> 5` and gets one DWORD (0xD3)
from which bit `n & 31` is taken, and the value matches the controller.
*Refutes:* firmware that takes the bit index directly and returns BOOL. *Report:*
what the capture shows, and the wrong values if any.

**E7. Fragmented and packed reads (items 12, 13).** Read a value larger than the
connection size, and enough tags to fill a Multiple Service Packet. *Confirms:*
every fragment repeats the type header (2 bytes, 4 for a structure), the offset
counts value bytes only, a single Read Tag too large returns 0x06; the general
status is 0x1E when an inner item fails and offsets are measured from the count
field. *Report:* the controller's real limits on packed requests and replies; for
Omron NJ/NX the failing size (reported around 1,900 bytes) and whether the
**maximum packet** option fixes it.

**E8. Download and online edit (item 14).** While polling, delete a tag, rename a
tag, do an online edit, a download and a mode change. *Confirms:* the deleted
tag returns 0x04 or 0x05 (sometimes 0x16), the symbol and template caches are
rebuilt, and affected tags go Bad then recover. *Report:* the statuses seen and
the time to recover.

**E9. Route path through a bridge (item 17).** Use `1,2,2,10.0.0.5,1,0` (or your
equivalent) through a 1756-EN2T. *Confirms:* the extended link address is parsed
and the controller is reached.

**E10. Throughput (item 18).** Measure the poll cycle time for 100 tags on one
controller. *Confirms:* `TCP_NODELAY` removes the delayed-ACK floor reported for
other clients. *Report:* cycle time and tag count.

## BACnet/IP (B1 to B10)

From [`server/drivers/bacnet/NOTES.md`](https://github.com/zbest1000/manifold/blob/main/server/drivers/bacnet/NOTES.md). Capture UDP 47808 while you run them.

| # | Check | Report |
|---|---|---|
| B1 | Unicast Who-Is from a port other than 47808 | which devices answer by unicast, which only by broadcast (then the wildcard read must find them) |
| B2 | ReadProperty of the device object at instance 4194303 | whether the device supports the wildcard instance |
| B3 | ReadPropertyMultiple sizing on devices with max APDU 50, 128, 206 and 480 | how each reports an oversize reply, and whether the split requests fit |
| B4 | A whole-request Error versus per-property errors in RPM | what the real stack sends for one unknown object in a request |
| B5 | Reads routed through a real B/IP-to-MS/TP router | timing, the APDU timeout needed, Reject-Message reasons |
| B6 | Replies from another source port; devices that reply only to 47808 | whether answers are accepted or lost |
| B7 | **Import from device** on a device with thousands of objects | time taken, RPM batching limits |
| B8 | Object names in character sets other than UTF-8 | that names import correctly |
| B9 | Status-flags, reliability and out-of-service per vendor | that the tag quality matches what the device shows |
| B10 | The discovery probe (unicast Who-Is plus wildcard read) | how devices and intrusion-detection systems react |

## SNMP (N1 to N7)

From [`server/drivers/snmp/NOTES.md`](https://github.com/zbest1000/manifold/blob/main/server/drivers/snmp/NOTES.md).

| # | Check | Report |
|---|---|---|
| N1 | net-snmp `snmpd`: v1, v2c and v3 with every authentication and privacy combination; compare with `snmpget -On`; a small `maxMessageSize` | values that differ, the tooBig behaviour |
| N2 | A managed switch: ifTable / ifXTable **Rate /s** against the switch's own counters; **Import from agent** of `1.3.6.1.2.1.2` | rate differences, walk time |
| N3 | A UPS network card with UPS-MIB: v1 agents, noSuchName, slow agents | retries and timeouts needed |
| N4 | Engine reboot of a real v3 agent; an agent with a regenerated engine ID | that the driver re-synchronises without going offline |
| N5 | An agent behind NAT or multi-homed, answering from another address | that **Accept answers from another address** is needed and works |
| N6 | Opaque float values from net-snmp extend scripts | that they decode as floats |
| N7 | The discovery probe (one v2c `public` Get on 161) | how firewalls and intrusion-detection systems treat it |

## HTTP/JSON (H1 to H6)

From [`server/drivers/httpjson/NOTES.md`](https://github.com/zbest1000/manifold/blob/main/server/drivers/httpjson/NOTES.md).

| # | Check | Report |
|---|---|---|
| H1 | 1 s polling over one keep-alive connection | devices that close after each answer or reject `Connection: keep-alive` |
| H2 | The `Accept` and `Accept-Encoding: identity` headers | devices that refuse them |
| H3 | **That a GET on every polled path has no side effect on the device** | any path that changes state when read |
| H4 | Digest authentication (not implemented) | devices that require it |
| H5 | ETags on devices that send them but never answer 304 | that values keep updating |
| H6 | TLS with a self-signed certificate, the CA and the fingerprint options, hostname versus IP in the certificate | what works |

## MTConnect (MT1 to MT7)

From [`server/drivers/mtconnect/NOTES.md`](https://github.com/zbest1000/manifold/blob/main/server/drivers/mtconnect/NOTES.md).

| # | Check | Report |
|---|---|---|
| MT1 | A real cppagent and at least one commercial agent on a machine tool: `/probe` with Compositions, Configuration and the Agent device | parse and browse problems |
| MT2 | Behaviour at `from == nextSequence` | agents that answer OUT_OF_RANGE (the driver then resyncs every poll) |
| MT3 | The HTTP status used for OUT_OF_RANGE and INVALID_REQUEST, `Content-Type` variants | the values seen |
| MT4 | Agent restart: `instanceId` change in `/sample`, `/probe` unchanged versus changed | that the driver resynchronises |
| MT5 | UNAVAILABLE for conditions after a controller disconnect | the quality shown |
| MT6 | Very large `/current` documents (thousands of data items) | size cap and request deadline |
| MT7 | Time zones and clock skew between agent and Manifold | the source timestamps (used as sent) |

## CoAP (CO1 to CO5)

[`server/drivers/coap/NOTES.md`](https://github.com/zbest1000/manifold/blob/main/server/drivers/coap/NOTES.md) lists what is handled and not supported; these are the
behaviours it names as unverified.

| # | Check | Report |
|---|---|---|
| CO1 | Retransmission timing on real low-power links (**ACK timeout**, **Retransmissions**, **Request deadline**) | settings that work |
| CO2 | Block-wise transfers (Block2) on devices with small buffers | devices that mishandle the option |
| CO3 | Observe: registration, notification order, re-registration after Max-Age | devices that ignore or break Observe |
| CO4 | The CoAP ping at connect | devices that ignore it (then **Check on connect: none**) |
| CO5 | SenML (JSON and CBOR) as real gateways emit it | names, units and times that resolve differently |

## Matter Server and Z-Wave JS Server (MS1 to MS4, ZW1 to ZW4)

[`server/drivers/matterserver/NOTES.md`](https://github.com/zbest1000/manifold/blob/main/server/drivers/matterserver/NOTES.md) and
[`server/drivers/zwavejs/NOTES.md`](https://github.com/zbest1000/manifold/blob/main/server/drivers/zwavejs/NOTES.md) list every API detail handled; the
drivers were run only against simulators of the two WebSocket APIs. Use a test installation.

| # | Check | Report |
|---|---|---|
| MS1 | python-matter-server and the matter.js server: handshake, schema version agreed, `get_nodes` | incompatibilities between server releases |
| MS2 | Real node dumps: bridges and multi-endpoint devices | attributes that browse or convert wrongly |
| MS3 | Units and scaling of the common clusters against the device's own app | values that differ |
| MS4 | That nothing but the six read commands reaches the server (server log) | any other command |
| ZW1 | Z-Wave JS Server versions and schema negotiation (`set_api_schema`) | the schema range that works |
| ZW2 | Real node dumps with multi-channel devices and Configuration values | values that are missing or mislabelled |
| ZW3 | **That battery devices are never woken**: no radio traffic from Manifold (controller statistics) | any wake-up or poll |
| ZW4 | Dead and asleep nodes: quality shown | Bad for dead, Good with `sleeping` for asleep |

## IoT over MQTT conventions (I1 to I5)

[`server/services/iot/NOTES.md`](https://github.com/zbest1000/manifold/blob/main/server/services/iot/NOTES.md) states the versions targeted (Zigbee2MQTT 1.3x and 2.x,
Z-Wave JS UI 8.x to 10.x, Home Assistant discovery 2024.11+ and the older form, Tasmota 12.x to 14.x,
Shelly Gen1 and Gen2+, ChirpStack v4, The Things Stack v3); none was re-checked against a running
instance.

| # | Check | Report |
|---|---|---|
| I1 | Turn detection on for a broker with a real bridge | devices missing, tags wrongly typed or unnamed |
| I2 | Rename a device in the bridge | that the device keeps its identity and its mapping |
| I3 | Take a device offline (availability, LWT, dead node, bridge stopped) | that its tags go Bad and the mapping publishes `_status` offline |
| I4 | Home Assistant devices with real value templates | templates shown as *template not supported* |
| I5 | **A subscriber on the bridges' command, set and downlink topics** while Manifold runs | any message from Manifold (there must be none) |

## Discovery probes on a real network (optional)

Only on a network you may scan, with a small range, in a window. Tick the device
protocols (and, each on its own, BACnet/IP, CoAP and SNMP) and scan a range with known devices. *Confirms:* each device is
reported by the right protocol (Modbus: any register or exception reply; S7: a
COTP CC or DR; EtherNet/IP: ListIdentity with vendor, product name and
revision); closed ports and non-devices are not reported; nothing is written to
any device (the capture shows only the three requests described on
[Devices and Drivers](Devices-and-Drivers#finding-devices-on-the-network-discovery)).
*Report:* any device that reacted badly (reset, fault, alarm) and its model.

## Timebase direct write

Run these against a real Timebase Historian (2.x is current; CI exercises
`timebase/historian:1.3.4`). Manifold writes
`POST {url}/api/datasets/{dataset}/data` with a body `{ "<tag>": [ { "t": ISO,
"v": value, "q": quality } ] }`, oldest first per tag, with `Authorization:
Bearer <apiKey>` when a key is set, and reads back with `GET
.../data?tagname=...&start=...&end=...`.

| # | Check | How | Confirms / refutes |
|---|---|---|---|
| T1 | **Ordering.** Write a sample at 12:00:10, then one at 12:00:05 for the same tag; query | Use the historian's **Test write** and a script with `curl` | Confirms or refutes that an older TVQ is ignored (a code comment says it is). If it is **not** ignored, the strict oldest-first outbox is merely cautious; if it is, the outbox ordering is essential |
| T2 | **Bad sample without a value.** Disconnect a device that feeds a binding with a direct historian target and an `envelope` format | Look at the stored point | Manifold sends `v: null` with the quality; report whether Timebase accepted it, how it stores and returns it, and the HTTP status if refused |
| T3 | **Resolution.** Write two samples 100 ms apart | Query both | Timebase advertises 500 ms storage resolution; report whether both are kept. Avoid poll groups under 500 ms with a Timebase target until known |
| T4 | **Duplicates.** Write the same timestamp and value twice, then the same timestamp with a different value | Query | Confirms or refutes "first-in-wins" (the second identical pair is discarded). If confirmed, outbox retries after an ambiguous failure are safe |
| T5 | **Quality codes.** Write q 192, 64 and 0 | Query and compare to the Timebase quality model | Report the mapping Timebase applies (Manifold sends 192, 64, 0) |
| T6 | **Limits and auth.** A batch of increasing size; an invalid and a valid token; a dataset that does not exist | Note the status codes | Report the batch limit, how authentication fails, and whether the dataset is created on first write (Manifold assumes it is) |

## What to report back

For each item you ran: its id (for example `S4`, `E6`, `M3`), **confirmed**,
**refuted** or **not tested**, the device model and firmware, what you saw
(the status codes, bytes or values; attach the capture for anything refuted),
and anything surprising. A short template:

```text
Item: E6 (BOOL arrays)        Result: REFUTED
Device: 1769-L33ER, firmware 32.011, via 1769-AENTR
Observed: BoolArr[37] returned BOOL (0xC1) when the element index was 37, not
          a DWORD at index 1; capture bool-array.pcapng frames 41-44
Manifold: <commit or version>, driver S7/EIP/Modbus/BACnet/..., interval 1000 ms
```

A driver leaves "experimental" only when its checklist is fully run and every
refuted item is fixed or documented as a limit. Open an issue with the table of
results and the captures; the NOTES file for the protocol should be updated with
the findings.
