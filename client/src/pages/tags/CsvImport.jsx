import { useState } from 'react';
import { X } from 'lucide-react';
import toast from 'react-hot-toast';
import { Modal, Button } from '@/components/ui';

export default function CsvImport({ onClose, onImport }) {
  const [text, setText] = useState('');
  const parse = () => {
    const rows = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const tags = [];
    for (const row of rows) {
      const cols = row.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
      if (!cols[0] || /^(nodeid|address|tag)/i.test(cols[0])) continue; // header
      tags.push({ address: cols[0], name: cols[1] || cols[0].split(/[.;=/]/).pop() });
    }
    if (!tags.length) return toast.error('No rows parsed. Expected "nodeId,name" lines');
    onImport(tags);
  };
  return (
    <Modal title="Import tag list (CSV)" onClose={onClose} className="max-w-xl p-5">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-base font-semibold text-slate-100">Import tag list (CSV)</h3>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10">
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <p className="mb-2 text-xs text-slate-400">
        Paste a tag export (Kepware or Ignition style): one <span className="font-mono">nodeId,name</span> per line. Rows land in the
        selection so you can bind them like browsed tags.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        aria-label="CSV rows"
        placeholder={'ns=2;s=Line1.Motor.RPM,Motor RPM\nns=2;s=Line1.Motor.Temp,Motor Temp'}
        className="w-full rounded-lg border border-white/10 bg-surface-950/60 p-2 font-mono text-xs text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-accent-500/30"
      />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={parse} disabled={!text.trim()}>Parse &amp; select</Button>
      </div>
    </Modal>
  );
}
