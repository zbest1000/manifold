'use strict';

/**
 * Curated industrial icon subset — the icons a UNS actually uses, imported
 * INDIVIDUALLY from `lucide-react` (the one icon package the app uses for both
 * React components and this canvas drawing). Each icon module exports its raw
 * IconNode as `__iconNode`, so the bundle carries just these ~130 arrays
 * instead of the ~2,000-icon library.
 *
 * Keys are kebab-case lucide names, matching what the picker persists and the
 * renderer resolves. Every name referenced by unsIcons.js's KEYWORD_ICONS and
 * LEVEL_ICONS tables is included, so automatic mapping never needs the full
 * library. The full set stays available via unsIcons.loadFullLibrary().
 */

// Facilities & structure
import { __iconNode as Factory } from 'lucide-react/dist/esm/icons/factory.mjs';
import { __iconNode as Warehouse } from 'lucide-react/dist/esm/icons/warehouse.mjs';
import { __iconNode as Building } from 'lucide-react/dist/esm/icons/building.mjs';
import { __iconNode as Building2 } from 'lucide-react/dist/esm/icons/building-2.mjs';
import { __iconNode as Network } from 'lucide-react/dist/esm/icons/network.mjs';
import { __iconNode as LayoutGrid } from 'lucide-react/dist/esm/icons/layout-grid.mjs';
import { __iconNode as Rows3 } from 'lucide-react/dist/esm/icons/rows-3.mjs';
import { __iconNode as Component } from 'lucide-react/dist/esm/icons/component.mjs';
import { __iconNode as CircleDot } from 'lucide-react/dist/esm/icons/circle-dot.mjs';
// Mechanical & maintenance
import { __iconNode as Cog } from 'lucide-react/dist/esm/icons/cog.mjs';
import { __iconNode as Settings } from 'lucide-react/dist/esm/icons/settings.mjs';
import { __iconNode as Wrench } from 'lucide-react/dist/esm/icons/wrench.mjs';
import { __iconNode as Hammer } from 'lucide-react/dist/esm/icons/hammer.mjs';
import { __iconNode as HardHat } from 'lucide-react/dist/esm/icons/hard-hat.mjs';
import { __iconNode as Construction } from 'lucide-react/dist/esm/icons/construction.mjs';
// Measurement & time
import { __iconNode as Gauge } from 'lucide-react/dist/esm/icons/gauge.mjs';
import { __iconNode as CircleGauge } from 'lucide-react/dist/esm/icons/circle-gauge.mjs';
import { __iconNode as Thermometer } from 'lucide-react/dist/esm/icons/thermometer.mjs';
import { __iconNode as Weight } from 'lucide-react/dist/esm/icons/weight.mjs';
import { __iconNode as Scale } from 'lucide-react/dist/esm/icons/scale.mjs';
import { __iconNode as Timer } from 'lucide-react/dist/esm/icons/timer.mjs';
import { __iconNode as Clock } from 'lucide-react/dist/esm/icons/clock.mjs';
import { __iconNode as Calendar } from 'lucide-react/dist/esm/icons/calendar.mjs';
import { __iconNode as Activity } from 'lucide-react/dist/esm/icons/activity.mjs';
import { __iconNode as AudioWaveform } from 'lucide-react/dist/esm/icons/audio-waveform.mjs';
import { __iconNode as Waves } from 'lucide-react/dist/esm/icons/waves-horizontal.mjs';
import { __iconNode as Hash } from 'lucide-react/dist/esm/icons/hash.mjs';
// Fluids, air & heat
import { __iconNode as Droplet } from 'lucide-react/dist/esm/icons/droplet.mjs';
import { __iconNode as Droplets } from 'lucide-react/dist/esm/icons/droplets.mjs';
import { __iconNode as Wind } from 'lucide-react/dist/esm/icons/wind.mjs';
import { __iconNode as Fan } from 'lucide-react/dist/esm/icons/fan.mjs';
import { __iconNode as Flame } from 'lucide-react/dist/esm/icons/flame.mjs';
import { __iconNode as Snowflake } from 'lucide-react/dist/esm/icons/snowflake.mjs';
import { __iconNode as Sun } from 'lucide-react/dist/esm/icons/sun.mjs';
import { __iconNode as Cloud } from 'lucide-react/dist/esm/icons/cloud.mjs';
import { __iconNode as Heater } from 'lucide-react/dist/esm/icons/heater.mjs';
import { __iconNode as AirVent } from 'lucide-react/dist/esm/icons/air-vent.mjs';
import { __iconNode as Pipette } from 'lucide-react/dist/esm/icons/pipette.mjs';
import { __iconNode as Cylinder } from 'lucide-react/dist/esm/icons/cylinder.mjs';
// Power & energy
import { __iconNode as Zap } from 'lucide-react/dist/esm/icons/zap.mjs';
import { __iconNode as Plug } from 'lucide-react/dist/esm/icons/plug.mjs';
import { __iconNode as PlugZap } from 'lucide-react/dist/esm/icons/plug-zap.mjs';
import { __iconNode as Battery } from 'lucide-react/dist/esm/icons/battery.mjs';
import { __iconNode as BatteryCharging } from 'lucide-react/dist/esm/icons/battery-charging.mjs';
import { __iconNode as Fuel } from 'lucide-react/dist/esm/icons/fuel.mjs';
import { __iconNode as Power } from 'lucide-react/dist/esm/icons/power.mjs';
// Compute & connectivity
import { __iconNode as Cpu } from 'lucide-react/dist/esm/icons/cpu.mjs';
import { __iconNode as CircuitBoard } from 'lucide-react/dist/esm/icons/circuit-board.mjs';
import { __iconNode as Microchip } from 'lucide-react/dist/esm/icons/microchip.mjs';
import { __iconNode as Server } from 'lucide-react/dist/esm/icons/server.mjs';
import { __iconNode as Database } from 'lucide-react/dist/esm/icons/database.mjs';
import { __iconNode as HardDrive } from 'lucide-react/dist/esm/icons/hard-drive.mjs';
import { __iconNode as Radio } from 'lucide-react/dist/esm/icons/radio.mjs';
import { __iconNode as RadioTower } from 'lucide-react/dist/esm/icons/radio-tower.mjs';
import { __iconNode as Wifi } from 'lucide-react/dist/esm/icons/wifi.mjs';
import { __iconNode as Antenna } from 'lucide-react/dist/esm/icons/antenna.mjs';
import { __iconNode as Router } from 'lucide-react/dist/esm/icons/router.mjs';
import { __iconNode as SatelliteDish } from 'lucide-react/dist/esm/icons/satellite-dish.mjs';
import { __iconNode as Cable } from 'lucide-react/dist/esm/icons/cable.mjs';
import { __iconNode as Barcode } from 'lucide-react/dist/esm/icons/barcode.mjs';
// Robotics, logistics & transport
import { __iconNode as Bot } from 'lucide-react/dist/esm/icons/bot.mjs';
import { __iconNode as MoveHorizontal } from 'lucide-react/dist/esm/icons/move-horizontal.mjs';
import { __iconNode as Truck } from 'lucide-react/dist/esm/icons/truck.mjs';
import { __iconNode as Forklift } from 'lucide-react/dist/esm/icons/forklift.mjs';
import { __iconNode as Ship } from 'lucide-react/dist/esm/icons/ship.mjs';
import { __iconNode as Package } from 'lucide-react/dist/esm/icons/package.mjs';
import { __iconNode as Boxes } from 'lucide-react/dist/esm/icons/boxes.mjs';
import { __iconNode as Container } from 'lucide-react/dist/esm/icons/container.mjs';
// Lab & quality
import { __iconNode as FlaskConical } from 'lucide-react/dist/esm/icons/flask-conical.mjs';
import { __iconNode as Beaker } from 'lucide-react/dist/esm/icons/beaker.mjs';
import { __iconNode as TestTube } from 'lucide-react/dist/esm/icons/test-tube.mjs';
import { __iconNode as Microscope } from 'lucide-react/dist/esm/icons/microscope.mjs';
import { __iconNode as BadgeCheck } from 'lucide-react/dist/esm/icons/badge-check.mjs';
import { __iconNode as Radiation } from 'lucide-react/dist/esm/icons/radiation.mjs';
import { __iconNode as Recycle } from 'lucide-react/dist/esm/icons/recycle.mjs';
// Pipelines & flow
import { __iconNode as GitBranch } from 'lucide-react/dist/esm/icons/git-branch.mjs';
import { __iconNode as GitMerge } from 'lucide-react/dist/esm/icons/git-merge.mjs';
import { __iconNode as Workflow } from 'lucide-react/dist/esm/icons/workflow.mjs';
import { __iconNode as Filter } from 'lucide-react/dist/esm/icons/funnel.mjs';
import { __iconNode as Target } from 'lucide-react/dist/esm/icons/target.mjs';
// Safety & security
import { __iconNode as Siren } from 'lucide-react/dist/esm/icons/siren.mjs';
import { __iconNode as Bell } from 'lucide-react/dist/esm/icons/bell.mjs';
import { __iconNode as AlarmClock } from 'lucide-react/dist/esm/icons/alarm-clock.mjs';
import { __iconNode as Shield } from 'lucide-react/dist/esm/icons/shield.mjs';
import { __iconNode as ShieldCheck } from 'lucide-react/dist/esm/icons/shield-check.mjs';
import { __iconNode as ShieldAlert } from 'lucide-react/dist/esm/icons/shield-alert.mjs';
import { __iconNode as Lock } from 'lucide-react/dist/esm/icons/lock.mjs';
import { __iconNode as Eye } from 'lucide-react/dist/esm/icons/eye.mjs';
import { __iconNode as Camera } from 'lucide-react/dist/esm/icons/camera.mjs';
import { __iconNode as ScanLine } from 'lucide-react/dist/esm/icons/scan-line.mjs';
import { __iconNode as FireExtinguisher } from 'lucide-react/dist/esm/icons/fire-extinguisher.mjs';
// Location & layout
import { __iconNode as MapPin } from 'lucide-react/dist/esm/icons/map-pin.mjs';
import { __iconNode as Layers } from 'lucide-react/dist/esm/icons/layers.mjs';
import { __iconNode as Grid3x3 } from 'lucide-react/dist/esm/icons/grid-3x3.mjs';
// Charts & trends
import { __iconNode as ChartLine } from 'lucide-react/dist/esm/icons/chart-line.mjs';
import { __iconNode as ChartColumn } from 'lucide-react/dist/esm/icons/chart-column.mjs';
import { __iconNode as ChartBar } from 'lucide-react/dist/esm/icons/chart-bar.mjs';
import { __iconNode as ChartPie } from 'lucide-react/dist/esm/icons/chart-pie.mjs';
import { __iconNode as TrendingUp } from 'lucide-react/dist/esm/icons/trending-up.mjs';
import { __iconNode as TrendingDown } from 'lucide-react/dist/esm/icons/trending-down.mjs';
import { __iconNode as BarChart3 } from 'lucide-react/dist/esm/icons/chart-column.mjs';
// Arrows & actions
import { __iconNode as ArrowUp } from 'lucide-react/dist/esm/icons/arrow-up.mjs';
import { __iconNode as ArrowDown } from 'lucide-react/dist/esm/icons/arrow-down.mjs';
import { __iconNode as ArrowLeft } from 'lucide-react/dist/esm/icons/arrow-left.mjs';
import { __iconNode as ArrowRight } from 'lucide-react/dist/esm/icons/arrow-right.mjs';
import { __iconNode as ArrowUpDown } from 'lucide-react/dist/esm/icons/arrow-up-down.mjs';
import { __iconNode as ArrowLeftRight } from 'lucide-react/dist/esm/icons/arrow-left-right.mjs';
import { __iconNode as RefreshCw } from 'lucide-react/dist/esm/icons/refresh-cw.mjs';
import { __iconNode as SlidersHorizontal } from 'lucide-react/dist/esm/icons/sliders-horizontal.mjs';
import { __iconNode as SlidersVertical } from 'lucide-react/dist/esm/icons/sliders-vertical.mjs';
// Organization & documents
import { __iconNode as Tag } from 'lucide-react/dist/esm/icons/tag.mjs';
import { __iconNode as Bookmark } from 'lucide-react/dist/esm/icons/bookmark.mjs';
import { __iconNode as Folder } from 'lucide-react/dist/esm/icons/folder.mjs';
import { __iconNode as FileText } from 'lucide-react/dist/esm/icons/file-text.mjs';
import { __iconNode as Clipboard } from 'lucide-react/dist/esm/icons/clipboard.mjs';
import { __iconNode as ClipboardList } from 'lucide-react/dist/esm/icons/clipboard-list.mjs';
import { __iconNode as Briefcase } from 'lucide-react/dist/esm/icons/briefcase.mjs';
import { __iconNode as Blocks } from 'lucide-react/dist/esm/icons/blocks.mjs';
import { __iconNode as Users } from 'lucide-react/dist/esm/icons/users.mjs';
// Status & flags
import { __iconNode as Check } from 'lucide-react/dist/esm/icons/check.mjs';
import { __iconNode as CircleCheck } from 'lucide-react/dist/esm/icons/circle-check.mjs';
import { __iconNode as X } from 'lucide-react/dist/esm/icons/x.mjs';
import { __iconNode as CircleX } from 'lucide-react/dist/esm/icons/circle-x.mjs';
import { __iconNode as TriangleAlert } from 'lucide-react/dist/esm/icons/triangle-alert.mjs';
import { __iconNode as CircleAlert } from 'lucide-react/dist/esm/icons/circle-alert.mjs';
import { __iconNode as OctagonAlert } from 'lucide-react/dist/esm/icons/octagon-alert.mjs';
import { __iconNode as Info } from 'lucide-react/dist/esm/icons/info.mjs';
// Misc plant floor
import { __iconNode as Lightbulb } from 'lucide-react/dist/esm/icons/lightbulb.mjs';
import { __iconNode as DoorOpen } from 'lucide-react/dist/esm/icons/door-open.mjs';
import { __iconNode as Printer } from 'lucide-react/dist/esm/icons/printer.mjs';
import { __iconNode as Stamp } from 'lucide-react/dist/esm/icons/stamp.mjs';
import { __iconNode as Blend } from 'lucide-react/dist/esm/icons/blend.mjs';

