# Manifold UI design system

The rules every page of the console follows, and the tokens and primitives that implement them. Reference pages: `client/src/pages/Overview.jsx` (dashboard), `client/src/pages/Brokers.jsx` (list + form dialog), `client/src/pages/Devices.jsx` (table + detail drawer + full-page form) and `client/src/pages/Tags.jsx` with `client/src/pages/tags/editor/` (workspace + full-height editor). The client is on Tailwind 4: `index.css` imports `tailwindcss` and loads `tailwind.config.js` with `@config`, and that config replaces Tailwind's palette with the semantic tokens, so only the names below exist.

Files:

| What | Where |
| --- | --- |
| Tokens (both themes), fonts, base styles | `client/src/index.css` |
| Tailwind theme: the semantic palette only (the default palette is replaced) | `client/tailwind.config.js` |
| Guard against Tailwind palette and other off-system class names | `client/src/test/designSystemClasses.test.js` |
| Theme before first paint | `client/public/theme-init.js` (loaded from `client/index.html`) |
| Theme at runtime (`useTheme`, `setThemePreference`) | `client/src/lib/theme.js` |
| Primitives (import from `@/components/ui`) | `client/src/components/ui/*.jsx`, re-exported by `client/src/components/ui.jsx` |
| Shell | `client/src/components/Layout.jsx`, `PageHeader.jsx`, `ErrorLog.jsx` |
| Local primitives not yet promoted | section 11 |

---

## 1. Principles

Manifold is an instrument for controls and automation engineers. It is open next to a PLC programming tool for hours, often on a plant-floor screen. The UI should behave like a good measuring instrument: precise, quiet, legible, and loud only when something is wrong.

1. **State is the only thing that gets colour.** Neutral greys carry the layout. Green, amber, red and blue mean good, warning, bad and info, and nothing else. The single accent (teal) marks what you can act on or what is selected.
2. **Layers, not effects.** Surfaces differ by a lightness step and a 1px hairline. No translucency, glass, glows or gradients. Shadows exist only on things that float above the page (menus, dialogs, drawers, toasts).
3. **Density with calm.** 13px body text, 32px controls, 8px table rows. Spacing comes from one scale, and alignment is strict, so a dense page still reads easily.
4. **Data first.** Numbers are tabular, units are always shown, paths keep their leaf visible, timestamps are relative with the absolute time on hover.
5. **Text over ornament.** Sentence case. No icon in front of a heading. Use an icon only where it carries meaning (state, a tool, a nav item) or helps scanning.
6. **Two real themes.** Dark is the default and light is first-class. Both come from the same semantic tokens, so a component written once works in both.
7. **Plain copy.** Specific, short, sentence case. Write "1 of 2 connected", not "Live snapshot of your brokers". Avoid marketing voice and exclamation marks.

## 2. Patterns to avoid

| Avoid | Use instead |
| --- | --- |
| Navy-black pages with blue accents and blue-tinted greys | Graphite neutrals with the teal accent used sparingly |
| Gradient icon tiles on stat cards | `Stat` (label, number, unit, secondary line) in a `StatGroup` strip |
| Glowing or gradient buttons and brand tiles | A solid accent button, no shadow; a flat monochrome brand mark |
| Translucent glass cards with blur and double shadows, nested inside each other | `Panel` / `Card`: 6px radius, 1px `border-line`, solid `bg-panel`, never nested |
| Pills for everything (status, counts, levels) | `StatusText` (dot + word) for state; `Badge` is a small square-cornered label |
| Uppercase letter-spaced micro-labels | Sentence-case 12px medium labels |
| A decorative icon in front of every heading | Plain headings |
| Generous padding and low density | 16px panel padding, 32px nav rows, 32px controls |
| A ping halo on every connected dot | Static dots; motion only for state changes |
| Generic copy ("Live snapshot of your brokers") | Specific copy ("1 of 2 connected"), or no subtitle |

## 3. Colour tokens

All tokens are `R G B` triplets on `:root` (dark, the default) and `:root[data-theme='light']`, consumed as `rgb(var(--token) / <alpha>)`. Components use the Tailwind names in the right-hand column and never raw palette steps.

### 3.1 Neutrals and surfaces

