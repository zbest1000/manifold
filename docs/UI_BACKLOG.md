# UI Backlog

Running list of UI/UX issues discovered during the overhaul, with evidence and
proposed fixes. Ordered roughly by impact. Checked items are done; the commit or
PR that closed them is noted inline.

## Open

### Medium

- [~] **Modal portal consistency.** A shared portaled `Modal` primitive now
  exists (`components/ui.jsx`) — it renders through `document.body` (escaping any
  `backdrop-blur` ancestor Card, which becomes the containing block for
  `position:fixed` and otherwise traps the modal under its neighbours) and owns
  Esc + backdrop-close. `HelpButton` migrated. **Still to migrate:**
  `components/UnsIconPicker.jsx`, `components/ErrorLog.jsx`, and the two modals in
  `pages/TopicGraph.jsx` (`HistoryChartModal`, expanded `TopicPanel`). None are
  currently *visibly* broken (their ancestors aren't blur-Cards today), so this
  is preventive — migrate them to the primitive as they're touched.

- [ ] **UNS topology over-zooms when a deep mount is present.** With the demo
  OPC-UA mount (opc-plc, hundreds of nodes) grafted in, the "fit everything on
  load" framing shrinks the whole forest to unreadable (k clamps near the 0.2
  floor). The MQTT broker trees — the thing you usually want — become tiny.
  Options: (a) exclude/soft-weight deep mounts from the initial fit, (b) fit to
  the broker subtrees and let the user pan to mounts, or (c) collapse mounts to
  their root by default. Needs a design call.

- [ ] **OPC-UA / i3X mounts default fully-expanded in UNS.** Compounds the
  over-zoom above and makes the paper canvas very tall. Mounts probably want to
  seed collapsed (root only), unlike broker namespaces which seed to level 1.

### Low

- [ ] **Small object graphs lay out as a horizontal line with overlapping
  labels.** Discovered on the i3X page with the 11-node mock hierarchy: the force
  layout leaves all nodes on one row and the labels ("Manifold Mock i3X", "Acme
  Plant", "Temperature"/"Speed"…) overlap. Same renderer as Topics, so it affects
  any small graph. Fix: for graphs under ~20 nodes, prefer the radial/tree layout
  by default, or bump label collision spacing at low node counts.
  (`graph/ForceGraph.jsx`, layout seeding in `pages/I3x.jsx`.)

- [ ] **System "Process health" sparklines are blank right after a restart.**
  Expected (needs ≥2 samples, ~6s) but reads as broken on first paint. Consider a
  1-px baseline placeholder until the first two samples land.

- [ ] **Replay scrubber polish (Topics/Trends).** Functional but visually thin;
  no keyboard control, no time labels on the track. Verify a11y + add tick marks.

- [ ] **Density/spacing audit tail.** Original QA flagged general density on
  UNS/Flows; revisit tile paddings and small-screen breakpoints once the bigger
  items land.

## Done (recent)

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
