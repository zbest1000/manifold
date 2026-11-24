# Manifold UI design system

Status: foundation implemented (tokens, themes, primitives, shell, compatibility layer). Reference pages: `client/src/pages/Overview.jsx` (dashboard) and `client/src/pages/Brokers.jsx` (list + form dialog). Every other page still runs on the compatibility layer and should be migrated with the guide at the end of this document.

Files:

| What | Where |
| --- | --- |
| Tokens (both themes), fonts, base styles, compatibility rules | `client/src/index.css` |
| Tailwind mapping of tokens and legacy colour names | `client/tailwind.config.js` |
| Theme before first paint | `client/public/theme-init.js` (loaded from `client/index.html`) |
| Theme at runtime (`useTheme`, `setThemePreference`) | `client/src/lib/theme.js` |
| Primitives (import from `@/components/ui`) | `client/src/components/ui/*.jsx`, re-exported by `client/src/components/ui.jsx` |
| Shell | `client/src/components/Layout.jsx`, `PageHeader.jsx`, `ErrorLog.jsx` |

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

## 2. What was removed (the generated look)

Observed in the before screenshots of every route, dark only. Each item lists its replacement:

| Anti-pattern (before) | Where it showed | Now |
| --- | --- | --- |
| Navy-black page (`#0a0f1c`) with sky-blue accents and blue-tinted slate greys | everywhere | Pure graphite neutrals with a teal accent used sparingly |
| Gradient icon tiles (sky / violet / amber / emerald squares with coloured shadows) on stat cards | Overview, I3x, Cesmii | `Stat` (label, number, unit, secondary line) in a `StatGroup` strip. Legacy tiles are neutralised to a quiet raised square |
| Glowing primary buttons (`bg-sky-700 shadow-lg shadow-sky-700/20`) and gradient brand tile | every header, sidebar brand | Solid accent button, no shadow. The brand is a flat monochrome mark |
| `rounded-2xl` translucent glass cards (`bg-surface-900/60 backdrop-blur border-white/5` plus a double shadow) nested inside each other | all panels | `Panel` / `Card`: 8px radius, 1px `border-line`, solid `bg-panel` |
| Pills for everything: status pills with tinted fill and ring, count pills, level pills | badges, log, tables | `StatusText` (dot + word) for state. `Badge` is a small square-cornered label |
| Uppercase letter-spaced micro-labels on every field, card title and table header | forms, System, Tags, tables | Sentence-case 12px medium labels. Uppercase survives only as `.overline`, used sparingly |
| A decorative icon in front of every heading ("Process health", "Recent messages") | panels | Plain headings |
| Generous padding and low density (28px card padding, 44px icon tiles, 40px nav rows) | everywhere | 16px panel padding, 32px nav rows, 32px controls |
| Ping halo on every connected dot, pulsing everything | status | Static dots. Motion only for state changes |
| Generic copy ("Live snapshot of your brokers, OPC UA servers and devices") | headers | Specific copy, or no subtitle |

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
* The switch is in the sidebar footer: a three-button group (system, light, dark). When the sidebar is collapsed it is one button that cycles.
* Graph canvases (Topics, UNS) keep their own style pickers. A dark canvas inside the light theme is intended. The floating chips over a canvas get a solid panel background in light so their text stays readable.
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
| 2xl | `text-2xl` | 24 / 32 | hero numbers (rare). `text-3xl` is capped here |

Weights: 400 body, 500 labels, headings and values, 600 page title only. Never bold for emphasis in running text. Case: sentence case everywhere. `.overline` (11px, uppercase, 0.04em) is the one allowed uppercase style. It is reserved for group captions in very dense lists and is currently not used.

## 6. Space, shape, depth, motion

