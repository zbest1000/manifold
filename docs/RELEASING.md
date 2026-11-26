# Releasing Manifold

## Cutting a release

Releases are driven entirely by git tags. From a checkout of `main`:

```bash
git pull origin main
git tag -a v1.1.0 -m "Manifold 1.1.0"
git push origin v1.1.0
```

(Equivalently: GitHub → Releases → *Draft a new release* → create tag `v1.1.0`
on `main` → publish. Tags created through the Releases UI fire the same
workflow.)

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which:

1. Builds the root `Dockerfile` (client bundled into the server image) and
   pushes `ghcr.io/<owner>/manifold` tagged `<version>`, `<major>.<minor>`,
   and `latest` (linux/amd64).
2. Creates a GitHub Release for the tag with generated notes and a link to
   [CHANGELOG.md](../CHANGELOG.md).

Before tagging: bump the `version` field in `package.json`,
`server/package.json`, `client/package.json`, and `mcp/package.json`, add a
CHANGELOG entry, and merge that to `main` first. (For v1.1.0 this is done:
every `package.json` and the root entries of each `package-lock.json`, the MCP
server's reported version in `mcp/index.js`, and the `[1.1.0]` CHANGELOG section.)
The release body points to the CHANGELOG; paste the release notes into the
GitHub release by hand if you want more than the generated list.

## Verification status

What is proven versus assumed, as of v1.1.0. CI runs on every push and pull
request: the `server` job runs the whole node:test suite (including a real
node-opcua server and an in-process MQTT broker), and the `integration` job runs
the server against **real** EMQX, InfluxDB, TimescaleDB and Timebase
(`timebase/historian:1.3.4`) containers (`server/test/services-int.test.js`).

### Proven in CI against real services

- MQTT intake, QoS-1 fallback, wildcard resolution (real EMQX over TCP).
- MQTT 5 over WebSocket: `ws://…:8083/mqtt`, `protocolVersion 5`, user
  properties surviving the broker round-trip into the topic store.
- InfluxDB: line-protocol writes **and** the Trends read-back path
  (`queryTags` + `querySeries`, the functions the UI calls).
- TimescaleDB: batch inserts into a real hypertable and `time_bucket`
  read-back.
- Timebase: TVQ writes to `POST /api/datasets/{dataset}/data` (datasets
  auto-create) and `querySeries` read-back, including a window-before-writes
  emptiness check, so the `start`/`end` query parameters are proven honored.
- **OPC UA against a real node-opcua server** (`server/test/support/opcuaTestServer.js`):
  endpoint discovery, None, **Sign and SignAndEncrypt** (Basic256Sha256,
  Aes128_Sha256_RsaOaep) with anonymous and user name logins, the trust flow
  (untrusted certificate refused, trusted by thumbprint, then connected),
  server restarts, outages, session and subscription loss, and bindings with
  Bad on loss and Good on recovery. Trust-on-first-connect now trusts exactly
  the certificate fetched from the endpoint; there is no global accept window
  a concurrent connect could use.
- Sparkplug publisher and host STATE lifecycle, including retained-will
  delivery on abrupt death (in-process broker).
- The UI: every route in both themes at desktop and phone width with axe
  checks (serious and critical findings fail), against the real backend.

### Still assumed — verify when you have the environment

- **The release pipeline itself.** `release.yml` and the root `Dockerfile` have
  never executed end-to-end (the development environment had no Docker daemon
  and no tag-push permission). The first `v1.1.0` tag is the real test. Since
  1.0.0 the workflow's actions were upgraded and every action is pinned to a
  commit SHA, which has not been exercised on a tag either. If the image build
  fails, start with the `npm ci` steps and the `/app/server` +
  `/app/client/dist` layout. After the image is pushed, run it with a token
  (`-e MANIFOLD_AUTH_TOKEN=...`): without one the server binds loopback inside
  the container and the published port reaches nothing.
- **Device drivers and IoT conventions on real hardware.** None has been run
  against a real device; every driver except Modbus TCP is experimental. See
  [Verifying on real hardware](wiki/Verifying-on-Real-Hardware.md).
- **Third-party OPC UA servers** (Kepware, Siemens S7-1500, Ignition, Prosys)
  and tens of thousands of monitored items.
- **Timebase REST details**: ordering of old samples, the shape of a Bad sample
  without a value, the 500 ms resolution, quality codes and batch limits; and
  authentication: the CI container runs unauthenticated, and the `apiKey` →
  `Authorization: Bearer` mapping has not been exercised against a secured
  instance. CI uses 1.3.4; 2.x is current.
- **Public test-broker presets**: host names and ports written from memory.
- **WebSocket path defaults.** `wsPath` defaults to `/mqtt` (EMQX/HiveMQ
  convention). Mosquitto's websocket listener uses no path — set `wsPath`
  accordingly per broker.
- **Shared subscriptions under load.** `$share/<group>/<filter>` intake is
  proven to subscribe correctly; load-balancing across multiple Manifold
  instances hasn't been observed.
- **WebGL and 3D on real GPUs**: only a software renderer was used.
