import { HelpButton } from '@/components/ui';

export default function UnsHelp() {
  return (
    <HelpButton title="How the Unified Namespace view works" label="How this view works">
      <p>
        This view maps every connected source into one live namespace, laid out as an ISA-95 hierarchy: Enterprise,
        Site, Area, Line, Cell, and so on down to individual tags. Each broker becomes a tree, and mounted sources
        (OPC UA, i3X) sit beside them. Sparkplug (spBv1.0) branches are not ISA-95 levels: they are labelled Sparkplug namespace, group, edge node and device.
      </p>
      <p>Two ways to look at it:</p>
      <ul className="list-disc space-y-1 pl-5">
        <li><b>Topology</b>: the graph. Nodes are badges, edges show the parent-child path.</li>
        <li><b>Tree</b>: the same namespace as a searchable, collapsible list.</li>
      </ul>
      <p>Reading the topology:</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>An edge becomes a <b>moving dashed line</b> in the green state colour while data flows through that branch, and returns to a plain hairline when it goes quiet.</li>
        <li>A leaf carries a state marker: a <b>circle</b> while it publishes, a <b>triangle</b> when it is overdue (silent for about 3x its usual interval) and a <b>square</b> when it has gone silent (about 10x).</li>
        <li>A leaf&apos;s latest value is printed under its name, so the map doubles as a live dashboard.</li>
      </ul>
      <p>Getting around:</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>Click a node to open its detail. Double-click, or click the <b>+ / -</b> badge, to expand or collapse.</li>
        <li>Drag a node to move it; it stays where you drop it. Ctrl or Cmd-click several nodes, or shift-drag a box, to move a group together. The map controls in the bottom-right corner zoom, fit the view (or press F) and auto-arrange (reset moved nodes).</li>
      </ul>
      <p className="text-subtle">
        The toolbar under the title: <b>Lint</b> checks the namespace for structural problems and shows each one on the map.
        <b> Events</b> is a live feed of new topics and Sparkplug births and deaths. <b>Levels</b> renames the ISA-95
        tiers. <b>Sources</b> adds OPC UA and i3X structure. Selecting a node puts it in the address bar, so you can share the link.
      </p>
    </HelpButton>
  );
}
