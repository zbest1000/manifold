# BACnet/IP driver: notes

Status: **experimental, not verified on real hardware.** Everything below was checked only against
`server/test/support/bacnetSimulator.js`, which was written together with the driver (with its own,
independent encoder). It shows that the two agree, not that either matches real firmware.

References used: ASHRAE 135 clause 6 (NPDU), clause 20 (APDU and tag encoding), clause 21
(enumerations), Annex J (BACnet/IP, BVLC). The enumeration tables in `enums.js` are generated from
the MIT-licensed bacnet-stack header `src/bacnet/bacenum.h` (names in kebab case); unit symbols in
`units.js` are keyed by the standard unit NAME, so a symbol cannot land on the wrong number.

## What is sent (read-only by construction)

`frame.encodePacket` is the only way to build a datagram. It accepts BVLC Original-Unicast-NPDU
only, an NPDU without network-layer message, and an APDU that is either Confirmed-Request
**ReadProperty (12)** or **ReadPropertyMultiple (14)** (unsegmented), or Unconfirmed-Request
**Who-Is (8)**. Anything else throws `BacnetReadOnlyError` before reaching the socket. There is no
encoder for WriteProperty, WritePropertyMultiple, SubscribeCOV(-Property), DeviceCommunicationControl,
ReinitializeDevice, Create/DeleteObject, Add/RemoveListElement, AtomicWriteFile, private transfer,
time synchronisation, I-Am, Segment-ACK, BBMD management (Register-Foreign-Device, Write-BDT) or any
network-layer message. Who-Is is sent **unicast to the configured device only**; nothing is broadcast.

COV is not used: SubscribeCOV writes to the device's subscription list. Values are polled.

## Deviations and pitfalls handled

1. **Who-Is answered by broadcast.** Many devices answer even a unicast Who-Is with a broadcast I-Am
   to port 47808, which the driver (ephemeral local port) never receives. The driver then reads the
   device object directly: with the configured instance, or with the wildcard instance 4194303 to
   learn it. Max APDU and segmentation then come from the device object's
   `max-apdu-length-accepted` and `segmentation-supported`.
2. **Max APDU and segmentation.** Taken from the I-Am (or the device object), capped at 1476 and by
   the optional `maxApdu` override (for devices that misreport). The client never accepts segmented
   replies (the "segmented-response-accepted" bit is 0), so the planner sizes every
   ReadPropertyMultiple so that the request and a worst-case reply estimate fit in one APDU.
3. **Reply too large anyway** (Abort segmentation-not-supported / buffer-overflow / apdu-too-long,
   Reject buffer-overflow, or a device that segments regardless): an RPM with several tags is split
   (runtime bisect); a single value falls back to ReadProperty; a value that still does not fit is
   quarantined with a message saying to read it by array index.
4. **RPM not supported.** `readMultiple: auto` tests RPM at connect on the device object; Reject
   unrecognized-service or Error services/optional-functionality-not-supported or
   service-request-denied switches to ReadProperty for the session. A device that starts rejecting
   RPM later falls back within the same poll cycle and re-plans.
5. **RPM per-property errors.** Each property result is parsed on its own. Unknown object, unknown
   property, invalid array index, read-access-denied, not-an-array are permanent: the request is
   split so the healthy tags stay together and the failing tag is quarantined alone with the
   device's reason. Transient errors (device-busy, configuration-in-progress, ...) make the tag Bad
   for that cycle only. Errors on the status properties read with present-value (reliability is
   optional on many objects) are ignored.
6. **Whole-RPM Error.** Some devices answer an RPM naming one unknown object with a single Error PDU
   for the whole request; the driver splits until the bad object is isolated.
