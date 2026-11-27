'use strict';

/**
 * Tag addresses: numeric OIDs ("1.3.6.1.2.1.1.3.0", leading dot allowed) or a
 * well-known object name followed by its instance ("sysUpTime.0",
 * "ifInOctets.3", "hrStorageUsed.31"). This is a small fixed table, not a MIB
 * compiler: anything else is entered numerically.
 */

const { parseOid, BerError } = require('./ber');

const MIB2 = '1.3.6.1.2.1';
const IF_ENTRY = `${MIB2}.2.2.1`;
const IFX_ENTRY = `${MIB2}.31.1.1.1`;
const HR = `${MIB2}.25`;
const UPS = `${MIB2}.33.1`;
const UCD = '1.3.6.1.4.1.2021';

/** name -> { oid, scalar?, kind: SNMP type hint, counter? } (object OIDs, without the instance). */
const OBJECTS = {
  // SNMPv2-MIB system group
  sysDescr: { oid: `${MIB2}.1.1`, scalar: true, kind: 'OctetString' },
  sysObjectID: { oid: `${MIB2}.1.2`, scalar: true, kind: 'OID' },
  sysUpTime: { oid: `${MIB2}.1.3`, scalar: true, kind: 'TimeTicks' },
  sysContact: { oid: `${MIB2}.1.4`, scalar: true, kind: 'OctetString' },
  sysName: { oid: `${MIB2}.1.5`, scalar: true, kind: 'OctetString' },
  sysLocation: { oid: `${MIB2}.1.6`, scalar: true, kind: 'OctetString' },
  sysServices: { oid: `${MIB2}.1.7`, scalar: true, kind: 'Integer32' },
  // IF-MIB
  ifNumber: { oid: `${MIB2}.2.1`, scalar: true, kind: 'Integer32' },
  ifIndex: { oid: `${IF_ENTRY}.1`, kind: 'Integer32' },
  ifDescr: { oid: `${IF_ENTRY}.2`, kind: 'OctetString' },
  ifType: { oid: `${IF_ENTRY}.3`, kind: 'Integer32' },
  ifMtu: { oid: `${IF_ENTRY}.4`, kind: 'Integer32' },
  ifSpeed: { oid: `${IF_ENTRY}.5`, kind: 'Gauge32' },
  ifPhysAddress: { oid: `${IF_ENTRY}.6`, kind: 'OctetString' },
  ifAdminStatus: { oid: `${IF_ENTRY}.7`, kind: 'Integer32' },
  ifOperStatus: { oid: `${IF_ENTRY}.8`, kind: 'Integer32' },
  ifLastChange: { oid: `${IF_ENTRY}.9`, kind: 'TimeTicks' },
  ifInOctets: { oid: `${IF_ENTRY}.10`, kind: 'Counter32' },
  ifInUcastPkts: { oid: `${IF_ENTRY}.11`, kind: 'Counter32' },
  ifInDiscards: { oid: `${IF_ENTRY}.13`, kind: 'Counter32' },
  ifInErrors: { oid: `${IF_ENTRY}.14`, kind: 'Counter32' },
  ifInUnknownProtos: { oid: `${IF_ENTRY}.15`, kind: 'Counter32' },
  ifOutOctets: { oid: `${IF_ENTRY}.16`, kind: 'Counter32' },
  ifOutUcastPkts: { oid: `${IF_ENTRY}.17`, kind: 'Counter32' },
  ifOutDiscards: { oid: `${IF_ENTRY}.19`, kind: 'Counter32' },
  ifOutErrors: { oid: `${IF_ENTRY}.20`, kind: 'Counter32' },
  ifName: { oid: `${IFX_ENTRY}.1`, kind: 'OctetString' },
  ifInMulticastPkts: { oid: `${IFX_ENTRY}.2`, kind: 'Counter32' },
  ifInBroadcastPkts: { oid: `${IFX_ENTRY}.3`, kind: 'Counter32' },
  ifOutMulticastPkts: { oid: `${IFX_ENTRY}.4`, kind: 'Counter32' },
  ifOutBroadcastPkts: { oid: `${IFX_ENTRY}.5`, kind: 'Counter32' },
  ifHCInOctets: { oid: `${IFX_ENTRY}.6`, kind: 'Counter64' },
  ifHCInUcastPkts: { oid: `${IFX_ENTRY}.7`, kind: 'Counter64' },
  ifHCInMulticastPkts: { oid: `${IFX_ENTRY}.8`, kind: 'Counter64' },
  ifHCInBroadcastPkts: { oid: `${IFX_ENTRY}.9`, kind: 'Counter64' },
  ifHCOutOctets: { oid: `${IFX_ENTRY}.10`, kind: 'Counter64' },
  ifHCOutUcastPkts: { oid: `${IFX_ENTRY}.11`, kind: 'Counter64' },
  ifHCOutMulticastPkts: { oid: `${IFX_ENTRY}.12`, kind: 'Counter64' },
  ifHCOutBroadcastPkts: { oid: `${IFX_ENTRY}.13`, kind: 'Counter64' },
  ifHighSpeed: { oid: `${IFX_ENTRY}.15`, kind: 'Gauge32' },
  ifAlias: { oid: `${IFX_ENTRY}.18`, kind: 'OctetString' },
  // HOST-RESOURCES-MIB
  hrSystemUptime: { oid: `${HR}.1.1`, scalar: true, kind: 'TimeTicks' },
  hrSystemNumUsers: { oid: `${HR}.1.5`, scalar: true, kind: 'Gauge32' },
  hrSystemProcesses: { oid: `${HR}.1.6`, scalar: true, kind: 'Gauge32' },
  hrMemorySize: { oid: `${HR}.2.2`, scalar: true, kind: 'Integer32' },
  hrStorageIndex: { oid: `${HR}.2.3.1.1`, kind: 'Integer32' },
  hrStorageType: { oid: `${HR}.2.3.1.2`, kind: 'OID' },
  hrStorageDescr: { oid: `${HR}.2.3.1.3`, kind: 'OctetString' },
  hrStorageAllocationUnits: { oid: `${HR}.2.3.1.4`, kind: 'Integer32' },
  hrStorageSize: { oid: `${HR}.2.3.1.5`, kind: 'Integer32' },
  hrStorageUsed: { oid: `${HR}.2.3.1.6`, kind: 'Integer32' },
  hrDeviceDescr: { oid: `${HR}.3.2.1.3`, kind: 'OctetString' },
  hrProcessorLoad: { oid: `${HR}.3.3.1.2`, kind: 'Integer32' },
  // UPS-MIB (RFC 1628)
  upsIdentManufacturer: { oid: `${UPS}.1.1`, scalar: true, kind: 'OctetString' },
  upsIdentModel: { oid: `${UPS}.1.2`, scalar: true, kind: 'OctetString' },
  upsBatteryStatus: { oid: `${UPS}.2.1`, scalar: true, kind: 'Integer32' },
  upsSecondsOnBattery: { oid: `${UPS}.2.2`, scalar: true, kind: 'Integer32' },
  upsEstimatedMinutesRemaining: { oid: `${UPS}.2.3`, scalar: true, kind: 'Integer32' },
  upsEstimatedChargeRemaining: { oid: `${UPS}.2.4`, scalar: true, kind: 'Integer32' },
  upsBatteryVoltage: { oid: `${UPS}.2.5`, scalar: true, kind: 'Integer32' },
  upsBatteryTemperature: { oid: `${UPS}.2.7`, scalar: true, kind: 'Integer32' },
  upsInputFrequency: { oid: `${UPS}.3.3.1.2`, kind: 'Integer32' },
  upsInputVoltage: { oid: `${UPS}.3.3.1.3`, kind: 'Integer32' },
  upsOutputSource: { oid: `${UPS}.4.1`, scalar: true, kind: 'Integer32' },
  upsOutputFrequency: { oid: `${UPS}.4.2`, scalar: true, kind: 'Integer32' },
  upsOutputVoltage: { oid: `${UPS}.4.4.1.2`, kind: 'Integer32' },
  upsOutputCurrent: { oid: `${UPS}.4.4.1.3`, kind: 'Integer32' },
  upsOutputPower: { oid: `${UPS}.4.4.1.4`, kind: 'Integer32' },
  upsOutputPercentLoad: { oid: `${UPS}.4.4.1.5`, kind: 'Integer32' },
  upsAlarmsPresent: { oid: `${UPS}.6.1`, scalar: true, kind: 'Gauge32' },
  // ENTITY-SENSOR-MIB
  entPhySensorType: { oid: `${MIB2}.99.1.1.1.1`, kind: 'Integer32' },
  entPhySensorScale: { oid: `${MIB2}.99.1.1.1.2`, kind: 'Integer32' },
  entPhySensorPrecision: { oid: `${MIB2}.99.1.1.1.3`, kind: 'Integer32' },
  entPhySensorValue: { oid: `${MIB2}.99.1.1.1.4`, kind: 'Integer32' },
  entPhySensorOperStatus: { oid: `${MIB2}.99.1.1.1.5`, kind: 'Integer32' },
  // UCD-SNMP-MIB (net-snmp agents on Linux gateways)
  laLoad: { oid: `${UCD}.10.1.3`, kind: 'OctetString' },
  laLoadInt: { oid: `${UCD}.10.1.5`, kind: 'Integer32' },
  memTotalReal: { oid: `${UCD}.4.5`, scalar: true, kind: 'Integer32' },
  memAvailReal: { oid: `${UCD}.4.6`, scalar: true, kind: 'Integer32' },
  ssCpuIdle: { oid: `${UCD}.11.11`, scalar: true, kind: 'Integer32' },
  // SNMP-FRAMEWORK-MIB
  snmpEngineID: { oid: '1.3.6.1.6.3.10.2.1.1', scalar: true, kind: 'OctetString' },
  snmpEngineBoots: { oid: '1.3.6.1.6.3.10.2.1.2', scalar: true, kind: 'Integer32' },
  snmpEngineTime: { oid: '1.3.6.1.6.3.10.2.1.3', scalar: true, kind: 'Integer32' },
};

