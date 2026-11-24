import { useState } from 'react';
import { Dialog, Button, Textarea, Field } from '@/components/ui';

/** Parse a Kepware / Ignition style export: one "nodeId,name" per line (comma, semicolon or tab). */
export function parseCsvTags(text) {
  const tags = [];
  for (const row of String(text).split('\n').map((l) => l.trim()).filter(Boolean)) {
    const cols = row.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
    if (!cols[0] || /^(nodeid|address|tag)$/i.test(cols[0])) continue; // header
    tags.push({ address: cols[0], name: cols[1] || cols[0].split(/[.;=/]/).pop() });
  }
  return tags;
}

/** Paste an OPC UA tag list; the rows land in the selection and open the mapping editor. */
export default function CsvImport({ onClose, onImport }) {
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const submit = () => {
    const tags = parseCsvTags(text);
    if (!tags.length) return setError('No rows found. Expected one "nodeId,name" per line.');
    onImport(tags);
  };
  return (
    <Dialog
      title="Import a tag list"
      description="Paste a Kepware or Ignition export: one nodeId,name per line. The rows are selected so you can map them like browsed tags."
      onClose={onClose}
      onSubmit={submit}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!text.trim()}>
            Select {parseCsvTags(text).length || ''} tags
          </Button>
        </>
      }
    >
      <Field label="CSV rows" error={error}>
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          rows={10}
          className="mono text-xs"
          placeholder={'ns=2;s=Line1.Motor.RPM,Motor RPM\nns=2;s=Line1.Motor.Temp,Motor Temp'}
          aria-invalid={Boolean(error) || undefined}
        />
      </Field>
    </Dialog>
  );
}
