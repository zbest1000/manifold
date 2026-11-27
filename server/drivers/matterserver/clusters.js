'use strict';

/**
 * Built-in table of the common Matter clusters (Matter 1.3/1.4 Application Cluster Library):
 * human names, data types, units and the scaling rules the spec defines for each attribute.
 * Clusters and attributes not listed here are still readable by numeric path; they are then
 * shown with their ids and their raw value.
 *
 * Attribute entry: [id, name, type, opts?]
 *   type   bool | uint8..uint64 | int8..int64 | enum8 | enum16 | bitmap8..bitmap32 | single |
 *          string | octstr | list | struct | epoch-s | epoch-us
 *   opts   scale   multiply the raw integer (e.g. 0.01 for 0.01 degC units)
 *          unit    unit AFTER scaling
 *          states  enum labels
 *          transform  'illuminance' (10^((v-1)/10000) lx, 0 = too low), 'bit0' (bitmap -> bool),
 *                     'energy' (EnergyMeasurementStruct -> energy field, mWh -> Wh)
 *          unitFrom   attribute id in the same cluster whose enum value names the unit
 */

const CONC_UNITS = { 0: 'ppm', 1: 'ppb', 2: 'ppt', 3: 'mg/m³', 4: 'µg/m³', 5: 'ng/m³', 6: 'particles/m³', 7: 'Bq/m³' };
const LEVEL_STATES = { 0: 'Unknown', 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Critical' };
const MEDIUM_STATES = { 0: 'Air', 1: 'Water', 2: 'Soil' };

/** The attribute layout shared by every concentration measurement cluster. */
function concentration() {
  return [
    [0x0000, 'MeasuredValue', 'single', { unitFrom: 0x0008 }],
    [0x0001, 'MinMeasuredValue', 'single', { unitFrom: 0x0008 }],
    [0x0002, 'MaxMeasuredValue', 'single', { unitFrom: 0x0008 }],
    [0x0003, 'PeakMeasuredValue', 'single', { unitFrom: 0x0008 }],
    [0x0004, 'PeakMeasuredValueWindow', 'uint32', { unit: 's' }],
    [0x0005, 'AverageMeasuredValue', 'single', { unitFrom: 0x0008 }],
    [0x0006, 'AverageMeasuredValueWindow', 'uint32', { unit: 's' }],
    [0x0007, 'Uncertainty', 'single'],
    [0x0008, 'MeasurementUnit', 'enum8', { states: { 0: 'PPM', 1: 'PPB', 2: 'PPT', 3: 'MGM3', 4: 'UGM3', 5: 'NGM3', 6: 'PM3', 7: 'BQM3' } }],
    [0x0009, 'MeasurementMedium', 'enum8', { states: MEDIUM_STATES }],
    [0x000a, 'LevelValue', 'enum8', { states: LEVEL_STATES }],
  ];
}

const BASIC_INFO = [
  [0x0000, 'DataModelRevision', 'uint16'],
  [0x0001, 'VendorName', 'string'],
  [0x0002, 'VendorID', 'uint16'],
  [0x0003, 'ProductName', 'string'],
  [0x0004, 'ProductID', 'uint16'],
  [0x0005, 'NodeLabel', 'string'],
  [0x0006, 'Location', 'string'],
  [0x0007, 'HardwareVersion', 'uint16'],
  [0x0008, 'HardwareVersionString', 'string'],
  [0x0009, 'SoftwareVersion', 'uint32'],
  [0x000a, 'SoftwareVersionString', 'string'],
  [0x000b, 'ManufacturingDate', 'string'],
  [0x000c, 'PartNumber', 'string'],
  [0x000d, 'ProductURL', 'string'],
  [0x000e, 'ProductLabel', 'string'],
  [0x000f, 'SerialNumber', 'string'],
  [0x0011, 'Reachable', 'bool'],
  [0x0012, 'UniqueID', 'string'],
];

const CLUSTERS = [
  [0x001d, 'Descriptor', [
    [0x0000, 'DeviceTypeList', 'list'],
    [0x0001, 'ServerList', 'list'],
    [0x0002, 'ClientList', 'list'],
    [0x0003, 'PartsList', 'list'],
    [0x0004, 'TagList', 'list'],
  ]],
  [0x0028, 'BasicInformation', BASIC_INFO],
  [0x0039, 'BridgedDeviceBasicInformation', BASIC_INFO],
  [0x0006, 'OnOff', [
    [0x0000, 'OnOff', 'bool'],
    [0x4000, 'GlobalSceneControl', 'bool'],
    [0x4001, 'OnTime', 'uint16', { scale: 0.1, unit: 's' }],
    [0x4002, 'OffWaitTime', 'uint16', { scale: 0.1, unit: 's' }],
    [0x4003, 'StartUpOnOff', 'enum8', { states: { 0: 'Off', 1: 'On', 2: 'Toggle' } }],
  ]],
  [0x0008, 'LevelControl', [
    [0x0000, 'CurrentLevel', 'uint8', { description: '0-254' }],
    [0x0001, 'RemainingTime', 'uint16', { scale: 0.1, unit: 's' }],
    [0x0002, 'MinLevel', 'uint8'],
    [0x0003, 'MaxLevel', 'uint8'],
    [0x0004, 'CurrentFrequency', 'uint16', { unit: 'Hz' }],
    [0x000f, 'Options', 'bitmap8'],
    [0x0010, 'OnOffTransitionTime', 'uint16', { scale: 0.1, unit: 's' }],
    [0x0011, 'OnLevel', 'uint8'],
    [0x4000, 'StartUpCurrentLevel', 'uint8'],
  ]],
  [0x0300, 'ColorControl', [
    [0x0000, 'CurrentHue', 'uint8', { description: '0-254 = 0-360 degrees' }],
    [0x0001, 'CurrentSaturation', 'uint8', { description: '0-254' }],
    [0x0002, 'RemainingTime', 'uint16', { scale: 0.1, unit: 's' }],
    [0x0003, 'CurrentX', 'uint16', { scale: 1 / 65536, description: 'CIE x' }],
    [0x0004, 'CurrentY', 'uint16', { scale: 1 / 65536, description: 'CIE y' }],
    [0x0007, 'ColorTemperatureMireds', 'uint16', { unit: 'mired' }],
    [0x0008, 'ColorMode', 'enum8', { states: { 0: 'Hue/Saturation', 1: 'XY', 2: 'Color temperature' } }],
    [0x4000, 'EnhancedCurrentHue', 'uint16'],
    [0x4001, 'EnhancedColorMode', 'enum8', { states: { 0: 'Hue/Saturation', 1: 'XY', 2: 'Color temperature', 3: 'Enhanced hue/saturation' } }],
    [0x400a, 'ColorCapabilities', 'bitmap16'],
    [0x400b, 'ColorTempPhysicalMinMireds', 'uint16', { unit: 'mired' }],
    [0x400c, 'ColorTempPhysicalMaxMireds', 'uint16', { unit: 'mired' }],
  ]],
  [0x0402, 'TemperatureMeasurement', [
    [0x0000, 'MeasuredValue', 'int16', { scale: 0.01, unit: '°C' }],
    [0x0001, 'MinMeasuredValue', 'int16', { scale: 0.01, unit: '°C' }],
    [0x0002, 'MaxMeasuredValue', 'int16', { scale: 0.01, unit: '°C' }],
    [0x0003, 'Tolerance', 'uint16', { scale: 0.01, unit: '°C' }],
  ]],
  [0x0403, 'PressureMeasurement', [
    [0x0000, 'MeasuredValue', 'int16', { scale: 0.1, unit: 'kPa' }],
    [0x0001, 'MinMeasuredValue', 'int16', { scale: 0.1, unit: 'kPa' }],
    [0x0002, 'MaxMeasuredValue', 'int16', { scale: 0.1, unit: 'kPa' }],
    [0x0003, 'Tolerance', 'uint16', { scale: 0.1, unit: 'kPa' }],
    [0x0010, 'ScaledValue', 'int16', { description: 'ScaledValue x 10^Scale kPa' }],
    [0x0014, 'Scale', 'int8'],
  ]],
  [0x0400, 'IlluminanceMeasurement', [
    [0x0000, 'MeasuredValue', 'uint16', { transform: 'illuminance', unit: 'lx' }],
    [0x0001, 'MinMeasuredValue', 'uint16', { transform: 'illuminance', unit: 'lx' }],
    [0x0002, 'MaxMeasuredValue', 'uint16', { transform: 'illuminance', unit: 'lx' }],
    [0x0003, 'Tolerance', 'uint16'],
    [0x0004, 'LightSensorType', 'enum8', { states: { 0: 'Photodiode', 1: 'CMOS' } }],
  ]],
  [0x0405, 'RelativeHumidityMeasurement', [
    [0x0000, 'MeasuredValue', 'uint16', { scale: 0.01, unit: '%' }],
    [0x0001, 'MinMeasuredValue', 'uint16', { scale: 0.01, unit: '%' }],
    [0x0002, 'MaxMeasuredValue', 'uint16', { scale: 0.01, unit: '%' }],
    [0x0003, 'Tolerance', 'uint16', { scale: 0.01, unit: '%' }],
  ]],
  [0x0406, 'OccupancySensing', [
    [0x0000, 'Occupancy', 'bitmap8', { transform: 'bit0', description: 'bit 0: occupied' }],
    [0x0001, 'OccupancySensorType', 'enum8', { states: { 0: 'PIR', 1: 'Ultrasonic', 2: 'PIR and ultrasonic', 3: 'Physical contact' } }],
    [0x0002, 'OccupancySensorTypeBitmap', 'bitmap8'],
    [0x0010, 'PIROccupiedToUnoccupiedDelay', 'uint16', { unit: 's' }],
  ]],
  [0x0045, 'BooleanState', [[0x0000, 'StateValue', 'bool']]],
  [0x002f, 'PowerSource', [
    [0x0000, 'Status', 'enum8', { states: { 0: 'Unspecified', 1: 'Active', 2: 'Standby', 3: 'Unavailable' } }],
    [0x0001, 'Order', 'uint8'],
    [0x0002, 'Description', 'string'],
    [0x0003, 'WiredAssessedInputVoltage', 'uint32', { scale: 0.001, unit: 'V' }],
    [0x0004, 'WiredAssessedInputFrequency', 'uint16', { unit: 'Hz' }],
    [0x0005, 'WiredCurrentType', 'enum8', { states: { 0: 'AC', 1: 'DC' } }],
    [0x0006, 'WiredAssessedCurrent', 'uint32', { scale: 0.001, unit: 'A' }],
    [0x0008, 'WiredMaximumCurrent', 'uint32', { scale: 0.001, unit: 'A' }],
    [0x0009, 'WiredPresent', 'bool'],
    [0x000b, 'BatVoltage', 'uint32', { scale: 0.001, unit: 'V' }],
    [0x000c, 'BatPercentRemaining', 'uint8', { scale: 0.5, unit: '%' }],
    [0x000d, 'BatTimeRemaining', 'uint32', { unit: 's' }],
    [0x000e, 'BatChargeLevel', 'enum8', { states: { 0: 'OK', 1: 'Warning', 2: 'Critical' } }],
    [0x000f, 'BatReplacementNeeded', 'bool'],
    [0x0010, 'BatReplaceability', 'enum8', { states: { 0: 'Unspecified', 1: 'Not replaceable', 2: 'User replaceable', 3: 'Factory replaceable' } }],
    [0x0011, 'BatPresent', 'bool'],
    [0x0013, 'BatReplacementDescription', 'string'],
    [0x0019, 'BatQuantity', 'uint8'],
    [0x001a, 'BatChargeState', 'enum8', { states: { 0: 'Unknown', 1: 'Charging', 2: 'At full charge', 3: 'Not charging' } }],
  ]],
  [0x0090, 'ElectricalPowerMeasurement', [
    [0x0000, 'PowerMode', 'enum8', { states: { 0: 'Unknown', 1: 'DC', 2: 'AC' } }],
    [0x0001, 'NumberOfMeasurementTypes', 'uint8'],
    [0x0002, 'Accuracy', 'list'],
    [0x0004, 'Voltage', 'int64', { scale: 0.001, unit: 'V' }],
    [0x0005, 'ActiveCurrent', 'int64', { scale: 0.001, unit: 'A' }],
    [0x0006, 'ReactiveCurrent', 'int64', { scale: 0.001, unit: 'A' }],
    [0x0007, 'ApparentCurrent', 'int64', { scale: 0.001, unit: 'A' }],
    [0x0008, 'ActivePower', 'int64', { scale: 0.001, unit: 'W' }],
    [0x0009, 'ReactivePower', 'int64', { scale: 0.001, unit: 'var' }],
    [0x000a, 'ApparentPower', 'int64', { scale: 0.001, unit: 'VA' }],
    [0x000b, 'RMSVoltage', 'int64', { scale: 0.001, unit: 'V' }],
    [0x000c, 'RMSCurrent', 'int64', { scale: 0.001, unit: 'A' }],
    [0x000d, 'RMSPower', 'int64', { scale: 0.001, unit: 'W' }],
    [0x000e, 'Frequency', 'int64', { scale: 0.001, unit: 'Hz' }],
    [0x0010, 'HarmonicCurrents', 'list'],
    [0x0011, 'PowerFactor', 'int64', { scale: 0.01 }],
    [0x0012, 'NeutralCurrent', 'int64', { scale: 0.001, unit: 'A' }],
  ]],
  [0x0091, 'ElectricalEnergyMeasurement', [
    [0x0000, 'Accuracy', 'struct'],
    [0x0001, 'CumulativeEnergyImported', 'struct', { transform: 'energy', unit: 'Wh' }],
    [0x0002, 'CumulativeEnergyExported', 'struct', { transform: 'energy', unit: 'Wh' }],
    [0x0003, 'PeriodicEnergyImported', 'struct', { transform: 'energy', unit: 'Wh' }],
    [0x0004, 'PeriodicEnergyExported', 'struct', { transform: 'energy', unit: 'Wh' }],
    [0x0005, 'CumulativeEnergyReset', 'struct'],
  ]],
  [0x0201, 'Thermostat', [
    [0x0000, 'LocalTemperature', 'int16', { scale: 0.01, unit: '°C' }],
    [0x0001, 'OutdoorTemperature', 'int16', { scale: 0.01, unit: '°C' }],
    [0x0002, 'Occupancy', 'bitmap8', { transform: 'bit0', description: 'bit 0: occupied' }],
    [0x0003, 'AbsMinHeatSetpointLimit', 'int16', { scale: 0.01, unit: '°C' }],
    [0x0004, 'AbsMaxHeatSetpointLimit', 'int16', { scale: 0.01, unit: '°C' }],
    [0x0005, 'AbsMinCoolSetpointLimit', 'int16', { scale: 0.01, unit: '°C' }],
    [0x0006, 'AbsMaxCoolSetpointLimit', 'int16', { scale: 0.01, unit: '°C' }],
    [0x0007, 'PICoolingDemand', 'uint8', { unit: '%' }],
    [0x0008, 'PIHeatingDemand', 'uint8', { unit: '%' }],
    [0x0011, 'OccupiedCoolingSetpoint', 'int16', { scale: 0.01, unit: '°C' }],
    [0x0012, 'OccupiedHeatingSetpoint', 'int16', { scale: 0.01, unit: '°C' }],
    [0x0013, 'UnoccupiedCoolingSetpoint', 'int16', { scale: 0.01, unit: '°C' }],
    [0x0014, 'UnoccupiedHeatingSetpoint', 'int16', { scale: 0.01, unit: '°C' }],
    [0x0015, 'MinHeatSetpointLimit', 'int16', { scale: 0.01, unit: '°C' }],
    [0x0016, 'MaxHeatSetpointLimit', 'int16', { scale: 0.01, unit: '°C' }],
    [0x0017, 'MinCoolSetpointLimit', 'int16', { scale: 0.01, unit: '°C' }],
    [0x0018, 'MaxCoolSetpointLimit', 'int16', { scale: 0.01, unit: '°C' }],
    [0x001b, 'ControlSequenceOfOperation', 'enum8', { states: { 0: 'Cooling only', 1: 'Cooling with reheat', 2: 'Heating only', 3: 'Heating with reheat', 4: 'Cooling and heating', 5: 'Cooling and heating with reheat' } }],
    [0x001c, 'SystemMode', 'enum8', { states: { 0: 'Off', 1: 'Auto', 3: 'Cool', 4: 'Heat', 5: 'Emergency heat', 6: 'Precooling', 7: 'Fan only', 8: 'Dry', 9: 'Sleep' } }],
    [0x001e, 'ThermostatRunningMode', 'enum8', { states: { 0: 'Off', 3: 'Cool', 4: 'Heat' } }],
    [0x0029, 'ThermostatRunningState', 'bitmap16', { description: 'bit 0 heat, 1 cool, 2 fan' }],
  ]],
  [0x0101, 'DoorLock', [
    [0x0000, 'LockState', 'enum8', { states: { 0: 'Not fully locked', 1: 'Locked', 2: 'Unlocked', 3: 'Unlatched' } }],
    [0x0001, 'LockType', 'enum8'],
    [0x0002, 'ActuatorEnabled', 'bool'],
    [0x0003, 'DoorState', 'enum8', { states: { 0: 'Open', 1: 'Closed', 2: 'Jammed', 3: 'Forced open', 4: 'Unspecified error', 5: 'Ajar' } }],
    [0x0004, 'DoorOpenEvents', 'uint32'],
    [0x0005, 'DoorClosedEvents', 'uint32'],
    [0x0025, 'OperatingMode', 'enum8', { states: { 0: 'Normal', 1: 'Vacation', 2: 'Privacy', 3: 'No remote lock/unlock', 4: 'Passage' } }],
  ]],
  [0x0102, 'WindowCovering', [
    [0x0000, 'Type', 'enum8'],
    [0x0007, 'ConfigStatus', 'bitmap8'],
    [0x0008, 'CurrentPositionLiftPercentage', 'uint8', { unit: '%' }],
    [0x0009, 'CurrentPositionTiltPercentage', 'uint8', { unit: '%' }],
    [0x000a, 'OperationalStatus', 'bitmap8'],
    [0x000b, 'TargetPositionLiftPercent100ths', 'uint16', { scale: 0.01, unit: '%' }],
    [0x000c, 'TargetPositionTiltPercent100ths', 'uint16', { scale: 0.01, unit: '%' }],
    [0x000d, 'EndProductType', 'enum8'],
    [0x000e, 'CurrentPositionLiftPercent100ths', 'uint16', { scale: 0.01, unit: '%' }],
    [0x000f, 'CurrentPositionTiltPercent100ths', 'uint16', { scale: 0.01, unit: '%' }],
    [0x0017, 'Mode', 'bitmap8'],
  ]],
  [0x005b, 'AirQuality', [
    [0x0000, 'AirQuality', 'enum8', { states: { 0: 'Unknown', 1: 'Good', 2: 'Fair', 3: 'Moderate', 4: 'Poor', 5: 'Very poor', 6: 'Extremely poor' } }],
  ]],
  [0x040c, 'CarbonMonoxideConcentrationMeasurement', concentration()],
  [0x040d, 'CarbonDioxideConcentrationMeasurement', concentration()],
  [0x0413, 'NitrogenDioxideConcentrationMeasurement', concentration()],
  [0x0415, 'OzoneConcentrationMeasurement', concentration()],
  [0x042a, 'Pm25ConcentrationMeasurement', concentration()],
  [0x042b, 'FormaldehydeConcentrationMeasurement', concentration()],
  [0x042c, 'Pm1ConcentrationMeasurement', concentration()],
  [0x042d, 'Pm10ConcentrationMeasurement', concentration()],
  [0x042e, 'TotalVolatileOrganicCompoundsConcentrationMeasurement', concentration()],
  [0x042f, 'RadonConcentrationMeasurement', concentration()],
];

/** Global attributes present on every cluster. */
const GLOBAL_ATTRIBUTES = [
  [0xfff8, 'GeneratedCommandList', 'list'],
  [0xfff9, 'AcceptedCommandList', 'list'],
  [0xfffa, 'EventList', 'list'],
  [0xfffb, 'AttributeList', 'list'],
  [0xfffc, 'FeatureMap', 'bitmap32'],
  [0xfffd, 'ClusterRevision', 'uint16'],
];

/** Device type ids that show up most (for endpoint labels in browse). */
const DEVICE_TYPES = {
  0x0016: 'Root node', 0x0011: 'Power source', 0x000e: 'Aggregator', 0x0013: 'Bridged node',
  0x0100: 'On/off light', 0x0101: 'Dimmable light', 0x010c: 'Color temperature light', 0x010d: 'Extended color light',
  0x010a: 'On/off plug-in unit', 0x010b: 'Dimmable plug-in unit', 0x0103: 'On/off light switch', 0x0104: 'Dimmer switch',
  0x0015: 'Contact sensor', 0x0106: 'Light sensor', 0x0107: 'Occupancy sensor', 0x0302: 'Temperature sensor',
  0x0305: 'Pressure sensor', 0x0307: 'Humidity sensor', 0x002c: 'Air quality sensor', 0x0301: 'Thermostat',
  0x000a: 'Door lock', 0x0202: 'Window covering', 0x0510: 'Electrical sensor', 0x002b: 'Fan', 0x0043: 'Water leak detector',
  0x0076: 'Smoke/CO alarm', 0x0041: 'Water freeze detector', 0x0044: 'Rain sensor', 0x050d: 'Device energy management',
};

const INT_TYPES = new Set(['uint8', 'uint16', 'uint32', 'uint64', 'int8', 'int16', 'int32', 'int64', 'enum8', 'enum16', 'bitmap8', 'bitmap16', 'bitmap32', 'epoch-s', 'epoch-us']);

const byId = new Map();
const byName = new Map();
for (const [id, name, attrs] of CLUSTERS) {
  if (byId.has(id)) throw new Error(`duplicate cluster ${id}`);
  const attributes = new Map();
  const attrByName = new Map();
  for (const [aid, aname, type, opts] of [...attrs, ...GLOBAL_ATTRIBUTES]) {
    const a = { id: aid, name: aname, type, ...(opts || {}) };
    attributes.set(aid, a);
    attrByName.set(aname.toLowerCase(), a);
  }
  const c = { id, name, attributes, attrByName };
  byId.set(id, c);
  byName.set(name.toLowerCase(), c);
}
const globalByName = new Map(GLOBAL_ATTRIBUTES.map(([aid, aname, type]) => [aname.toLowerCase(), { id: aid, name: aname, type }]));
const globalById = new Map(GLOBAL_ATTRIBUTES.map(([aid, aname, type]) => [aid, { id: aid, name: aname, type }]));

function clusterById(id) {
  return byId.get(id) || null;
}
function clusterByName(name) {
  return byName.get(String(name).toLowerCase()) || null;
}
/** Attribute definition (known cluster or global attribute), or null. */
function attributeDef(clusterId, attributeId) {
  const c = byId.get(clusterId);
  if (c) return c.attributes.get(attributeId) || null;
  return globalById.get(attributeId) || null;
}
function attributeByName(clusterId, name) {
  const c = byId.get(clusterId);
  const key = String(name).toLowerCase();
  if (c) return c.attrByName.get(key) || null;
  return globalByName.get(key) || null;
}

/** Sample type a definition decodes to (before the user's optional type override). */
function sampleTypeOf(def) {
  if (!def) return null;
  if (def.transform === 'bit0' || def.type === 'bool') return 'bool';
  if (def.transform === 'illuminance' || def.transform === 'energy' || def.type === 'single') return 'float64';
  if (def.type === 'string') return 'string';
  if (INT_TYPES.has(def.type)) return def.scale && def.scale !== 1 ? 'float64' : 'int64';
  return 'json';
}

const round = (v) => Math.round(v * 1e9) / 1e9;

/**
 * Convert a raw attribute value with its definition.
 * @returns {{ok:true, v:any, type:string} | {ok:false, reason:string}}
 */
function convert(def, raw) {
  if (raw === null || raw === undefined) return { ok: false, reason: 'no value' };
  if (!def) return rawValue(raw);
  switch (def.transform) {
    case 'bit0':
      return typeof raw === 'number' ? { ok: true, v: (raw & 1) === 1, type: 'bool' } : rawValue(raw);
    case 'illuminance':
      if (typeof raw !== 'number') return rawValue(raw);
      if (raw === 0) return { ok: true, v: 0, type: 'float64' }; // "too low to be measured"
      if (raw === 0xffff) return { ok: false, reason: 'no value' };
      return { ok: true, v: round(Math.pow(10, (raw - 1) / 10000)), type: 'float64' };
    case 'energy': {
      if (typeof raw !== 'object') return rawValue(raw);
      const e = raw.energy ?? raw['0'];
      if (e === null || e === undefined) return { ok: false, reason: 'no value' };
      const n = Number(e);
      return Number.isFinite(n) ? { ok: true, v: round(n / 1000), type: 'float64' } : { ok: false, reason: 'no value' };
    }
    default:
      break;
  }
  if (def.type === 'bool') return typeof raw === 'boolean' ? { ok: true, v: raw, type: 'bool' } : typeof raw === 'number' ? { ok: true, v: raw !== 0, type: 'bool' } : rawValue(raw);
  if (def.type === 'string') return { ok: true, v: typeof raw === 'string' ? raw : JSON.stringify(raw), type: 'string' };
  if (INT_TYPES.has(def.type) || def.type === 'single') {
    const n = typeof raw === 'string' && /^-?\d+$/.test(raw) ? Number(raw) : raw; // int64 may travel as text
    if (typeof n !== 'number' || !Number.isFinite(n)) return rawValue(raw);
    if (def.scale && def.scale !== 1) return { ok: true, v: round(n * def.scale), type: 'float64' };
    return { ok: true, v: n, type: def.type === 'single' ? 'float64' : 'int64' };
  }
  return rawValue(raw);
}

/** A value with no definition: scalars as they are, lists and structs as JSON text. */
function rawValue(raw) {
  if (typeof raw === 'boolean') return { ok: true, v: raw, type: 'bool' };
  if (typeof raw === 'number') return { ok: true, v: raw, type: Number.isInteger(raw) ? 'int64' : 'float64' };
  if (typeof raw === 'string') return { ok: true, v: raw, type: 'string' };
  return { ok: true, v: JSON.stringify(raw), type: 'json' };
}

const hex = (n, w = 4) => `0x${n.toString(16).padStart(w, '0')}`;

module.exports = { CLUSTERS, DEVICE_TYPES, CONC_UNITS, clusterById, clusterByName, attributeDef, attributeByName, sampleTypeOf, convert, rawValue, hex };
