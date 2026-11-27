# 🔌 Matter and Z-Wave bridge servers

> **Goal:** read Matter and Z-Wave devices through the bridge server that already runs them, as
> devices with tags you can map into the UNS. Part of [Devices and Drivers](Devices-and-Drivers):
> the device page, poll groups, secrets, quality, profiles and polling health work as described there.

Two drivers read smart-home and IoT device networks through the standard
open-source bridge servers, over WebSocket. Manifold does **not** talk to the
devices or the radio itself:

| Driver | Talks to | URL (default) |
|---|---|---|
| `matter-server` | The open-source **Matter Server** (python-matter-server, and its matter.js-based successor, which keeps the same API) | `ws://<host>:5580/ws` |
| `zwave-js` | **Z-Wave JS Server** (`@zwave-js/server`) | `ws://<host>:3000` |

Stated plainly:

- **Manifold only reads through the bridge.** It does not commission, pair,
  include, exclude, interview, heal, update firmware, or remove anything, and
  it does not control or write to any device. Commission and include devices
  with Home Assistant or the server's own tools; Manifold then sees them.
- **Battery devices are never woken.** Everything the Z-Wave driver asks for is
  answered from Z-Wave JS Server's own value cache; nothing it sends goes out
  on the Z-Wave radio (no `poll_value`, no refresh, no ping). A sleeping device's
  value updates when the device reports on its own. The Matter driver reads the
  server's attribute cache too; only the **Probe** button sends a live Matter
  read (`read_attribute`) to the node.
- **Experimental — not verified on real hardware.** Both drivers were tested only against
  in-process simulators of the two servers' WebSocket APIs
  (`server/test/support/matterServerSimulator.js`, `zwaveJsServerSimulator.js`), written from
  their public documentation. They carry the **Experimental** badge.

## Pointing Manifold at a bridge

Enter the URL as **Host**, **Port**, **Scheme** (`ws` or `wss`) and **Path**:
`ws://ha.local:5580/ws` is host `ha.local`, port `5580`, scheme `ws`, path `/ws`
(paste the whole URL into **Host** and the form splits it). There is no network
discovery for bridges. **Test connection** reports the
server version, the API schema it agreed on and the node count.

- **Home Assistant, Matter Server add-on**: Home Assistant itself reaches the
  add-on internally; for Manifold the WebSocket port has to be published on the
  host. Open the add-on's **Configuration → Network**, give the 5580/tcp entry a
  host port (it is usually empty, which means not published) and restart the
  add-on. Then use `ws://<home-assistant-host>:<that port>/ws`.
- **Home Assistant, Z-Wave JS add-on**: the same for its 3000/tcp entry under
  **Configuration → Network**. Then `ws://<home-assistant-host>:<that port>`.
  These menu names were taken from the add-on documentation, not checked on a
  live installation.
  With **Z-Wave JS UI**, enable **Settings → Home Assistant → WS Server** and use
  its port (3000 by default).
- Neither server authenticates clients: whoever reaches the port can control
  every device. Keep it on a trusted network. If you put an authenticating
  reverse proxy in front (wss), enter its token in **Bearer token**; it is sent as
  `Authorization: Bearer`, stored with the device and never shown again or
  exported. TLS certificates are verified; for a private CA paste it in **CA
  certificate**, or pin a self-signed proxy's **certificate fingerprint**;
  **Do not verify the TLS certificate** is an explicit per-device opt-out (the
  same TLS settings as the HTTP drivers).
- The host passes the same egress guard and address pinning as every device:
  a private address needs `MANIFOLD_ALLOW_PRIVATE_TARGETS=1`.

## Tags

| Driver | Address | Examples |
|---|---|---|
| Matter | `node/endpoint/cluster/attribute` (ids, hex, or names for the built-in clusters) | `5/1/1026/0`, `5/1/TemperatureMeasurement/MeasuredValue`, `5/1/0x0402/0x0000` |
| Z-Wave | value id `node/commandClass/endpoint/property[/propertyKey]` | `5/49/0/Air temperature`, `5/Binary Switch/1/currentValue`, `3/50/0/value/65537` |

The type is optional. Matter values are converted with a built-in table of the
common clusters (on/off, level, colour, temperature in 0.01 °C, humidity,
pressure, illuminance, occupancy, contact, power source and battery, electrical
power and energy, thermostat, door lock, window covering, air quality and the
concentration clusters, descriptor, basic information); other clusters are read
by number and show the raw value. Z-Wave values use the server's metadata
(label, unit, type, min/max, states). **Import from server** browses nodes →
endpoints → clusters → attributes (Matter) or nodes → command classes → values
(Z-Wave) and fills in unit and description; write-only Z-Wave values are not offered.

## Quality

| Situation | Value | Quality |
|---|---|---|
| Matter node `available: false` | — | Bad, "node unavailable" |
| Matter attribute is `null` | — | Bad, "no value" |
| Z-Wave node asleep | last reported value | Good, reason "sleeping" |
| Z-Wave node dead | — | Bad, "node dead" |
| Node or value not known to the server | — | Bad, with the reason |
| Connection to the bridge lost | — | Bad, "disconnected"; reconnect with backoff |

Values arrive by **subscription**: the server streams every change and
Manifold passes it on at once. The poll group interval still applies: at that
interval each tag gets a fresh sample from Manifold's copy of the server state
(no network traffic), so staleness and mappings behave as for polled devices.
A full resync (Matter: `get_nodes`; Z-Wave: `node.get_value` from the server's
cache, schema 14 or newer) runs every 5 minutes by default.

The driver notes list every API detail handled and what is not supported:
[`server/drivers/matterserver/NOTES.md`](https://github.com/zbest1000/manifold/blob/main/server/drivers/matterserver/NOTES.md),
[`server/drivers/zwavejs/NOTES.md`](https://github.com/zbest1000/manifold/blob/main/server/drivers/zwavejs/NOTES.md).

## Read-only, and what is not verified

- **Matter Server:** `start_listening`, `get_nodes`, `get_node`, `server_info`, `diagnostics` and
  `read_attribute` are the only commands the driver can encode. Commissioning, `device_command`,
  `write_attribute`, `remove_node`, `interview_node` and the rest cannot be encoded.
- **Z-Wave JS Server:** `set_api_schema`, `start_listening`, `node.get_defined_value_ids`,
  `node.get_value_metadata` and `node.get_value` only, all answered from the server's cache.
  `node.set_value`, `node.poll_value`, refresh, inclusion/exclusion, healing, firmware and `driver.*`
  setters cannot be encoded. The test simulators of both servers refuse and record any other
  command, and every test asserts that none arrived.
- **Not yet verified:** schema differences between server releases, the shape of real node dumps
  (especially bridges and multi-endpoint devices), and the matter.js server's compatibility are to
  be confirmed against real servers. The checklist is in
  [Verifying on real hardware](Verifying-on-Real-Hardware#matter-server-and-z-wave-js-server-ms1-to-ms4-zw1-to-zw4).

Next: [Devices and Drivers](Devices-and-Drivers), [Mapping to the UNS](Mapping-to-the-UNS).
