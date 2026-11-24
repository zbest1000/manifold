import { useId, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Modal, Button, IconButton } from '@/components/ui';
import BrowseTree from './BrowseTree';
import { nodesToTags } from './model';

/**
 * "Import from controller": pick tags from the controller's own list and append
 * them to the editor with generated unique keys and suggested UNS property names.
 */
export default function BrowseImportDialog({ device, descriptor, existing, pollGroups, makeId, onAdd, onClose }) {
  const titleId = useId();
  const [selection, setSelection] = useState(() => new Map());
  const taken = useMemo(() => new Set(existing.map((t) => String(t.address || '').trim()).filter(Boolean)), [existing]);
  const toggle = (node) =>
    setSelection((s) => {
      const n = new Map(s);
      if (n.has(node.id)) n.delete(node.id);
      else n.set(node.id, node);
      return n;
    });
  const add = () => onAdd(nodesToTags([...selection.values()], { descriptor, existing, pollGroup: pollGroups[0]?.id || '', makeId }));
  return (
    <Modal title="Import from controller" labelledBy={titleId} onClose={onClose} className="max-w-3xl p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 id={titleId} className="text-base font-semibold text-slate-100">Import tags from {device.name}</h3>
        <IconButton icon={X} label="Close" onClick={onClose} />
      </div>
      <BrowseTree deviceId={device.id} selection={selection} onToggle={toggle} takenAddresses={taken} />
      <div className="mt-4 flex items-center justify-between gap-2">
        <p className="text-xs text-slate-400" aria-live="polite">{selection.size} selected</p>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="button" onClick={add} disabled={!selection.size}>Add {selection.size} tag{selection.size === 1 ? '' : 's'}</Button>
        </div>
      </div>
    </Modal>
  );
}
