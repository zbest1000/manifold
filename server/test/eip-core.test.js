'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const cip = require('../drivers/eip/cip');
const frame = require('../drivers/eip/frame');
const { parseAddress, formatAddress, encodePath } = require('../drivers/eip/address');
const { parseTemplate, decodeTagReply, decodeStruct, probeDecodings, LayoutError, DecodeError } = require('../drivers/eip/decode');
const { planReads, bisect, messageBudget } = require('../drivers/eip/planner');
const { parseSymbolType, parseInstanceAttributeList } = require('../drivers/eip/symbols');
const eip = require('../drivers/eip');

const hex = (s) => Buffer.from(s.replace(/\s/g, ''), 'hex');
const { EipReadOnlyError } = frame;

// ── EPATH golden vectors ────────────────────────────────────────────────────

test('logical segments use the smallest format', () => {
  assert.deepEqual(cip.logical('class', 0x6b), hex('20 6b'));
  assert.deepEqual(cip.logical('instance', 0x1234), hex('25 00 34 12'));
  assert.deepEqual(cip.logical('instance', 0x12345), hex('26 00 45 23 01 00'));
  assert.deepEqual(cip.element(3), hex('28 03'));
  assert.deepEqual(cip.element(300), hex('29 00 2c 01'));
  assert.deepEqual(cip.element(70000), hex('2a 00 70 11 01 00'));
  assert.deepEqual(cip.logical('attribute', 10), hex('30 0a'));
  assert.throws(() => cip.logical('class', 0x10000), RangeError);
});

test('symbolic segments are padded to even length', () => {
  assert.deepEqual(cip.symbolic('Motor'), hex('91 05 4d6f746f72 00'));
  assert.deepEqual(cip.symbolic('Tag1'), hex('91 04 54616731'));
});

test('route paths: slot, multi-hop and extended link address', () => {
  assert.deepEqual(cip.slotRoute(0), hex('01 00'));
  assert.deepEqual(cip.slotRoute(3), hex('01 03'));
  assert.deepEqual(cip.encodeRoutePath('1,0'), hex('01 00'));
  assert.deepEqual(cip.encodeRoutePath('1,2,2,10.0.0.5,1,0'), Buffer.concat([hex('01 02 12 08'), Buffer.from('10.0.0.5'), hex('01 00')]));
  assert.deepEqual(cip.encodeRoutePath('1,2,2,10.0.0.55,1,0'), Buffer.concat([hex('01 02 12 09'), Buffer.from('10.0.0.55'), hex('00 01 00')]));
  assert.throws(() => cip.encodeRoutePath('1'), /pairs/);
  assert.throws(() => cip.encodeRoutePath('1,abc'), /IPv4/);
});

test('describePath reports classes and symbolic segments', () => {
  assert.deepEqual(cip.describePath(hex('20 06 24 01')), { classes: [6], instances: [1], symbolic: false, ports: 0 });
  assert.equal(cip.describePath(cip.symbolic('X')).symbolic, true);
  assert.throws(() => cip.describePath(hex('20')), /truncated/);
  assert.throws(() => cip.describePath(hex('e0 00')), /unsupported/);
});

// ── addresses ───────────────────────────────────────────────────────────────

test('parseAddress: every supported form', () => {
  assert.deepEqual(parseAddress('Tag'), { program: null, segments: [{ name: 'Tag' }], bit: null });
  assert.deepEqual(parseAddress('Program:Main.Tag'), { program: 'Main', segments: [{ name: 'Tag' }], bit: null });
  assert.deepEqual(parseAddress('Motor.Speed'), { program: null, segments: [{ name: 'Motor' }, { name: 'Speed' }], bit: null });
  assert.deepEqual(parseAddress('Arr[3]'), { program: null, segments: [{ name: 'Arr', indices: [3] }], bit: null });
  assert.deepEqual(parseAddress('Arr[1, 2]'), { program: null, segments: [{ name: 'Arr', indices: [1, 2] }], bit: null });
  assert.deepEqual(parseAddress('Word.5'), { program: null, segments: [{ name: 'Word' }], bit: 5 });
  assert.deepEqual(parseAddress('program:P1.Motors[2].Status.31'), {
    program: 'P1',
    segments: [{ name: 'Motors', indices: [2] }, { name: 'Status' }],
    bit: 31,
  });
  assert.equal(formatAddress(parseAddress(' Arr[1, 2].x.3 ')), 'Arr[1,2].x.3');
});

