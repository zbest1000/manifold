# SNMP driver — notes and what to verify on real agents

Read-only SNMP v1 / v2c / v3 (USM) over UDP, BER written by hand, crypto from
Node's built-in `crypto` only. Implemented from the RFCs (1155/1157 v1, 1905 /
3416 PDUs, 2578 SMIv2, 3412 message processing, 3414 USM, 3584 coexistence,
3826 AES, 7860 SHA-2 HMAC) and checked against `server/test/support/snmpSimulator.js`
(same author) plus the RFC 3414 A.3 key-localisation vectors and the FIPS 81
DES-CBC vector. **Experimental until checked against real agents.**

Independent interoperability check (manual, once, not part of the test suite):
against **pysnmp 7.1.34** as the agent, the driver connected, polled and walked
with v1, v2c, v3 noAuthNoPriv and all six authentication protocols at
authNoPriv and authPriv with both DES and AES-128 (21 of 21 combinations), and
reported a wrong authentication password and an unknown user correctly. pysnmp
as the manager read every type from `snmpSimulator.js` at the same 21
combinations, including GetBulk. pysnmp is a second implementation, not a
device: net-snmp and vendor agents are still to be checked (below). In
particular DES with a SHA-2 authentication protocol uses the first 16 bytes of
the SHA-2 localised key (as pysnmp does); other agents may differ there.

## Files

| File | What |
|---|---|
| `ber.js` | BER primitives: definite lengths only, SMI application types, v2 exceptions |
| `message.js` | v1/v2c and v3 framing; **can only encode Get, GetNext, GetBulk** with NULL values |
| `usm.js` | password-to-key, localisation, HMAC truncation, CBC-DES and CFB-AES-128 |
| `session.js` | one UDP socket, request-id / msgID matching, retries, v3 engine state |
| `planner.js` | packs OIDs into PDUs by count and estimated response size |
| `decode.js` | varbind value -> sample (types, text/hex, Opaque float/double) |
| `rate.js` | counter -> per-second rate with wrap and restart handling |
| `oids.js` | numeric OIDs, the small built-in name table, browse roots |
| `identify.js` | the opt-in discovery probe (one v2c Get, community "public") |
| `../runtime/udpTransport.js` | the UDP socket (pinned literal IP, egress re-check, source filter) |

## Deviations and pitfalls handled

1. **Counter32/Gauge32/TimeTicks sent with the sign bit set and no leading zero**
   (some embedded agents): the bytes are read as unsigned; more than 32 bits is
   refused. Counter64 likewise up to 64 bits (9 bytes with the leading zero).
2. **INTEGER wider than 32 bits** from buggy agents: decoded (as int64 string
   when outside the safe range) instead of rejected.
3. **Trailing NULs in OctetStrings** (`"name\0\0"`): dropped before the
   printable check. Non-UTF-8 or control bytes -> colon hex (`00:1a:2b`), per-tag
   `encoding` (`auto` | `text` | `hex`) overrides.
4. **Opaque-wrapped float/double** (net-snmp `ASN_OPAQUE_FLOAT/DOUBLE`, tag
   0x9f78 / 0x9f79, also 0x9f76/7a/7b 64-bit forms): decoded to numbers; any
   other Opaque is hex.
5. **v1 agents and Counter64**: per RFC 3584 a v1 agent hides Counter64 objects
   (noSuchName); the driver reports that tag Bad `noSuchName`.
6. **v1 error-index**: a noSuchName (or any status) with a valid error-index
   drops that one varbind (Bad with the status name) and asks again for the
   rest; the OID is then skipped for 60 s instead of costing an extra request
   every poll. An error-status with index 0 (genErr from some agents) halves the
   batch until the culprit is isolated.
7. **tooBig**: the batch is halved; the largest batch that then fitted becomes
   the per-device cap (the runtime caches its plan, so the driver re-chunks
   internally). A single value that still does not fit is Bad `tooBig` and
   skipped for 60 s. v2c agents answer tooBig with an empty varbind list, v1
   agents echo the request; both are handled.
8. **Response varbinds in the wrong order / wrong OID** (seen on broken
   agents): such a varbind is Bad `oid-mismatch`; a different varbind *count*
   is a framing error (fatal, reconnect).
9. **Wrong community = silence.** Agents drop requests with an unknown community
   without an answer, so the connect error lists the usual causes (community,
   agent ACL, UDP filtered).
