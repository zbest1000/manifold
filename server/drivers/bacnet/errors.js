'use strict';

/**
 * BACnet Error / Reject / Abort classification (clause 18) into messages an operator can act on
 * and into what the driver and runtime should do next.
 */

const { ERROR_CLASSES, ERROR_CODES, REJECT_REASONS, ABORT_REASONS } = require('./enums');

const errorClassName = (c) => ERROR_CLASSES[c] || `class ${c}`;
const errorCodeName = (c) => ERROR_CODES[c] || `code ${c}`;
const rejectName = (r) => REJECT_REASONS[r] || (r >= 64 ? `proprietary reason ${r}` : `reason ${r}`);
const abortName = (r) => ABORT_REASONS[r] || (r >= 64 ? `proprietary reason ${r}` : `reason ${r}`);

// Error codes that will not go away by asking again: the object/property/index is not there or not readable.
const PERMANENT_CODES = new Set([
  31, // unknown-object
  32, // unknown-property
  42, // invalid-array-index
  27, // read-access-denied
  50, // property-is-not-an-array
  36, // unsupported-object-type
  9, // invalid-data-type
  22, // property-is-not-a-list
]);
// The device does not implement the service (ReadPropertyMultiple): switch to ReadProperty.
const UNSUPPORTED_SERVICE_CODES = new Set([
  45, // optional-functionality-not-supported
  29, // service-request-denied
]);

const HINTS = {
  31: 'the object does not exist in this device (check the object type and instance, or browse the device)',
  32: 'this object has no such property',
  42: 'the array index is out of range (index 0 holds the array length)',
  27: 'the device refuses to let this property be read',
  50: 'the property is not an array; remove the [index]',
  3: 'the device is busy; it will be asked again on the next cycle',
  2: 'the device is being configured; it will be asked again',
};

/** "property / unknown-property: this object has no such property" */
function errorText(errorClass, errorCode) {
  const hint = HINTS[errorCode];
  return `${errorClassName(errorClass)} / ${errorCodeName(errorCode)}${hint ? `: ${hint}` : ''}`;
}

/** @returns {'permanent'|'unsupported-service'|'transient'} */
function classifyError(errorClass, errorCode) {
  if (errorClass === 5 && UNSUPPORTED_SERVICE_CODES.has(errorCode)) return 'unsupported-service'; // services class
  if (PERMANENT_CODES.has(errorCode) && (errorClass === 1 || errorClass === 2 || errorClass === 4)) return 'permanent';
  return 'transient';
}

const REJECT_HINTS = {
  9: 'the device does not implement this service',
  1: 'the request was larger than the device can take',
  4: 'the device could not parse the request',
};

function rejectText(reason) {
  return `request rejected: ${rejectName(reason)}${REJECT_HINTS[reason] ? ` (${REJECT_HINTS[reason]})` : ''}`;
}

const ABORT_HINTS = {
  4: 'the reply does not fit in one APDU and the device cannot segment it',
  1: 'the reply did not fit the device buffer',
  11: 'the reply is longer than the device can send',
  9: 'the device ran out of resources',
  3: 'the device was busy with a higher priority task',
};

function abortText(reason, server) {
  return `transaction aborted by the ${server ? 'device' : 'client'}: ${abortName(reason)}${ABORT_HINTS[reason] ? ` (${ABORT_HINTS[reason]})` : ''}`;
}

/** Reject/Abort reasons meaning "the reply is too big for one APDU": split the request. */
function isTooBig(res) {
  if (res.kind === 'abort') return res.reason === 4 || res.reason === 1 || res.reason === 11;
  if (res.kind === 'reject') return res.reason === 1;
  return false;
}

/** Reject/Error meaning "this device does not do ReadPropertyMultiple". */
function isUnsupportedService(res) {
  if (res.kind === 'reject') return res.reason === 9;
  if (res.kind === 'error') return classifyError(res.errorClass, res.errorCode) === 'unsupported-service';
  return false;
}

/** Short code for runtime exception counters: "property/unknown-property", "reject/unrecognized-service". */
function codeOf(res) {
  if (res.kind === 'error') return `${errorClassName(res.errorClass)}/${errorCodeName(res.errorCode)}`;
  if (res.kind === 'reject') return `reject/${rejectName(res.reason)}`;
  if (res.kind === 'abort') return `abort/${abortName(res.reason)}`;
  return res.kind;
}

function resultText(res) {
  if (res.kind === 'error') return errorText(res.errorClass, res.errorCode);
  if (res.kind === 'reject') return rejectText(res.reason);
  if (res.kind === 'abort') return abortText(res.reason, res.server);
  return res.message || res.kind;
}

module.exports = {
  errorClassName,
  errorCodeName,
  rejectName,
  abortName,
  errorText,
  classifyError,
  rejectText,
  abortText,
  isTooBig,
  isUnsupportedService,
  codeOf,
  resultText,
};