test('parseAddress rejects malformed addresses with a reason', () => {
  for (const bad of ['', '5Tag', 'Tag[', 'Tag]', 'Tag[a]', 'Tag[1,2,3,4]', 'Program:Main', 'Tag..X', 'Ta-g', `T${'x'.repeat(40)}`, 'Word.64']) {
    assert.throws(() => parseAddress(bad), Error, bad);
  }
  assert.throws(() => parseAddress(42), /string/);
});

test('encodePath golden vector: program, member, multi-dim element', () => {
  const p = encodePath(parseAddress('Program:Main.Arr[3,300].X'));
  assert.deepEqual(
    p,
    Buffer.concat([hex('91 0c'), Buffer.from('Program:Main'), hex('91 03'), Buffer.from('Arr'), hex('00 28 03 29 00 2c 01 91 01 58 00')])
  );
  // bit numbers are not part of the path
  assert.deepEqual(encodePath(parseAddress('Word.5')), cip.symbolic('Word'));
  // BOOL array element override
  assert.deepEqual(encodePath(parseAddress('B[37]'), { elementOverride: [1] }), hex('91 01 42 00 28 01'));
});

// ── framing ─────────────────────────────────────────────────────────────────

test('encodeFrame golden: RegisterSession, UnRegisterSession, ListIdentity', () => {
  const ctx = hex('0102030405060708');
  assert.deepEqual(frame.encodeFrame({ command: 0x65, context: ctx }), hex('6500 0400 00000000 00000000 0102030405060708 00000000 0100 0000'));
  assert.deepEqual(frame.encodeFrame({ command: 0x66, session: 0x11223344 }), hex('6600 0000 44332211 00000000 0000000000000000 00000000'));
  assert.deepEqual(frame.encodeFrame({ command: 0x63 }), hex('6300 0000 00000000 00000000 0000000000000000 00000000'));
});

test('encodeFrame golden: SendRRData Read Tag and SendUnitData', () => {
  const read = frame.readTag(cip.symbolic('Tag1'), 1);
  const rr = frame.encodeFrame({ command: 0x6f, session: 0x01020304, context: Buffer.alloc(8), cip: read });
  assert.deepEqual(rr, hex('6f00 1a00 04030201 00000000 0000000000000000 00000000  00000000 0000 0200 0000 0000 b200 0a00  4c 03 9104 54616731 0100'));
  const ud = frame.encodeFrame({ command: 0x70, session: 1, cip: read, connectionId: 0xaabbccdd, sequence: 7 });
  assert.deepEqual(
    ud,
    hex('7000 2000 01000000 00000000 0000000000000000 00000000  00000000 0000 0200 a100 0400 ddccbbaa b100 0c00 0700  4c 03 9104 54616731 0100')
  );
});

test('Unconnected Send wraps the message with the route path', () => {
  const buf = frame.encodeCip(frame.unconnectedSend(frame.readTag(cip.symbolic('A'), 1), cip.slotRoute(2)));
  assert.deepEqual(buf, hex('52 02 2006 2401  0a 0e 0800  4c 02 9101 4100 0100  01 00 01 02'));
});

test('Forward Open golden fields (small and large)', () => {
  const route = cip.slotRoute(0);
  const small = frame.encodeCip(frame.forwardOpen({ large: false, size: 504, toConnectionId: 0x11111111, serial: 0x2222, originatorSerial: 0x33333333, route }));
  assert.equal(small[0], 0x54);
  assert.deepEqual(small.subarray(0, 6), hex('54 02 2006 2401'));
  const d = small.subarray(6);
  assert.equal(d.readUInt32LE(6), 0x11111111);
  assert.equal(d.readUInt16LE(10), 0x2222);
  assert.equal(d.readUInt32LE(14), 0x33333333);
  assert.equal(d.readUInt16LE(26), 0x43f8); // point-to-point | variable | 504
  assert.equal(d.readUInt16LE(32), 0x43f8);
  assert.equal(d[34], 0xa3);
  assert.deepEqual(d.subarray(35), hex('03 0100 2002 2401'));

  const large = frame.encodeCip(frame.forwardOpen({ large: true, size: 4002, toConnectionId: 1, serial: 1, originatorSerial: 1, route }));
  assert.equal(large[0], 0x5b);
  const l = large.subarray(6);
  assert.equal(l.readUInt32LE(26), 0x42000fa2);
  assert.equal(l.readUInt32LE(34), 0x42000fa2);
  assert.equal(l[38], 0xa3);
});

