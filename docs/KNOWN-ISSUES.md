# Known issues

What is still open in Manifold 1.1.0, checked against the code. Fixed defects are in the
[CHANGELOG](../CHANGELOG.md); how to report a security problem is in [SECURITY.md](../SECURITY.md).

## Not verified

- **No driver and no IoT-over-MQTT convention has run against real hardware.** Every driver was
  checked only against simulators written with it; every driver except Modbus TCP is marked
  experimental. The procedure for engineers with devices is
  [Verifying on real hardware](wiki/Verifying-on-Real-Hardware.md).
- **OPC UA was verified only against node-opcua's server**, not against Kepware, S7-1500,
  Ignition, Prosys or large item counts.
- **WebGL and 3D graphs ran only on a software renderer** (SwiftShader in headless Chromium);
  there is no real-GPU performance data.
- **No screen-reader or manual keyboard audit.** Accessibility is checked automatically (axe on
  every route in both themes, `client/e2e/`) and by the keyboard paths the specs drive.
- **The public test-broker presets** on the broker form (EMQX, HiveMQ, Mosquitto) were written from
  memory, not checked against the operators' current documentation.
- **The release pipeline has never run.** `.github/workflows/release.yml` was never executed end to
  end; the first `v1.1.0` tag is its first test ([RELEASING](RELEASING.md)).
- **Timebase details beyond writes are unconfirmed**: ordering of old samples, the shape of a Bad
  sample without a value, quality codes and batch limits (`server/services/historians.js`).

## Behaviour to know

- **A pipeline historian target stores an envelope payload as JSON text.** Add a `numeric`
  transform with `field: "v"` to store the number (`server/services/pipelineEngine.js`). A
  mapping's direct historian target is not affected.
- **Retained cleanup is bounded** to 20,000 recorded topics per broker; the rest is counted and not
  cleaned automatically.
- **Idle topics are never evicted by default**, so a broker with an unbounded set of topic names
  eventually reaches the topic cap; set `MANIFOLD_TOPIC_IDLE_TTL_MS` ([Operations](wiki/Operations.md)).
- **Not supported:** CoAP over DTLS (`coaps://`) and HTTP digest authentication.

## Open UI issues

- **Wide tables scroll their row actions out of view** on tablets (1024 px with the sidebar open)
  and phones: Brokers, Routes, Historians, Recorder, Codecs, Mappings, Profiles, OPC UA, Alert
  rules. Alerts and Devices switch to cards; the others do not.
- **Overview, Connections:** the Type column mixes driver ids (`modbus-tcp`) with labels (`OPC UA`,
  `MQTT`) (`client/src/pages/Overview.jsx`, `ConnectionsPanel`).
- **Touch targets on phones:** row checkboxes and sortable headers are 16 px, below the WCAG 2.2
  24 px minimum (`Checkbox` in `client/src/components/ui/controls.jsx`, `Th` in `table.jsx`).
- **Trends, Export CSV without a token:** the browser downloads the URL directly, so a server error
  arrives as a downloaded JSON file instead of a message (`client/src/lib/trendsExport.js`).
- **A reopened OPC UA mapping** leaves the tag table's Unit and Description placeholders blank; the
  tag's details panel shows the server's values (`client/src/pages/tags/editor/TagTable.jsx`).
- **The Sparkplug primary-host control is on the Tags page**, not on the broker
  (`client/src/pages/tags/HostStatePanel.jsx`).
- **Sorting is partial:** the Historians, Recorder, Models and Contracts lists do not sort.
- **The mapping preview has no lint delta**; it shows collisions, raw-address and option warnings
  only (`previewBinding` in `server/services/bindingModel.js`).

## Accepted security limits

See [SECURITY.md](../SECURITY.md) for the deployment rules these sit in.

- **MQTT broker hosts, OPC UA endpoints and historian URLs are outside the egress guard**, by
  decision; only link-local and cloud-metadata targets are refused for them. An admin token can
  make the server connect to any other host it can reach through those three paths.
- **DNS re-resolution for some historians:** TimescaleDB and HTTPS historians without a custom CA
  are checked on the resolved address, but the library resolves the name again to connect, so an
  answer that changes in between is not caught (`server/services/historians.js`).
- **BACnet invoke ids are 8 bits** (the protocol's size). They start from a random value and a
  reply is accepted only from the device's address for a pending request, but a peer that can see
  the traffic and spoof the device's address can still answer first (`server/drivers/bacnet/client.js`).
- **MTConnect responses are held in memory** up to `maxResponseBytes` (default 8 MiB, at most
  256 MiB) and parsed into a tree of at most 2,000,000 elements; a hostile agent can make one
  driver process use that much (`server/drivers/mtconnect/xml.js`, `index.js`). Use **Run this
  device in its own driver process** for agents you do not trust.
- **The console keeps the API token in `localStorage`** (`tc.authToken`), readable by any script
  in the page origin; the client is served with a Content-Security-Policy. Sign out from
  **Settings → General → Session**.
- **`npm audit` reports advisories in `nodemon`**, a development dependency of `server/` used only
  by `npm run dev`; it is not in the production image.
