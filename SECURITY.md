# Security Policy

Manifold is a **control plane**, not a passive viewer: its API can publish to
brokers (including Sparkplug commands that actuate equipment), disconnect
connections, and run network scans. Its device drivers and its IoT-over-MQTT
detection only ever **read** from devices, but see the note on device networks
below. Treat every deployment accordingly.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for an
unpatched vulnerability.

- Use GitHub's **[Private vulnerability reporting](https://github.com/zbest1000/manifold/security/advisories/new)**
  (Security tab → "Report a vulnerability"), or
- open a regular issue that says only "security contact requested" with no
  details, and a maintainer will arrange a private channel.

Please include: affected version/commit, a description, reproduction steps or a
proof of concept, and the impact you observed. We aim to acknowledge within a
few days and to ship a fix or mitigation as fast as the severity warrants.

## Deploying Manifold safely

Manifold ships usable-by-default, not hardened-by-default. Before exposing an
instance beyond your own machine:

- **Set `MANIFOLD_AUTH_TOKEN`** (or `MANIFOLD_TOKENS` for named, revocable,
  per-user tokens). Without a token the server binds **loopback only** and warns
  loudly; exposing an unauthenticated instance off-host requires deliberately
  setting `MANIFOLD_HOST=0.0.0.0`.
- **A token-less local instance answers only to loopback names.** While it is bound to
  loopback without a token, a request whose `Host` is not `localhost`, `127.x`, `::1` or a
  name listed in `MANIFOLD_ALLOWED_HOSTS` is refused with 421, and the Socket.IO handshake
  refuses a browser `Origin` other than the page's own or `CLIENT_URL`. A web page you open
  therefore cannot drive the instance through DNS rebinding or a cross-site WebSocket.
- **Use a read-only viewer token** (`MANIFOLD_VIEWER_TOKEN`) for anyone who
  should not publish, actuate, or reconfigure. A viewer token on its own also
  turns auth on, so set an admin token as well. In `MANIFOLD_TOKENS` an unknown
  role is rejected (it is never treated as admin); if every entry is rejected,
  auth stays on and all requests are refused. Viewers can call only a short
  allowlist of read-only POSTs (historian queries, pipeline and mapping previews, name
  suggestions, subscription resolve, schema inference, device tag validation, i3X reads,
  CESMII history; the list is `VIEWER_READ_ONLY_POSTS` in `server/services/authConfig.js`),
  cannot read the audit trail. The console disables every mutating control for a viewer
  session and says why.
- **Alert webhook URLs are secrets.** For chat webhooks the path is the credential, so no
  role gets the URL back: rule answers (including `409` bodies) carry `hasWebhook` and the
  origin only, the editor shows "Set, calls <origin>" with **Replace** and **Remove**, and
  config export and the audit log redact it.
- **`/metrics` needs a token** whenever auth is on (a viewer token is enough for
  Prometheus). `MANIFOLD_METRICS_PUBLIC=1` opts out; `/health` stays open.
