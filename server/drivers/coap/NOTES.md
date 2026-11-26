# CoAP driver notes

Status: **experimental**. Written against RFC 7252, RFC 7959, RFC 7641, RFC 6690, RFC 8428 and
RFC 8949 and tested only against the in-process simulator
(`server/test/support/coapSimulator.js`). Nothing here has been run against real constrained
hardware.

## What it does

- CoAP over UDP, default port 5683, hand-encoded. No dependency.
- **Read only.** The only request the codec can build is `GET` (0.01); the only other thing it
  sends is an empty message (ACK or RST for what a device sent us, and the CoAP ping at connect).
  There is no method parameter anywhere. `assertReadOnlyDatagram` checks the code of every datagram
  right before the socket and refuses anything else (PUT, POST, DELETE, FETCH, PATCH, iPATCH and
  any response code). Observe deregistration is a `GET` with Observe=1, which is a read.
- Confirmable GET with the RFC 7252 retransmission: first timeout `ACK_TIMEOUT x random(1, 1.5)`,
  doubled after each retransmission, `MAX_RETRANSMIT` 4, all configurable per device. The device's
  request deadline caps the whole exchange; raise it for lossy links (the default for new CoAP
  devices is 10 s).
- Message id and token matching (8 random bytes), piggybacked and separate responses (empty ACK,
  then CON or NON; a CON response is ACKed; a response that overtakes its empty ACK is accepted),
  deduplication of incoming CON/NON by message id for `EXCHANGE_LIFETIME`, Reset handling, `NSTART`
  (default 1) outstanding exchanges per device with a bounded queue.
- Block-wise transfer of responses (Block2): our preferred size is proposed in the first request,
  the server's size wins, ETag consistency between blocks (a change restarts the transfer, twice at
  most), `Size2` and a byte cap (default 256 KiB) abort early.
- Observe (opt-in per tag, `observe:` prefix or `tag.observe`): registration, freshness rule of
  RFC 7641 section 3.4 (24-bit serial arithmetic plus the 128 s escape), CON notifications ACKed,
  notifications that arrive in several blocks, re-registration when Max-Age (plus a grace period)
  passes without a notification and after a failed or Reset registration (backoff), fall back to
  polling when the server ignores Observe, deregistration on stop. A value past its Max-Age is
  Uncertain (`stale`).
- Content formats: text/plain, application/json, application/cbor (own decoder: integers, half,
  single and double floats, byte and text strings including indefinite length, arrays, maps, tags,
  simple values; bignums wider than 64 bytes are refused), application/senml+json and senml+cbor (base name/time/unit/value/sum), link-format,
  octet-stream (hex). A response without a Content-Format is read as text when it is printable UTF-8,
  otherwise as hex.
- Tag address: `[observe:]/path[?query][#selector]`. The selector is a dotted path into JSON/CBOR
  (`a.b[0].c`, `["odd.key"]`) or, for SenML, the record name. Own properties only; `__proto__`,
  `constructor` and `prototype` are refused.
- Browse reads `/.well-known/core` (rt, if, ct, sz, obs, title); a JSON/CBOR/SenML resource expands into its
  values, and SenML units arrive as `meta.unit`, which the import dialog copies into the tag's unit.

## Deviations and pitfalls handled

- **Block2 in the first request**: some devices answer `4.02 Bad Option` to it. The driver asks again
  without the option and remembers for the rest of the connection.
- A device that **changes block size** mid transfer: the next block number is recomputed from the
  bytes received; a size that no longer divides them is a protocol error.
- Blocks that carry fewer bytes than their size while More is set, wrong block numbers and a missing
  Block2 option on a continuation are protocol errors (the tag goes Bad; the device stays online).
- A **duplicate** response, a response with the right message id and the wrong token, junk and
  truncated datagrams are ignored, never fatal. A CON/NON response that matches nothing gets a RST.