test('FrameParser reassembles chunks and is poisoned by bad commands', () => {
  const pkt = frame.encodeFrame({ command: 0x65, context: Buffer.alloc(8) });
  const p = new frame.FrameParser();
  assert.deepEqual(p.push(pkt.subarray(0, 10)), []);
  const out = p.push(Buffer.concat([pkt.subarray(10), pkt]));
  assert.equal(out.length, 2);
  assert.equal(out[0].command, 0x65);
  assert.deepEqual(out[0].body, hex('01000000'));
  const bad = Buffer.from(pkt);
  bad.writeUInt16LE(0x0004, 0);
  const q = new frame.FrameParser();
  assert.throws(() => q.push(bad), frame.EipFramingError);
  assert.throws(() => q.push(pkt), frame.EipFramingError);
  const huge = Buffer.from(pkt);
  huge.writeUInt16LE(60000, 2);
  assert.throws(() => new frame.FrameParser().push(huge), /exceeds/);
});

test('parseCipReply and parseMspReply golden + per-item status', () => {
  const r = frame.parseCipReply(hex('cc 00 ff 01 0521 c400'));
  assert.deepEqual(r, { service: 0xcc, status: 0xff, ext: [0x2105], data: hex('c400') });
  assert.throws(() => frame.parseCipReply(hex('4c 00 00 00')), /reply bit/);
  // two items: success DINT 7, then path destination unknown
  const body = hex('0200 0600 1000  cc 00 00 00 c400 07000000  cc 00 05 00');
  const items = frame.parseMspReply(body, 2);
  assert.equal(items[0].status, 0);
  assert.deepEqual(items[0].data, hex('c400 07000000'));
  assert.equal(items[1].status, 0x05);
  assert.throws(() => frame.parseMspReply(body, 3), /request had 3/);
  assert.throws(() => frame.parseMspReply(hex('0200 0600 4000 cc000000'), 2), /bad MSP offset/);
});

test('parseCpf rejects truncated and trailing data', () => {
  assert.throws(() => frame.parseCpf(hex('00000000 0000 0100 b200 0a00 0102')), /truncated/);
  assert.throws(() => frame.parseCpf(hex('00000000 0000 0100 b200 0100 01 02')), /trailing/);
});

// ── read-only allowlist ─────────────────────────────────────────────────────

const SYM = cip.symbolic('Tag');
const CLS = (c, i = 1) => Buffer.concat([cip.logical('class', c), cip.logical('instance', i)]);

test('allowed services encode', () => {
  const ok = [
    frame.readTag(SYM, 1),
    frame.readTagFragmented(SYM, 10, 0),
    frame.readTag(CLS(0x6b, 5), 1),
    frame.getInstanceAttributeList(0, [1, 2], null),
    frame.getInstanceAttributeList(0, [1, 2], 'Program:Main'),
    frame.readTemplate(0x101, 0, 100),
    frame.getAttributeList(0x6c, 0x101, [4, 5, 2, 1]),
    frame.getAttributeAll(1, 1),
    { service: 0x0e, path: Buffer.concat([CLS(1), cip.logical('attribute', 7)]) },
    frame.multipleServicePacket([frame.readTag(SYM), frame.readTag(cip.symbolic('B'))]),
    frame.unconnectedSend(frame.readTag(SYM), cip.slotRoute(0)),
    frame.forwardOpen({ large: true, size: 4002, toConnectionId: 1, serial: 1, originatorSerial: 1, route: cip.slotRoute(0) }),
    frame.forwardClose({ serial: 1, originatorSerial: 1, route: cip.slotRoute(0) }),
  ];
  for (const req of ok) {
    assert.doesNotThrow(() => frame.encodeFrame({ command: 0x6f, session: 1, cip: req }), `service 0x${req.service.toString(16)}`);
  }
});

