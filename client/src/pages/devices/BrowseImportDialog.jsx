import { useMemo, useState } from 'react';
import { Dialog, Button } from '@/components/ui';
import BrowseTree from './BrowseTree';
import { nodesToTags, browseNoun } from './model';

/**
 * "Import from controller": pick tags from the controller's own list and append
 * them to the editor with generated unique keys and suggested UNS property names.
 */
export default function BrowseImportDialog({ device, descriptor, existing, pollGroups, makeId, onAdd, onClose }) {
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
    <Dialog
      title={`Import tags from ${device.name}`}
      description={`Pick tags from the ${browseNoun(descriptor)}'s own list. They are added to the editor; save the device to keep them.`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <p className="mr-auto text-sm tabular-nums text-muted" aria-live="polite">
            {selection.size} selected
          </p>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={add} disabled={!selection.size}>
            Add {selection.size} tag{selection.size === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <BrowseTree noun={browseNoun(descriptor)} deviceId={device.id} selection={selection} onToggle={toggle} takenAddresses={taken} />
    </Dialog>
  );
}
