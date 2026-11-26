'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseXml, XmlError, decode } = require('../drivers/mtconnect/xml');
const { parseDocument, parseProbe, parseObservations, unitSymbol } = require('../drivers/mtconnect/document');

// Documents below follow the shapes in the public MTConnect Standard (Parts 1, 2 and 4) and the
// reference agent's published examples; ids and values are made up.

const STREAMS_13 = `<?xml version="1.0" encoding="UTF-8"?>
<MTConnectStreams xmlns:m="urn:mtconnect.org:MTConnectStreams:1.3" xmlns="urn:mtconnect.org:MTConnectStreams:1.3"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="urn:mtconnect.org:MTConnectStreams:1.3 http://schemas.mtconnect.org/schemas/MTConnectStreams_1.3.xsd">
  <Header creationTime="2012-02-21T23:57:34Z" sender="localhost" instanceId="1329892454" bufferSize="131072"
          version="1.3.0.0" nextSequence="34150" firstSequence="1" lastSequence="34149"/>
  <Streams>
    <DeviceStream name="VMC-3Axis" uuid="000">
      <ComponentStream component="Linear" name="X" componentId="x">
        <Samples>
          <Position dataItemId="Xact" timestamp="2012-02-21T23:57:34.123456Z" name="Xact" subType="ACTUAL" sequence="34100">-1.5</Position>
          <PositionTimeSeries dataItemId="Xts" timestamp="2012-02-21T23:57:34.2Z" sequence="34101" sampleCount="3" sampleRate="100">1 2 3</PositionTimeSeries>
        </Samples>
        <Events/>
        <Condition>
          <Normal dataItemId="Xcond" timestamp="2012-02-21T23:57:34Z" sequence="34102" type="POSITION"/>
        </Condition>
      </ComponentStream>
      <ComponentStream component="Controller" name="controller" componentId="cn">
        <Events>
          <Execution dataItemId="exec" timestamp="2012-02-21T23:57:35Z" sequence="34110">ACTIVE</Execution>
          <Message dataItemId="msg" timestamp="2012-02-21T23:57:36Z" sequence="34111" nativeCode="M30">Program &amp; cycle &lt;done&gt; &#x263A;</Message>
          <VariableDataSet dataItemId="vars" timestamp="2012-02-21T23:57:37Z" sequence="34112" count="2"><Entry key="a">1</Entry><Entry key="b">2</Entry></VariableDataSet>
        </Events>
        <Condition>
          <Fault dataItemId="sys" timestamp="2012-02-21T23:57:38Z" sequence="34120" type="SYSTEM" nativeCode="E42" nativeSeverity="9" qualifier="HIGH">Over temperature</Fault>
          <Warning dataItemId="sys" timestamp="2012-02-21T23:57:38Z" sequence="34121" type="SYSTEM" nativeCode="W7"><![CDATA[Filter <low>]]></Warning>
          <Unavailable dataItemId="other" timestamp="2012-02-21T23:57:38Z" sequence="34122" type="LOGIC_PROGRAM"/>
        </Condition>
      </ComponentStream>
    </DeviceStream>
  </Streams>
</MTConnectStreams>`;

const STREAMS_PREFIXED_2 = `<?xml version="1.0" encoding="UTF-8"?>
<m:MTConnectStreams xmlns:m="urn:mtconnect.org:MTConnectStreams:2.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<m:Header creationTime="2024-05-01T10:00:00Z" sender="agent" instanceId="18446744073709551000" bufferSize="8192" version="2.2.0.1"
  nextSequence="18446744073709551600" firstSequence="18446744073709550000" lastSequence="18446744073709551599" deviceModelChangeTime="2024-05-01T09:00:00Z"/>
<m:Streams><m:DeviceStream name="Agent" uuid="agent-uuid"><m:ComponentStream component="Agent" name="Agent" componentId="agent_1">
<m:Events><m:Availability dataItemId="agent_avail" timestamp="2024-05-01T10:00:00.5Z" sequence="18446744073709551598">AVAILABLE</m:Availability></m:Events>
</m:ComponentStream></m:DeviceStream></m:Streams></m:MTConnectStreams>`;