test('every forbidden service throws EipReadOnlyError before any bytes exist', () => {
  const data = hex('c400 0100 01000000');
  const forbidden = [
    { service: 0x4d, path: SYM, data }, // Write Tag
    { service: 0x53, path: SYM, data }, // Write Tag Fragmented
    { service: 0x4e, path: SYM, data }, // Read-Modify-Write Tag
    { service: 0x4d, path: CLS(0x6b, 3), data },
    { service: 0x02, path: CLS(1) }, // Set_Attribute_All
    { service: 0x04, path: CLS(1) }, // Set_Attribute_List
    { service: 0x10, path: Buffer.concat([CLS(1), cip.logical('attribute', 1)]) }, // Set_Attribute_Single
    { service: 0x10, path: CLS(0x6c, 0x101) },
    { service: 0x05, path: CLS(1) }, // Reset
    { service: 0x06, path: CLS(0x8e) }, // Start
    { service: 0x07, path: CLS(0x8e) }, // Stop
    { service: 0x08, path: CLS(0x6b) }, // Create
    { service: 0x09, path: CLS(0x6b) }, // Delete
    { service: 0x0d, path: CLS(1) },
    { service: 0x4b, path: CLS(0x6b) }, // Execute PCCC etc.
    { service: 0x4c, path: CLS(0x01) }, // 0x4C on a class that is not Symbol/Template
    { service: 0x52, path: CLS(0x01) },
    { service: 0x55, path: CLS(0x6c) }, // instance list on the wrong class
    { service: 0x54, path: SYM }, // Forward Open not on the CM
    { service: 0x4e, path: Buffer.concat([cip.symbolic('X'), CLS(6)]) },
    { service: 0x0e, path: SYM }, // Get attribute on a symbolic path
    { service: 0x0a, path: CLS(0x6b) }, // MSP not on the message router
    { service: 0x0a, path: cip.MESSAGE_ROUTER_PATH, data: Buffer.alloc(4) }, // MSP without structured services
    { service: 0x52, path: cip.CONNECTION_MANAGER_PATH, data: Buffer.alloc(8) }, // US without structured request
    { service: 0x4c, path: hex('20') }, // malformed path
    { service: 0x4c, path: 'Tag' },
    { service: 0xcc, path: SYM },
  ];
  for (let s = 0; s < 0x80; s++) {
    if (![0x01, 0x03, 0x0a, 0x0e, 0x4c, 0x4e, 0x52, 0x54, 0x55, 0x5b].includes(s)) forbidden.push({ service: s, path: CLS(1) });
  }
  for (const req of forbidden) {
    let out;
    assert.throws(
      () => {
        out = frame.encodeFrame({ command: 0x6f, session: 1, cip: req });
      },
      EipReadOnlyError,
      `service ${req.service}`
    );
    assert.equal(out, undefined);
    assert.throws(() => frame.encodeFrame({ command: 0x70, session: 1, connectionId: 1, sequence: 1, cip: req }), EipReadOnlyError);
  }
});

test('Multiple Service Packet containing a write is refused as a whole', () => {
  const msp = frame.multipleServicePacket([frame.readTag(SYM), { service: 0x4d, path: cip.symbolic('B'), data: hex('c400 0100 01000000') }]);
  assert.throws(() => frame.encodeFrame({ command: 0x70, session: 1, connectionId: 1, sequence: 1, cip: msp }), /Write Tag/);
  const nested = frame.multipleServicePacket([frame.readTag(SYM), frame.multipleServicePacket([frame.readTag(SYM)])]);
  assert.throws(() => frame.encodeCip(nested), /nested Multiple Service Packet/);
  const usInMsp = frame.multipleServicePacket([frame.unconnectedSend(frame.readTag(SYM), cip.slotRoute(0))]);
  assert.throws(() => frame.encodeCip(usInMsp), EipReadOnlyError);
});

test('Unconnected Send containing a forbidden service is refused', () => {
  const route = cip.slotRoute(0);
  assert.throws(() => frame.encodeCip(frame.unconnectedSend({ service: 0x4d, path: SYM, data: Buffer.alloc(4) }, route)), EipReadOnlyError);
  assert.throws(() => frame.encodeCip(frame.unconnectedSend({ service: 0x05, path: CLS(1) }, route)), /Reset/);
  assert.throws(() => frame.encodeCip(frame.unconnectedSend(frame.unconnectedSend(frame.readTag(SYM), route), route)), /nested/);
  const fo = frame.forwardOpen({ large: false, size: 504, toConnectionId: 1, serial: 1, originatorSerial: 1, route });
  assert.throws(() => frame.encodeCip(frame.unconnectedSend(fo, route)), /Forward Open/);
});