* **Spacing:** Tailwind's 4px scale. Use 1, 1.5, 2, 3, 4, 5 and 6 (4 to 24px). Panel padding is `p-4`, page gutter is `px-4 sm:px-6`, the vertical rhythm between page sections is `space-y-5`, label to control is 6px, and fields sit 12px apart.
* **Radii:** controls 6px (`rounded-md`), chips and badges 4px (`rounded`), panels and dialogs 8px (`rounded-lg`), dots and switches `rounded-full`. Legacy `rounded-xl` maps to 6px and `rounded-2xl`/`3xl` to 8px.
* **Borders:** 1px. Use `border-line` for structure, `border-line-strong` for control outlines and overlays.
* **Depth:** surface steps only. `shadow-overlay` (a 1px outline plus a soft drop) is for menus, dialogs, drawers, tooltips and toasts. Legacy `shadow-sm`/`shadow` are none, `md` to `2xl` equal the overlay shadow, coloured shadow utilities are disabled, and `backdrop-blur` is off.
* **Motion:** 120 to 180ms with `cubic-bezier(0.2,0,0,1)`. It applies only to colour on hover and state change, the dialog entrance (4px rise and fade), drawer slide (24px and fade), switch knob, tab underline and meter fill. Never animate decoration. `prefers-reduced-motion` reduces all of it to an instant change. Spinners are allowed. The ping halo is removed.

## 7. Components

Everything is imported from `@/components/ui`. All legacy exports and props still work.

### Buttons

| Primitive | Spec | Rules |
| --- | --- | --- |
| `Button variant="primary"` | solid accent, `text-accent-fg`, 32px (`size="sm"` 28, `lg` 36), 6px radius, 500 weight | One per view: the action the page exists for. |
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
* `Tooltip label side`: shows on hover and focus. 12px text on `bg-overlay`. Hidden tooltips are `visibility:hidden` so they never cause overflow.
* `Dialog title description size onSubmit footer`: header (title, one-line description), scrolling body, footer with actions right-aligned (secondary, then primary). With `onSubmit` the body is a `<form>`, so Enter submits. The close button comes last in DOM order, so focus starts on the first field. Focus trap, Esc, backdrop click and focus restore come from `Modal`.
* `Drawer title side width actions footer`: a side sheet for details and secondary editing.
* `ConfirmDialog` and `useConfirm()`: focus starts on Cancel, and a destructive confirm uses `danger`.
* `Modal`: the low-level overlay for custom layouts. Prefer `Dialog` or `Drawer`.
* Toasts (react-hot-toast): `bg-overlay`, hairline, 6px radius, state-coloured icon. Use them only to confirm the result of a user action. Never use a toast for a persistent problem; use a `Banner` or the attention list instead.

### Tables

`Table caption` (a focusable, named scroll region), `THead`, `TableSort`, `Th sortKey align srOnly`, `Tr highlight`, `Td header align`, `RowActions`.

* Header: 32px, 12px medium muted, sentence case, no fill. The sort icon appears on hover or focus and is accent when the column is active.
* Rows: 8px vertical padding (about 36px), hairline between rows, hover tint at 3.5%, selected or edited row `highlight` (2px accent rule plus a 7% accent tint).
* Numbers are right-aligned and tabular. Mono for identifiers. The first cell is `Td header` (row header) holding the name, with the endpoint under it in mono `text-xs text-muted`.
* Row actions go last, as icon buttons with full labels ("Edit Plant broker").
* Wide tables set a `min-w-*` on `Table` and scroll inside their region on phones.

### Layout primitives

`PageHeader title subtitle actions`, `PageBody`, `Toolbar`, `ToolbarDivider`.

## 8. Page patterns

**Page header.** One row, at least 56px: `h1` at 16px semibold, an optional one-line `subtitle` that states the current state ("1 of 2 connected") rather than a tagline, and actions on the right with the primary last. On phones the actions wrap under the title.

**List page** (reference: `Brokers.jsx`). Header with the primary "create" action, then the error `Banner` if any, then one of `LoadingState`, `EmptyState` inside a `Card`, or the sortable `Table`. Create and edit use the same `Dialog`; the row being edited is `highlight`ed. Delete goes through `useConfirm` with `danger`. Column order: name with endpoint, state with its reason, configuration, counters, last activity, errors (a link to the log), actions.

