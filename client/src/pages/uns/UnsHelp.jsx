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
        <li>An edge turns <b className="text-emerald-400">green and animated</b> while data is flowing through that branch, and fades to gray when it goes quiet.</li>
        <li>A leaf carries a status dot: <b className="text-emerald-400">green</b> is publishing now, <b className="text-amber-400">amber</b> is overdue (silent about 3x its usual interval), <b className="text-rose-400">red</b> is dead (about 10x).</li>
        <li>A leaf&apos;s latest value is printed under its name, so the map doubles as a live dashboard.</li>
      </ul>
      <p>Getting around:</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>Click a node to open its detail. Double-click, or click the <b>+ / -</b> badge, to expand or collapse.</li>
        <li>Drag a node to move it; it stays where you drop it. Ctrl or Cmd-click several nodes, or shift-drag a box, to move a group together. <b>Auto arrange</b> resets the layout, <b>Fit</b> re-frames it.</li>
      </ul>
      <p className="text-slate-400">
        The buttons up top: <b>Lint</b> checks the namespace for structural problems and jumps you to each one.
        <b> Events</b> is a live feed of new topics and Sparkplug births and deaths. <b>Levels</b> renames the ISA-95
        tiers. <b>Mounts</b> grafts in OPC UA and i3X sources.
      </p>
    </HelpButton>
  );
}