test('encapsulation commands outside the allowlist are refused', () => {
  for (const command of [0x0000, 0x0001, 0x0004, 0x0064, 0x0072, 0x0073, 0xffff, undefined]) {
    assert.throws(() => frame.encodeFrame({ command }), EipReadOnlyError);
  }
  assert.throws(() => frame.encodeFrame(null), EipReadOnlyError);
});

test('byte-level guard: hand-built write frames are refused by inspectOutgoingFrame', () => {
  const good = frame.encodeFrame({ command: 0x70, session: 1, connectionId: 9, sequence: 1, cip: frame.readTag(SYM) });
  assert.doesNotThrow(() => frame.inspectOutgoingFrame(good));
  const write = Buffer.from(good);
  write[24 + 22] = 0x4d; // flip the service byte to Write Tag
  assert.throws(() => frame.inspectOutgoingFrame(write), /Write Tag/);
  // a write hidden inside an MSP inside SendRRData
  const msp = frame.encodeFrame({ command: 0x6f, session: 1, cip: frame.multipleServicePacket([frame.readTag(SYM), frame.readTag(SYM)]) });
  const mspOff = msp.indexOf(Buffer.from([0x4c, 0x03, 0x91]), 24 + 16 + 8);
  const tampered = Buffer.from(msp);
  tampered[msp.indexOf(Buffer.from([0x4c, 0x03, 0x91]), mspOff + 1)] = 0x4d;
  assert.throws(() => frame.inspectOutgoingFrame(tampered), EipReadOnlyError);
  const listServices = Buffer.from(frame.encodeFrame({ command: 0x63 }));
  listServices.writeUInt16LE(0x0004, 0);
  assert.throws(() => frame.inspectOutgoingFrame(listServices), EipReadOnlyError);
  assert.throws(() => frame.inspectOutgoingFrame(Buffer.alloc(3)), EipReadOnlyError);
});

// ── decoding ────────────────────────────────────────────────────────────────

test('decodeTagReply: every atomic type (golden)', () => {
  const cases = [
    ['c100 01', true, 'bool'],
    ['c100 00', false, 'bool'],
    ['c200 fb', -5, 'int8'],
    ['c300 2efb', -1234, 'int16'],
    ['c400 40e20100', 123456, 'int32'],
    ['c500 ffffffffffffdfff', '-9007199254740993', 'int64'],
    ['c600 c8', 200, 'uint8'],
    ['c700 60ea', 60000, 'uint16'],
    ['c800 0028 6bee', 4000000000, 'uint32'],
    ['c900 ffffffffffffffff', '18446744073709551615', 'uint64'],
    ['ca00 00006040', 3.5, 'float32'],
    ['cb00 6957148b0abf0540', 2.718281828459045, 'float64'],
  ];
  for (const [h, v, type] of cases) assert.deepEqual(decodeTagReply(hex(h)), { v, type }, h);
  assert.deepEqual(decodeTagReply(hex('c400 01000000 02000000'), { elements: 2 }), { v: [1, 2], type: 'int32' });
  assert.throws(() => decodeTagReply(hex('c400 0100')), DecodeError);
  assert.throws(() => decodeTagReply(hex('ee00 00')), /unsupported/);
});

test('decodeTagReply: bit of word and BOOL array words', () => {
  assert.deepEqual(decodeTagReply(hex('c400 20000000'), { bit: 5 }), { v: true, type: 'bool' });
  assert.deepEqual(decodeTagReply(hex('c400 20000000'), { bit: 4 }), { v: false, type: 'bool' });
  assert.deepEqual(decodeTagReply(hex('c500 0000000000000080'), { bit: 63 }), { v: true, type: 'bool' });
  assert.throws(() => decodeTagReply(hex('ca00 00000000'), { bit: 1 }), /not addressable/);
  // BoolArr[33] -> DWORD index 1, bit 1
  assert.deepEqual(decodeTagReply(hex('d300 02000000'), { boolIndex: 33 }), { v: true, type: 'bool' });
  assert.deepEqual(decodeTagReply(hex('d300 02000000'), { boolIndex: 32 }), { v: false, type: 'bool' });
  assert.throws(() => decodeTagReply(hex('c400 02000000'), { boolIndex: 1 }), LayoutError);
  const whole = decodeTagReply(hex('d300 05000080'), { boolArray: true });
  assert.equal(whole.v.length, 32);
  assert.deepEqual([whole.v[0], whole.v[1], whole.v[2], whole.v[31]], [true, false, true, true]);
});

