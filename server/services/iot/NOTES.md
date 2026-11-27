# IoT over MQTT: implementation notes

Manifold subscribes to what consumer/prosumer ecosystems already publish on an MQTT broker and
shows it as devices with named, typed tags. **It never publishes to these ecosystems**: no module
in this directory holds a publish function, and `server/test/iot-int.test.js` checks that statically
(no `publish(`, `connect(`, `write(` or `require('mqtt')` in this directory or `routes/iot.js`) and at
run time (full simulator traffic, a subscriber on every command/set/downlink topic sees nothing).

**Not verified against real hardware or real bridges.** Formats follow each project's documented
MQTT API as known when this was written. The project documentation sites could not be fetched
from the build environment, so the versions below are the documented behaviour this targets, not
something re-checked against a running instance. Fixtures in `server/test/support/iotMqttSimulator.js`
are reconstructions of documented examples.

## Versions targeted

| Convention | Version targeted | Topics read |
|---|---|---|
| Zigbee2MQTT | 1.3x and 2.x | `<base>/bridge/devices`, `bridge/groups`, `bridge/state`, `bridge/info`, `<base>/<friendly_name>`, `<base>/<friendly_name>/availability` |
| Z-Wave JS UI (zwavejs2mqtt) | 8.x to 10.x gateway | `<prefix>/_CLIENTS/ZWAVE_GATEWAY-<name>/status`, value topics, `<node>/status`, `<node>/nodeinfo`, `<node>/lastActive` |
| Home Assistant MQTT discovery | 2024.11+ (device-based discovery), older per-entity form | `<prefix>/<component>/[<node_id>/]<object_id>/config`, each entity's state, availability and json_attributes topics |
| Tasmota | 12.x to 14.x | `tele/<topic>/LWT|SENSOR|STATE`, `stat/<topic>/POWER[n]|RESULT|STATUS8|STATUS10`, `tasmota/discovery/<MAC>/config` |
| Shelly | Gen1 firmware 1.x; Gen2+ (Plus/Pro/Gen3) | `shellies/<id>/...`; `<prefix>/online`, `<prefix>/status/<component>`, `<prefix>/events/rpc` |
| ChirpStack | v4 MQTT integration, JSON marshaler | `application/<appId>/device/<devEui>/event/<up|status|join|...>` |
| The Things Stack | v3 MQTT server | `v3/<app-id>[@<tenant-id>]/devices/<device-id>/up` |

## Deviations and awkward shapes handled

Zigbee2MQTT
- Friendly names may contain `/`: state topics are matched by exact lookup against the device
  list, never by splitting levels. `<name>/set`, `<name>/set/<attr>`, `<name>/get...` are ignored.
- State messages that arrive before `bridge/devices` (retained order is not guaranteed) are kept
  (up to 500 topics) and replayed once the list arrives.
- Availability in both forms: legacy string `online`/`offline` and JSON `{"state":"online"}`;
  `bridge/state` likewise. Bridge offline makes every device offline.
- Exposes walk: generic (`numeric`, `binary`, `enum`, `text`, `list`), specific (`light`, `switch`,
  `cover`, `lock`, `climate`, `fan`: features at top level) and `composite` (features nested
  under `payload[property]`). Only properties whose `access` includes bit 1 ("published state")
  become tags; set-only ones (access 2) are skipped. Missing `access` (very old bridges) is read as 1.
  Ranges from `value_min/value_max`, enums from `values`, binary `value_on/value_off` map to booleans,
  `category: diagnostic` and `linkquality` are diagnostics.
- Renames: identity is the IEEE address, so the device and its tag keys survive a friendly-name
  change; the old topic stops being read.
- Unsupported devices (no definition): tags are built from the scalar keys of their state messages.
- Groups: tags are the members' shared light/switch/cover state features.
- `last_seen` (ISO with zone or epoch) is the source timestamp; `ISO_8601_local` has an offset and works.

Z-Wave JS UI
- Topic layouts: valueid (`<node>/<cc>/<endpoint>/<property>[/<propertyKey>]`), named
  (`<node>/<cc_name>/endpoint_<n>/<propertyName>[/...]`), and the node part may contain a location
  level (`<location>/<name>`). The command-class level is found by shape (numeric CC >= 32 followed
  by a numeric endpoint, or a snake_case CC name followed by `endpoint_<n>`).
- Payloads: JSON time-value `{time, value}`, entire value object (metadata: label, unit, min, max,
  states, type, readable) and just-value. Only the entire value object carries metadata and the
  node id; with the other forms the device identity is the topic's node part (`nodeID_5` and a
  bare `5` give node 5), so renaming a node in the gateway with named topics creates a new device.
- "Configured topics" (user-defined per value) are understood only with the entire-value payload.
- Node `status`: `Dead` / false -> offline; `Alive`, `Awake`, `Asleep` -> online (sleeping is normal).
  Gateway `_CLIENTS/.../status` false -> all nodes offline. Writes (`.../set`) and `_CLIENTS/.../api/...`
  are never read.

Home Assistant discovery
- Abbreviated keys (top level, `device`, `origin`, availability entries) are expanded; `~` is
  expanded at the start or end of `*_topic` values and availability topics.