- **Keep network targets scoped.** Outbound connections (the discovery scanner
  and the i3X/CESMII/broker-admin HTTP clients) pass through an egress guard:
  loopback, link-local (including cloud metadata `169.254.169.254`), multicast,
  and reserved ranges are always blocked. RFC1918/LAN targets are **fail-closed
  by default**; set `MANIFOLD_ALLOW_PRIVATE_TARGETS=1` only on a trusted on-prem
  network (needed for Discovery, on-prem i3X/CESMII and PLCs on a plant network —
  the server warns at startup when it's on). The guard also covers alert
  webhooks (so a webhook to `localhost` is refused) and **device targets**;
  loopback device targets need the separate opt-in
  `MANIFOLD_ALLOW_LOOPBACK_DEVICES=1`, meant for local simulators only. A device hostname is resolved and validated in the server process, the driver connects to the validated address (no second resolution), and the name is re-checked on every host restart and every 30 s. It does
  **not** cover MQTT broker hosts, OPC UA endpoints or historian/database URLs.
  That is a deliberate choice: a broker or historian on `localhost` or the LAN is
  the standard setup. These three still **refuse link-local and cloud-metadata
  targets**: 169.254.0.0/16 (including `169.254.169.254`), fe80::/10, the
  single-address metadata helpers (Azure `168.63.129.16`, Alibaba `100.100.100.200`,
  Oracle `192.0.0.192`, AWS `fd00:ec2::254`, also in IPv4-mapped/NAT64/6to4 form) and
  well-known metadata host names (`metadata.google.internal`, `instance-data`, ...).
  The check runs at save (403 `EGRESS_BLOCKED`) and at connect, on the resolved
  address: MQTT connects through a lookup that refuses those addresses on every
  (re)connect, OPC UA re-checks before every session and discovery, historians before
  every request and database query (an HTTPS historian with a custom CA or
  self-signed setting also connects through the guarded lookup; for the others and for
  TimescaleDB the library resolves the name again, so a DNS answer that changes between
  the check and the connect is a residual risk). Private, LAN and loopback addresses
  are not restricted for these three. The residual risk is that anyone holding an
  admin token can make the server connect to any other host it can reach through
  those three paths, internal services included, so protect admin tokens and use
  network policy.
- **A stored secret never follows an address change.** Editors keep a stored password,
  token or community when the field is left blank, because the API never shows it.
  When the scheme, host or port changes (for a URL: its origin) and no new secret is
  entered, the save is refused with 400 `{ code: 'secret-required', field }` and the
  form says "The address changed, so the password must be entered again". This covers
  MQTT brokers, the broker admin API URL (a masked `user:***@host` saved against another
  host), historians (token, API key, database password, password in the URL), OPC UA
  connections and devices (HTTP passwords and tokens, SNMP community and v3 passwords,
  bridge-server tokens), including the device connection test. A name or path change
  keeps the secret. Config import never restores a stored secret into an imported item
  whose endpoint differs from the stored one. CESMII requires its secret on every save
  and i3X drops its token when it is not supplied, so neither keeps a secret across a
  change.
- **Network discovery** <a id="network-discovery"></a>(the CIDR scan) is opt-in for PLC protocols, read-only
  and bounded, but it is still a port scanner. The rules, in one place:
  - *Which addresses.* Every address goes through the egress guard. Public: scanned. RFC1918
    (`10/8`, `172.16/12`, `192.168/16`): only with `MANIFOLD_ALLOW_PRIVATE_TARGETS=1`. Loopback
    (`127.0.0.0/8`): only with `MANIFOLD_ALLOW_LOOPBACK_DEVICES=1`, the same explicit opt-in device
    drivers use for local simulators, honoured for every probe kind except i3X (whose client cannot
    connect to loopback, so a hit would be a dead end). Link-local and cloud metadata
    (`169.254/16`, including `169.254.169.254`), multicast and reserved space (`0/8`, CGNAT,
    TEST-NET, `240/4`): never, whatever you set. Why loopback is an opt-in and not on: a scan of
    `127.0.0.1` is an unauthenticated port probe of the server's own host (databases, admin ports).
    The startup warning for `MANIFOLD_ALLOW_LOOPBACK_DEVICES` covers scans too. A refused range's
    message names the one flag that would allow it, or says that nothing will.
  - *What is sent.* A TCP connect to each selected port; only open ports get an identification
    handshake (MQTT CONNECT, OPC UA Hello then GetEndpoints over security None without a session, i3X `GET /info`, Modbus FC 43/14 then FC 3, S7 COTP and the
    read-only SZL identity read, EtherNet/IP ListIdentity), built with the drivers' allowlisted
    encoders (Modbus FC 43 is a fixed 11-byte frame outside the driver's allowlist, which still refuses
    everything but FC 1 to 4). The UDP kinds are each opt-in on their own and send one unicast
    exchange per address and port: BACnet/IP a unicast Who-Is and a ReadProperty of the device object,
    CoAP one `GET /.well-known/core`, SNMP one v2c GetRequest with the community `public` (a
    community string goes on the wire, which is why it has its own tick box). Nothing is broadcast
    and nothing is ever written; the simulators count writes and the tests assert zero.
  - *How hard.* At most 32 sockets at once and 2 per address by default, bounded timeouts, a limit of
    1,024 hosts per scan (`MANIFOLD_DISCOVERY_MAX_HOSTS`), and Cancel destroys every socket at once.
    Starting a scan needs an admin token (a viewer token is refused). Even so, fragile PLCs and gateways can
    react badly and intrusion-detection systems will notice: scan only networks you are allowed to scan.
- **Treat device networks as writable by everyone on them.** Modbus TCP, S7comm,
  plain EtherNet/IP, BACnet/IP, SNMP v1/v2c, plain CoAP and the Matter and Z-Wave
  JS servers do not authenticate clients (or, for SNMP v1/v2c, send the community
  in clear), and enabling PUT/GET on an S7 CPU (required for Manifold to read it)
  makes its data blocks readable and writable by any peer. Manifold's drivers never
  send a write, but that is a property of Manifold, not of the device. Where a hard
  guarantee is needed, use a firewall rule or data diode in front of the device.
  Every driver except Modbus TCP is **experimental — not verified on real
  hardware**: checked only against simulators.
- **Read-only guarantees, per driver.** Each driver builds every outgoing request
  through one encoder with an allowlist, and the tests assert that nothing else
  reaches a socket:

  | Driver | The only requests it can build |
  |---|---|
  | Modbus TCP | function codes 1 to 4 |
  | Siemens S7 | setup communication, Read Var, SZL read |
  | EtherNet/IP | session management, Forward Open/Close, Read Tag (Fragmented), Multiple Service Packet (each inner service checked), attribute and template reads |
  | BACnet/IP | unicast Who-Is, ReadProperty, ReadPropertyMultiple (no WriteProperty, no COV subscription, nothing broadcast) |
  | SNMP | GetRequest, GetNextRequest, GetBulkRequest; no SetRequest encoder exists |
  | HTTP/JSON, MTConnect | `GET` without a body (MTConnect: `/probe`, `/current`, `/sample`); redirects only to the same host, port and scheme |
  | CoAP | `GET` and the empty ping / acknowledgement messages; no DTLS |
  | Matter Server | `start_listening`, `get_nodes`, `get_node`, `server_info`, `diagnostics`, `read_attribute` |
  | Z-Wave JS Server | `set_api_schema`, `start_listening`, `node.get_defined_value_ids`, `node.get_value_metadata`, `node.get_value` (answered from the server's cache) |

- **Device secrets are never sent back.** HTTP passwords, bearer tokens and custom
  header values, SNMP communities and v3 passwords and the bridge servers' bearer
  token are stored with the device in `profiles.json` and passed to the driver
  process. Every API answer carries a stored secret as `null` (lists, saves, bulk,
  profile instances and the `409` conflict body); an edit that leaves it blank keeps
  it, and a secret the settings no longer use is dropped. Config export and the
  audit log redact them.
- **IoT devices over MQTT are read, never commanded.** Detection (off by default,
  per broker and convention) only subscribes; the IoT code never calls publish, so
  nothing is sent to Zigbee2MQTT, Z-Wave JS UI, Home Assistant, Tasmota, Shelly or
  LoRaWAN command, set or downlink topics. A mapping is refused when it would publish
  into topics that detection reads on the same broker. Home Assistant value templates
  are evaluated by a small evaluator that runs no code. Payloads are bounded (size,
  JSON depth, devices and tags per broker) and malformed ones are counted and skipped.
- **The broker canary publishes only when you turn it on.** It is off by default and
  the connect form says that it publishes. When enabled it sends a small, never-retained
  message to its canary topic (default `manifold/canary/<id>`) on the configured interval
  and receives it through its own subscription. A custom topic must start with
  `manifold/canary/` and may not contain a level used by command, request or Sparkplug
  topics (`set`, `get`, `cmd`, `cmnd`, `command`, `rpc`, `down`, `api`, `write`,
  `_CLIENTS`, `NCMD`, `DCMD`, `spBv*`), so the canary can never publish to a system
  (`$...`), Sparkplug or command topic. Canary traffic is kept out of topics,
  the UNS, recordings, pipelines, mappings and alerts. The **security posture** is
  computed from what Manifold already knows about the connection; nothing is probed.
- **Public test-broker presets are public.** The connect form's presets (EMQX,
  HiveMQ, Mosquitto test brokers) point at shared brokers where anyone can read and
  publish; they subscribe to `testtopic/#` only. Do not use them with plant data.
  Their host names and ports were written from memory, not checked against the
  operators' current documentation.
- **The console keeps the access token in the browser.** The unlock screen stores it in
  `localStorage` (`tc.authToken`) of that browser profile, so use a trusted device and
  **Settings → General → Session → Sign out / use a different token** to remove it. Any
  script running in the page origin could read it; the server sends `helmet` security
  headers and locks CORS to `CLIENT_URL`.
- **Protect the data directory.** `profiles.json` stores broker passwords and
  admin API keys (owner-readable `0600`), and so do its rotating backups
  (`profiles.json.bak.*`); restrict the host and the directory. The audit log
  rotates by size and never records bearer tokens, only token names.
- **Config exports are secret-stripped by field name** (device tag `key`
  identifiers are kept, a secret inside a tag or a TLS `key` is not); review an
  export before committing it.
- **Put TLS and a reverse proxy in front** of any internet-facing instance, and
  prefer network segmentation for OT deployments (IEC 62443 zones/conduits). Behind
  a proxy, set `MANIFOLD_TRUST_PROXY` to the number of proxy hops (`1`) or the proxy
  addresses, so the rate limit, the auth-failure throttle and the audit log see each
  client instead of the proxy (off by default; `true` is refused, since it would let
  any client choose its own address with `X-Forwarded-For`).
- **Watch for degraded storage.** When the configuration store or the alert history
  cannot be written (disk full, permissions), `GET /api/system/status` answers
  `degraded`, Overview lists it under **Needs attention** and the Health page shows a
  banner: changes are then not being saved and are lost on restart.

## Supported versions

Security fixes target the `main` branch and the latest tagged release. Older
tags are not maintained.