| Token | Tailwind | Dark | Light | Use |
| --- | --- | --- | --- | --- |
| `--bg` | `bg-app` | `#0f0f10` | `#f6f6f7` | App background, sidebar |
| `--panel` | `bg-panel` | `#161617` | `#ffffff` | Panels, tables, cards |
| `--raised` | `bg-raised` | `#1e1e20` | `#f0f0f2` | Hover, selected nav item, segment, badge fill |
| `--overlay` | `bg-overlay` | `#232325` | `#ffffff` | Dialogs, drawers, menus, tooltips, toasts |
| `--field` | `bg-field` | `#121213` | `#ffffff` | Inputs, selects, textareas |
| `--border` | `border-line` | `#2a2a2d` | `#e2e2e5` | Default hairline |
| `--border-strong` | `border-line-strong` | `#3a3a3e` | `#cdcdd2` | Control borders, overlay outline |
| `--border-stronger` | `border-line-stronger` | `#4a4a4f` | `#a9a9b0` | Control hover |
| `--text` | `text-fg` | `#ececee` | `#17171a` | Body text, values |
| `--text-muted` | `text-muted` | `#a3a3a9` | `#55555c` | Labels, secondary text |
| `--text-subtle` | `text-subtle` | `#8f8f95` | `#64646b` | Meta, units, helper text |
| `--text-faint` | `text-faint` | `#85858b` | `#6b6b72` | Placeholders, quiet icons |
| `--control-off` | `bg-control-off` | `#6b6b72` | `#8e8e96` | Switch track off, neutral status dot |

Why pure neutral: blue-tinted slate on navy is the most common default of generated dashboards. A graphite scale with no hue lets the four state colours and the accent mean something.

### 3.2 Accent

| Token | Tailwind | Dark | Light |
| --- | --- | --- | --- |
| `--accent` | `bg-accent`, `border-accent`, `ring-accent` | `#2cc5cf` | `#00747d` |
| `--accent-hover` | `bg-accent-hover` | `#5ad4dc` | `#00636b` |
| `--accent-fg` | `text-accent-fg` (text on accent) | `#04191b` | `#ffffff` |
| `--accent-text` | `text-accent-text` (links, selected text) | `#4fd2db` | `#006d75` |
| `--focus` | focus outline | = accent-text | = accent-text |

**Choice: signal teal (hue about 185°).** Amber or orange is the natural industrial colour, but in ISA-101 style HMI practice it means *warning or alarm*, so an amber accent would compete with the warning state on every screen. Teal sits between the good green (about 150°) and the info blue (about 215°) without being either, reads as "instrument" rather than "SaaS", and is not a Tailwind default (sky, indigo or violet). On dark the primary button is bright teal with near-black text, which is more distinctive and more legible than white on mid-teal. Use the accent for: the primary action (one per view), focus, the selected nav item rule, the selected tab underline, links, toggles that are on, the selected table row rule. Do not use it for headings, icons or decoration.

### 3.3 State

| Token | Tailwind | Dark | Light | Meaning |
| --- | --- | --- | --- | --- |
| `--good` | `text-good`, `bg-good` | `#3fc184` | `#137a48` | connected, online, running, quality good |
| `--warn` | `text-warn`, `bg-warn` | `#e3a33a` | `#975a00` | connecting, stale, degraded, spill |
| `--bad` | `text-bad`, `bg-bad` | `#f06a63` | `#c4282e` | error, offline with a failure, quality bad |
| `--info` | `text-info`, `bg-info` | `#6aa6f8` | `#1f5fc2` | informational notices |
| `--aux` | `text-aux`, `bg-aux` | `#b39af5` | `#6b47c9` | a fifth hue for canvases and charts (not a state) |
| `--danger` / `--danger-hover` / `--danger-fg` | `bg-danger text-danger-fg` | `#c9302c` / `#d83a35` / white | `#c4282e` / `#a81e24` / white | destructive buttons only |

The four were tuned as a set: in each theme they have similar contrast against the panel (dark 6.0 to 8.2:1, light 5.4 to 6.0:1), so none shouts louder than another. Show state as a **dot** (`StatusDot`), a **dot and word** (`StatusText`), a **2px left rule** (`Banner`, selected row), or **coloured text** for a short value. Never as a large tinted pill. A tint background is allowed only at 6 to 10% behind an inline alert or a hover.

### 3.4 Contrast (WCAG 2.1, computed)

Text on each surface. AA needs 4.5:1 for body text. Everything below passes in both themes.

