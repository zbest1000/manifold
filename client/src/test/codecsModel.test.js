import { describe, expect, it } from 'vitest';
import { bindingState, codecCaption, formErrors, formFor, payloadSize, toRequest, MAX_SCHEMA_BYTES } from '@/pages/pipelines/codecsModel';

describe('codecs: form', () => {
  it('validates the filter and the schema before the server compiles it', () => {
    const f = formFor(null);
    expect(formErrors(f).filter).toMatch(/Enter the topic filter/);
    expect(formErrors({ ...f, filter: 'a/#/b' }).filter).toMatch(/whole, final level/);
    expect(formErrors({ ...f, filter: 'a/b#' }).filter).toMatch(/whole, final level/);
    expect(formErrors({ ...f, filter: 'a/x+/b' }).filter).toMatch(/\+ wildcard/);
    expect(formErrors({ ...f, filter: 'plant/+/pump/#' })).toEqual({});
    expect(formErrors({ ...f, filter: 'a', codec: 'protobuf' }).schemaText).toMatch(/\.proto schema/);
    expect(formErrors({ ...f, filter: 'a', codec: 'avro' }).schemaText).toMatch(/Avro schema/);
    expect(formErrors({ ...f, filter: 'a', codec: 'avro', schemaText: 'x'.repeat(MAX_SCHEMA_BYTES + 1) }).schemaText).toMatch(/larger than 128 KiB/);
    expect(formErrors({ ...f, filter: 'a', codec: 'cbor', schemaText: '' })).toEqual({});
  });

  it('builds the request: schema only for schema codecs, message type only for Protobuf, rev for edits', () => {
    const base = { ...formFor(null), filter: ' plant/# ', name: ' Pumps ', schemaText: 'leftover', messageType: 'x.Y' };
    expect(toRequest(base)).toEqual({ name: 'Pumps', brokerId: null, filter: 'plant/#', codec: 'cbor', schemaText: null, messageType: null, enabled: true });
    const pb = toRequest({ ...base, codec: 'protobuf' });
    expect(pb.schemaText).toBe('leftover');
    expect(pb.messageType).toBe('x.Y');
    expect(toRequest({ ...base, codec: 'avro' }).messageType).toBeNull();
    const edit = toRequest(formFor({ id: 'b1', rev: 3, filter: 'a/#', codec: 'msgpack', brokerId: 'br' }));
    expect(edit).toMatchObject({ id: 'b1', rev: 3, brokerId: 'br', codec: 'msgpack' });
  });
});

describe('codecs: table state and captions', () => {
  it('reports broken, schema error, disabled, failing, raw and decoding', () => {
    expect(bindingState({ broken: [{ kind: 'broker', id: 'x' }] }, {}).label).toBe('Broken reference');
    expect(bindingState({}, { compileError: 'bad' })).toMatchObject({ tone: 'bad', label: 'Schema error', detail: 'bad' });
    expect(bindingState({ enabled: false }, {}).label).toBe('Disabled');
    expect(bindingState({}, { failed: 2, lastErrorAt: 20, lastDecodedAt: 10, lastError: 'truncated' })).toMatchObject({ tone: 'warn', label: 'Failing', detail: 'truncated' });
    expect(bindingState({}, { failed: 2, decoded: 5, lastErrorAt: 10, lastDecodedAt: 20 }).label).toBe('Decoding');
    expect(bindingState({ codec: 'raw' }, {}).label).toBe('Kept raw');
    expect(bindingState({}, {}).label).toBe('Waiting for data');
  });

  it('captions the codec on a topic', () => {
    expect(codecCaption(null)).toBeNull();
    expect(codecCaption({ name: 'cbor', auto: true })).toBe('Auto-detected CBOR');
    expect(codecCaption({ name: 'protobuf', binding: 'Pumps' })).toBe('Decoded by Protobuf (binding Pumps)');
  });

  it('sizes a pasted payload by encoding', () => {
    expect(payloadSize('08 96 01', 'hex')).toBe(3);
    expect(payloadSize('0x08:0x96', 'hex')).toBe(2);
    expect(payloadSize('zz', 'hex')).toBeNull();
    expect(payloadSize('CJYB', 'base64')).toBe(3);
    expect(payloadSize('ü', 'text')).toBe(2);
  });
});