10. **ICMP port unreachable**: the socket is `connect()`ed, so an agent that is
    not running fails fast (`unreachable`) instead of waiting out every retry.
11. **Answers from another interface address** (multi-homed agents) are dropped
    by default (the connected socket filters them); `allowAnySource` accepts them.
12. **Stale / duplicated / garbage datagrams**: ignored and counted; retries keep
    the same request-id, so a late answer to an earlier attempt still completes
    the request.
13. **GetBulk walks**: an OID that does not increase stops the walk with a note
    (agent loop protection); tooBig halves max-repetitions; v1 walks use GetNext
    and treat noSuchName as the end of the view. Rows and time are capped
    (`browseMaxRows`, hard max 2000; at most 8 s or 3 request deadlines), with a
    "More" node that continues after the last OID.
14. **v3 engine discovery** uses an empty user name and empty engine ID with the
    reportable flag (RFC 3414 4), accepts either the Report or a Response, then
    for authenticated levels an empty authenticated Get to obtain boots/time via
    notInTimeWindows.
15. **v3 time window** (RFC 3414 3.2 step 7b) on every authenticated message:
    the cached boots/time only move forward; messages older than 150 s or from a
    previous boot are discarded as possible replays.
16. **notInTimeWindows** (agent rebooted, clock jumped) and **unknownEngineIDs**
    (agent replaced, engine ID re-generated) reports are recovered inside one
    request (at most two resyncs; a notInTimeWindows report is only believed when
    it is authenticated, as RFC 3414 has agents send it, so an agent that sends it
    unauthenticated cannot be resynchronised and shows the time-window error);
    the other usmStats reports become clear errors
    (unknown user, wrong digest = wrong auth password/protocol, decryption error
    = wrong privacy password/protocol, unsupported security level).
17. **Single DES with OpenSSL 3**: Node does not load the legacy provider, so
    CBC-DES runs as `des-ede3-cbc` with K1=K2=K3 (identical result; checked
    against the FIPS 81 vector).
18. **AES key from a SHA-2 or SHA-1 localised key**: the first 16 bytes are used
    (RFC 3826 3.1.2.1); no key extension ("Reeder"/Blumenthal) is applied, so
    AES-192/256 are not offered.
19. **Counter rates** use the agent's sysUpTime from the same PDU as the time
    base (immune to retry delay), wrap Counter32 modulo 2^32 and Counter64
    modulo 2^64, and treat sysUpTime going backwards (other than its 497-day wrap)
    as an agent restart (Bad `counter-reset` for one sample).

## Not supported

- **Set** (and therefore any write) — not encodable. No trap or inform
  receiver, no agent.
- MIB files: no compiler. Numeric OIDs plus a fixed table of well-known names
  (system, IF-MIB, ifXTable, HOST-RESOURCES, UPS-MIB, ENTITY-SENSOR, UCD).
- AES-192/256, 3DES privacy (draft-reeder), TSM/TLS/DTLS transport, SNMP over
  TCP or IPv6 scoped addresses beyond what Node's dgram offers.
- Per-context engine IDs other than one `contextEngineId` per device.
- DateAndTime / BITS / textual conventions: shown as hex/text, not decoded.
- Agents that cache table values (net-snmp ifTable ~5 s, many switches): a poll
  interval shorter than the agent's cache gives zero/spiky rates; poll slower.

## Verify on real agents

1. net-snmp `snmpd` (Linux): v1/v2c/v3 every auth/priv combination; compare
   values with `snmpget -On`; check the tooBig behaviour with a small
   `maxMessageSize`.
2. A managed switch (Cisco/HPE/Mikrotik): ifTable/ifXTable rates against the
   switch's own counters; GetBulk walk of 1.3.6.1.2.1.2; a v1-only mode if any.
3. A UPS network card (APC/Eaton) with UPS-MIB: v1 agents and noSuchName
   handling, slow agents (retry/timeouts).
4. Engine reboot on a real v3 agent: boots increments, the driver resyncs
   without going offline; an agent with a re-generated engine ID.
5. An agent behind NAT / multi-homed answering from another address
   (`allowAnySource`).
6. Opaque float values from net-snmp extend scripts.
7. Discovery probe: how IDS/firewalls treat a v2c "public" Get on 161.
