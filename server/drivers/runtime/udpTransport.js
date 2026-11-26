'use strict';

/**
 * One UDP socket to one device, for datagram protocols (SNMP). Self-contained
 * on purpose: the TCP drivers own their sockets in their clients, and other
 * UDP drivers can share or replace this file without touching the runtime.
 *
 * What it adds over a bare dgram socket:
 *  - the target must be a literal IP: the PINNED address the main process
 *    validated (device.pinned, see pinnedAddress.js). A hostname is refused, so
 *    nothing here can resolve a name a second time;
 *  - a second egress check in the driver process (same policy as the main
 *    process: loopback only with MANIFOLD_ALLOW_LOOPBACK_DEVICES=1, private
 *    ranges only with MANIFOLD_ALLOW_PRIVATE_TARGETS=1, never metadata or
 *    multicast). Broadcast is never enabled on the socket, so a directed
 *    broadcast address fails to send (EACCES) instead of reaching a subnet;
 *  - source pinning: by default the socket is connect()ed to address:port, so
 *    the kernel drops datagrams from anywhere else and an ICMP port-unreachable
 *    surfaces as an 'unreachable' event. With `allowAnySource` (agents that answer
 *    from another interface address) the socket stays unconnected and every
 *    datagram is passed up with its source, counted as `foreign`.
 *
 * Events: 'message' (buf, rinfo), 'unreachable' (err), 'rejected' (rinfo), 'error' (err), 'close'.
 */

const dgram = require('dgram');
const net = require('net');
const { EventEmitter } = require('events');

class UdpTransport extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.address literal IPv4/IPv6 address to talk to (the pinned one)
   * @param {number} o.port
   * @param {boolean} [o.allowAnySource=false]
   * @param {string} [o.displayHost] for messages
   * @param {Function} [o.createSocket] dgram.createSocket replacement (tests)
   * @param {(ip:string)=>boolean} [o.isAllowed] egress check replacement (tests)
   */
  constructor(o) {
    super();
    this.address = o.address;
    this.port = o.port;
    this.allowAnySource = Boolean(o.allowAnySource);
    this.displayHost = o.displayHost || o.address;
    this._createSocket = o.createSocket || dgram.createSocket;
    this._isAllowed = o.isAllowed || null;
    this.socket = null;
    this.stats = { sent: 0, received: 0, rejected: 0, foreign: 0, unreachable: 0 };
  }

  isOpen() {
    return this.socket !== null;
  }

  _checkTarget() {
    const family = net.isIP(String(this.address || ''));
    if (!family) throw new Error(`UDP target must be a literal IP address (got "${this.address}"); hostnames are resolved and pinned by the main process`);
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) throw new Error('UDP port must be 1..65535');
    const allowed = this._isAllowed || ((ip) => require('../../services/egressGuard').isAllowedAddress(ip, { device: true }));
    if (!allowed(this.address)) throw new Error(`egress to ${this.displayHost} (${this.address}) is blocked by policy`);
    return family;
  }

  async open() {
    if (this.socket) return;
    const family = this._checkTarget();
    const socket = this._createSocket({ type: family === 6 ? 'udp6' : 'udp4' });
    this.socket = socket;
    socket.on('message', (msg, rinfo) => this._onMessage(socket, msg, rinfo));
    socket.on('error', (err) => this._onError(socket, err));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.emit('close');
    });
    try {
      await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(0, () => {
          socket.removeListener('error', reject);
          resolve();
        });
      });
      if (!this.allowAnySource) {
        await new Promise((resolve, reject) => {
          socket.once('error', reject);
          socket.connect(this.port, this.address, () => {
            socket.removeListener('error', reject);
            resolve();
          });
        });
      }
    } catch (err) {
      this.close();
      throw err;
    }
  }

  _onMessage(socket, msg, rinfo) {
    if (socket !== this.socket) return;
    const fromTarget = rinfo && rinfo.address === this.address && rinfo.port === this.port;
    if (!fromTarget) {
      if (!this.allowAnySource) {
        this.stats.rejected++;
        this.emit('rejected', rinfo);
        return;
      }
      this.stats.foreign++;
    }
    this.stats.received++;
    this.emit('message', msg, rinfo);
  }

  _onError(socket, err) {
    if (socket !== this.socket) return;
    if (err && (err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH')) {
      this.stats.unreachable++;
      this.emit('unreachable', err);
      return;
    }
    this.emit('error', err);
  }

  /** Send one datagram. Resolves when handed to the kernel; rejects on a send error. */
  send(buf) {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('UDP socket is closed'));
    return new Promise((resolve, reject) => {
      const done = (err) => {
        if (err) {
          if (err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') {
            this.stats.unreachable++;
            this.emit('unreachable', err);
            resolve(); // reported as unreachable; the caller's timeout handles the rest
            return;
          }
          reject(err);
          return;
        }
        this.stats.sent++;
        resolve();
      };
      try {
        if (this.allowAnySource) socket.send(buf, this.port, this.address, done);
        else socket.send(buf, done);
      } catch (err) {
        reject(err);
      }
    });
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }
}

module.exports = { UdpTransport };