/** Hand-built template bytes (independent of the simulator's encoder). */
function motorTemplateBytes() {
  const rec = (info, type, offset) => {
    const b = Buffer.alloc(8);
    b.writeUInt16LE(info, 0);
    b.writeUInt16LE(type, 2);
    b.writeUInt32LE(offset, 4);
    return b;
  };
  return Buffer.concat([
    rec(0, 0xc2, 0), // ZZZZZZZZZZMotorType0 host SINT
    rec(0, 0xc1, 0), // Running bit 0
    rec(1, 0xc1, 0), // Fault bit 1
    rec(0, 0xca, 4), // Speed REAL (after 3 bytes padding)
    rec(0, 0xc4, 8), // Count DINT
    rec(0, 0x8f9c, 12), // Name STRING
    rec(0, 0xc2, 100), // Code SINT, then 3 bytes tail padding
    Buffer.from('MotorType;n\0ZZZZZZZZZZMotorType0\0Running\0Fault\0Speed\0Count\0Name\0Code\0', 'latin1'),
  ]);
}
const STRING_TEMPLATE_BYTES = Buffer.concat([hex('0000 c400 00000000'), hex('5200 c200 04000000'), Buffer.from('ASCIISTRING82;n\0LEN\0DATA\0', 'latin1')]);

test('parseTemplate: hidden BOOL host, bit members, padding and STRING detection', () => {
  const tpl = parseTemplate({ id: 0x101, handle: 0xabcd, memberCount: 7, structSize: 104 }, motorTemplateBytes());
  assert.equal(tpl.name, 'MotorType');
  assert.equal(tpl.size, 104);
  assert.equal(tpl.string, false);
  assert.deepEqual(
    tpl.members.map((m) => [m.name, m.kind, m.offset, m.hidden]),
    [
      ['ZZZZZZZZZZMotorType0', 'atomic', 0, true],
      ['Running', 'bit', 0, false],
      ['Fault', 'bit', 0, false],
      ['Speed', 'atomic', 4, false],
      ['Count', 'atomic', 8, false],
      ['Name', 'struct', 12, false],
      ['Code', 'atomic', 100, false],
    ]
  );
  assert.equal(tpl.members[2].bit, 1);
  const str = parseTemplate({ id: 0xf9c, handle: 0x0fce, memberCount: 2, structSize: 88 }, STRING_TEMPLATE_BYTES);
  assert.equal(str.name, 'STRING');
  assert.equal(str.string, true);
  assert.throws(() => parseTemplate({ id: 1, handle: 1, memberCount: 9, structSize: 4 }, Buffer.alloc(16)), DecodeError);
});

test('UDT decode uses template offsets, never summed member sizes', () => {
  const motor = parseTemplate({ id: 0x101, handle: 0xabcd, memberCount: 7, structSize: 104 }, motorTemplateBytes());
  const str = parseTemplate({ id: 0xf9c, handle: 0x0fce, memberCount: 2, structSize: 88 }, STRING_TEMPLATE_BYTES);
  const get = (id) => ({ 0x101: motor, 0xf9c: str })[id];
  const body = Buffer.alloc(104);
  body[0] = 0b10; // Running false, Fault true
  body.fill(0xee, 1, 4); // padding garbage must be ignored
  body.writeFloatLE(12.5, 4);
  body.writeInt32LE(-3, 8);
  body.writeInt32LE(4, 12);
  body.write('Pump', 16, 'latin1');
  body.writeInt8(9, 100);
  const reply = Buffer.concat([hex('a002 cdab'), body]);
  assert.deepEqual(decodeTagReply(reply, { template: motor, getTemplate: get }), {
    v: { Running: false, Fault: true, Speed: 12.5, Count: -3, Name: 'Pump', Code: 9 },
    type: 'struct',
  });
  // Summed sizes would put Speed at 1 and Code at 97 — prove we do not.
  assert.notEqual(body.readFloatLE(1), 12.5);
  // a STRING tag (88-byte struct): LEN clamps to the DATA capacity
  const s = Buffer.alloc(88);
  s.writeInt32LE(500, 0);
  s.fill(0x41, 4);
  assert.equal(decodeTagReply(Buffer.concat([hex('a002 ce0f'), s]), { template: str }).v, 'A'.repeat(82));
  // struct handle mismatch is layout drift
  assert.throws(() => decodeTagReply(Buffer.concat([hex('a002 0000'), body]), { template: motor, getTemplate: get }), LayoutError);
  assert.throws(() => decodeTagReply(Buffer.concat([hex('a002 cdab'), body]), {}), LayoutError);
  assert.throws(() => decodeTagReply(Buffer.concat([hex('a002 cdab'), body.subarray(0, 50)]), { template: motor, getTemplate: get }), DecodeError);
  assert.throws(() => decodeStruct(motor, body, 0, () => undefined), LayoutError);
});