| Text token | Dark: bg / panel / raised / overlay | Light: bg / panel / raised / overlay |
| --- | --- | --- |
| text | 16.2 / 15.3 / 14.1 / 13.3 | 16.6 / 17.9 / 15.7 / 17.9 |
| text-muted | 7.6 / 7.2 / 6.6 / 6.3 | 6.9 / 7.4 / 6.5 / 7.4 |
| text-subtle | 6.0 / 5.6 / 5.2 / 4.9 | 5.4 / 5.9 / 5.2 / 5.9 |
| text-faint | 5.2 / 4.9 / 4.5 / 4.3* | 4.9 / 5.3 / 4.7 / 5.3 |
| accent-text | 10.6 / 10.0 / 9.2 / 8.7 | 5.7 / 6.1 / 5.4 / 6.1 |
| good | 8.4 / 7.9 / 7.3 / 6.9 | 5.0 / 5.4 / 4.7 / 5.4 |
| warn | 8.7 / 8.2 / 7.6 / 7.2 | 5.2 / 5.6 / 4.9 / 5.6 |
| bad | 6.3 / 6.0 / 5.5 / 5.2 | 5.3 / 5.7 / 5.0 / 5.7 |
| info | 7.7 / 7.3 / 6.7 / 6.3 | 5.6 / 6.0 / 5.3 / 6.0 |

\* `text-faint` is for placeholders and quiet icons. Do not put it on `bg-overlay` for real text.

Other pairs: accent-fg on accent is 8.6:1 dark and 5.5:1 light. White on danger is 5.3:1 dark and 5.7:1 light. Each state colour on its own 12% tint is at least 5.1:1 dark and 4.6:1 light. Non-text (WCAG 1.4.11, 3:1): accent against panel is 8.6 dark and 5.5 light, the switch-off track is 3.4 and 3.3, and the focus outline uses accent-text. Hairlines (`border` 1.3:1) are decorative separators. Interactive control boundaries use `border-line-strong` together with the field fill.

`prefers-contrast: more` raises `--border`, `--border-strong` and the muted, subtle and faint text tokens in both themes (see `index.css`).

## 4. Themes

* The preference is `system | light | dark`, stored in `localStorage['tc.theme']`, default `system`.
* `public/theme-init.js` runs synchronously in `<head>` and sets `<html data-theme="dark|light">`, the `dark` class and `color-scheme` before first paint, so there is no flash. It is a same-origin file, not inline, so it keeps working if a strict CSP is enabled.
* `src/lib/theme.js` (`useTheme()`) keeps the attribute current when the preference changes, when the OS theme changes under `system`, and when another tab changes it.
* The switch is in the sidebar footer: a three-button group (system, light, dark). When the sidebar is collapsed it is one button that cycles. **Settings → Appearance** shows the same choice.
* Canvases follow the app theme. `src/graph/canvasTokens.js` reads the same custom properties once per theme change and every canvas theme object (UNS, Topics graph styles, charts) is derived from that snapshot, so a canvas background is the page surface and a "bad" node is the same red as a "bad" badge (section 12). A theme switch repaints in place, keeping the camera and selection. There is no separate light/dark toggle on the UNS map.
* E2E: `e2e/routes.spec.js` runs every route in dark and in light, setting the preference through `localStorage` exactly as a user would. Playwright's `colorScheme` defaults to dark for the rest of the suite.

## 5. Type

* **UI face:** IBM Plex Sans (variable, `@fontsource-variable/ibm-plex-sans`), latin and latin-ext only. It was drawn for engineering software, has an open aperture at small sizes, distinct `Il1`, and is not the Inter of every template.
* **Data face:** IBM Plex Mono 400 and 500 (`@fontsource/ibm-plex-mono`, latin). Use it for topics, addresses, IDs, payloads and register values.
* Both are self-hosted and bundled by Vite (no CDN), which suits air-gapped plants. They add about 75 KB of woff2 on first visit (45.7 KB sans latin, 14.7 + 14.9 KB mono). latin-ext is only fetched if the page uses those characters.
* `font-variant-numeric: tabular-nums lining-nums` applies to every `table`, `.mono`, `.font-mono`, `.tabular-nums` and `[data-numeric]`. Add `tabular-nums` to any number that updates.

