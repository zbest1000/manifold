'use strict';

/**
 * BACnetEngineeringUnits -> unit text for mapping metadata. The enumeration (number -> standard
 * name) comes from ./enums.js; the symbols below are keyed by that NAME, so a symbol can never
 * land on the wrong number. A unit without a symbol here falls back to its standard name.
 */

const { UNITS } = require('./enums');

const SYMBOLS = {
  'square-meters': 'm²', 'square-feet': 'ft²', 'square-inches': 'in²', 'square-centimeters': 'cm²',
  milliamperes: 'mA', amperes: 'A', ohms: 'Ω', milliohms: 'mΩ', kilohms: 'kΩ', megohms: 'MΩ',
  volts: 'V', millivolts: 'mV', kilovolts: 'kV', megavolts: 'MV',
  'volt-amperes': 'VA', 'kilovolt-amperes': 'kVA', 'megavolt-amperes': 'MVA',
  'volt-amperes-reactive': 'var', 'kilovolt-amperes-reactive': 'kvar', 'megavolt-amperes-reactive': 'Mvar',
  'degrees-phase': '°', 'power-factor': '', joules: 'J', kilojoules: 'kJ', megajoules: 'MJ',
  'watt-hours': 'Wh', 'kilowatt-hours': 'kWh', 'megawatt-hours': 'MWh', btus: 'BTU', 'kilo-btus': 'kBTU', 'mega-btus': 'MBTU',
  therms: 'thm', 'ton-hours': 'ton·h', 'cycles-per-hour': 'cph', 'cycles-per-minute': 'cpm', hertz: 'Hz', kilohertz: 'kHz', megahertz: 'MHz',
  'percent-relative-humidity': '%RH', millimeters: 'mm', centimeters: 'cm', meters: 'm', kilometers: 'km', micrometers: 'µm',
  inches: 'in', feet: 'ft', 'watts-per-square-foot': 'W/ft²', 'watts-per-square-meter': 'W/m²',
  lumens: 'lm', luxes: 'lx', 'foot-candles': 'fc', candelas: 'cd', 'candelas-per-square-meter': 'cd/m²',
  kilograms: 'kg', grams: 'g', milligrams: 'mg', 'pounds-mass': 'lb', tons: 'ton',
  'kilograms-per-second': 'kg/s', 'kilograms-per-minute': 'kg/min', 'kilograms-per-hour': 'kg/h',
  'pounds-mass-per-second': 'lb/s', 'pounds-mass-per-minute': 'lb/min', 'pounds-mass-per-hour': 'lb/h',
  'grams-per-second': 'g/s', 'grams-per-minute': 'g/min', 'tons-per-hour': 't/h',
  milliwatts: 'mW', watts: 'W', kilowatts: 'kW', megawatts: 'MW', 'btus-per-hour': 'BTU/h', 'kilo-btus-per-hour': 'kBTU/h',
  horsepower: 'hp', 'tons-refrigeration': 'TR',
  pascals: 'Pa', hectopascals: 'hPa', kilopascals: 'kPa', millibars: 'mbar', bars: 'bar',
  'pounds-force-per-square-inch': 'psi', 'centimeters-of-water': 'cmH₂O', 'inches-of-water': 'inH₂O', 'millimeters-of-water': 'mmH₂O',
  'millimeters-of-mercury': 'mmHg', 'centimeters-of-mercury': 'cmHg', 'inches-of-mercury': 'inHg',
  'degrees-celsius': '°C', 'degrees-kelvin': 'K', kelvin: 'K', 'degrees-fahrenheit': '°F',
  'delta-degrees-fahrenheit': 'Δ°F', 'delta-degrees-kelvin': 'ΔK', 'delta-kelvin': 'ΔK',
  'degree-days-celsius': '°C·d', 'degree-days-fahrenheit': '°F·d',
  years: 'a', months: 'mo', weeks: 'wk', days: 'd', hours: 'h', minutes: 'min', seconds: 's',
  'hundredths-seconds': 'cs', milliseconds: 'ms',
  'meters-per-second': 'm/s', 'kilometers-per-hour': 'km/h', 'feet-per-second': 'ft/s', 'feet-per-minute': 'ft/min',
  'miles-per-hour': 'mph', 'millimeters-per-second': 'mm/s', 'millimeters-per-minute': 'mm/min',
  'meters-per-minute': 'm/min', 'meters-per-hour': 'm/h', 'meters-per-second-per-second': 'm/s²',
  'cubic-feet': 'ft³', 'cubic-meters': 'm³', 'imperial-gallons': 'gal (UK)', liters: 'L', milliliters: 'mL', 'us-gallons': 'gal',
  'cubic-feet-per-minute': 'cfm', 'cubic-feet-per-second': 'ft³/s', 'cubic-feet-per-hour': 'ft³/h',
  'cubic-meters-per-second': 'm³/s', 'cubic-meters-per-minute': 'm³/min', 'cubic-meters-per-hour': 'm³/h',
  'imperial-gallons-per-minute': 'gal (UK)/min', 'liters-per-second': 'L/s', 'liters-per-minute': 'L/min', 'liters-per-hour': 'L/h',
  'milliliters-per-second': 'mL/s', 'us-gallons-per-minute': 'gpm', 'us-gallons-per-hour': 'gal/h',
  'degrees-angular': '°', radians: 'rad', 'radians-per-second': 'rad/s', 'revolutions-per-minute': 'rpm',
  'degrees-celsius-per-hour': '°C/h', 'degrees-celsius-per-minute': '°C/min',
  'degrees-fahrenheit-per-hour': '°F/h', 'degrees-fahrenheit-per-minute': '°F/min',
  'no-units': '', 'parts-per-million': 'ppm', 'parts-per-billion': 'ppb', percent: '%', 'percent-per-second': '%/s', 'per-mille': '‰',
  'per-minute': '/min', 'per-second': '/s', 'per-hour': '/h',
  newton: 'N', 'newton-meters': 'N·m', 'newton-seconds': 'N·s', 'newtons-per-meter': 'N/m',
  farads: 'F', henrys: 'H', siemens: 'S', millisiemens: 'mS', microsiemens: 'µS', teslas: 'T', webers: 'Wb',
  decibels: 'dB', 'decibels-millivolt': 'dBmV', 'decibels-volt': 'dBV', 'decibels-a': 'dBA',
  'kilograms-per-cubic-meter': 'kg/m³', 'grams-per-cubic-meter': 'g/m³', 'milligrams-per-cubic-meter': 'mg/m³',
  'micrograms-per-cubic-meter': 'µg/m³', 'nanograms-per-cubic-meter': 'ng/m³',
  'grams-per-liter': 'g/L', 'milligrams-per-liter': 'mg/L', 'micrograms-per-liter': 'µg/L',
  'nephelometric-turbidity-unit': 'NTU', ph: 'pH',
  'watt-hours-reactive': 'varh', 'kilowatt-hours-reactive': 'kvarh', 'megawatt-hours-reactive': 'Mvarh',
};

/**
 * @param {number} code BACnetEngineeringUnits value
 * @returns {{code:number, name:string, text:string}} text: the symbol, '' for no-units, else the standard name
 */
function unitInfo(code) {
  const name = UNITS[code] || (code >= 256 ? `proprietary-unit-${code}` : `unit-${code}`);
  const text = Object.hasOwn(SYMBOLS, name) ? SYMBOLS[name] : name;
  return { code, name, text };
}

module.exports = { unitInfo, SYMBOLS };