/** kebab-case lucide name → IconNode ([[tag, attrs], ...]) */
export const CURATED_ICONS = new Map([
  ['factory', Factory], ['warehouse', Warehouse], ['building', Building], ['building-2', Building2],
  ['network', Network], ['layout-grid', LayoutGrid], ['rows-3', Rows3],
  ['component', Component], ['circle-dot', CircleDot],

  ['cog', Cog], ['settings', Settings], ['wrench', Wrench], ['hammer', Hammer], ['hard-hat', HardHat],
  ['construction', Construction],

  ['gauge', Gauge], ['circle-gauge', CircleGauge], ['thermometer', Thermometer], ['weight', Weight],
  ['scale', Scale], ['timer', Timer], ['clock', Clock], ['calendar', Calendar],
  ['activity', Activity], ['audio-waveform', AudioWaveform], ['waves', Waves], ['hash', Hash],

  ['droplet', Droplet], ['droplets', Droplets], ['wind', Wind], ['fan', Fan], ['flame', Flame],
  ['snowflake', Snowflake], ['sun', Sun], ['cloud', Cloud], ['heater', Heater], ['air-vent', AirVent],
  ['pipette', Pipette], ['cylinder', Cylinder],

  ['zap', Zap], ['plug', Plug], ['plug-zap', PlugZap],
  ['battery', Battery], ['battery-charging', BatteryCharging],
  ['fuel', Fuel], ['power', Power],

  ['cpu', Cpu], ['circuit-board', CircuitBoard], ['microchip', Microchip],
  ['server', Server], ['database', Database], ['hard-drive', HardDrive], ['radio', Radio],
  ['radio-tower', RadioTower], ['wifi', Wifi], ['antenna', Antenna], ['router', Router],
  ['satellite-dish', SatelliteDish], ['cable', Cable], ['barcode', Barcode],

  ['bot', Bot], ['move-horizontal', MoveHorizontal], ['truck', Truck], ['forklift', Forklift],
  ['ship', Ship], ['package', Package], ['boxes', Boxes], ['container', Container],

  ['flask-conical', FlaskConical], ['beaker', Beaker], ['test-tube', TestTube],
  ['microscope', Microscope], ['badge-check', BadgeCheck], ['radiation', Radiation], ['recycle', Recycle],

  ['git-branch', GitBranch], ['git-merge', GitMerge], ['workflow', Workflow], ['filter', Filter],
  ['target', Target],

  ['siren', Siren], ['bell', Bell], ['alarm-clock', AlarmClock],
  ['shield', Shield], ['shield-check', ShieldCheck], ['shield-alert', ShieldAlert], ['lock', Lock],
  ['eye', Eye], ['camera', Camera], ['scan-line', ScanLine], ['fire-extinguisher', FireExtinguisher],

  ['map-pin', MapPin], ['layers', Layers], ['grid-3x3', Grid3x3],

  ['chart-line', ChartLine], ['chart-column', ChartColumn], ['chart-bar', ChartBar],
  ['chart-pie', ChartPie], ['trending-up', TrendingUp], ['trending-down', TrendingDown],
  ['bar-chart-3', BarChart3],

  ['arrow-up', ArrowUp], ['arrow-down', ArrowDown], ['arrow-left', ArrowLeft], ['arrow-right', ArrowRight],
  ['arrow-up-down', ArrowUpDown], ['arrow-left-right', ArrowLeftRight], ['refresh-cw', RefreshCw],
  ['sliders-horizontal', SlidersHorizontal], ['sliders-vertical', SlidersVertical],

  ['tag', Tag], ['bookmark', Bookmark], ['folder', Folder], ['file-text', FileText],
  ['clipboard', Clipboard], ['clipboard-list', ClipboardList], ['briefcase', Briefcase],
  ['blocks', Blocks], ['users', Users],

  ['check', Check], ['circle-check', CircleCheck], ['x', X], ['circle-x', CircleX],
  ['triangle-alert', TriangleAlert], ['circle-alert', CircleAlert], ['octagon-alert', OctagonAlert],
  ['info', Info],

  ['lightbulb', Lightbulb], ['door-open', DoorOpen], ['printer', Printer],
  ['stamp', Stamp], ['blend', Blend]
]);

export function curatedIconNames() {
  return [...CURATED_ICONS.keys()];
}