| Step | Class | Size / line | Use |
| --- | --- | --- | --- |
| 2xs | `text-2xs` | 11 / 16 | dense meta only (counts in chips, log source) |
| xs | `text-xs` | 12 / 16 | labels, table headers, helper text, mono values |
| sm | `text-sm` | 13 / 20 | **default UI text**, table cells, buttons |
| base | `text-base` | 14 / 22 | body default, dialog titles |
| lg | `text-lg` | 16 / 24 | page title (`h1`) |
| xl | `text-xl` | 20 / 28 | stat values |
| 2xl | `text-2xl` | 24 / 32 | hero numbers (rare); do not go larger |

Weights: 400 body, 500 labels, headings and values, 600 page title only. Never bold for emphasis in running text. Case: sentence case everywhere. `.overline` (11px, uppercase, 0.04em) is the one allowed uppercase style. It is reserved for group captions in very dense lists and is currently not used.

## 6. Space, shape, depth, motion

* **Spacing:** Tailwind's 4px scale. Use 1, 1.5, 2, 3, 4, 5 and 6 (4 to 24px). Panel padding is `p-4`, page gutter is `px-4 sm:px-6`, the vertical rhythm between page sections is `space-y-5`, label to control is 6px, and fields sit 12px apart.
* **Radii:** controls and chips 4px (`rounded`, `rounded-md`), panels and dialogs 6px (`rounded-lg`), dots and switches `rounded-full`. Larger radii (`rounded-xl` and up) do not exist in the theme.
* **Borders:** 1px. Use `border-line` for structure, `border-line-strong` for control outlines and overlays.
* **Depth:** surface steps only. `shadow-overlay` (a 1px outline plus a soft drop) is for menus, dialogs, drawers, tooltips and toasts. No other shadow utility exists, coloured shadow utilities are disabled and there is no blur.
* **Motion:** 120 to 180ms with `cubic-bezier(0.2,0,0,1)`. It applies only to colour on hover and state change, the dialog entrance (4px rise and fade), drawer slide (24px and fade), switch knob, tab underline and meter fill. Never animate decoration. `prefers-reduced-motion` reduces all of it to an instant change. Spinners are allowed. The ping halo is removed.

## 7. Components

Everything is imported from `@/components/ui` (`variant="outline"` is an alias of `secondary`, and `Badge status=` renders `StatusText`).

### Buttons

| Primitive | Spec | Rules |
| --- | --- | --- |
| `Button variant="primary"` | solid accent, `text-accent-fg`, 32px (`size="sm"` 28, `lg` 36), 4px radius, 500 weight | One per view: the action the page exists for. |
| `variant="secondary"` (= `outline`) | `bg-panel`, `border-line-strong`, hover `bg-raised` | Default for every other action. |
| `variant="ghost"` | text only, hover `bg-raised` | Toolbars, Cancel inside dense UI, dismiss. |
| `variant="subtle"` | `bg-raised` | Rare; toggled filters. |
| `variant="danger"` | `bg-danger text-danger-fg` | Only the confirm button of a destructive dialog. |
| `variant="danger-ghost"` | red text, hover tint | Inline destructive actions in a form. |
| `loading` | spinner, disabled, `aria-busy` | Use instead of disabling plus changing the label. |
| `ButtonLink` / `buttonClass()` | a router `<Link>` styled as a button | Navigation that looks like a button. Never nest a link in a button. |
| `IconButton` | 32px square, always has `label` (tooltip and aria-label), `active` for pressed tools | Row actions, toolbars. |

Do put the primary action last (right) in a header or footer. Don't place two primary buttons in one view, use an icon-only button without a label, or add a coloured shadow.

### Form controls

* `Field label help error`: a 12px medium muted label above the control (sentence case), helper text below, error in `text-bad` with `role="alert"`. The label element wraps the control, so it is the accessible name.
* `Input`, `Textarea`, `Select`: `bg-field`, `border-line-strong`, 32px tall. Focus is an accent border plus a 1px accent ring. Invalid uses `aria-invalid="true"` and gets a red border. Use `className="mono"` for hosts, ports, topics and IDs.
* `Checkbox`, `Radio`: native inputs with `accent-color` set to the accent. Group radios in a `<fieldset>` with a `<legend>`.
* `Toggle` (= `Switch`): `role="switch"`, 28×16 track, `control-off` grey to accent. Use it for settings that apply immediately. Use a checkbox for a choice that is submitted with a form.
* `SegmentedControl`: a radiogroup with arrow keys, for 2 to 5 mutually exclusive views or modes (Graph / 3D / Tree; 15m / 1h / 6h). The selected segment is `bg-raised` with an inset hairline.
* `Tabs` and `TabPanel`: tablist with arrow keys, Home and End, and a 2px accent underline. Use them for sibling sections of one object. Don't use tabs to switch between views of the same data; use `SegmentedControl` for that.
* Forms get a max width: dialogs `size="md"` (512px) or `lg` (672px), inline settings forms `max-w-2xl`. Two columns from `sm` up, one on phones.

