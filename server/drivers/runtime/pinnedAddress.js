'use strict';

/**
 * The address a driver must open its socket to. The main process resolves a device
 * hostname, checks every returned address against the egress policy and hands the
 * validated ones over as `device.pinned.addresses`; connecting to the hostname here
 * would resolve it AGAIN and could land on an address that was never checked.
 * A device configured with a literal IP has no pin (nothing to resolve).
 * The hostname stays in `device.host` for messages and logs.
 */
function connectAddress(device) {
  const pinned = device && device.pinned && Array.isArray(device.pinned.addresses) ? device.pinned.addresses : null;
  return pinned && pinned.length && typeof pinned[0] === 'string' ? pinned[0] : device.host;
}

module.exports = { connectAddress };
