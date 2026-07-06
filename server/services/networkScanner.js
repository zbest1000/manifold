const { EventEmitter } = require('events');
const net = require('net');

// Pure-JS TCP scanner. Deliberately has NO external dependencies (previously
// required node-nmap + ping, which were never installed and crashed the server
// on boot). Host liveness and port state are inferred from TCP connect results.
const DEFAULT_PORTS = '1883,8883,1884,8884,1888,8888,80,443,22,502,102,44818,4840';
const CONNECT_TIMEOUT_MS = 800; // per-port connect timeout during a port sweep
const LIVENESS_TIMEOUT_MS = 600; // per-probe timeout when inferring host liveness
const PROBE_TIMEOUT_MS = 5000; // MQTT CONNECT/CONNACK probe timeout
const HOST_CONCURRENCY = 64; // parallel host-liveness probes
const PORT_CONCURRENCY = 100; // parallel port connects within a host sweep
const MAX_HISTORY_ENTRIES = 100;
const MAX_RESULT_ENTRIES = 50; // bound scanResults growth (was an unbounded leak)
const LIVENESS_PORTS = [1883, 8883, 80, 443, 22]; // any response => host is up

class NetworkScanner extends EventEmitter {
  constructor(io) {
    super();
    this.io = io;
    // NOTE: state flag is `scanning`, NOT `isScanning`. A boolean property named
    // isScanning would shadow the isScanning() method on the instance.
    this.scanning = false;
    this.currentScanId = null;
    this.scanResults = new Map();
    this.scanHistory = [];
  }

  async startScan(options = {}) {
    if (this.scanning) {
      throw new Error('Scan already in progress');
    }

    const scanOptions = {
      target: '192.168.1.0/24',
      ports: DEFAULT_PORTS,
      serviceDetection: true,
      ...options
    };

    this.validateTarget(scanOptions.target);
    const ports = this.parsePorts(scanOptions.ports);

    this.scanning = true;
    const scanId = `scan_${Date.now()}`;
    this.currentScanId = scanId;
    const startedAt = Date.now();

    console.log(`🔍 Starting network scan: ${scanOptions.target}`);
    this.io.emit('network-scan-started', { scanId, options: scanOptions });

    try {
      const results = await this.performScan(scanOptions, ports, scanId);

      this.scanResults.set(scanId, {
        id: scanId,
        options: scanOptions,
        results,
        timestamp: new Date(),
        duration: Date.now() - startedAt
      });
      this.pruneResults();
      this.addToHistory(scanId, results);

      console.log(`✅ Network scan completed: ${results.hosts.length} hosts found`);
      this.io.emit('network-scan-completed', { scanId, results });
      return results;
    } catch (error) {
      console.error('Network scan failed:', error);
      this.io.emit('network-scan-error', { scanId, error: error.message });
      throw error;
    } finally {
      this.scanning = false;
      this.currentScanId = null;
    }
  }

  async performScan(options, ports, scanId) {
    const results = {
      hosts: [],
      mqttBrokers: [],
      webServices: [],
      industrialDevices: [],
      summary: {
        totalHosts: 0,
        mqttBrokers: 0,
        webServices: 0,
        industrialDevices: 0,
        unknownServices: 0
      }
    };

    // Phase 1: host discovery
    this.io.emit('network-scan-progress', { scanId, phase: 'host-discovery', progress: 0 });
    const aliveHosts = await this.discoverHosts(options.target);
    results.summary.totalHosts = aliveHosts.length;
    this.io.emit('network-scan-progress', { scanId, phase: 'host-discovery', progress: 100 });

    // Phase 2: port scanning
    for (let i = 0; i < aliveHosts.length; i++) {
      if (!this.scanning) {
        break;
      }
      const host = aliveHosts[i];
      const progress = Math.round((i / Math.max(aliveHosts.length, 1)) * 100);
      this.io.emit('network-scan-progress', {
        scanId,
        phase: 'port-scanning',
        progress,
        currentHost: host.ip
      });

      const hostInfo = await this.scanHost(host.ip, ports);
      results.hosts.push(hostInfo);
      this.categorizeHost(hostInfo, results);
    }

    // Phase 3: MQTT broker probing (optional)
    if (options.serviceDetection) {
      this.io.emit('network-scan-progress', { scanId, phase: 'service-detection', progress: 0 });
      await this.probeDiscoveredBrokers(results, scanId);
    }

    this.io.emit('network-scan-progress', { scanId, phase: 'completed', progress: 100 });
    return results;
  }

  async discoverHosts(target) {
    const ips = this.expandTarget(target);

    // Single host: skip liveness gating and let the port scan speak for itself.
    if (ips.length === 1) {
      return [{ ip: ips[0], alive: true }];
    }

    const alive = [];
    await this.runPool(
      ips,
      async (ip) => {
        if (await this.isHostAlive(ip)) {
          alive.push({ ip, alive: true });
        }
      },
      HOST_CONCURRENCY
    );
    return alive;
  }