### Display

* `Panel title count description actions flush`: a titled section with a 40px header row and a hairline under it. `flush` drops body padding for tables and lists. `Card` is the untitled surface. Don't nest panels; inside a panel, separate groups with a hairline or a 12px heading.
* `StatusDot tone|status size`: a decorative 8px dot (6px in dense meta). Always pair it with text.
* `StatusText status tone`: dot plus word. Text is `text-fg`, except bad (`text-bad`) and neutral (`text-muted`). `toneOf(status)` maps the vocabulary: connected, online, running → good; connecting, reconnecting, stale, degraded → warn; error, failed, fault, dead → bad; offline, disconnected, disabled, idle → neutral. Pass `tone="bad"` yourself when "offline" really means failing (for example a broker with `lastError`).
* `Badge`: a 20px label with a 4px radius, `bg-raised` and hairline, muted text (protocol, type, version). `tone` colours only the text. `Badge status=` renders `StatusText`, for compatibility.
* `Stat label value unit sub tone to` inside `StatGroup`: one strip of hairline-divided cells. The value is 20px, medium, tabular. `tone` puts a dot before the label. `to` makes the whole cell a link. Don't use icon tiles or more than one number per cell.
* `Meter value max warnAt badAt`: a 4px gauge with `role="meter"` (poll cycle against interval, queue fill, disk).
* `KeyValue items columns`: a definition list for object details.
* `Mono`, `Code`, `Kbd`, `Path`: `Path` truncates the **start** of a topic or asset path and keeps the leaf.
* `Timestamp value`: relative ("12 s ago") with the absolute time in the tooltip and `dateTime`. `relativeTime()` is the formatter.

### Feedback and overlays

* `Banner variant=info|success|warn|error title onRetry onDismiss action`: an inline alert with a hairline box, 2px state rule on the left, 6% tint and an icon. Errors use `role="alert"`, the rest `role="status"`.
* `EmptyState title hint action icon`: text first, one action. The icon is optional, 20px and faint, with no bubble.
* `Skeleton`, `LoadingState label rows` (`role="status" aria-busy`), `PageSkeleton`.
* `Tooltip label side`: shows on hover and focus. 12px text on `bg-overlay`. A closed tooltip is `display: none`, so it never widens a table's scroll area.
* `Dialog title description size onSubmit footer`: header (title, one-line description), scrolling body, footer with actions right-aligned (secondary, then primary). With `onSubmit` the body is a `<form>`, so Enter submits. The close button comes last in DOM order, so focus starts on the first field. Focus trap, Esc, backdrop click and focus restore come from `Modal`.
* `Drawer title side width actions footer`: a side sheet for details and secondary editing.
* `ConfirmDialog` and `useConfirm()`: focus starts on Cancel, and a destructive confirm uses `danger`.
* `Modal`: the low-level overlay for custom layouts. Prefer `Dialog` or `Drawer`.
* Toasts (react-hot-toast): `bg-overlay`, hairline, 6px radius, state-coloured icon. Use them only to confirm the result of a user action. Never use a toast for a persistent problem; use a `Banner` or the attention list instead.

### Tables

`Table caption` (a focusable, named scroll region), `THead`, `TableSort`, `Th sortKey hint align srOnly`, `Tr highlight`, `Td header align`, `RowActions`.

* Header: 32px, 12px medium muted, sentence case, no fill. The sort icon appears on hover or focus and is accent when the column is active.
* Rows: 8px vertical padding (about 36px), hairline between rows, hover tint at 3.5%, selected or edited row `highlight` (2px accent rule plus a 7% accent tint).
* Numbers are right-aligned and tabular. Mono for identifiers. The first cell is `Td header` (row header) holding the name, with the endpoint under it in mono `text-xs text-muted`.
* Row actions go last, as icon buttons with full labels ("Edit Plant broker").
* Wide tables set a `min-w-*` on `Table` and scroll inside their region on phones (Alerts and Devices switch to cards instead; see [Known issues](../KNOWN-ISSUES.md)).

### Layout primitives

