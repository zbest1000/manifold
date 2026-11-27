import { useRef, useState } from 'react';
import { Plus, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Button, Input, Field, Banner, Dialog, StatusText, Path, Panel, Table, THead, Th, Tr, Td, Select, Textarea, Toggle, SegmentedControl, useConfirm } from '@/components/ui';
import { READ_ONLY_REASON } from '@/store/selectors';
import { Count, HeadHint, ListState, RowButtons, TabToolbar, useRo } from './shared';
import { brokerName } from './helpers';
import { CODEC_OPTIONS, MAX_SCHEMA_BYTES, SCHEMA_CODECS, bindingState, codecLabel, formErrors, formFor, payloadSize, toRequest } from './codecsModel';

/**
 * Codecs: decode non-JSON MQTT payloads on ingest. A binding maps a topic filter (optionally on one
 * broker) to a codec; Protobuf and Avro also need a schema. Binary payloads without a binding are
 * auto-detected as CBOR or MessagePack when that is unambiguous. The test box decodes a pasted payload.
 */
export default function CodecsTab({ brokers }) {
  const [form, setForm] = useState(null); // null = dialog closed
  const [attempted, setAttempted] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const ro = useRo();
  const readOnly = Boolean(ro.disabled);

  const { data, error, loading, reload } = usePolled(() => api.listCodecs(), { interval: 5000 });
  const codecs = data?.codecs || [];
  const counters = data?.counters || {};
  const auto = data?.auto || {};
  const limits = data?.limits || {};

  const openNew = () => {
    setAttempted(false);
    setSaveError(null);
    setForm(formFor(null));
  };
  const openEdit = (b) => {
    setAttempted(false);
    setSaveError(null);
    setForm(formFor(b));
  };

  const errors = form ? formErrors(form) : {};
  const shownErrors = attempted ? errors : {};

  const save = async () => {
    if (busy || readOnly) return;
    setAttempted(true);
    if (Object.keys(errors).length) return;
    setBusy(true);
    setSaveError(null);
    try {
      await api.saveCodec(toRequest(form));
      setForm(null);
      reload();
      toast.success('Codec binding saved');
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (b) => {
    const ok = await confirm({
      title: `Delete the codec binding for "${b.name || b.filter}"?`,
      message: 'Matching payloads are no longer decoded by it: they show as they arrive (binary payloads may still be auto-detected).',
      confirmLabel: 'Delete binding',
      danger: true
    });
    if (!ok) return;
    try {
      await api.deleteCodec(b.id);
      reload();
      toast.success('Codec binding deleted');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const autoSummary = data
    ? data.autodetect
      ? `Auto-detection on: ${(auto.cbor || 0).toLocaleString()} CBOR and ${(auto.msgpack || 0).toLocaleString()} MessagePack payloads decoded without a binding.`
      : 'Auto-detection is off (MANIFOLD_CODEC_AUTODETECT=0).'
    : '';

  return (
    <>
      <ListState
        loading={loading}
        error={error}
        reload={reload}
        count={codecs.length}
        label="codec bindings"
        empty={{
          title: 'No codec bindings yet',
          hint: 'Devices that publish CBOR, MessagePack, SenML, Protobuf or Avro show as unreadable binary. Bind a topic filter to its codec and the payload is decoded on arrival, so topics, Trends, mappings and routes see the values.',
          action: (
            <Button onClick={openNew} {...ro}>
              <Plus size={14} aria-hidden="true" /> Add a codec binding
            </Button>
          )
        }}
      >
        <TabToolbar summary={`${codecs.length} ${codecs.length === 1 ? 'binding' : 'bindings'}. ${autoSummary}`}>
          <Button onClick={openNew} {...ro}>
            <Plus size={14} aria-hidden="true" /> Add a codec binding
          </Button>
        </TabToolbar>
        <Table caption="Codec bindings" className="min-w-[48rem]">
          <THead>
            <Th>Binding</Th>
            <Th>Codec</Th>
            <Th>State</Th>
            <Th align="right">
              <HeadHint hint="Payloads decoded by this binding. Topics are coalesced per 100 ms flush, so a topic publishing faster counts its latest payload per flush.">Decoded</HeadHint>
            </Th>
            <Th align="right">
              <HeadHint hint="Payloads this binding could not decode. They are kept as they arrived; ingest is never blocked.">Failed</HeadHint>
            </Th>
            <Th srOnly align="right">
              Actions
            </Th>
          </THead>
          <tbody>
            {codecs.map((b) => {
              const k = counters[b.id] || {};
              const name = b.name || b.filter;
              const state = bindingState(b, k);
              return (
                <Tr key={b.id}>
                  <Td header className="max-w-[24rem]">
                    <span className="block truncate font-medium text-fg">{name}</span>
                    <Path value={`${b.brokerId ? brokerName(brokers, b.brokerId) : 'Any broker'}: ${b.filter}`} className="text-muted" />
                  </Td>
                  <Td>
                    <span className="block text-fg">{codecLabel(b.codec)}</span>
                    {b.messageType && <span className="mono block text-xs text-subtle">{b.messageType}</span>}
                  </Td>
                  <Td className="max-w-[18rem]">
                    <StatusText tone={state.tone}>{state.label}</StatusText>
                    {state.detail && (
                      <span className="block break-words text-xs text-subtle" data-testid="codec-state-detail">
                        {state.detail}
                      </span>
                    )}
                  </Td>
                  <Td align="right" className="mono" data-testid="codec-decoded">
                    <Count value={k.decoded} />
                  </Td>
                  <Td align="right" className="mono" data-testid="codec-failed">
                    <Count value={k.failed} tone="bad" />
                  </Td>
                  <Td align="right" className="w-20">
                    <RowButtons what={`codec binding ${name}`} onEdit={() => openEdit(b)} onDelete={() => remove(b)} />
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </ListState>

      <Panel title="Test a payload" aria-label="Test a payload" description="Paste a payload to see how it decodes. Nothing is stored or counted.">
        <TestBox codecs={codecs} maxBytes={limits.maxBytes} />
      </Panel>

      {form && (
        <Dialog
          title={form.id ? (readOnly ? 'Codec binding' : 'Edit codec binding') : 'Add a codec binding'}
          description="Matching payloads are decoded on arrival. The most specific filter wins when several match."
          size="lg"
          onClose={() => setForm(null)}
          onSubmit={save}
          footer={
            <>
              <Button variant="secondary" onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={busy} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
                Save binding
              </Button>
            </>
          }
        >
          <CodecForm form={form} setForm={setForm} brokers={brokers} errors={shownErrors} saveError={saveError} maxBytes={limits.maxBytes} />
        </Dialog>
      )}
      {confirmDialog}
    </>
  );
}

function CodecForm({ form, setForm, brokers, errors, saveError, maxBytes }) {
  const fileRef = useRef(null);
  const [fileError, setFileError] = useState(null);
  const usesSchema = SCHEMA_CODECS.has(form.codec);
  const option = CODEC_OPTIONS.find((o) => o.value === form.codec);
  const set = (patch) => setForm({ ...form, ...patch });

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_SCHEMA_BYTES) {
      setFileError(`${file.name} is ${Math.ceil(file.size / 1024)} KiB; the schema limit is ${MAX_SCHEMA_BYTES / 1024} KiB.`);
      return;
    }
    setFileError(null);
    set({ schemaText: await file.text() });
  };

  return (
    <div className="space-y-4">
      {saveError && (
        <Banner variant="error" title="Could not save the binding">
          <span data-testid="codec-save-error">{saveError}</span>
        </Banner>
      )}
      <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
        <Field label="Name">
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Pump telemetry" data-autofocus />
        </Field>
        <Select label="Broker" value={form.brokerId} onChange={(e) => set({ brokerId: e.target.value })}>
          <option value="">Any broker</option>
          {brokers.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
        <Field label="Topic filter" error={errors.filter} help="MQTT filter: + matches one level, # the rest.">
          <Input className="mono" aria-invalid={errors.filter ? 'true' : undefined} value={form.filter} onChange={(e) => set({ filter: e.target.value })} placeholder="plant/+/pump/#" />
        </Field>
        <Select label="Codec" value={form.codec} onChange={(e) => set({ codec: e.target.value })} help={option?.hint}>
          {CODEC_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
      {usesSchema && (
        <div className="space-y-3">
          <Field
            label={form.codec === 'protobuf' ? 'Schema (.proto)' : 'Schema (Avro JSON)'}
            error={errors.schemaText || fileError}
            help={`Up to ${MAX_SCHEMA_BYTES / 1024} KiB. ${form.codec === 'protobuf' ? 'Only google/protobuf well-known types can be imported; put every other message in this schema.' : 'Named types, unions and logical types are supported.'}`}
          >
            <Textarea
              className="mono min-h-48 text-xs"
              spellCheck={false}
              aria-invalid={errors.schemaText ? 'true' : undefined}
              value={form.schemaText}
              onChange={(e) => set({ schemaText: e.target.value })}
              placeholder={form.codec === 'protobuf' ? 'syntax = "proto3";\nmessage Pump {\n  double temp = 1;\n  int32 rpm = 2;\n}' : '{"type":"record","name":"Pump","fields":[{"name":"temp","type":"double"}]}'}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept=".proto,.avsc,.json,text/plain,application/json" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={onFile} data-testid="codec-schema-file" />
            <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
              <Upload size={14} aria-hidden="true" /> Upload schema file
            </Button>
          </div>
          {form.codec === 'protobuf' && (
            <Field label="Message type" help="Fully qualified, like plant.v1.Pump. Leave empty when the schema defines one message.">
              <Input className="mono" value={form.messageType} onChange={(e) => set({ messageType: e.target.value })} placeholder="plant.v1.Pump" />
            </Field>
          )}
        </div>
      )}
      <Toggle checked={form.enabled} onChange={(v) => set({ enabled: v })} label="Enabled" description="A disabled binding is kept but does not decode." />
      <div className="border-t border-line pt-3">
        <p className="mb-2 text-sm font-medium text-fg">Try this codec</p>
        <TestBox spec={{ codec: form.codec, schemaText: usesSchema ? form.schemaText : undefined, messageType: form.codec === 'protobuf' ? form.messageType : undefined }} maxBytes={maxBytes} compact />
      </div>
    </div>
  );
}

const ENCODINGS = [
  { value: 'hex', label: 'Hex' },
  { value: 'base64', label: 'Base64' },
  { value: 'text', label: 'Text' }
];

/**
 * Decode a pasted payload. With `spec` (the dialog) it tests the unsaved codec and schema; otherwise the
 * user picks auto-detection, a saved binding or a built-in codec.
 */
function TestBox({ spec, codecs = [], maxBytes, compact = false }) {
  const [using, setUsing] = useState('auto');
  const [encoding, setEncoding] = useState('hex');
  const [payload, setPayload] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const size = payloadSize(payload, encoding);

  const run = async () => {
    if (!payload.trim() || busy) return;
    setBusy(true);
    try {
      let body;
      if (spec) body = { ...spec };
      else if (using.startsWith('binding:')) body = { bindingId: using.slice(8) };
      else body = { codec: using };
      setResult(await api.testCodec({ ...body, payload, encoding }));
    } catch (e) {
      setResult({ ok: false, error: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        {!spec && (
          <Select label="Decode with" value={using} onChange={(e) => setUsing(e.target.value)} fieldClassName="min-w-[14rem]">
            <option value="auto">Auto-detect (CBOR or MessagePack)</option>
            {codecs.length > 0 && (
              <optgroup label="Saved bindings">
                {codecs.map((b) => (
                  <option key={b.id} value={`binding:${b.id}`}>
                    {b.name || b.filter} ({codecLabel(b.codec)})
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Built-in codecs">
              {CODEC_OPTIONS.filter((o) => !SCHEMA_CODECS.has(o.value) && o.value !== 'raw').map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          </Select>
        )}
        <SegmentedControl label="Payload encoding" size="sm" value={encoding} onChange={setEncoding} options={ENCODINGS} />
      </div>
      <Field
        label="Payload"
        help={`${size === null ? 'Not valid hex.' : `${size.toLocaleString()} bytes.`}${maxBytes ? ` Payloads above ${Math.round(maxBytes / 1024)} KiB are not decoded.` : ''}`}
      >
        <Textarea
          className={`mono text-xs ${compact ? 'min-h-16' : 'min-h-24'}`}
          spellCheck={false}
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          placeholder={encoding === 'hex' ? 'a2 64 74 65 6d 70 fb 40 35 80 00 00 00 00 00 63 72 70 6d 19 05 dc' : encoding === 'base64' ? 'omR0ZW1w+0A1gAAAAAAAY3JwbRkF3A==' : '[{"bn":"pump1/","n":"temp","u":"Cel","v":21.5}]'}
          data-testid={compact ? 'codec-try-payload' : 'codec-test-payload'}
        />
      </Field>
      <Button variant="secondary" onClick={run} loading={busy} disabled={!payload.trim()}>
        Decode
      </Button>
      <div aria-live="polite">
        {result &&
          (result.ok ? (
            <div>
              <p className="mb-1 text-xs text-muted">
                Decoded as {codecLabel(result.codec)} ({(result.bytes || 0).toLocaleString()} bytes)
                {Number.isFinite(result.sourceTimestamp) ? `, source time ${new Date(result.sourceTimestamp).toISOString()}` : ''}
              </p>
              <pre tabIndex={0} role="region" aria-label="Decoded payload" className="mono max-h-64 overflow-auto rounded-md border border-line bg-app p-3 text-xs text-fg" data-testid="codec-test-output">
                {JSON.stringify(result.value, null, 2)}
              </pre>
            </div>
          ) : (
            <Banner variant={result.schemaError ? 'error' : 'warn'} title={result.schemaError ? 'The schema has a problem' : 'Could not decode'}>
              <span data-testid="codec-test-error">{result.error}</span>
            </Banner>
          ))}
      </div>
    </div>
  );
}