**Form dialog** (reference: the Brokers dialog). `Dialog size="lg" onSubmit`. Fields are grouped in `<fieldset>` with a `<legend>` at 13px medium. Advanced settings sit behind a disclosure button with `aria-expanded`, indented with a 2px `border-line` rule. Footer: Cancel (secondary), then the primary submit with `loading`.

**Detail or drawer.** `Drawer` for inspecting a row without leaving the list (`KeyValue` on top, then sections with 13px headings, actions in the footer). Use a full page only when the object has its own sub-navigation (tabs).

**Wizard.** A `Dialog size="lg"`. A step indicator in the header area (numbered text such as "1 Target · 2 Naming · 3 Options", current step `text-fg`, others `text-subtle`, done steps with a check), the body as a `role="region"` named after the step, and a footer with Back (secondary), then Next or Create (primary). Validate on Next and show errors inline in `Field error`, never as toasts.

**Dashboard** (reference: `Overview.jsx`). Top to bottom: (1) **Needs attention**: a `Panel` list of what is wrong, worst first, each row linking to where it is fixed; when nothing is wrong it collapses to one line with a green dot. (2) Small sections with a 13px heading, each holding a `StatGroup` of `Stat`s with `to` links. (3) Two columns from `xl`: the connection table (problems first) and the latest values (`Path` and readable value with unit, raw payload in the tooltip). Don't use icon tiles, hero numbers or charts that only decorate.

**Canvas page with floating toolbars** (Topics, UNS). The canvas fills the page body under the header. Floating controls are `bg-panel` (solid), `border-line`, 6px radius, `shadow-overlay`, inset 16px from the edges. Group them by job (view, display, export) with `ToolbarDivider` and use `SegmentedControl` for modes. Each canvas keeps its own style picker; it does not follow the app theme.

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

## 11. Compatibility layer: what un-migrated pages get

Done in `tailwind.config.js` and the "Compatibility layer" block of `index.css`, with no page edits:

| Legacy | Mapped to |
| --- | --- |
| `bg-surface-950` / `900` / `800` (any `/opacity`) | solid `--bg` / `--panel` / `--raised`. Opacity is ignored, so glass becomes a solid layer |
| `text-slate-50…950`, `gray`, `zinc` | themed neutral text scale: in dark 100 = fg, 400 = muted, 500 = subtle, 600 = faint; in light 100–300 become dark text and 700–900 stay dark |
| `bg-slate-*`, `border-slate-*`, `ring-slate-*` | fixed neutral greys (no blue), the same in both themes |
| `bg-white/x` | under 50%: a foreground tint (white in dark, near-black in light) so hovers stay visible on white; 50% and up: real white |
| `border-white/x`, `divide-white/x`, `ring-white/x` | up to 12% → `--border`, up to 22% → `--border-strong`, above → `--border-stronger` (hairlines never vanish on white) |
| `bg-black/x` | a well shade, about 4.5 times lighter in light |
| `rose` / `red` / `pink` | `bad` scale; `amber` / `yellow` / `orange` → `warn`; `emerald` / `green` / `lime` → `good`; `sky` / `blue` / `indigo` → `info`; `teal` / `cyan` → accent; `violet` / `purple` / `fuchsia` → a muted violet `aux` |
| …the 100–400 text shades of those | light pastels in dark, dark AA shades in light (every shade at least 4.6:1 on panel and raised) |
| `accent-100…950` | themed accent scale (300/400 = accent-text in light) |
| `accent-sky-500` etc. (native checkbox colour) | accent |
| `rounded-xl`, `rounded-2xl` | 6px and 8px |
| `shadow-lg` etc., `shadow-<colour>/x` | overlay shadow only; coloured shadows removed |
| `backdrop-blur*` | off (and the floating canvas chips get a solid panel in light) |
| `bg-gradient-to-*` tiles | flat raised square, hairline, muted icon |
| `.uppercase.tracking-wide` (and wider, widest, `[0.06em]`) | sentence case, normal tracking |
| `.label-xs` | 12px medium muted sentence case |
| `hover:text-white` | `text-fg` on hover in light |
| `text-[10px]`, `text-[9px]` | 11px |
| `animate-ping` | removed |
| uPlot legend, tooltip and cursor | tokens |