`PageHeader title subtitle actions`, `PageBody`, `Toolbar`, `ToolbarDivider`.

## 8. Page patterns

**Page header.** One row, at least 56px: `h1` at 16px semibold, an optional one-line `subtitle` that states the current state ("1 of 2 connected") rather than a tagline, and actions on the right with the primary last. On phones the actions wrap under the title.

**List page** (reference: `Brokers.jsx`). Header with the primary "create" action, then the error `Banner` if any, then one of `LoadingState`, `EmptyState` inside a `Card`, or the sortable `Table`. Create and edit use the same `Dialog`; the row being edited is `highlight`ed. Delete goes through `useConfirm` with `danger`. Column order: name with endpoint, state with its reason, configuration, counters, last activity, errors (a link to the log), actions.

**Form dialog** (reference: the Brokers dialog). `Dialog size="lg" onSubmit`. Fields are grouped in `<fieldset>` with a `<legend>` at 13px medium. Advanced settings sit behind a disclosure button with `aria-expanded`, indented with a 2px `border-line` rule. Footer: Cancel (secondary), then the primary submit with `loading`.

**Detail or drawer.** `Drawer` for inspecting a row without leaving the list (`KeyValue` on top, then sections with 13px headings, actions in the footer). Use a full page only when the object has its own sub-navigation (tabs).


**Dashboard** (reference: `Overview.jsx`). Top to bottom: (1) **Needs attention**: a `Panel` list of what is wrong, worst first, each row linking to where it is fixed; when nothing is wrong it collapses to one line with a green dot. (2) Small sections with a 13px heading, each holding a `StatGroup` of `Stat`s with `to` links. (3) Two columns from `xl`: the connection table (problems first) and the latest values (`Path` and readable value with unit, raw payload in the tooltip). Don't use icon tiles, hero numbers or charts that only decorate.

**Canvas page** (Topics, UNS, Flows, Trends). One toolbar row under the header (`role="toolbar"`): a `SegmentedControl` for the view (Topics: Graph, 3D, Tree; UNS: Topology, Tree), then the controls of the current view, then toggles (`ToolToggle`). The canvas fills the rest of the body; nothing floats over its top edge. Floating chips that remain (the rate chip, the map key, zoom controls) are `FloatingBar`s: `bg-panel` (solid), `border-line`, 6px radius, `shadow-overlay`, inset 16px. Details open in a docked `SidePanel`, not over the canvas. The canvas follows the app theme; its style preset (Standard, Schematic, Monochrome) and layout are chosen under Settings.

**Detail drawer plus full-page form** (reference: `Devices.jsx`). A sortable, filterable table; clicking a row opens a `Drawer` with tabs (Overview, Tags, Probe); Edit opens a full-page form with a sticky section nav (Connection, Protocol options, Polling, Tags, Advanced) and a footer with Cancel and Save. Validation is shown inline after the first save attempt, never as toasts.

**Full-height editor** (reference: `tags/editor/MappingEditor.jsx`). A modal that fills the viewport: sticky section tabs that scroll to anchors (Mapping, What, Where, Tags, Context, Payload, Delivery, with a problem dot per section), the working sheet in one scrolling column, a live server preview in a docked column from `xl`, and a footer with Cancel and Save (Ctrl+S). Unsaved work asks before it is discarded (Esc, Cancel).

## 9. Data display rules

* **Numbers:** `toLocaleString()` with grouping, tabular, right-aligned in tables. Floats get at most 3 fraction digits for display (raw value in the tooltip). Rates use one decimal under 10 and none above ("7.2 msg/s", "48 msg/s").
* **Units:** always shown, in `text-subtle`, separated by a space ("500 ms", "103 kPa"). Never bare numbers for durations or sizes.
* **Ratios:** "1 / 2" with the meaning as the secondary line ("connected").
* **Timestamps:** `Timestamp` gives relative time, an absolute tooltip and `<time dateTime>`. Use absolute local time ("13:44:09") only in logs and charts.
* **Quality / state:** `StatusText`. OPC UA or Modbus quality reads Good, Uncertain or Bad, mapped to good, warn or bad. Mark stale values with `opacity-70` plus the word "Stale" in the tooltip; don't use a new colour.
* **Identifiers:** mono, `text-xs`. Topics and asset paths use `Path`, which keeps the leaf. Hosts are `host:port`, URLs `proto://host:port`.
* **Truncation:** single-line `truncate` with the full value in `title`, never wrapped mid-identifier. Error reasons in table cells are truncated with a tooltip; the full text is in the log.
* **Empty:** say what will appear and how to make it appear, with one action. **Loading:** skeleton shaped like the content, with `aria-busy`. **Error:** `Banner variant="error"` with what failed, the server message, and Retry.