- A **CoAP ping** (empty CON) is the connect check, so "Test connection" and "Online" mean the device
  answered. Devices that ignore pings need `Check on connect: none`.
- **ICMP port unreachable** surfaces on the connected UDP socket and ends an exchange at once as a
  transport failure instead of waiting out the retransmissions.
- **5.03 Service Unavailable**: Max-Age is the retry hint (default 60 s, at most 5 min); the device is
  not asked again before it passes.
- Responses to a polled tag whose resource has an `Observe` option are fine; a registration answered
  without Observe means "this server does not observe": the tag is polled for the rest of the connection.
- Max-Age is only a staleness hint for observed values; a polled value is fresh when it arrives.
- Unknown Content-Format numbers are read as hex rather than guessed; SenML fields whose label ends in
  an underscore are must-understand and refuse the whole pack; SenML versions above 10 are refused.
- A datagram larger than 1152 bytes is never sent; the received size is not limited by the socket
  except through the response caps.

## UDP in the runtime

- One UDP socket per device driver (`coapUdp.js`): bound to an ephemeral port, `connect()`ed to the
  device so the kernel drops datagrams from other sources, and every received datagram is checked
  against the device address again.
- **Egress guard**: the destination has to pass the device policy (`assertAllowedHost` with
  `device: true`) when the socket opens: loopback only with `MANIFOLD_ALLOW_LOOPBACK_DEVICES=1`,
  RFC1918 only with `MANIFOLD_ALLOW_PRIVATE_TARGETS=1`, metadata, multicast and broadcast never.
- **Address pinning**: the socket only accepts an IP address. The main process resolves a device
  hostname, checks it and passes the validated address in `device.pinned.addresses`; a hostname that
  reaches the driver unresolved is refused.
- Unicast only: no multicast group is ever joined or addressed (no multicast discovery).
- `coapUdp.js` is deliberately self-contained so other UDP drivers can adopt or replace it later.
- Discovery: an opt-in probe (`coapPorts` or `includeCoap`) sends ONE unicast `GET /.well-known/core`
  (one retransmission) per address and port. `includeDevices` does not turn it on. It is the CoAP entry
  of the shared UDP probe table (`UDP_PROBES` in `server/services/discovery.js`).

## Not supported

- **DTLS (`coaps://`, port 5684), pre-shared keys, raw public keys and certificates.** Node has no
  built-in DTLS. `coaps://` in the host or in a tag address is refused with this explanation, and so
  is port 5684. Secured devices cannot be read.
- CoAP over TCP, TLS or WebSockets (RFC 8323).
- Any method other than GET: no PUT, POST, DELETE, FETCH, PATCH, iPATCH; no Block1; no conditional
  requests, no ETag validation requests.
- Multicast requests and multicast discovery (RFC 7390 groups, `224.0.1.187`, `ff0x::fd`).
- Proxying (Proxy-Uri, Proxy-Scheme), Uri-Host virtual hosting, Uri-Port.
- Group communication, resource directory, CoRAL, OSCORE, the `rt`/`if` semantic registries beyond
  showing the strings.
- application/senml-exi, EXI, XML, application/sensml+json streaming lists, LwM2M TLV/JSON (those are
  shown as hex).
- NON requests (every request is confirmable); NSTART above 1 is allowed but not recommended.
- Observe notifications are kept as the latest value per resource; there is no history or buffering of
  notifications that arrive between two poll cycles (the runtime is poll-based).
- The SenML time stamp is not used as the sample time: the sample carries the read time.

## Tests

`coap-codec.test.js` (wire format, malformed input, CBOR vectors from RFC 8949, SenML, link-format,
selector, address), `coap-client.test.js` (transactions, retransmission timing, separate responses,
dedup, Reset, NSTART counted by the client's own in-flight counter, block-wise, observe),
`coap-driver.test.js` (values, errors, observe through the driver, browse, probe, planning, guard and
pinning, read-only), `coap-int.test.js` (DeviceManager and a real child host process),
`coap-discovery.test.js`.
