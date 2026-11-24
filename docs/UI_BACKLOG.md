# UI Backlog

Running list of UI/UX issues discovered during the overhaul, with evidence and
proposed fixes. Ordered roughly by impact. Checked items are done; the commit or
PR that closed them is noted inline.

## Open

### Medium

- [x] **Modal portal consistency.** *Done: every overlay uses the shared portaled
  `Modal` (`components/ui.jsx`), including `UnsIconPicker`, `ErrorLog`, the topic
  panels, the System metric modal, the Tags wizard and the Devices dialogs; no
  `fixed inset-0` overlay remains outside the primitive (searched Nov 2026).* The
  primitive renders through `document.body` (escaping any `backdrop-blur`
  ancestor Card, which becomes the containing block for `position:fixed`), owns
  Esc and backdrop-close, traps focus and restores it.

- [ ] **No deep link from a binding to its node in the UNS.** The binding detail
  (`pages/tags/BindingDetail.jsx`) shows the resolved topics and a copyable asset
  path, but there is no "show in UNS" link, and the UNS page (`pages/Uns.jsx`)
  does not read a selected path from the URL, so the link cannot be built without
  changing both.

- [ ] **Sparkplug primary-host control sits on the Tags page**
  (`pages/tags/HostStatePanel.jsx`), beside bindings; it belongs on the broker.

- [ ] **Device fields without a UI:** the `isolate` flag (own host process per
  device) and the Modbus `options.unmapped` ranges are REST only.

- [ ] **A connections hub.** The design (section 8) lists MQTT and OPC UA
  connections next to devices under one "Add" picker; today they are separate
  pages. Device nodes do not appear in the UNS topology either.

- [ ] **Sorting and table semantics are partial.** Brokers, OPC UA connections and
  Discovery results sort (`lib/sortRows.js`); the Devices, Profiles and bindings
  tables do not.

- [ ] **Binding preview has no lint delta**, only collisions and raw-address
  warnings, and the MQTT-source bind path (pipeline routes) has none of the
  asset-path, `_meta` or historian options.

- [ ] **Not re-verified since the shell rewrite:** layout at 390 px on every page,
  contrast ratios (the AA tokens were not measured here), bundle size (every page
  is lazy, but both `lucide` and `lucide-react` are still dependencies), and the
  page-level `.catch(() => ...)` handlers that still swallow errors (seven in
  `client/src`).

- [x] **UNS topology over-zooms when a deep mount is present.** *Done: the auto-fit now frames only broker trees (mounts are excluded whenever any broker node exists), via `fitTransform` in `graph/unsLayout.js`; covered by a unit test.* With the demo
  OPC-UA mount (opc-plc, hundreds of nodes) grafted in, the "fit everything on
  load" framing shrinks the whole forest to unreadable (k clamps near the 0.2
  floor). The MQTT broker trees — the thing you usually want — become tiny.
  Options: (a) exclude/soft-weight deep mounts from the initial fit, (b) fit to
  the broker subtrees and let the user pan to mounts, or (c) collapse mounts to
  their root by default. Needs a design call.

- [x] **OPC-UA / i3X mounts default fully-expanded in UNS.** *Done: `seedExpansion` seeds mounts collapsed (root only) while brokers still open to level 1.* Compounds the
  over-zoom above and makes the paper canvas very tall. Mounts probably want to
  seed collapsed (root only), unlike broker namespaces which seed to level 1.

### Low

- [x] **System "Process health" sparklines are blank right after a restart.** *Done: `Sparkline` renders a dashed 1px baseline (and an aria-label "collecting samples") until the second sample lands.*
  Expected (needs ≥2 samples, ~6s) but reads as broken on first paint. Consider a
  1-px baseline placeholder until the first two samples land.

- [x] **Replay scrubber polish (Topics/Trends).** *Done: the track is now a keyboard slider (arrows 5%, Home/End, Space/Enter), with start/end clock labels, quarter tick marks, aria-valuetext and labelled buttons (`components/ReplayScrubber.jsx`).* Functional but visually thin;
  no keyboard control, no time labels on the track. Verify a11y + add tick marks.

- [x] **Density/spacing audit tail (UNS, Topics, Flows, Trends, System, Overview).** *Done: page headers wrap (`ResponsiveHeader`), side panels stack below the canvas under `md`, helper text is at least 12px in slate-400, and no page overflows horizontally at 390px.* Original QA flagged general density on
  UNS/Flows; revisit tile paddings and small-screen breakpoints once the bigger
  items land.

## Done (recent)

- [x] **Shell and accessibility pass (Nov 2026).** Off-canvas navigation drawer
  below `md`, global `:focus-visible`, AA colour tokens, shared `Modal`, `Table`
  and form primitives, lazy routes with a skeleton fallback, an ESLint config.