## 10. Accessibility

* Visible focus everywhere: a 2px outline in `--focus` with a 2px offset (`:focus-visible`).
* Every icon-only control has a label (`IconButton` enforces it). Decorative icons have `aria-hidden`.
* State is never colour-only: dots are always paired with a word.
* Dialogs and drawers trap focus, close on Esc and restore focus. The mobile nav is a drawer whose first focus is "Close navigation menu".
* Contrast: AA for all text in both themes (section 3.4). `prefers-contrast: more` and `prefers-reduced-motion` are honoured.
* Accessible names and roles that tests and users rely on were kept (headings, "Open navigation menu", row headers, region names).

## 11. Candidates to promote to `components/ui`

Primitives built locally by pages that other pages already need or would reuse. None is promoted yet; each has one home today. Promote one to `components/ui` when a second page needs it.

| Component | File | What it is | Reuse |
| --- | --- | --- | --- |
| `SidePanel`, `PanelSection`, `FloatingBar`, `BarDivider`, `ToolToggle`, `PressedGroup`, `CanvasNote` | `client/src/components/CanvasChrome.jsx` | Docked detail panel and floating toolbar chrome for canvas pages | Topics, UNS, Flows, i3X |
| `EditorSection`, `SubHeading`, `ErrorText`, `MiniSwitch`, `OriginLabel`, `OverrideField`, `NumberInput`, `PatternInput`, `KeyValueEditor`, `TokenChip` | `client/src/pages/tags/editor/parts.jsx` | Editor-sheet parts: a titled anchor section, a field that shows where its value comes from (device, mapping, default) with a reset, a glob list input, a key/value editor with limits, an insertable placeholder chip | mapping editor only; `KeyValueEditor` and `OverrideField` would suit the device and profile tag forms |
| `FormField`, `FormSection`, `DescriptorField`, `DescriptorFields`, `PresetButtons`, `ExperimentalBadge`, `FromProfileBadge`, `cellCls` | `client/src/pages/devices/FormControls.jsx` | Forms rendered from a driver descriptor, presets as a segmented control, the Experimental badge | Devices, Profiles; the badge is also wanted by Discovery |
| `RowStatus`, `runSummary` | `client/src/pages/devices/RowStatus.jsx` | Per-row result and status text for bulk creation | Devices bulk, Discovery "add all" |
| `EffectiveTagsTable`, `LiveTagsTable`, `TagTable`, `BrowseTree` | `client/src/pages/devices/` | A windowed, keyboard-driven tag grid (paste, shift-select), a virtualised live table, a lazy tree | Devices; the mapping editor has its own `editor/TagTable.jsx` with the same ideas |
| `useRo`, `RowButtons`, `BrokerSelect`, `ListState`, `TabToolbar`, `HeadHint`, `Count` | `client/src/pages/pipelines/shared.jsx` | The list-tab pattern: read-only props, row action buttons, loading/empty/error states, a tab toolbar | Pipelines tabs; `ListState` duplicates what Devices and Brokers assemble by hand |
| `Section` | `client/src/pages/settings/Section.jsx` | A two-column settings row (label and help left, control right) | Settings |
| `AssetPicker` | `client/src/pages/tags/AssetPicker.jsx` | Lazy tree picker over the UNS branches | Tags; would suit Pipelines target topics |

`ReadOnlyNote` and `useReadOnly` (`components/ReadOnlyNote.jsx`) are already shared by every page that mutates.

## 12. Canvas rendering: tokens, the data palette and the style presets

**How a canvas reads tokens.** A canvas cannot use `rgb(var(--token))`. `client/src/graph/canvasTokens.js` reads these 20 custom properties from the computed style of `<html>` once per theme change, converts them to hex and caches a frozen snapshot (`getCanvasTokens()`, `useCanvasTokens()`): `bg panel raised overlay border border-strong border-stronger text text-muted text-subtle text-faint accent accent-text accent-fg good warn bad info aux control-off`. It refreshes on `<html data-theme|class|style>` mutations, `prefers-contrast`, `prefers-color-scheme` and `storage`. `FALLBACK_TOKENS` (first render, unit tests) mirrors `index.css`; `test/canvasTheme.test.js` fails if they drift. The faces are `FONT` (IBM Plex Sans Variable) and `MONO` (IBM Plex Mono), exported by the same module. Three theme objects are derived from the snapshot:

