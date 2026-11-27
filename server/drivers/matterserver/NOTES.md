# Matter Server driver (`matter-server`) — notes

Status: **experimental, not verified against real hardware or a real Matter Server.** Tested
against `server/test/support/matterServerSimulator.js` only.

## What it talks to

The WebSocket API of the open-source Matter Server: `python-matter-server` (Open Home
Foundation, archived at 8.1.x) and its matter.js-based successor, which keeps the same API
("drop-in replacement"). Default `ws://<host>:5580/ws`. One Manifold device = one server.

Protocol summary (python-matter-server `common/models.py`, client `client.py`):

- First message from the server: `ServerInfo` `{fabric_id, compressed_fabric_id, schema_version,
  min_supported_schema_version, sdk_version, wifi_credentials_set, thread_credentials_set,
  bluetooth_enabled}`.
- Commands `{message_id, command, args}`; answers `{message_id, result}` or
  `{message_id, error_code, details}`; events `{event, data}`.
- `start_listening` answers with every node `{node_id, available, is_bridge, attributes, ...}`
  (attributes keyed `"endpoint/cluster/attribute"`) and then streams events.
- `attribute_updated` data is `[node_id, "ep/cluster/attr", value]`; `node_added` /
  `node_updated` carry a full node; `node_removed` the node id; `endpoint_added` /
  `endpoint_removed` `{node_id, endpoint_id}`; `server_shutdown`, `server_info_updated`,
  `node_event` (button presses etc.; ignored: no attribute value).

## Read-only guarantee

`client.js` `READ_COMMANDS` is the complete list Manifold can encode: `start_listening`,
`get_nodes`, `get_node`, `server_info`, `diagnostics`, `read_attribute`. `encodeCommand` throws
for anything else and is the only function that builds outgoing text
(`common/wsJsonSession.js` `request()` is the only call to `ws.send`). The commissioning,
control and maintenance commands (`commission_*`, `open_commissioning_window`,
`set_wifi_credentials`, `set_thread_dataset`, `device_command`, `write_attribute`,
`remove_node`, `interview_node`, `update_node`, `set_acl_entry`, `set_node_binding`, ...) are not
named anywhere in the driver; a test scans the source for them, and the simulator refuses and
records any non-read command (asserted after every test file). `ping_node` is a read but is not
used: it is not needed and it sends traffic to the node.

`read_attribute` (schema >= 9) is a live Matter read interaction to the node. It is used only by
**probe** (an explicit operator action). Polling and resync use the server's cache
(`start_listening` / `get_nodes`), never the network.

## Values

- Subscription: the node dump is kept in memory; `attribute_updated` and node events update it
  and push the affected tags at once (runtime `subscribe` hook). The poll groups re-read the
  in-memory copy (no network traffic) so every tag gets a fresh sample at the poll interval
  while the subscription is alive; that keeps staleness detection and bindings working as for
  polled devices.
- Periodic resync (`resyncIntervalS`, default 300 s): `get_nodes`, replace the cache, push only
  what changed. Repairs anything the event stream lost.
- `available: false` -> every tag of that node Bad `node unavailable`. Unknown node -> Bad
  `node not found`; attribute missing from the node -> Bad `attribute not reported by the node`.
- `null` -> Bad `no value` (Matter's nullable attributes, e.g. `LevelControl.OnLevel`,
  `TemperatureMeasurement.MeasuredValue` when the sensor has no reading).

## Cluster table (`clusters.js`)

Names, types, units and scaling for Descriptor, BasicInformation, BridgedDeviceBasicInformation,
OnOff, LevelControl, ColorControl, TemperatureMeasurement (0.01 °C), PressureMeasurement
(0.1 kPa), IlluminanceMeasurement (`10^((v-1)/10000)` lx; 0 = too low -> 0; 0xFFFF -> no value),
RelativeHumidityMeasurement (0.01 %), OccupancySensing (bit 0 -> bool), BooleanState,
PowerSource (mV -> V, mA -> A, BatPercentRemaining in half-percent), ElectricalPowerMeasurement
(mV/mA/mW/mHz -> V/A/W/Hz), ElectricalEnergyMeasurement (EnergyMeasurementStruct `energy`
field, mWh -> Wh), Thermostat (0.01 °C), DoorLock state, WindowCovering positions
(percent100ths -> %), AirQuality, the ten concentration measurement clusters (unit taken from
the cluster's `MeasurementUnit` attribute), and the global attributes. Enum labels are shown in
browse; the value stays the number.

Other clusters are readable by numeric path: scalars as they are, lists and structs as JSON text.
The user's tag type (`number`, `bool`, `string`, `json`) overrides the table.

## Deviations and pitfalls handled

- **Schema versions.** The server announces `schema_version` and
  `min_supported_schema_version`. A server that requires a newer client than schema 11 is
  refused with a clear message (as the official client does); a newer server is accepted with a
  note; below schema 9 there is no `read_attribute`, so probe shows the cached value.
- **`read_attribute` answer shape.** Current servers answer `{ "ep/cl/attr": value }`; older ones
  answered the bare value. Both are handled.
- **Struct field keys.** Struct values arrive keyed by field id as text (`{"0": ...}`); the
  energy transform also accepts the field name.
- **int64 values** may arrive as JSON numbers beyond 2^53 or as text; text is parsed, precision
  beyond 2^53 is lost.
- **matter.js server differences** (per its README): `attribute_subscriptions` always empty,
  extra `endpoint_parents` field — neither is used.
- **Large installations**: the node dump is one message. Frame and message caps default to
  32 MB (`maxMessageMB`); a larger message closes the connection with 1009 and the device shows
  the reason. The WebSocket client (`../common/wsClient.js`) also caps a message at 4,096 fragments
  and the pongs queued for a server that does not read them at 1 MiB.
- **Malformed or unknown messages** drop the connection (an update may have been lost); the
  runtime reconnects with backoff and `start_listening` reloads the full state.
- **Half-open TCP**: WebSocket ping after 20 s of silence, connection dropped after 10 s more.

## Not supported

- Commissioning, control, writes, bindings, ACLs, OTA updates: never, by design.
- Matter events (`node_event`) as tag values.
- Node ids above 2^53 (matter.js test nodes start at 0xFFFF_FFFE_0000_0000): JSON parsing loses
  precision. Real fabrics use small sequential ids.
- Network discovery of servers (mDNS): enter the URL.
- permessage-deflate (never negotiated; the server falls back to uncompressed frames).