const PROBE_2 = `<?xml version="1.0" encoding="UTF-8"?>
<MTConnectDevices xmlns="urn:mtconnect.org:MTConnectDevices:2.2" xmlns:m="urn:mtconnect.org:MTConnectDevices:2.2">
<Header creationTime="2024-05-01T10:00:00Z" sender="agent" instanceId="7" bufferSize="4096" version="2.2.0.1" assetBufferSize="1024" assetCount="0"
  nextSequence="1" firstSequence="1" lastSequence="0"/>
<Devices>
 <Device id="d1" name="lathe" uuid="LATHE-1" iso841Class="6">
  <Description manufacturer="Acme" model="L1">Lathe</Description>
  <DataItems><DataItem category="EVENT" id="d1_avail" type="AVAILABILITY"/></DataItems>
  <Components>
   <Axes id="a" name="Axes">
    <Components>
     <Rotary id="c" name="C"><DataItems>
       <DataItem category="SAMPLE" id="Sspeed" name="Srpm" type="SPINDLE_SPEED" subType="ACTUAL" units="REVOLUTION/MINUTE" nativeUnits="REVOLUTION/MINUTE"/>
       <DataItem category="SAMPLE" id="Stemp" type="TEMPERATURE" units="CELSIUS" statistic="AVERAGE"/>
       <DataItem category="SAMPLE" id="Svib" type="VIBRATION" units="HERTZ" representation="TIME_SERIES" sampleRate="100"/>
     </DataItems><Compositions><Composition id="mot" type="MOTOR"/></Compositions></Rotary>
    </Components>
   </Axes>
   <Controller id="ctl" name="controller">
    <DataItems><DataItem category="CONDITION" id="sys" type="SYSTEM"/><DataItem category="EVENT" id="vars" type="VARIABLE" representation="DATA_SET"/></DataItems>
    <Components><Path id="p1" name="path"><DataItems><DataItem category="EVENT" id="exec" type="EXECUTION"/></DataItems></Path></Components>
   </Controller>
  </Components>
 </Device>
</Devices></MTConnectDevices>`;

const ERROR_13 = `<?xml version="1.0" encoding="UTF-8"?>
<MTConnectError xmlns:m="urn:mtconnect.org:MTConnectError:1.3" xmlns="urn:mtconnect.org:MTConnectError:1.3">
<Header creationTime="2012-02-21T23:57:34Z" sender="localhost" instanceId="1329892454" bufferSize="131072" version="1.3.0.0"/>
<Errors><Error errorCode="OUT_OF_RANGE">'from' must be less than 34150, from = 99999</Error></Errors></MTConnectError>`;