const BY_LOWER = new Map(Object.keys(OBJECTS).map((n) => [n.toLowerCase(), n]));
const BY_OID = new Map(Object.entries(OBJECTS).map(([n, o]) => [o.oid, n]));

const SYS_UPTIME = '1.3.6.1.2.1.1.3.0';
const SYS_DESCR = '1.3.6.1.2.1.1.1.0';
const SYS_OBJECT_ID = '1.3.6.1.2.1.1.2.0';
const SYS_NAME = '1.3.6.1.2.1.1.5.0';

/** Subtrees offered as browse roots. */
const BROWSE_ROOTS = [
  { id: 'system', name: 'system', oid: `${MIB2}.1` },
  { id: 'interfaces', name: 'interfaces (ifTable)', oid: `${MIB2}.2` },
  { id: 'ifXTable', name: 'ifXTable (64-bit counters, names)', oid: `${MIB2}.31.1.1` },
  { id: 'host', name: 'host resources', oid: HR },
  { id: 'ups', name: 'UPS-MIB', oid: `${MIB2}.33` },
  { id: 'entitySensor', name: 'entity sensors', oid: `${MIB2}.99` },
  { id: 'enterprises', name: 'enterprises (vendor MIBs)', oid: '1.3.6.1.4.1' },
  { id: 'mib-2', name: 'mib-2 (everything standard)', oid: MIB2 },
];