| Theme object | File | Used by | Highlights |
| --- | --- | --- | --- |
| `buildUnsTheme(tokens)` | `client/src/graph/unsTheme.js` | UNS map | background `bg`; dot grid a step from the surface; edges `border-stronger`, live edges and rates `good`; overdue values `warn`, dead values `bad`; selection `accent`; level rings from `levelPalette` |
| `resolveGraphStyle(id, tokens)` | `client/src/graph/graphStyles.js` | Topics 2D, WebGL and 3D | background `bg`; link colour a mix of `bg` and `border-stronger`; flow `good`; selected ring `accent`; labels `text-muted` with a `bg` halo; node palette below |
| `buildChartTheme(tokens)` | `client/src/components/chartTheme.js` | uPlot charts | surface `panel`; axis `text-subtle`; grid a mix of `panel` and `border-strong`; gaps `text-faint`; series from the data palette; 12px Plex |

**The data palette** (`client/src/graph/dataPalette.js`) is what DATA gets on every canvas; chrome colours come from the tokens. Ten categorical series per theme, one hue family per slot in both (blue, orange, violet, gold, teal, pink, sky, magenta, green, red), with the state-like hues last so ordinary charts of 1 to 7 series never show a "good green" or "bad red" line:

| Slot | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dark | `#81b7fc` | `#c56c0c` | `#9e7cf1` | `#bca422` | `#169b86` | `#d887ae` | `#9cdffe` | `#b55fba` | `#77b868` | `#fcc4bf` |
| light | `#0256a9` | `#b4620c` | `#8460d2` | `#4d4206` | `#0c4d42` | `#843b61` | `#14799c` | `#69126f` | `#4d8c3e` | `#b02a2d` |

Constraints, asserted in `test/canvasTheme.test.js`: every slot at least 3:1 against the canvas (WCAG 1.4.11); adjacent slots at least 7.5 CIEDE2000 apart for normal vision and simulated protanopia, deuteranopia and tritanopia; any two slots at least 7.5 apart in each of those views. Slots 5 to 9 are drawn dashed in charts (`SERIES_DASH`: solid for 0 to 4, then `[6,3]`, `[2,3]`, `[8,3,2,3]`, `[4,4]`, `[1,2]`), so identity never depends on hue alone. ISA-95 ring colours by depth (`levelPalette`): root `text-muted`, then series 0, 2, 4, 1, 6, and `text-subtle` for the deepest level; Sparkplug namespaces use series 7 and `$SYS` series 3.

**The three graph style presets** (Settings, Topic graph; stored as `tc.graphStyle`; the retired ids `constellation`, `aurora`, `neon`, `blueprint`, `circuit`, `slate` still resolve to the nearest one):

| Preset | Drawing language | Node colours (broker, server, branch, telemetry, data, command, config, alarm, Sparkplug) |
| --- | --- | --- |
| `standard` (default) | filled discs coloured by node group | `text`, `text`, `text-faint`, series 0, `text-muted`, series 1, series 2, series 5, series 7 |
| `schematic` | square nodes on a fine grid (28 px, `border-strong` at 55 to 60 % alpha) for reading structure | same palette as `standard` |
| `mono` (Monochrome) | neutral nodes; colour only for selection, search and flow | greys only (`text`, `text-subtle`, `text-muted`) |

All presets: link width 1, node radius 4 to 20, label font 400 12px, labels shown from zoom 0.75, `protocol` colours `{ mqtt: series 0, opcua: series 2, i3x: series 4 }`. Layout presets (`organic`, `spacious`, `tight`, `radial`, `tree`, `cluster`; stored as `tc.graphLayout`) are independent of the style.

**Resolved values** (from `FALLBACK` in `canvasTokens.js`). Dark: `bg #0f0f10`, `panel #161617`, `text #ececee`, `accent #2cc5cf`, `good #3fc184`, `warn #e3a33a`, `bad #f06a63`, `info #6aa6f8`, `aux #b39af5`. Light: `bg #f6f6f7`, `panel #ffffff`, `text #17171a`, `accent #00747d`, `good #137a48`, `warn #975a00`, `bad #c4282e`, `info #1f5fc2`, `aux #6b47c9`.
