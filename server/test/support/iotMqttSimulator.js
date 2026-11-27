'use strict';

const mqtt = require('mqtt');

/**
 * IoT-over-MQTT traffic simulator: publishes realistic retained + live messages of every convention
 * Manifold's IoT detection reads (services/iot/), through a real MQTT broker (the in-process aedes
 * the tests use). The shapes follow the projects' documented examples, including awkward ones seen
 * in the field (a Zigbee2MQTT friendly name with "/", legacy availability strings, abbreviated and
 * "~"-based Home Assistant configs, values as strings, devices with no decoded payload).
 *
 * It is a STAND-IN for real bridges and devices, not a verification against hardware.
 *
 *   const sim = await startIotSimulator({ port });
 *   await sim.publishRetained();           // device lists, discovery configs, availability, first values
 *   await sim.tick();                      // one round of live values (counter-based, deterministic)
 *   sim.live(500) / sim.stopLive();
 *   await sim.renameZigbee('kitchen_plug', 'pantry_plug');
 *   await sim.removeHaEntity();            // empty retained discovery config
 *   await sim.setZigbeeAvailability('living_room/climate', 'offline');
 *   await sim.hostile();                   // deep, huge, malformed and prototype-key payloads
 *   sim.watchCommands() -> { messages, close() }  // a subscriber on every command/set/downlink topic
 *   await sim.close();
 *
 * Options: { port, host = '127.0.0.1', z2mBase = 'zigbee2mqtt', zwavePrefix = 'zwave',
 *            haPrefix = 'homeassistant' }
 */

const IEEE = { climate: '0x00158d0001a2b3c4', light: '0x0017880104e45521', plug: '0x588e81fffe2d1f3a', odd: '0x00124b0022aa33bb' };
const DEV_EUI = { cs1: '0004a30b001c0530', cs2: 'a840414e01234567', tts: '70b3d57ed0012345' };
const COMMAND_FILTERS = ['+/+/set', '+/+/+/set', '+/+/set/#', 'zwave/#', 'cmnd/#', 'shellies/+/+/+/command', 'shellies/+/relay/+/command', '+/rpc', '+/command', 'application/+/device/+/command/#', 'v3/+/devices/+/down/#', 'homeassistant/+/+/set', 'garage-env/#'];

function z2mDevices(base, names) {
  return [
    { ieee_address: '0x00124b0011223344', type: 'Coordinator', network_address: 0, supported: true, friendly_name: 'Coordinator', definition: null, interview_completed: true },
    {
      ieee_address: IEEE.climate,
      type: 'EndDevice',
      friendly_name: names.climate,
      power_source: 'Battery',
      model_id: 'lumi.weather',
      manufacturer: 'LUMI',
      supported: true,
      disabled: false,
      definition: {
        model: 'WSDCGQ11LM',
        vendor: 'Aqara',
        description: 'Temperature, humidity and pressure sensor',
        exposes: [
          { type: 'numeric', name: 'temperature', property: 'temperature', access: 1, unit: '°C', label: 'Temperature', description: 'Measured temperature value' },
          { type: 'numeric', name: 'humidity', property: 'humidity', access: 1, unit: '%', label: 'Humidity', description: 'Measured relative humidity' },
          { type: 'numeric', name: 'pressure', property: 'pressure', access: 1, unit: 'hPa', label: 'Pressure' },
          { type: 'numeric', name: 'battery', property: 'battery', access: 1, unit: '%', value_min: 0, value_max: 100, category: 'diagnostic', label: 'Battery' },
          { type: 'numeric', name: 'linkquality', property: 'linkquality', access: 1, unit: 'lqi', value_min: 0, value_max: 255, category: 'diagnostic', label: 'Linkquality' }
        ]
      }
    },
    {
      ieee_address: IEEE.light,
      type: 'Router',
      friendly_name: names.light,
      power_source: 'Mains (single phase)',
      supported: true,
      definition: {
        model: '9290022166',
        vendor: 'Philips',
        description: 'Hue white and color ambiance E26/E27',
        exposes: [
          {
            type: 'light',
            features: [
              { type: 'binary', name: 'state', property: 'state', access: 7, value_on: 'ON', value_off: 'OFF', value_toggle: 'TOGGLE', label: 'State' },
              { type: 'numeric', name: 'brightness', property: 'brightness', access: 7, value_min: 0, value_max: 254, label: 'Brightness' },
              { type: 'numeric', name: 'color_temp', property: 'color_temp', access: 7, unit: 'mired', value_min: 153, value_max: 500, label: 'Color temp', presets: [{ name: 'coolest', value: 153 }] },
              { type: 'composite', name: 'color_xy', property: 'color', access: 7, label: 'Color (X/Y)', features: [
                { type: 'numeric', name: 'x', property: 'x', access: 7 },
                { type: 'numeric', name: 'y', property: 'y', access: 7 }
              ] }
            ]
          },
          { type: 'enum', name: 'effect', property: 'effect', access: 2, values: ['blink', 'breathe', 'okay'], label: 'Effect' },
          { type: 'enum', name: 'power_on_behavior', property: 'power_on_behavior', access: 7, values: ['off', 'on', 'toggle', 'previous'], label: 'Power-on behavior' }
        ]
      }
    },
    {
      ieee_address: IEEE.plug,
      type: 'Router',
      friendly_name: names.plug,
      supported: true,
      definition: {
        model: 'E1603/E1702/E1708',
        vendor: 'IKEA',
        description: 'TRADFRI control outlet',
        exposes: [
          { type: 'switch', features: [{ type: 'binary', name: 'state', property: 'state', access: 7, value_on: 'ON', value_off: 'OFF' }] },
          { type: 'numeric', name: 'power', property: 'power', access: 5, unit: 'W', label: 'Power' },
          { type: 'enum', name: 'identify', property: 'identify', access: 2, values: ['identify'] }
        ]
      }
    },
    // Not supported by Zigbee2MQTT: no definition; tags come from what it publishes.
    { ieee_address: IEEE.odd, type: 'EndDevice', friendly_name: names.odd, supported: false, definition: null, model_id: 'TS0601_odd', manufacturer: '_TZE200_abcd' }
  ].map((d) => ({ ...d, base }));
}