/**
 * Resolve a tag address to a numeric OID.
 * @returns {{oid:string, name:string|null, kind:string|null}}
 * @throws {Error} with a message for the user
 */
function resolveAddress(address) {
  if (typeof address !== 'string' || !address.trim()) throw new Error('address must be a numeric OID or a known name such as sysUpTime.0');
  const text = address.trim();
  if (/^\.?\d/.test(text)) {
    try {
      const oid = parseOid(text).join('.');
      const named = nameOf(oid);
      return { oid, name: named ? named.text : null, kind: named ? named.kind : null };
    } catch (err) {
      if (err instanceof BerError) throw new Error(err.message);
      throw err;
    }
  }
  const m = /^([A-Za-z][A-Za-z0-9-]*)((?:\.\d+)*)$/.exec(text);
  if (!m) throw new Error(`"${text}" is neither a numeric OID nor name.instance (e.g. ifInOctets.1)`);
  const canonical = BY_LOWER.get(m[1].toLowerCase());
  if (!canonical) throw new Error(`unknown object name "${m[1]}"; enter the numeric OID instead (only a small built-in table of names is known)`);
  const obj = OBJECTS[canonical];
  let suffix = m[2];
  if (!suffix) {
    if (!obj.scalar) throw new Error(`${canonical} is a table column: add the row index, e.g. ${canonical}.1`);
    suffix = '.0';
  }
  const oid = parseOid(`${obj.oid}${suffix}`).join('.');
  return { oid, name: `${canonical}${suffix}`, kind: obj.kind };
}

/** Best-effort "name.instance" for a numeric OID (longest known object prefix), or null. */
function nameOf(oid) {
  const arcs = String(oid).split('.');
  for (let n = arcs.length - 1; n >= 2; n--) {
    const prefix = arcs.slice(0, n).join('.');
    const name = BY_OID.get(prefix);
    if (name) return { text: `${name}.${arcs.slice(n).join('.')}`, name, kind: OBJECTS[name].kind };
  }
  return null;
}

/** True when `oid` lies strictly under `root`. */
function isUnder(oid, root) {
  return oid.length > root.length && oid.startsWith(root) && oid[root.length] === '.';
}

/** Numeric OID comparison (lexicographic by arc), as SNMP orders the MIB. */
function compareOids(a, b) {
  const x = a.split('.');
  const y = b.split('.');
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return d < 0 ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

module.exports = {
  OBJECTS,
  BROWSE_ROOTS,
  SYS_UPTIME,
  SYS_DESCR,
  SYS_OBJECT_ID,
  SYS_NAME,
  resolveAddress,
  nameOf,
  isUnder,
  compareOids,
};
