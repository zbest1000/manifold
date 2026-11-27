# Z-Wave JS Server driver (`zwave-js`) — notes

Status: **experimental, not verified against real hardware or a real Z-Wave JS Server.** Tested
against `server/test/support/zwaveJsServerSimulator.js` only.

## What it talks to

`@zwave-js/server`, the WebSocket server in front of the `zwave-js` driver (Home Assistant's
Z-Wave JS add-on, Z-Wave JS UI's "WS Server"). Default `ws://<host>:3000`. One Manifold device =
one server = one Z-Wave network.

Protocol summary (zwave-js-server `README.md`, `API_SCHEMA.md`, `src/lib/node/message_handler.ts`):

- Greeting `{type:"version", driverVersion, serverVersion, homeId, minSchemaVersion, maxSchemaVersion}`.
- Commands `{messageId, command, ...args}`; answers `{type:"result", messageId, success, result | errorCode}`;
  events `{type:"event", event:{source:"driver"|"controller"|"node", event, ...}}`.
- `set_api_schema {schemaVersion}` first, then `start_listening` -> `{state:{driver, controller, nodes}}`;
  each node has `nodeId`, `status` (0 unknown, 1 asleep, 2 awake, 3 dead, 4 alive), `ready` and
  `values: [{commandClass, endpoint, property, propertyKey?, value, metadata, ...}]`.
- Node events: `value updated` / `value added` (`args.newValue`), `value notification`
  (`args.value`, stateless values such as Central Scene), `value removed`, `metadata updated`
  (`args.metadata`), `sleep`, `wake up`, `dead`, `alive`, `ready`, `statistics updated`;
  controller `node added` / `node removed` (`event.node`); driver `driver ready`.

## Read-only guarantee, and no radio traffic

`client.js` `READ_COMMANDS` is the complete list: `set_api_schema`, `start_listening`,
`node.get_defined_value_ids`, `node.get_value_metadata`, `node.get_value`. All of them are
answered from the server's value DB (`node.getValue`, `node.getValueMetadata`,
`node.getDefinedValueIDs` in zwave-js): none transmits on the Z-Wave radio, so **battery devices
are never woken** and the mesh carries no extra traffic. `encodeCommand` throws for anything
else and is the only function that builds outgoing text; arguments cannot override the command
or message id.

Never encoded, never named in the driver (a test scans the source): `node.set_value`,
`node.poll_value` (transmits a GET to the device; on a battery device it waits for the next
wake-up or drains it), `node.refresh_info`, `node.refresh_values`, `node.ping`,
`node.get_raw_config_parameter_value` (also a radio read), firmware, interview, health checks,
controller inclusion/exclusion/heal/rebuild-routes/firmware, `driver.*` setters, broadcast and
multicast `set_value`, `endpoint.invoke_cc_api`. The simulator refuses and records any of these.

## Values

- Tag address = value id `node/commandClass/endpoint/property[/propertyKey]`. Command class by
  id, hex or name. Digits-only segments are numbers; "/" and "%" inside names are
  percent-encoded.
- Conversion from metadata: `number` -> float64 (int64 when the metadata has `states`),
  `boolean` -> bool, `string` -> string, `duration` -> seconds (minutes converted; `default` /
  `unknown` -> Bad), Buffer values -> hex text, arrays / objects / `color` / `any` -> JSON text.
  `undefined`/`null` -> Bad `no value`. The tag type overrides.
- Node **asleep**: last reported value with Good quality and `qReason: "sleeping"` (shown as the
  reason in the UI). Node **dead**: Bad `node dead`. Values with `metadata.readable === false`
  are not offered in browse and read Bad `value is write-only`.
- Pushed on every event; poll groups re-read the local copy (no network traffic); every
  `resyncIntervalS` (default 300 s, schema >= 14 only) the tagged values are re-read from the
  server's cache with `node.get_value`, 8 at a time, and only changes are pushed.

## Deviations and pitfalls handled

- **Schema negotiation**: Manifold uses `min(serverMax, 44)`. A server whose minimum is above 44
  is refused with a clear message; a server below schema 3 too. Below 14 there is no
  `node.get_value`: values come from the event stream only and resync is off (reported in the
  connection test notes). `commandClasses` moved to endpoints in schema 15; not used.
- **`driver ready`** (the server restarted its Z-Wave driver, e.g. after a stick reset): the
  state is stale, so the connection is dropped and reloaded.
- **Message compression** (server schema 10+) is permessage-deflate on the server side; Manifold
  never offers the extension, so the server sends plain frames.
- **Large networks**: the full state is one message; caps default to 32 MB (`maxMessageMB`), plus
  the WebSocket client's caps of 4,096 fragments per message and 1 MiB of unread pongs.
- **Malformed or unknown messages** drop the connection; the runtime reconnects and
  `start_listening` reloads everything.

## Not supported

- Any write, inclusion, exclusion, healing, configuration or firmware action: never, by design.
- Polling devices for fresh values: by design (radio traffic, battery drain). Configure the
  device's own reporting instead.
- Z-Wave events without a value (`notification` CC events that are not values), statistics.
- Zniffer, multicast/broadcast groups, Long Range specifics beyond what values carry.
- Discovery of servers (mDNS): enter the URL.