## 12. Migration guide (mechanical)

Do one page at a time. Replace patterns top-down using the table, then check the page in both themes at 1440 and 390 (`npm run build`, then the e2e routes spec). Never introduce raw palette classes (`slate-`, `sky-`, `rose-`, `white/`, `surface-`) in new code; `grep -nE "(slate|sky|rose|amber|emerald|surface|white/|black/)" <file>` should come back empty when a page is done.

### Surfaces and structure

| Old | New |
| --- | --- |
| `<Card className="p-5">` + `<h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200"><Icon/> Title</h2>` | `<Panel title="Title">` (no icon) |
| `rounded-2xl border border-white/5 bg-surface-900/60 backdrop-blur …` | `<Panel>` / `<Card>` or `rounded-lg border border-line bg-panel` |
| A card nested in a card (`rounded-xl border-white/5 bg-white/[0.02] p-3` inside a Card) | rows separated by `divide-y divide-line`, or a `KeyValue`, or a `StatGroup` |
| `rounded-xl border border-white/5 bg-surface-950/40 p-4` (advanced section) | `border-l-2 border-line pl-4`, or a sub-`Panel` without nesting |
| `bg-surface-950` / `bg-surface-900` / `bg-surface-800` | `bg-app` / `bg-panel` / `bg-raised` |
| `bg-surface-900/85 backdrop-blur` (floating toolbar) | `bg-panel border border-line shadow-overlay rounded-md` |
| `border-white/5`, `border-white/10` | `border-line` |
| `border-white/20`, `hover:border-white/20` | `border-line-strong`, `hover:border-line-stronger` |
| `divide-white/5` | `divide-line` |
| `bg-white/5`, `hover:bg-white/5` | `bg-raised`, `hover:bg-raised` |
| `bg-white/[0.02]` row fill | remove (rows are separated by hairlines) |
| `bg-black/20` well | `bg-app` (or `bg-raised` inside an overlay) |
| `p-5`, `p-6` in panels | `p-4`, or `Panel` default |
| `space-y-6` between sections | `space-y-5` |

### Text

| Old | New |
| --- | --- |
| `text-slate-100`, `text-slate-200`, `text-white` (on surfaces) | `text-fg` |
| `text-slate-300` | `text-fg` (values) or `text-muted` (secondary) |
| `text-slate-400`, `text-muted` | `text-muted` |
| `text-slate-500`, `helper` | `text-subtle` / `helper` |
| `text-slate-600` | `text-faint` |
| `text-xs font-semibold uppercase tracking-wide text-slate-400` | `text-xs font-medium text-muted` (label), or a `Panel` title / 13px `h2` |
| `label-xs` on a `Th` | nothing: `Th` already has the style |
| `text-accent-300`, `text-accent-400`, `text-sky-300` (links, selected) | `text-accent-text` |
| `text-xl font-semibold` inside a page body | `text-lg font-semibold` is reserved for the page `h1`; section headings are `text-sm font-medium` |
| `text-3xl font-semibold` stat number | `<Stat value=…>` (20px) |
| `mono` | keep `mono`, add `text-xs` for identifiers |

### State

| Old | New |
| --- | --- |
| `<Badge status={s} />` | `<StatusText status={s} />` (Badge still works) |
| `bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30 rounded-full px-2` (status pill) | `<StatusText tone="good">online</StatusText>` |
| `bg-white/5 text-slate-300 ring-1 ring-white/10 rounded-full` (label pill) | `<Badge>Modbus TCP</Badge>` |
| `text-rose-300`, `text-red-400` (error text) | `text-bad` |
| `text-amber-300` | `text-warn` |
| `text-emerald-300`, `text-emerald-400` | `text-good` |
| `text-sky-300` (notice) | `text-info` |
| `rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-rose-200` + retry button | `<Banner variant="error" title onRetry>` |
| `border-sky-500/30 bg-sky-500/10 text-sky-100` notice `<p>` | `<Banner variant="info">` |
| `border-amber-500/30 bg-amber-500/10 text-amber-200` | `<Banner variant="warn">` |
| `h-2 w-2 rounded-full bg-emerald-400` | `<StatusDot tone="good" />` |
| `hover:bg-rose-500/10 hover:text-rose-300` on a delete icon | `hover:bg-bad/10 hover:text-bad` (or `RowActions`) |