- Device-based discovery: shared options at the top, one entity per `cmps` entry; a component
  reduced to `{ "p": "<platform>" }` is a removal; a missing component is removed too.
- Empty retained config removes the entity, and the device with its last entity.
- Entities group into devices by `device.identifiers[0]` (else `connections[0]`); an entity
  without a device block is its own device keyed by `unique_id`.
- State side only: `state_topic`, `*_state_topic`, `current_*_topic`, `*_status_topic`,
  `position_topic`, `latest_version_topic`, each with its matching template; `command_topic` is
  ignored. `json_attributes_topic` becomes an extra JSON tag.
- Value templates: a safe subset (see `template.js`): `{{ value }}`, `{{ value_json.a.b }}`,
  `value_json['a']`, `[n]`, `| float`, `| float(default)`, `| int`, `| round(n)`, `+ - * / // %`,
  parentheses, unary minus. Anything else marks the tag "template not supported"; the raw payload
  is still published as its value with Uncertain quality. Nothing is executed.
  `round` rounds half away from zero (Jinja uses Python's rounding; results can differ in the
  last digit for exact halves).
- Availability: single topic or list; `availability_mode` all / any / latest (default latest);
  per-entry payloads and templates. A device is offline when any of its entities says so.
- State payloads that arrive before their config (up to 2000 topics of at most 8 KB) are kept
  and applied when the config arrives.
- `binary_sensor` maps `payload_on`/`payload_off` (default `ON`/`OFF`) to booleans; numeric
  sensors (unit, state_class or display precision present) convert numeric strings, and
  `unknown` / `unavailable` / `None` / empty become null with Uncertain quality.

Tasmota
- Any FullTopic with `%prefix%`, `%topic%` and optional `%hostname%` / `%id%` levels.
- Native discovery gives name, model, MAC, firmware, LWT payloads; a device first seen by topic
  moves to its MAC id once discovery arrives.
- SENSOR: nested objects walked (depth-bounded); units from `TempUnit`, `PressureUnit`,
  `SpeedUnit` and known field names (ENERGY Total/Today/Yesterday kWh, Power W, Voltage V, ...).
  A leaf missing from the next SENSOR message becomes Uncertain.
- `Time` is device-local time without a zone and is NOT used as source time.
- `cmnd/` is never read.

Shelly
- Gen1 energy is in watt-minutes (unit `Wmin`, not converted). `temperature` is taken as °C
  (Gen1 also publishes `temperature_f`).
- Gen2+: any topic prefix works; component names are whitelisted to avoid false matches on
  unrelated `<x>/status/<y>` topics. `NotifyStatus` / `NotifyFullStatus` are partial updates;
  `params.ts` (seconds) is the source time. `by_minute` arrays are not tags.
- An unknown `<x>/online` topic does not create a device unless the prefix starts with `shelly`
  or a status topic was seen first.

LoRaWAN
- JSON marshaling only (ChirpStack's protobuf marshaler is binary: not supported).
- Decoded payload fields become tags (`decoded.<path>`); RSSI/SNR are from the best gateway;
  frame counter, port, frequency, gateways heard, battery (ChirpStack status event, TTS
  `last_battery_percentage`) and link margin are diagnostics. Without a decoded payload the raw
  payload is a hex tag (`payloadHex`). Source time: `time` / `received_at`.
- LoRaWAN has no online/offline notion: availability stays "unknown"; see last seen. A field an
  earlier uplink had but the latest lacks becomes Uncertain (devices that alternate payload types
  per port will show this).

## Bounds

- At most 2000 devices and 50 000 tags per broker (`MANIFOLD_IOT_MAX_DEVICES`,
  `MANIFOLD_IOT_MAX_TAGS`), 400 tags per device; past a cap a device/tag is refused and counted.
- Payloads over 256 KB (the topic store truncates them anyway) and JSON deeper than 24 levels are
  refused whole and counted; derived-tag walks stop at depth 8; strings are capped at 4096
  characters and structured values at 16 KB.
- Each convention handler runs in a try/catch per message: a payload that throws is counted
  (shown as "unreadable") and ingest continues. Own-property reads only; `__proto__`,
  `constructor` and `prototype` keys are dropped from expanded discovery configs.

## Not supported

- Pairing, interviewing, configuring or controlling devices (by design).
- Zigbee2MQTT `bridge/devices` larger than 256 KB (very large networks): the topic store truncates
  it; raise `MANIFOLD_MAX_PAYLOAD_BYTES` if needed.
- Home Assistant templates beyond the subset above; `device_automation`, `tag`, `camera`, `image`,
  `button`, `scene`, `notify` have no state side and give no tags.
- Home Assistant state topics outside the broker intake filter: discovery configs are subscribed
  explicitly, but state topics are only seen when the broker's intake (default `#`) covers them.
- Z-Wave JS UI metadata with time-value or just-value payloads (it is only in the entire value
  object payload); configured topics without it.
- Tasmota Berry/ rule-generated custom topics; Shelly Gen1 `info` document (the scalar topics carry
  the same values).
- ChirpStack v3 topic layout, protobuf payloads; TTS `uplink_normalized`, location and service topics.
- Binary payload codecs (CBOR etc.): JSON and text only.