async function startIotSimulator({ port, host = '127.0.0.1', z2mBase = 'zigbee2mqtt', zwavePrefix = 'zwave', haPrefix = 'homeassistant' } = {}) {
  const client = mqtt.connect(`mqtt://${host}:${port}`, { reconnectPeriod: 0, clientId: `iot-sim-${Math.random().toString(36).slice(2, 8)}` });
  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('error', reject);
  });
  const pub = (topic, payload, { retain = false } = {}) =>
    new Promise((resolve, reject) => {
      const body = Buffer.isBuffer(payload) ? payload : typeof payload === 'string' ? payload : JSON.stringify(payload);
      client.publish(topic, body, { qos: 1, retain }, (e) => (e ? reject(e) : resolve()));
    });
  const retained = (t, p) => pub(t, p, { retain: true });
  const names = { climate: 'living_room/climate', light: 'hue_bulb', plug: 'kitchen_plug', odd: 'tuya_odd' };
  let n = 0;
  let timer = null;
  const now = () => new Date().toISOString();

  const sim = {
    names,
    ieee: IEEE,
    devEui: DEV_EUI,

    async publishRetained() {
      // ---- Zigbee2MQTT
      await retained(`${z2mBase}/bridge/state`, { state: 'online' });
      await retained(`${z2mBase}/bridge/info`, { version: '2.1.3', commit: 'abc123', coordinator: { type: 'zStack3x0', ieee_address: '0x00124b0011223344' }, config: { mqtt: { base_topic: z2mBase } }, permit_join: false });
      await retained(`${z2mBase}/bridge/devices`, z2mDevices(z2mBase, names));
      await retained(`${z2mBase}/bridge/groups`, [{ id: 1, friendly_name: 'kitchen_lights', members: [{ ieee_address: IEEE.light, endpoint: 11 }], scenes: [] }]);
      await retained(`${z2mBase}/${names.climate}/availability`, { state: 'online' }); // JSON form
      await retained(`${z2mBase}/${names.plug}/availability`, 'online'); // legacy string form
      await retained(`${z2mBase}/${names.climate}`, { temperature: 21.5, humidity: 45.2, pressure: 1013.2, battery: 97, linkquality: 120, last_seen: now() });
      await retained(`${z2mBase}/${names.light}`, { state: 'ON', brightness: 200, color_temp: 370, color: { x: 0.4573, y: 0.41 }, power_on_behavior: 'previous', linkquality: 87 });

      // ---- Z-Wave JS UI
      await retained(`${zwavePrefix}/_CLIENTS/ZWAVE_GATEWAY-zwave-js-ui/status`, { value: true, time: Date.now() });
      await retained(`${zwavePrefix}/5/status`, { time: Date.now(), value: true, status: 'Alive', nodeId: 5 });
      await retained(`${zwavePrefix}/5/nodeinfo`, { id: 5, name: 'Hallway multisensor', loc: 'Hallway', manufacturer: 'Aeotec Ltd.', productLabel: 'ZW100', productDescription: 'MultiSensor 6', firmwareVersion: '1.13' });
      await retained(`${zwavePrefix}/5/49/0/Air_temperature`, {
        id: '5-49-0-Air temperature', nodeId: 5, commandClass: 49, commandClassName: 'Multilevel Sensor', endpoint: 0, property: 'Air temperature',
        propertyName: 'Air temperature', type: 'number', readable: true, writeable: false, label: 'Air temperature', unit: '°C', min: -40, max: 85, value: 20.8, lastUpdate: Date.now()
      });
      await retained(`${zwavePrefix}/5/113/0/Home_Security/Motion_sensor_status`, {
        id: '5-113-0-Home Security-Motion sensor status', nodeId: 5, commandClass: 113, commandClassName: 'Notification', endpoint: 0, property: 'Home Security', propertyKey: 'Motion sensor status',
        type: 'number', readable: true, writeable: false, label: 'Motion sensor status', states: { 0: 'idle', 8: 'Motion detection' }, value: 0, lastUpdate: Date.now()
      });
      // Named topics with a location level and time-value payloads; a dead node.
      await retained(`${zwavePrefix}/Kitchen/Door_sensor/status`, { time: Date.now(), value: false, status: 'Dead' });
      await retained(`${zwavePrefix}/Kitchen/Door_sensor/notification/endpoint_0/Access_Control/Door_state`, { time: Date.now(), value: 23 });
      // valueid layout, "just value" payload
      await retained(`${zwavePrefix}/nodeID_7/37/0/currentValue`, true);

      // ---- Home Assistant MQTT discovery
      await retained(`${haPrefix}/sensor/garage_env/temperature/config`, {
        '~': 'garage-env', name: 'Temperature', stat_t: '~/sensor/temperature/state', unit_of_meas: '°C', dev_cla: 'temperature', stat_cla: 'measurement',
        uniq_id: 'garage_env_temp', avty_t: '~/status', dev: { ids: ['garage_env_01'], name: 'Garage environment', mf: 'Espressif', mdl: 'ESP32 DevKit', sw: '2024.6.1' }
      });
      await retained(`${haPrefix}/sensor/garage_env/humidity/config`, {
        '~': 'garage-env', name: 'Humidity', stat_t: '~/sensor/climate', val_tpl: '{{ value_json.humidity | float }}', unit_of_meas: '%', dev_cla: 'humidity', stat_cla: 'measurement',
        uniq_id: 'garage_env_hum', avty_t: '~/status', json_attr_t: '~/sensor/climate', dev: { ids: ['garage_env_01'] }
      });
      await retained(`${haPrefix}/sensor/garage_env/power/config`, {
        name: 'Heater power', state_topic: 'garage-env/sensor/climate', value_template: "{{ (value_json['power_mw'] / 1000) | round(2) }}", unit_of_measurement: 'W', device_class: 'power', state_class: 'measurement',
        unique_id: 'garage_env_power', availability: [{ topic: 'garage-env/status' }, { topic: 'garage-env/heater', payload_available: 'up', payload_not_available: 'down' }], availability_mode: 'all', device: { identifiers: 'garage_env_01' }
      });
      await retained(`${haPrefix}/sensor/garage_env/mode/config`, {
        name: 'Mode text', state_topic: 'garage-env/sensor/climate', value_template: '{% if value_json.mode %}{{ value_json.mode }}{% endif %}', unique_id: 'garage_env_mode', device: { identifiers: ['garage_env_01'] }
      });
      await retained(`${haPrefix}/binary_sensor/garage_env/door/config`, {
        name: 'Door', stat_t: 'garage-env/binary_sensor/door/state', pl_on: '1', pl_off: '0', dev_cla: 'door', uniq_id: 'garage_env_door', dev: { ids: ['garage_env_01'] }
      });
      await retained(`${haPrefix}/switch/garage_env/heater/config`, {
        name: 'Heater', stat_t: 'garage-env/switch/heater/state', cmd_t: 'garage-env/switch/heater/set', uniq_id: 'garage_env_heater_sw', dev: { ids: ['garage_env_01'] }
      });
      // Device-based discovery (one config, several components).
      await retained(`${haPrefix}/device/energy_meter_01/config`, {
        dev: { ids: 'em01', name: 'Energy meter', mf: 'Acme', mdl: 'EM-3' },
        o: { name: 'acme-bridge', sw: '1.0' },
        stat_t: 'acme/em01/state',
        cmps: {
          voltage: { p: 'sensor', name: 'Voltage', unit_of_meas: 'V', dev_cla: 'voltage', val_tpl: '{{ value_json.voltage }}', uniq_id: 'em01_voltage' },
          energy: { p: 'sensor', name: 'Energy', unit_of_meas: 'kWh', dev_cla: 'energy', stat_cla: 'total_increasing', val_tpl: '{{ value_json.energy_wh / 1000 }}', uniq_id: 'em01_energy' }
        }
      });
      await retained('garage-env/status', 'online');
      await retained('garage-env/heater', 'up');
      await retained('garage-env/sensor/temperature/state', '21.4');
      await retained('garage-env/sensor/climate', { humidity: '48.5', power_mw: 1234567, mode: 'auto', firmware: 'x' });
      await retained('garage-env/binary_sensor/door/state', '0');
      await retained('garage-env/switch/heater/state', 'ON');
      await retained('acme/em01/state', { voltage: 231.4, energy_wh: 123456 });

      // ---- Tasmota
      await retained('tasmota/discovery/A4CF12ABCDEF/config', {
        ip: '192.168.1.50', dn: 'Workshop plug', fn: ['Workshop plug', null], hn: 'tasmota-ABCDEF-1234', mac: 'A4CF12ABCDEF', md: 'Sonoff Pow R2', ty: 0, if: 0,
        ofln: 'Offline', onln: 'Online', state: ['OFF', 'ON', 'TOGGLE', 'HOLD'], sw: '13.4.0', t: 'tasmota_ABCDEF', ft: '%prefix%/%topic%/', tp: ['cmnd', 'stat', 'tele'], rl: [1, 0], ver: 1
      });
      await retained('tele/tasmota_ABCDEF/LWT', 'Online');
      await pub('tele/tasmota_ABCDEF/SENSOR', {
        Time: '2026-11-25T10:00:00', ENERGY: { TotalStartTime: '2024-01-01T00:00:00', Total: 12.345, Yesterday: 0.512, Today: 0.123, Power: 45, ApparentPower: 50, ReactivePower: 20, Factor: 0.9, Voltage: 230, Current: 0.217 },
        AM2301: { Temperature: 22.3, Humidity: 45.6, DewPoint: 9.8 }, TempUnit: 'C'
      });
      await pub('tele/tasmota_ABCDEF/STATE', { Time: '2026-11-25T10:00:00', Uptime: '0T01:00:00', UptimeSec: 3600, Heap: 25, LoadAvg: 19, POWER: 'ON', Wifi: { AP: 1, SSId: 'plant', RSSI: 80, Signal: -60, Channel: 6 } });

      // ---- Shelly Gen1 + Gen2
      await retained('shellies/shellyplug-s-7AF1E2/online', 'true');
      await pub('shellies/shellyplug-s-7AF1E2/announce', { id: 'shellyplug-s-7AF1E2', model: 'SHPLG-S', mac: 'C45BBE7AF1E2', ip: '192.168.1.60', new_fw: false, fw_ver: '20230913-114008/v1.14.0-gcb84623' });
      await retained('shellies/shellyplug-s-7AF1E2/relay/0', 'on');
      await pub('shellies/shellyplug-s-7AF1E2/relay/0/power', '12.5');
      await pub('shellies/shellyplug-s-7AF1E2/relay/0/energy', '3456');
      await pub('shellies/shellyplug-s-7AF1E2/temperature', '31.2');
      await retained('shellyplus1pm-a8032ab12345/online', 'true');
      await retained('shellyplus1pm-a8032ab12345/status/switch:0', {
        id: 0, source: 'init', output: false, apower: 0, voltage: 230.1, current: 0, aenergy: { total: 12.34, by_minute: [0, 0, 0], minute_ts: 1764000000 }, temperature: { tC: 40.1, tF: 104.2 }
      });
      await retained('shellyplus1pm-a8032ab12345/status/sys', { mac: 'A8032AB12345', restart_required: false, uptime: 3600, ram_free: 120000 });

      // ---- LoRaWAN (uplinks are not retained in real deployments; the first ones go out live here)
      await sim.lorawan(0);
    },

    async lorawan(k) {
      await pub(`application/6d4e2b1a-0000-4000-8000-000000000001/device/${DEV_EUI.cs1}/event/up`, {
        deduplicationId: 'a', time: now(),
        deviceInfo: { tenantId: 't', tenantName: 'Plant', applicationId: '6d4e2b1a-0000-4000-8000-000000000001', applicationName: 'cold-chain', deviceProfileName: 'Elsys ERS', deviceName: 'freezer-3', devEui: DEV_EUI.cs1, tags: {} },
        devAddr: '01020304', adr: true, dr: 5, fCnt: 100 + k, fPort: 5, confirmed: false, data: 'AQDiAiwDAA==',
        object: { temperature: -18.5 + k / 10, humidity: 61, battery: { voltage: 3.61 } },
        rxInfo: [{ gatewayId: '0016c001ff10a235', rssi: -97, snr: 4.2 }, { gatewayId: '0016c001ff10a236', rssi: -83, snr: 9.5 }],
        txInfo: { frequency: 868100000, modulation: { lora: { bandwidth: 125000, spreadingFactor: 7, codeRate: 'CR_4_5' } } }
      });
      // No codec configured on this device profile: raw data only.
      await pub(`application/6d4e2b1a-0000-4000-8000-000000000001/device/${DEV_EUI.cs2}/event/up`, {
        time: now(), deviceInfo: { deviceName: 'pulse-counter-1', devEui: DEV_EUI.cs2, applicationName: 'cold-chain' }, fCnt: 7 + k, fPort: 2, data: 'AAECAwQ=', rxInfo: [{ rssi: -110, snr: -7.5 }], txInfo: { frequency: 868300000 }
      });
      await pub(`application/6d4e2b1a-0000-4000-8000-000000000001/device/${DEV_EUI.cs1}/event/status`, { time: now(), deviceInfo: { devEui: DEV_EUI.cs1, deviceName: 'freezer-3' }, margin: 12, externalPowerSource: false, batteryLevelUnavailable: false, batteryLevel: 87.5 });
      await pub(`v3/cold-chain@ttn/devices/eui-${DEV_EUI.tts}/up`, {
        end_device_ids: { device_id: `eui-${DEV_EUI.tts}`, application_ids: { application_id: 'cold-chain' }, dev_eui: DEV_EUI.tts.toUpperCase(), dev_addr: '260B1234' },
        received_at: now(),
        uplink_message: {
          f_port: 1, f_cnt: 42 + k, frm_payload: 'CGQB9A==', decoded_payload: { temperature_c: 4.2, door_open: false },
          rx_metadata: [{ gateway_ids: { gateway_id: 'gw-dock' }, rssi: -71, channel_rssi: -71, snr: 8.25 }],
          settings: { data_rate: { lora: { bandwidth: 125000, spreading_factor: 7 } }, frequency: '868500000' }, received_at: now(), last_battery_percentage: { f_cnt: 40, value: 92.1, received_at: now() }
        }
      });
    },

    /** One round of live values (deterministic: value = base + counter). */
    async tick() {
      n += 1;
      await pub(`${z2mBase}/${names.climate}`, { temperature: 21.5 + n / 10, humidity: 45.2, pressure: 1013.2, battery: 97, linkquality: 120, last_seen: now() });
      await pub(`${z2mBase}/${names.plug}`, { state: n % 2 ? 'ON' : 'OFF', power: 10 + n, linkquality: 60 });
      await pub(`${z2mBase}/${names.odd}`, { co2: 400 + n, voc_index: '12', last_seen: Date.now() });
      await pub(`${zwavePrefix}/5/49/0/Air_temperature`, {
        id: '5-49-0-Air temperature', nodeId: 5, commandClass: 49, commandClassName: 'Multilevel Sensor', endpoint: 0, property: 'Air temperature',
        type: 'number', readable: true, writeable: false, label: 'Air temperature', unit: '°C', min: -40, max: 85, value: 20.8 + n / 10, lastUpdate: Date.now()
      });
      await pub('garage-env/sensor/temperature/state', String(21.4 + n / 10));
      await pub('garage-env/sensor/climate', { humidity: String(48.5 + n), power_mw: 1234567 + n * 1000, mode: 'auto' });
      await pub('tele/tasmota_ABCDEF/SENSOR', { Time: '2026-11-25T10:00:00', ENERGY: { Total: 12.345 + n / 1000, Power: 45 + n, Voltage: 230, Current: 0.217 }, AM2301: { Temperature: 22.3, Humidity: 45.6 }, TempUnit: 'C' });
      await pub('stat/tasmota_ABCDEF/POWER', n % 2 ? 'ON' : 'OFF');
      await pub('shellies/shellyplug-s-7AF1E2/relay/0/power', String(12.5 + n));
      await pub('shellyplus1pm-a8032ab12345/events/rpc', { src: 'shellyplus1pm-a8032ab12345', dst: 'shellyplus1pm-a8032ab12345/events', method: 'NotifyStatus', params: { ts: Date.now() / 1000, 'switch:0': { id: 0, apower: 5 + n } } });
      await sim.lorawan(n);
      return n;
    },

    live(ms = 500) {
      clearInterval(timer);
      timer = setInterval(() => sim.tick().catch(() => {}), ms);
      timer.unref?.();
    },
    stopLive() {
      clearInterval(timer);
      timer = null;
    },

    async renameZigbee(from, to) {
      const key = Object.keys(names).find((k) => names[k] === from);
      if (!key) throw new Error(`no simulated device ${from}`);
      await retained(`${z2mBase}/${from}`, '');
      await retained(`${z2mBase}/${from}/availability`, '');
      names[key] = to;
      await retained(`${z2mBase}/bridge/devices`, z2mDevices(z2mBase, names));
      await retained(`${z2mBase}/${to}/availability`, 'online');
    },

    setZigbeeAvailability(name, state, { legacy = false } = {}) {
      return retained(`${z2mBase}/${name}/availability`, legacy ? state : { state });
    },
    setBridgeState(state) {
      return retained(`${z2mBase}/bridge/state`, { state });
    },
    setHaAvailability(state) {
      return retained('garage-env/status', state);
    },
    removeHaEntity() {
      return retained(`${haPrefix}/binary_sensor/garage_env/door/config`, '');
    },

    /** Payloads a hostile or broken publisher could send. None may crash or block ingest. */
    async hostile() {
      let deep = { v: 1 };
      for (let i = 0; i < 200; i++) deep = { a: deep };
      // distinct topics: the broker intake coalesces per topic, so each shape must arrive on its own
      await pub(`${z2mBase}/${names.light}`, deep);
      await pub(`${z2mBase}/${names.plug}`, '{"temperature": 2'); // truncated JSON
      await pub(`${z2mBase}/bridge/devices`, '{"not":"a list"}');
      await pub(`${haPrefix}/sensor/evil/x/config`, '{"__proto__":{"polluted":true},"name":"x","stat_t":"evil/x","constructor":{"prototype":{"bad":1}}}');
      await pub(`${haPrefix}/sensor/evil/y/config`, { name: 'y', stat_t: 'evil/y', val_tpl: "{{ ''.__class__.__mro__[1].__subclasses__() }}" });
      await pub('evil/y', '1');
      await pub('tele/evil_dev/SENSOR', { Time: 'x', BIG: { list: new Array(5000).fill(1), str: 'x'.repeat(100_000) } });
      await pub('shellyplus1pm-a8032ab12345/events/rpc', { method: 'NotifyStatus', params: null });
      await pub(`application/x/device/${DEV_EUI.cs1}/event/up`, [1, 2, 3]);
      await pub(`${zwavePrefix}/5/49/0/Air_temperature`, Buffer.from([0xff, 0xfe, 0x00, 0x01]));
      await pub(`${z2mBase}/${names.climate}`, Buffer.alloc(300 * 1024, 0x41)); // over the payload cap
    },

    /** A separate subscriber on every command / set / downlink topic of the simulated ecosystems. */
    async watchCommands() {
      const c = mqtt.connect(`mqtt://${host}:${port}`, { reconnectPeriod: 0 });
      const messages = [];
      await new Promise((resolve, reject) => {
        c.once('connect', resolve);
        c.once('error', reject);
      });
      c.on('message', (topic, buf) => {
        // zwave/# and garage-env/# are watched whole: only their write topics count.
        if ((topic.startsWith(`${zwavePrefix}/`) || topic.startsWith('garage-env/')) && !/\/set$|\/api\//.test(topic)) return;
        messages.push({ topic, payload: buf.toString() });
      });
      await new Promise((resolve, reject) => c.subscribe(COMMAND_FILTERS.map((f) => f.replace(/^zwave/, zwavePrefix)), { qos: 0 }, (e) => (e ? reject(e) : resolve())));
      return { messages, close: () => new Promise((resolve) => c.end(true, {}, resolve)) };
    },

    async close() {
      sim.stopLive();
      await new Promise((resolve) => client.end(true, {}, resolve));
    }
  };
  return sim;
}

module.exports = { startIotSimulator, IEEE, DEV_EUI, COMMAND_FILTERS };