test('streams 1.3: header, every observation kind, entities, CDATA, 6-digit fractional seconds', () => {
  const doc = parseDocument(STREAMS_13);
  assert.equal(doc.kind, 'streams');
  assert.equal(doc.header.instanceId, '1329892454');
  assert.equal(doc.header.nextSequence, 34150n);
  assert.equal(doc.header.firstSequence, 1n);
  assert.equal(doc.header.bufferSize, 131072);
  const obs = parseObservations(doc.root);
  const by = Object.fromEntries(obs.map((o, i) => [`${o.id}${o.nativeCode ? `#${o.nativeCode}` : ''}`, { ...o, i }]));
  assert.equal(by.Xact.kind, 'sample');
  assert.equal(by.Xact.value, '-1.5');
  assert.equal(by.Xact.sequence, 34100n);
  assert.equal(by.Xact.timestamp, Date.parse('2012-02-21T23:57:34.123Z'));
  assert.equal(by.Xact.device, 'VMC-3Axis');
  assert.equal(by.Xact.component, 'X');
  assert.equal(by.Xts.representation, 'TIME_SERIES');
  assert.equal(by.exec.kind, 'event');
  assert.equal(by.msg.value, 'Program & cycle <done> ☺');
  assert.equal(by.vars.representation, 'DATA_SET');
  assert.equal(by.Xcond.level, 'normal');
  assert.equal(by['sys#E42'].level, 'fault');
  assert.deepEqual([by['sys#E42'].nativeSeverity, by['sys#E42'].qualifier, by['sys#E42'].conditionType, by['sys#E42'].value], ['9', 'HIGH', 'SYSTEM', 'Over temperature']);
  assert.equal(by['sys#W7'].value, 'Filter <low>');
  assert.equal(by.other.level, 'unavailable');
  assert.equal(obs.length, 9);
});

test('streams 2.x with a prefixed root, 64-bit sequences (BigInt) and the Agent device', () => {
  const doc = parseDocument(STREAMS_PREFIXED_2);
  assert.equal(doc.kind, 'streams');
  assert.equal(doc.header.nextSequence, 18446744073709551600n);
  assert.equal(doc.header.instanceId, '18446744073709551000');
  const [o] = parseObservations(doc.root);
  assert.deepEqual([o.id, o.value, o.sequence, o.device], ['agent_avail', 'AVAILABLE', 18446744073709551598n, 'Agent']);
});

test('probe 2.x: component tree, data items, units, representation, compositions ignored', () => {
  const { devices, items } = parseProbe(parseDocument(PROBE_2).root);
  assert.equal(devices.length, 1);
  assert.deepEqual([devices[0].name, devices[0].uuid], ['lathe', 'LATHE-1']);
  assert.equal(items.size, 7);
  const s = items.get('Sspeed');
  assert.deepEqual([s.category, s.type, s.subType, s.units, s.unit, s.name, s.device], ['SAMPLE', 'SPINDLE_SPEED', 'ACTUAL', 'REVOLUTION/MINUTE', 'rev/min', 'Srpm', 'lathe']);
  assert.equal(s.path, 'lathe / Axes / C');
  assert.equal(items.get('Stemp').unit, '°C');
  assert.equal(items.get('Svib').representation, 'TIME_SERIES');
  assert.equal(items.get('vars').representation, 'DATA_SET');
  assert.equal(items.get('exec').representation, 'VALUE');
  assert.equal(items.get('exec').path, 'lathe / controller / path');
  assert.equal(items.get('d1_avail').path, 'lathe');
  const tree = devices[0].tree;
  assert.deepEqual(tree.folders.map((f) => f.name), ['Axes', 'controller']);
  assert.equal(unitSymbol('SOME_NEW_UNIT'), 'some_new_unit');
  assert.equal(unitSymbol(''), '');
});

test('error documents: code and text, whatever the namespace', () => {
  const doc = parseDocument(ERROR_13);
  assert.equal(doc.kind, 'error');
  assert.deepEqual(doc.errors, [{ code: 'OUT_OF_RANGE', message: "'from' must be less than 34150, from = 99999" }]);
  const v2 = parseDocument('<MTConnectError><Header instanceId="1"/><Errors><Error errorCode="INVALID_REQUEST">bad</Error><Error errorCode="NO_DEVICE"/></Errors></MTConnectError>');
  assert.deepEqual(v2.errors.map((e) => e.code), ['INVALID_REQUEST', 'NO_DEVICE']);
});

test('parser tolerance: BOM, comments, processing instructions, DOCTYPE, odd attribute syntax, stray end tags', () => {
  const root = parseXml(
    '﻿<?xml version="1.0"?><!-- c --><!DOCTYPE r [ <!ENTITY x "y"> ]><?pi x?><a b=1 c = \'2\'  d><b/>text<c></x></c><!-- tail --></a>trailing'
  );
  assert.equal(root.name, 'a');
  assert.deepEqual(root.attrs, { b: '1', c: '2', d: '' });
  assert.deepEqual(root.children.map((c) => c.name), ['b', 'c']);
  assert.equal(root.text, 'text');
  // a mis-nested end tag closes the nearest matching open element
  const r2 = parseXml('<a><b><c>1</b>2</a>');
  assert.deepEqual(r2.children[0].children.map((c) => c.name), ['c']);
  assert.equal(r2.text, '2');
  // a second root is ignored
  assert.equal(parseXml('<a/><b/>').name, 'a');
  // unquoted value directly before a self-closing slash
  assert.equal(parseXml('<a x=1/>').attrs.x, '1');
});

test('entities: predefined and numeric only; DOCTYPE entities are never expanded', () => {
  const bomb = '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><r a="&lol2;">&lol2; &amp; &#65;&#x42;</r>';
  const r = parseXml(bomb);
  assert.equal(r.attrs.a, '&lol2;');
  assert.equal(r.text, '&lol2; & AB');
  assert.equal(decode('&#xD800; &#0; &#1114112; &unknown; &lt;'), '� \u0000 � &unknown; <'.replace('\u0000', '\u0000'));
});

test('a document that ends early is an error, never a partial result', () => {
  const cuts = [STREAMS_13.slice(0, 300), STREAMS_13.slice(0, STREAMS_13.indexOf('</Streams>')), STREAMS_13.slice(0, STREAMS_13.indexOf('sequence="34100"') + 5), '<a><b x="1', '<a><!-- never closed', '<a><![CDATA[ x', '<a>', ''];
  for (const t of cuts) assert.throws(() => parseXml(t), XmlError, t.slice(0, 40));
  // every cut point of a real document fails or yields a complete tree (the root was closed)
  for (let n = 1; n < STREAMS_13.length; n += 37) {
    try {
      const root = parseXml(STREAMS_13.slice(0, n));
      assert.equal(root.name, 'MTConnectStreams');
      assert.ok(STREAMS_13.slice(0, n).includes('</MTConnectStreams>'), `accepted a truncated document at ${n}`);
    } catch (e) {
      assert.ok(e instanceof XmlError);
    }
  }
});

test('non-XML and wrong documents', () => {
  assert.throws(() => parseXml('this is not xml'), XmlError);
  assert.throws(() => parseXml('{"json":true}'), XmlError);
  assert.equal(parseDocument('<html><body>login</body></html>').kind, 'other');
  assert.equal(parseDocument('<MTConnectAssets><Header instanceId="1"/><Assets/></MTConnectAssets>').kind, 'assets');
  assert.equal(parseDocument(Buffer.from('<MTConnectStreams/>')).header, null);
});

test('bounds: nesting depth and sequence parsing', () => {
  assert.throws(() => parseXml('<a>'.repeat(200) + '</a>'.repeat(200)), /nested deeper/);
  const h = parseDocument('<MTConnectStreams><Header instanceId="1" nextSequence="abc" firstSequence="-1" lastSequence="99999999999999999999999"/></MTConnectStreams>').header;
  assert.deepEqual([h.nextSequence, h.firstSequence, h.lastSequence], [null, null, null]);
});

test('observations without a dataItemId or outside a stream container are ignored', () => {
  const doc = parseDocument(
    '<MTConnectStreams><Streams><DeviceStream name="d"><ComponentStream name="c"><Samples><Position timestamp="2024-01-01T00:00:00Z">1</Position><Position dataItemId="p" sequence="1">2</Position></Samples></ComponentStream></DeviceStream></Streams></MTConnectStreams>'
  );
  assert.deepEqual(parseObservations(doc.root).map((o) => o.id), ['p']);
  assert.deepEqual(parseObservations(parseXml('<Samples><Position dataItemId="x">1</Position></Samples>')), []);
});
