'use strict';

/**
 * One UDP socket for one CoAP device (self-contained: nothing outside this
 * driver directory depends on it).
 *
 *  - Egress guard: the destination must be a literal IP address that passes
 *    the same policy as every other device target (loopback only with
 *    MANIFOLD_ALLOW_LOOPBACK_DEVICES=1, RFC1918 only with
 *    MANIFOLD_ALLOW_PRIVATE_TARGETS=1, metadata, multicast and broadcast
 *    never). The check runs when the socket opens, so a name that the main
 *    process resolved and pinned is the only thing ever connected to.
 *  - Address pinning: a hostname is refused here. The main process resolves
 *    device hostnames, checks them and passes the validated address down as
 *    `device.pinned.addresses`; this module never resolves anything.
 *  - The socket is connect()ed to the device, so the kernel drops datagrams
 *    from any other source, and every received datagram is checked against
 *    the device address again (belt and braces; connect() does not exist on
 *    every stack the tests may run on).
 *  - Unicast only. No multicast group is ever joined or addressed.
 *  - Every outgoing datagram passes `assertReadOnlyDatagram`: only an empty
 *    message or a GET leaves this process.
 */

const dgram = require('node:dgram');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { assertReadOnlyDatagram } = require('./message');

const MAX_DATAGRAM = 1152; // RFC 7252 section 4.6: the size that avoids IP fragmentation on any path

function normalizeIp(ip) {
  const s = String(ip).toLowerCase().replace(/%.*$/, '');
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  return m ? m[1] : s;
}

class CoapUdpSocket extends EventEmitter {
  /**
   * @param {{address:string, port:number, displayHost?:string, guard?:Function, dgramModule?:object}} opts
   *   `guard(ip)` is a test seam; the default is the egress guard's device policy.
   */
  constructor({ address, port, displayHost, guard, dgramModule } = {}) {
    super();
    this.address = address;
    this.port = port;
    this.displayHost = displayHost || address;
    this._guard = guard || ((ip) => require('../../services/egressGuard').assertAllowedHost(ip, { device: true, purpose: 'coap' }));
    this._dgram = dgramModule || dgram;
    this._sock = null;
    this._open = false;
    this.stats = { sent: 0, received: 0, bytesOut: 0, bytesIn: 0, foreign: 0 };
  }

  isOpen() {
    return this._open;
  }

  async open() {
    if (this._open) return;
    if (!net.isIP(this.address)) {
      throw new Error(`CoAP needs an IP address to send to, got "${this.address}": the host name was not resolved and checked by the server`);
    }
    await this._guard(this.address);
    const sock = this._dgram.createSocket({ type: net.isIPv6(this.address) ? 'udp6' : 'udp4' });
    this._sock = sock;
    try {
      await new Promise((resolve, reject) => {
        sock.once('error', reject);
        sock.bind(0, () => {
          sock.removeListener('error', reject);
          resolve();
        });
      });
      await new Promise((resolve, reject) => {
        sock.once('error', reject);
        sock.connect(this.port, this.address, () => {
          sock.removeListener('error', reject);
          resolve();
        });
      });
    } catch (err) {
      this._sock = null;
      try {
        sock.close();
      } catch {
        /* never opened */
      }
      throw err;
    }
    sock.on('message', (msg, rinfo) => {
      if (this._sock !== sock) return;
      if (normalizeIp(rinfo.address) !== normalizeIp(this.address) || rinfo.port !== this.port) {
        this.stats.foreign++;
        return;
      }
      this.stats.received++;
      this.stats.bytesIn += msg.length;
      this.emit('message', Buffer.from(msg));
    });
    // ICMP port/host unreachable surfaces on a connected UDP socket as an asynchronous error.
    sock.on('error', (err) => {
      if (this._sock === sock) this.emit('socket-error', err);
    });
    sock.on('close', () => {
      if (this._sock === sock) {
        this._sock = null;
        this._open = false;
        this.emit('closed');
      }
    });
    this._open = true;
  }

  /** Send one datagram (read-only guarded). Resolves when handed to the kernel. */
  send(buf) {
    assertReadOnlyDatagram(buf);
    if (buf.length > MAX_DATAGRAM) throw new RangeError(`datagram of ${buf.length} bytes exceeds ${MAX_DATAGRAM}`);
    const sock = this._sock;
    if (!sock || !this._open) return Promise.reject(new Error('socket is closed'));
    return new Promise((resolve, reject) => {
      sock.send(buf, (err) => {
        if (err) reject(err);
        else {
          this.stats.sent++;
          this.stats.bytesOut += buf.length;
          resolve();
        }
      });
    });
  }

  close() {
    const sock = this._sock;
    this._sock = null;
    this._open = false;
    if (!sock) return Promise.resolve();
    return new Promise((resolve) => {
      sock.removeAllListeners('message');
      sock.on('error', () => {});
      try {
        sock.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
}

module.exports = { CoapUdpSocket, MAX_DATAGRAM, normalizeIp };