test('probeDecodings shows every candidate', () => {
  const d = probeDecodings(hex('00006040'));
  assert.equal(d.REAL, 3.5);
  assert.equal(d.DINT, 1080033280);
  assert.equal(d.LINT, undefined);
});

// ── symbols ─────────────────────────────────────────────────────────────────

test('symbol type word decoding', () => {
  assert.deepEqual(parseSymbolType(0x00c4), { struct: false, dimCount: 0, system: false, code: 0xc4, bitPosition: 0, typeName: 'DINT' });
  assert.equal(parseSymbolType(0x20c4).dimCount, 1);
  assert.equal(parseSymbolType(0x40c3).dimCount, 2);
  assert.deepEqual(parseSymbolType(0x8101), { struct: true, dimCount: 0, system: false, templateId: 0x101 });
  assert.equal(parseSymbolType(0xa101).dimCount, 1);
  assert.equal(parseSymbolType(0x1068).system, true);
  assert.equal(parseSymbolType(0x05c1).bitPosition, 5);
});

test('parseInstanceAttributeList golden (with external access)', () => {
  const rec = Buffer.concat([hex('05000000 0300'), Buffer.from('Abc'), hex('c420'), hex('0a000000 00000000 00000000'), hex('02')]);
  const [s] = parseInstanceAttributeList(rec, true);
  assert.equal(s.instance, 5);
  assert.equal(s.name, 'Abc');
  assert.deepEqual(s.dims, [10, 0, 0]);
  assert.equal(s.access, 'Read Only');
  assert.equal(s.dimCount, 1);
  assert.throws(() => parseInstanceAttributeList(rec.subarray(0, 10), true), /truncated/);
});

test('fetchSymbols: a controller whose "more" replies do not advance is stopped at once, and the list is bounded', async () => {
  const { fetchSymbols, SymbolError } = require('../drivers/eip/symbols');
  const rec = (instance) => Buffer.concat([Buffer.from([instance & 0xff, (instance >> 8) & 0xff, (instance >> 16) & 0xff, instance >>> 24]), hex('0000 c400'), Buffer.alloc(12)]);
  // 1. always the same instance with status 0x06 (more): would loop and accumulate
  let calls = 0;
  const stuck = async () => {
    calls++;
    return { status: 0x06, data: Buffer.concat(Array(200).fill(rec(1))) };
  };
  await assert.rejects(fetchSymbols(stuck, null, { externalAccess: false }), SymbolError);
  assert.ok(calls <= 2, `${calls} requests to a controller that never advances`);
  // 2. advancing by one each time, forever: the total is capped
  let next = 0;
  calls = 0;
  const endless = async () => {
    calls++;
    const batch = [];
    for (let i = 0; i < 200; i++) batch.push(rec(next++));
    return { status: 0x06, data: Buffer.concat(batch) };
  };
  await assert.rejects(fetchSymbols(endless, null, { externalAccess: false }), SymbolError);
  assert.ok(calls * 200 <= 200000 + 200, `${calls * 200} symbols accumulated`);
});

// ── planner ─────────────────────────────────────────────────────────────────

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('planner property: limits respected, every key exactly once', () => {
  const rnd = mulberry32(42);
  for (let round = 0; round < 300; round++) {
    const connectionSize = [504, 4002, 1000][round % 3];
    const n = Math.floor(rnd() * 120);
    const items = Array.from({ length: n }, (_, i) => ({
      key: `k${i}`,
      requestBytes: 8 + Math.floor(rnd() * 60),
      replyBytes: rnd() < 0.05 ? 5000 : 7 + Math.floor(rnd() * 400),
    }));
    const maxPacketBytes = round % 5 === 0 ? 300 : Infinity;
    const plan = planReads(items, { connectionSize, maxPacketBytes });
    const seen = plan.flatMap((r) => r.items.map((i) => i.key));
    assert.deepEqual(seen.sort(), items.map((i) => i.key).sort());
    const byKey = new Map(items.map((i) => [i.key, i]));
    const budget = messageBudget(connectionSize);
    for (const r of plan) {
      const its = r.items.map((i) => byKey.get(i.key));
      if (r.kind === 'fragmented') {
        assert.equal(its.length, 1);
        assert.ok(its[0].replyBytes > budget);
      } else if (r.kind === 'single') {
        assert.equal(its.length, 1);
        assert.ok(its[0].replyBytes <= budget);
      } else {
        assert.ok(its.length > 1);
        const req = 8 + its.reduce((a, i) => a + i.requestBytes + 2, 0);
        const rep = 6 + its.reduce((a, i) => a + i.replyBytes + 2, 0);
        assert.ok(req <= Math.min(budget, maxPacketBytes), `request ${req}`);
        assert.ok(rep <= Math.min(budget, maxPacketBytes), `reply ${rep}`);
      }
    }
  }
});

