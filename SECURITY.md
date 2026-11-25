# Security Policy

Manifold is a **control plane**, not a passive viewer: its API can publish to
brokers (including Sparkplug commands that actuate equipment), disconnect
connections, and run network scans. Its device drivers (Modbus TCP, S7,
EtherNet/IP) only ever **read** from devices, but see the note on device
networks below. Treat every deployment accordingly.

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
- **Use a read-only viewer token** (`MANIFOLD_VIEWER_TOKEN`) for anyone who
  should not publish, actuate, or reconfigure. A viewer token on its own also
  turns auth on, so set an admin token as well. In `MANIFOLD_TOKENS` an unknown
  role is rejected (it is never treated as admin); if every entry is rejected,
  auth stays on and all requests are refused. Viewers can call only a short
  allowlist of read-only POSTs (historian queries, pipeline and mapping previews, name
  suggestions, subscription resolve, schema inference, device tag validation, i3X reads,
  CESMII history; the list is `VIEWER_READ_ONLY_POSTS` in `server/services/authConfig.js`),
  cannot see alert webhook URLs, and cannot read the audit trail. The console disables
  every mutating control for a viewer session and says why.
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
  the standard setup. The residual risk is that anyone holding an admin token can
  make the server connect to any host it can reach through those three paths,
  internal services included, so protect admin tokens and use network policy.
- **Discovery of devices is opt-in and read-only, but intrusive.** The scan can
  send one identification request per ticked protocol to every address in a range
  (a Modbus read of one register, an S7 COTP connection request, an EtherNet/IP
  ListIdentity), built with the drivers' allowlisted encoders. Scan only networks
  you are allowed to scan; the scanner refuses loopback and link-local always and
  private ranges unless `MANIFOLD_ALLOW_PRIVATE_TARGETS=1`.
- **Treat device networks as writable by everyone on them.** Modbus TCP, S7comm
  and plain EtherNet/IP do not authenticate clients, and enabling PUT/GET on an
  S7 CPU (required for Manifold to read it) makes its data blocks readable and
  writable by any peer. Manifold's drivers never send a write (each frame
  encoder allows read services only), but that is a property of Manifold, not of
  the PLC. Where a hard guarantee is needed, use a firewall rule or data diode in
  front of the PLC. The S7 and EtherNet/IP drivers are **experimental**:
  verified only against simulators.
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
  prefer network segmentation for OT deployments (IEC 62443 zones/conduits).

## Supported versions

Security fixes target the `main` branch and the latest tagged release. Older
tags are not maintained.