7. **Invoke ids.** One socket per device; ids 0-255 allocated round-robin, never reused while
   pending, and **retired for 10 s after a timeout**, so a late reply is dropped instead of answering
   a newer request (the UDP equivalent of the TCP drivers' "destroy the socket after a timeout").
   Replies must also match the request's service choice. Concurrency is configurable
   (`maxOutstanding`, default 1) and used for browse and the ReadProperty fallback.
8. **Retries and timeouts.** Each confirmed request is re-sent with the same invoke id up to
   `apduRetries` times after `apduTimeoutMs`, all within the runtime's request deadline. No answer
   at all is fatal: the runtime marks every tag Bad, closes the socket and reconnects with backoff
   (a new socket, a new local port).
9. **Devices behind routers.** `network` + `mac` put DNET/DADR (hop count 255) in the NPDU; replies
   must carry the matching SNET/SADR. MAC forms: MS/TP `0-127`, remote B/IP `10.0.0.5:47808`, hex.
   A Reject-Message-To-Network from the router fails the request with the router's reason. When a
   device configured as local answers with a source network (a gateway with a virtual network), the
   timeout message names the network and MAC to configure.
10. **Replies from another source port.** Accepted: only the source IP must be the device's (pinned)
    address. Datagrams from any other address are counted and dropped.
11. **Error/Reject/Abort** are turned into text with the class/code/reason names and a hint, and
    counted per code in the device status (`property/unknown-property`, `reject/...`, `abort/...`).
12. **Error PDU wrapped in context tag 0** by some stacks is accepted.
13. **object-list too large for one APDU**: browse reads `object-list[0]` (the count) and then the
    entries by array index, batched in RPMs (or one ReadProperty each), capped at 10,000 objects.
    Types are folders; more than 100 objects of a type are paged.
14. **Character strings**: UTF-8, UCS-2 (big endian), UCS-4, ISO 8859-1 are decoded; DBCS and JIS
    are returned as latin1 text with the character set named (no code-page tables).
15. **Quality**: with present-value the driver reads status-flags, reliability and out-of-service.
    Reliability other than no-fault-detected or the FAULT flag = Bad (`reliability: <name>` /
    `fault`); out-of-service = Uncertain. IN_ALARM and OVERRIDDEN keep Good (the value is real).
    In ReadProperty mode only status-flags is read (one extra request per tag).

## UDP and the shared runtime

No change to `drivers/runtime/*` or `egressGuard.js` was needed. The runtime is protocol-agnostic
(connect / plan / execute / bisect / browse / probe). The egress guard checks the device host at
save, test and apply as for TCP; the driver sends only to the pinned, validated address
(`connectAddress`), refuses a hostname without a pin, and accepts replies only from that address.
The only shared change is the registration line in `services/deviceManager.js`.

## Not supported

- Segmented replies (receive) and segmented requests; values larger than one APDU must be read by
  array index.
- WriteProperty and every other write or control service (by design).
- COV subscriptions (they write to the device), event/alarm services, ReadRange (trend logs),
  file access.
- Broadcast Who-Is, Who-Has, and foreign-device registration with a BBMD (the latter writes the
  BBMD's foreign-device table). A device on another IP subnet is reached by unicast to its address
  or through a BACnet router's address with network + MAC.
- A device that only answers to source port 47808 (some old devices reply to 47808 regardless of
  the request's port): the driver uses an ephemeral port so that several devices share one host
  process; such a device times out.
- BACnet/IPv6, BACnet/SC, MS/TP directly (only through a router), Ethernet (ISO 8802-2).
- Proprietary object types and properties are readable by number; their constructed values are
  shown as raw context-tagged structures.
- Engineering-unit text for proprietary units: the numeric code is shown.

## To verify on real hardware

1. Unicast Who-Is from a non-47808 port: which devices answer unicast, which broadcast.
2. ReadProperty on device 4194303: supported by the target devices?
3. RPM response sizing on devices with max APDU 50/128/206/480; how each reports an oversize reply.
4. Whole-RPM Error vs per-property errors on real stacks.
5. Routed reads through a real B/IP-to-MS/TP router (timing, APDU timeout needed, Reject-Message
   reasons).
6. Replies from a different source port (some routers) and devices that only reply to 47808.
7. object-list browse on a device with thousands of objects (time, RPM batching limits).
8. Character sets other than UTF-8 in object names.
9. Status-flags / reliability semantics per vendor for quality.
10. Discovery probe (unicast Who-Is + wildcard read) against real devices and IDS reactions.