test('planner: packing off, dedupe, invalid size, bisect', () => {
  const items = [1, 2, 3].map((i) => ({ key: `k${i}`, requestBytes: 10, replyBytes: 10 }));
  assert.deepEqual(planReads(items, { connectionSize: 504, packing: false }).map((r) => r.kind), ['single', 'single', 'single']);
  const packed = planReads([...items, items[0]], { connectionSize: 504 });
  assert.equal(packed.length, 1);
  assert.equal(packed[0].kind, 'multi');
  assert.equal(packed[0].items.length, 3);
  assert.throws(() => planReads(items, { connectionSize: 10 }), RangeError);
  const [a, b] = bisect(packed[0]);
  assert.deepEqual(a.items.map((i) => i.key), ['k1', 'k2']);
  assert.equal(a.kind, 'multi');
  assert.deepEqual(b.items.map((i) => i.key), ['k3']);
  assert.equal(b.kind, 'single');
  assert.equal(bisect(b), null);
  assert.equal(bisect(null), null);
});

// ── module surface ──────────────────────────────────────────────────────────

test('describe() and validateTag()', () => {
  const d = eip.describe();
  assert.equal(eip.protocol, 'ethernet-ip');
  assert.equal(d.label, 'EtherNet/IP (Logix)');
  assert.equal(d.defaultPort, 44818);
  assert.equal(d.experimental, true);
  assert.equal(d.deviceFields.find((f) => f.key === 'slot').default, 0);
  assert.equal(d.deviceFields.find((f) => f.key === 'routePath').advanced, true);
  assert.ok(d.optionFields.find((f) => f.key === 'connectionSize'));
  assert.ok(d.optionFields.find((f) => f.key === 'packing'));
  assert.match(d.prerequisites, /External Access/);
  assert.match(d.prerequisites, /no authentication/);
  assert.ok(d.tagTypes.includes('LINT') && d.tagTypes.includes('STRING'));

  assert.deepEqual(eip.validateTag({ key: 'a', address: ' Motor.Speed ', type: 'real' }), { ok: true, normalized: { key: 'a', address: 'Motor.Speed', type: 'REAL' } });
  assert.deepEqual(eip.validateTag({ key: 'b', address: 'Arr[1,2]', pollGroup: 'fast' }), { ok: true, normalized: { key: 'b', address: 'Arr[1,2]', pollGroup: 'fast' } });
  assert.equal(eip.validateTag({ key: 'c', address: '1bad' }).ok, false);
  assert.equal(eip.validateTag({ key: 'c', address: 'W.3', type: 'DINT' }).ok, false);
  assert.equal(eip.validateTag({ key: 'c', address: 'W', type: 'not a type!' }).ok, false);
  assert.equal(eip.validateTag({ address: 'W' }).ok, false);
  assert.equal(eip.validateTag(null).ok, false);
});

test('createDriver shape and execute without a connection never throws', async () => {
  const d = eip.createDriver({ id: 'x', name: 'x', protocol: 'ethernet-ip', host: '127.0.0.1', tags: [{ key: 't', address: 'T' }] });
  assert.equal(d.protocol, 'ethernet-ip');
  assert.deepEqual(d.capabilities, { browse: true, subscribe: false, maxInFlight: 1 });
  assert.equal(d.isConnected(), false);
  const plan = d.plan();
  assert.equal(plan.length, 1);
  assert.deepEqual(await d.execute(plan[0], 100), { ok: false, kind: 'transport', fatal: true, message: 'not connected' });
  await d.close();
  assert.throws(() => eip.createDriver({ tags: [] }), /host/);
});