### Controls

| Old | New |
| --- | --- |
| `<Button>` with `shadow-*` or `bg-sky-*` classes | `<Button>` (variant only) |
| More than one `<Button>` (primary) in a view | keep one primary, the rest `variant="secondary"` |
| `variant="outline"` | `variant="secondary"` (outline is an alias) |
| `<Link to=…><Button>…</Button></Link>` | `<ButtonLink to=… variant=…>` |
| A button showing "Saving…" with `disabled={busy}` | `<Button loading={busy}>Save</Button>` |
| Hand-rolled tabs (`bg-accent-500/15 ring-1 …` on the active button) | `<Tabs>` + `<TabPanel>` (sections) or `<SegmentedControl>` (views/modes) |
| A row of toggle buttons for ranges (15m / 1h / …) | `<SegmentedControl size="sm">` |
| Native `<select className={selectClass}>` | `<Select label=…>` (or `aria-label`) |
| `accent-sky-500` checkbox | `<Checkbox>` |
| Inline create/edit form card toggled by a header button | `<Dialog onSubmit footer>` (see Brokers) |
| `fixed inset-0` overlay div | `<Dialog>` / `<Drawer>` / `<Modal>` |

### Data

| Old | New |
| --- | --- |
| Gradient icon tile + number + label card | `<Stat label value unit sub to tone>` inside `<StatGroup className="grid-cols-2 xl:grid-cols-4">` |
| `<Card>` with "UPTIME" micro-label + value + sparkline placeholder | `<Stat>`; put the sparkline under the value if it is real data |
| `formatDistanceToNow(…)` in a cell | `<Timestamp value={…} />` |
| Truncated topic `truncate mono` | `<Path value={topic} />` |
| `{n}` counters | `{n.toLocaleString()}` in a `tabular-nums` cell, right-aligned |
| Poll-cycle bar (`h-1.5 rounded-full bg-white/10` + inner `bg-emerald-500`) | `<Meter value={avgMs} max={intervalMs} warnAt={0.8} badAt={1} label="Poll cycle" />` |
| Icon bubble empty state | `<EmptyState title hint action>` |

## 13. Known gaps on un-migrated pages

The compatibility layer makes them coherent in both themes (verified at 1440 and 390, dark and light). These issues remain until each page is migrated:

* **Topics / UNS:** the canvas keeps its own (dark) style in the light theme by design. Toolbars are hand-rolled clusters with "Display / View / Export" captions; migrate them to `Toolbar` + `SegmentedControl`. The UNS canvas labels ("UNIFIED NAMESPACE") are drawn in `graph/` in uppercase.
* **Devices:** cards use pill-ish chips ("Connects 1", "Requests 1905") and an inline poll bar; migrate to `KeyValue` / `Meter`, and consider a table layout. Several primary buttons appear in one header (Refresh / From profile / Add device), where only Add device should be primary.
* **System:** nested cards with dashed sparkline placeholders and icons before every heading. Should become `Panel` + `StatGroup`.
* **Flows / Settings / Tags / Trends / Pipelines / OPC UA / I3x / Cesmii / Discovery:** icons before panel headings; hand-rolled tabs and segments using accent tints (Flows tabs, Pipelines tabs, Trends sources); inline info boxes that should be `Banner`; more than one primary button per view (Discovery: "Start scan", "Scan", "Start a network scan"); Trends subtitle is lowercase copy; the Settings graph-style picker shows the canvas palettes (correct, they are data).
* **Charts** (`charts.jsx`, `TrendChart.jsx`): series colours and axis grey are hard-coded for dark. The axis labels (`#7c8aa0`) are about 3.5:1 on white; give the chart a theme-aware axis colour when charts are next touched.