- [x] **Tags page.** Accessible tree (arrows, Space, Enter), filter box,
  select-all-in-folder, bound-tag indicator, a three-step bind wizard (target,
  naming with the server's topic preview, options) with an asset-path picker,
  layout choice (topic per tag or object per asset), units and deadband type,
  heartbeat, direct historian target (Timebase and TimescaleDB only) and profile
  bindings; save-time warnings are shown after saving.
- [x] **Devices page.** Generic forms for Modbus, S7 and EtherNet/IP with
  presets, experimental badges and the prerequisites text, controller import
  (EtherNet/IP), probe, polling health, quarantine reasons, Profiles tab with
  bulk creation. Discovery: "Find devices" and "Add as device".
- [x] **UNS and Topics.** Dark UNS theme, the Sparkplug namespace labelled as
  such, one topic counter and one ingest-rate hook, label level of detail.

- [x] A shared Y axis flattened mixed-magnitude tags (temperature ~50 went flat
  next to speed ~1450). Added a Normalize toggle to Trends that rescales each
  series to its own 0-100% range so shapes compare directly; the legend keeps
  the real min-max. (`components/TrendChart.jsx`.)
- [x] Trends read empty out of the box and, worse, a file recording of the demo
  charted nothing because `recorder.series()` did `Number(objectPayload)` = NaN.
  Fixed the numeric extraction (handles `{value,unit}`), added a searchable
  captured-tags endpoint, seeded an always-on "Built-in historian" recording
  (`factory/#`), and defaulted Trends to it. Trends now has real persisted
  history on first load, no external DB. (Chose the existing JSONL recorder over
  a new SQLite native dep.)
- [x] Small object graphs (e.g. the i3X hierarchy) collapsed onto one horizontal
  line. Root cause: `treePositions` read `link.source/target` after d3's
  forceLink had mutated them from id strings to node objects, so every node
  looked parentless. Made it endpoint-agnostic and widened the tree gaps; small
  graphs now render as proper trees.
- [x] Right-click to open node properties was unreliable (OS/browser swallows the
  contextmenu). Replaced with a discoverable Properties button in the shared
  GraphToolbar and 3D controls (Topics, i3X, everywhere), tracking panelOpen so
  closing the panel no longer loses access. Extracted a shared GraphLegend used
  across views.
- [x] i3X and CESMII SMIP pages had no server to talk to locally, so they read as
  dead. Added two Docker mock servers (`docker/i3x-mock`, `docker/cesmii-mock`)
  wired into the demo compose stack; verified end-to-end (connect, catalog,
  hierarchy graph, and history chart all render live).
- [x] 3D graph had no look-and-feel controls or Beautify (2D had Beautify but 3D
  didn't). Added a 3D control cluster: Beautify (depth-graded colour ramp from the
  active palette + additive link glow + slow auto-rotate), an Auto-rotate toggle,
  and node-size / link-opacity sliders. Ref-driven so the on-demand render loop
  stays alive during rotation.
- [x] Right-clicking a graph node did nothing (browser context menu) — properties
  panel only opened on left-click. Wired `contextmenu` in all three renderers (2D
  canvas, 3D three.js, WebGL) to open the properties panel; also fixed WebGL
  click-vs-drag threshold to be HiDPI-aware.
- [x] No colour legend on the Topic graph, so group colours were unexplained.
  Added a collapsible legend (Broker / Branch / Data / Sparkplug…) to the 2D and
  3D views.
- [x] Destructive deletes (route, model, historian, recording, contract) fired
  with no confirmation. Wrapped all five in a confirm, warning about credential
  loss / data loss where relevant.
- [x] UNS "Mounts" panel only listed OPC UA / i3X, so MQTT and Sparkplug looked
  like they weren't UNS sources. Reworked into a "UNS sources" panel that shows
  Live sources (MQTT brokers, Sparkplug decoded within them) alongside Mounted
  sources (OPC UA, i3X), and explains how they connect (one namespace; bridge
  values with a Pipeline route or Tag binding).
- [x] Expanded in-app help with concrete examples and plainer wording (no
  em-dashes, no filler): richer Pipelines help; added help to UNS topology,
  Trends, and UNS sources; tightened Tags help.


- [x] Charts flashing / resetting every data tick — memoize uPlot options on a
  structural key so live data flows through `setData` (PR #43).
- [x] Health-metric popup see-through / trapped under cards — `createPortal`
  to `document.body` (PR #43).
- [x] Every chart migrated to uPlot (mature, lightweight; Grafana's engine),
  Recharts removed (~300KB off the bundle) (PR #42).
- [x] Health tiles → click to expand a full time chart (PR #42).
- [x] UNS moved nodes fighting their position — absolute pinning (PR #42).
- [x] UNS didn't center on load; lint findings now jump-to-node + explain (#41).
- [x] Sparklines rendered as filled blocks — domain padding + flat baseline (#41).
- [x] UNS multi-select + group move; Topics detail pane expandable (#41).

## How this list is maintained

Appended to during the UI-overhaul loop: each pass inspects a surface (live via
Chrome DevTools and/or by reading its component), records concrete,
evidence-backed issues here, and fixes the highest-value safe ones. Keep entries
specific — name the file, the symptom, and the proposed fix.