  async isHostAlive(ip) {
    const states = await Promise.all(
      LIVENESS_PORTS.map((port) => this.tcpProbe(ip, port, LIVENESS_TIMEOUT_MS))
    );
    // 'open' or 'closed' (ECONNREFUSED) both prove the host answered.
    return states.some((state) => state === 'open' || state === 'closed');
  }

  async scanHost(ip, ports) {
    const openPorts = [];
    await this.runPool(
      ports,
      async (port) => {
        const state = await this.tcpProbe(ip, port, CONNECT_TIMEOUT_MS);
        if (state === 'open') {
          openPorts.push(port);
        }
      },
      PORT_CONCURRENCY
    );

    openPorts.sort((a, b) => a - b);
    return {
      ip,
      hostname: null,
      openPorts,
      services: openPorts.map((port) => this.identifyService(port)),
      os: null
    };
  }

  // Resolves 'open' | 'closed' | 'filtered' without ever throwing.
  tcpProbe(ip, port, timeout) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (state) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        resolve(state);
      };

      socket.setTimeout(timeout);
      socket.once('connect', () => finish('open'));
      socket.once('timeout', () => finish('filtered'));
      socket.once('error', (error) => finish(error.code === 'ECONNREFUSED' ? 'closed' : 'filtered'));

      try {
        socket.connect(port, ip);
      } catch (error) {
        finish('filtered');
      }
    });
  }

  identifyService(port) {
    const service = {
      port,
      name: 'unknown',
      type: 'unknown',
      confidence: 'low',
      details: {}
    };

    if ([1883, 8883, 1884, 8884, 1888, 8888].includes(port)) {
      service.type = 'mqtt';
      service.name = port === 8883 || port === 8884 ? 'mqtts' : 'mqtt';
      service.confidence = 'high';
    } else if ([80, 443, 8080, 8443].includes(port)) {
      service.type = 'web';
      service.name = port === 443 || port === 8443 ? 'https' : 'http';
      service.confidence = 'high';
    } else if (port === 502) {
      service.type = 'industrial';
      service.name = 'modbus';
      service.confidence = 'medium';
    } else if (port === 102) {
      service.type = 'industrial';
      service.name = 's7comm';
      service.confidence = 'medium';
    } else if (port === 44818) {
      // 44818 is EtherNet/IP (CIP), not OPC-UA. OPC-UA is 4840.
      service.type = 'industrial';
      service.name = 'ethernet-ip';
      service.confidence = 'medium';
    } else if (port === 4840) {
      service.type = 'industrial';
      service.name = 'opc-ua';
      service.confidence = 'medium';
    } else if (port === 22) {
      service.type = 'management';
      service.name = 'ssh';
      service.confidence = 'high';
    }

    return service;
  }

  categorizeHost(hostInfo, results) {
    const types = new Set(hostInfo.services.map((s) => s.type));

    if (types.has('mqtt')) {
      results.mqttBrokers.push(hostInfo);
      results.summary.mqttBrokers++;
    }
    if (types.has('web')) {
      results.webServices.push(hostInfo);
      results.summary.webServices++;
    }
    if (types.has('industrial')) {
      results.industrialDevices.push(hostInfo);
      results.summary.industrialDevices++;
    }
    if (!types.has('mqtt') && !types.has('web') && !types.has('industrial') && hostInfo.services.length > 0) {
      results.summary.unknownServices++;
    }
  }

  async probeDiscoveredBrokers(results, scanId) {
    const brokers = results.mqttBrokers;
    for (let i = 0; i < brokers.length; i++) {
      if (!this.scanning) {
        break;
      }
      const broker = brokers[i];
      const progress = Math.round((i / Math.max(brokers.length, 1)) * 100);
      this.io.emit('network-scan-progress', {
        scanId,
        phase: 'service-detection',
        progress,
        currentHost: broker.ip
      });

      for (const service of broker.services) {
        if (service.type !== 'mqtt') {
          continue;
        }
        try {
          service.details = await this.probeMQTTBroker(broker.ip, service.port);
          service.confidence = 'high';
        } catch (error) {
          service.details = { error: error.message };
        }
      }
    }
  }

  probeMQTTBroker(host, port) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const probeInfo = {
        responsive: false,
        protocolVersion: null,
        authRequired: null,
        features: []
      };

      socket.setTimeout(PROBE_TIMEOUT_MS);

      socket.connect(port, host, () => {
        probeInfo.responsive = true;
        socket.write(this.buildConnectPacket('MQTTExplore-probe'));
      });

      socket.once('data', (data) => {
        // CONNACK has packet type 0x20 in the first byte.
        if (data.length >= 4 && data[0] === 0x20) {
          probeInfo.protocolVersion = 'MQTT 3.1.1';
          const returnCode = data[3];
          switch (returnCode) {
            case 0:
              probeInfo.authRequired = false;
              probeInfo.features.push('Anonymous access allowed');
              break;
            case 4:
            case 5:
              probeInfo.authRequired = true;
              probeInfo.features.push('Authentication required');
              break;
            default:
              probeInfo.features.push(`Connection refused (code: ${returnCode})`);
          }
        }
        socket.end();
        resolve(probeInfo);
      });

      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      });

      socket.once('error', (error) => {
        socket.destroy();
        reject(error);
      });
    });
  }

  // Builds a spec-correct MQTT 3.1.1 CONNECT packet. The previous implementation
  // passed string characters inside Buffer.from([...]), which coerces them to 0x00.
  buildConnectPacket(clientId) {
    const protocolName = Buffer.from('MQTT', 'utf8');
    const clientIdBuf = Buffer.from(clientId, 'utf8');

    const variableHeader = Buffer.concat([
      this.encodeUtf8String(protocolName),
      Buffer.from([0x04]), // protocol level 4 (MQTT 3.1.1)
      Buffer.from([0x02]), // connect flags: clean session
      Buffer.from([0x00, 0x3c]) // keep-alive: 60s
    ]);
    const payload = this.encodeUtf8String(clientIdBuf);
    const body = Buffer.concat([variableHeader, payload]);

    return Buffer.concat([
      Buffer.from([0x10]), // CONNECT packet type
      this.encodeRemainingLength(body.length),
      body
    ]);
  }

  encodeUtf8String(buf) {
    return Buffer.concat([Buffer.from([(buf.length >> 8) & 0xff, buf.length & 0xff]), buf]);
  }

  encodeRemainingLength(length) {
    const bytes = [];
    let value = length;
    do {
      let byte = value % 128;
      value = Math.floor(value / 128);
      if (value > 0) {
        byte |= 0x80;
      }
      bytes.push(byte);
    } while (value > 0);
    return Buffer.from(bytes);
  }

  // Bounded-concurrency worker pool. Aborts cleanly if scanning is stopped.
  async runPool(items, worker, concurrency) {
    let index = 0;
    const runNext = async () => {
      while (index < items.length && this.scanning) {
        const current = index++;
        await worker(items[current], current);
      }
    };
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, runNext);
    await Promise.all(runners);
  }

  validateTarget(target) {
    if (typeof target !== 'string') {
      throw new Error('Scan target must be a string');
    }
    // Strict IPv4 or IPv4/CIDR. Also blocks argument-injection style targets.
    if (!/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(target)) {
      throw new Error(`Invalid scan target: ${target}`);
    }
    const [ip, mask] = target.split('/');
    if (ip.split('.').some((octet) => Number(octet) > 255)) {
      throw new Error(`Invalid IP address in target: ${target}`);
    }
    if (mask !== undefined && Number(mask) > 32) {
      throw new Error(`Invalid CIDR mask in target: ${target}`);
    }
  }

  parsePorts(ports) {
    const raw = String(ports);
    if (!/^[\d,\s]+$/.test(raw)) {
      throw new Error('Invalid ports specification');
    }
    const list = raw
      .split(',')
      .map((p) => parseInt(p.trim(), 10))
      .filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535);
    if (list.length === 0) {
      throw new Error('No valid ports specified');
    }
    return Array.from(new Set(list));
  }

  expandTarget(target) {
    if (!target.includes('/')) {
      return [target];
    }
    // Pure-JS mode scans the /24 that contains the base address. Ranges wider
    // than /24 are intentionally not expanded (would be 65k+ probes).
    const base = target.split('/')[0].split('.').slice(0, 3).join('.');
    const ips = [];
    for (let i = 1; i <= 254; i++) {
      ips.push(`${base}.${i}`);
    }
    return ips;
  }

  stopScan() {
    this.scanning = false;
    console.log('⏹️  Network scan stopped');
    this.io.emit('network-scan-stopped', { scanId: this.currentScanId });
  }

  addToHistory(scanId, results) {
    this.scanHistory.unshift({
      id: scanId,
      timestamp: new Date(),
      summary: results.summary,
      hostsFound: results.hosts.length
    });
    if (this.scanHistory.length > MAX_HISTORY_ENTRIES) {
      this.scanHistory = this.scanHistory.slice(0, MAX_HISTORY_ENTRIES);
    }
  }

  pruneResults() {
    if (this.scanResults.size <= MAX_RESULT_ENTRIES) {
      return;
    }
    const keys = Array.from(this.scanResults.keys());
    for (const key of keys.slice(0, keys.length - MAX_RESULT_ENTRIES)) {
      this.scanResults.delete(key);
    }
  }

  getScanResults(scanId) {
    return this.scanResults.get(scanId);
  }

  getAllScanResults() {
    return Array.from(this.scanResults.values());
  }

  getScanHistory() {
    return this.scanHistory;
  }

  clearHistory() {
    this.scanHistory = [];
    this.scanResults.clear();
  }

  isScanning() {
    return this.scanning;
  }

  getStatus() {
    return {
      isScanning: this.scanning,
      totalScans: this.scanResults.size,
      historyEntries: this.scanHistory.length
    };
  }

  async quickHealthCheck(targets = ['1.1.1.1', '8.8.8.8']) {
    const states = await Promise.all(targets.map((t) => this.tcpProbe(t, 53, 1000)));
    const reachable = states.filter((s) => s === 'open' || s === 'closed').length;
    return {
      internetAccess: reachable > 0,
      targetsChecked: targets.length,
      reachable,
      timestamp: new Date()
    };
  }
}

module.exports = NetworkScanner;
