import { HelpButton, Kbd } from '@/components/ui';

/** The Tags page's "How this works". */
export default function TagsHelp() {
  return (
    <HelpButton title="Mapping tags into the UNS">
      <p>
        A <b>tag</b> is one data point: a reading, a setpoint, a status. A <b>mapping</b> publishes tags under an asset path in your namespace, with the names, units and context you give them.
      </p>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>
          <b>Devices</b>: tags configured on the Devices page. Map a pick list, or every tag that matches rules (new tags are picked up automatically).
        </li>
        <li>
          <b>OPC UA</b>: the address space of a connected server. <b>Sparkplug</b>: metrics from BIRTH certificates on a broker.
        </li>
        <li>
          <b>MQTT topics</b>: one value per topic, read from the payload (a field path, or a value/time/quality envelope). Map picked topics, or every topic under a filter. A mapping never reads what it publishes.
        </li>
      </ul>
      <p>
        In the editor, the table holds one row per tag: rename, set units and descriptions inline, paste a column from a spreadsheet, import or export rows as CSV, or select rows for bulk changes. The preview on the right is the server&apos;s answer: topics, example payloads, the <code>_meta</code> document and warnings.
      </p>
      <p>Mappings only read. Manifold never writes to a device.</p>
      <p className="text-subtle">
        Tree keys: arrows move, Right and Left expand and collapse, <Kbd>Space</Kbd> selects, <Kbd>Enter</Kbd> expands. Editor: <Kbd>Ctrl</Kbd> + <Kbd>S</Kbd> saves.
      </p>
    </HelpButton>
  );
}
