const EventEmitter = require('events');
const net = require('net');

class MQTTDiscoveryService extends EventEmitter {
  constructor(io) {
    super();
    this.io = io;
    this.isDiscovering = false;
    this.discoveredBrokers = new Map();

    // Default discovery options
    this.options = {
      networkRange: '192.168.1.0/24',
      portRange: [1883, 8883, 1884, 8884, 1888, 8888, 9001],
      timeout: 5000,
      enablePortScan: true,
      // mDNS (real, via bonjour-service) is on by default. SSDP is real but
      // rarely advertises MQTT, so it stays opt-in.
      enableMDNS: true,
      enableSSDP: false,
      enableFingerprinting: true
    };
  }

  async startDiscovery(options = {}) {
    if (this.isDiscovering) {
      console.log('Discovery already in progress');
      return;
    }

    this.options = { ...this.options, ...options };
    this.isDiscovering = true;
    this.discoveredBrokers.clear();

    console.log('🔍 Starting MQTT broker discovery...');
    
    this.io.emit('discovery-started', {
      timestamp: new Date().toISOString(),
      options: this.options
    });

    try {
      // Start different discovery methods
      await Promise.all([
        this.portScanDiscovery(),
        this.mdnsDiscovery(),
        this.ssdpDiscovery()
      ]);
    } catch (error) {
      console.error('Discovery error:', error);
      this.io.emit('discovery-error', { error: error.message });
    } finally {
      // Always reset so discovery can run more than once per process.
      this.isDiscovering = false;
      this.io.emit('discovery-completed', {
        timestamp: new Date().toISOString(),
        brokersFound: this.discoveredBrokers.size
      });
    }
  }

  stopDiscovery() {
    if (!this.isDiscovering) return;

    console.log('⏹️  Stopping MQTT broker discovery...');
    // The in-flight port scan loops check this flag and break early.
    this.isDiscovering = false;

    this.io.emit('discovery-stopped', {
      timestamp: new Date().toISOString(),
      brokersFound: this.discoveredBrokers.size
    });
  }

  async portScanDiscovery() {
    if (!this.options.enablePortScan) return;

    console.log('🔍 Starting port scan discovery...');
    
    const networkRange = this.parseNetworkRange(this.options.networkRange);
    
    for (const ip of networkRange) {
      if (!this.isDiscovering) break;
      
      for (const port of this.options.portRange) {
        if (!this.isDiscovering) break;
        
        await this.scanPort(ip, port);
      }
    }
  }

  parseNetworkRange(range) {
    // Simple CIDR parsing for common cases
    if (range.includes('/24')) {
      const baseIp = range.split('/')[0];
      const parts = baseIp.split('.');
      const base = parts.slice(0, 3).join('.');
      
      const ips = [];
      for (let i = 1; i <= 254; i++) {
        ips.push(`${base}.${i}`);
      }
      return ips;
    }
    
    // Single IP
    return [range];
  }

  async scanPort(ip, port) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, this.options.timeout);

      socket.connect(port, ip, async () => {
        clearTimeout(timeout);
        socket.destroy();
        
        console.log(`✅ Found open port: ${ip}:${port}`);
        
        // Try to identify if it's an MQTT broker
        const brokerInfo = await this.identifyMQTTBroker(ip, port);
        if (brokerInfo) {
          this.addDiscoveredBroker(brokerInfo);
        }
        
        resolve(true);
      });

      socket.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  async identifyMQTTBroker(ip, port) {
    try {
      // Simple MQTT connection attempt
      const mqtt = require('mqtt');
      const connectStart = Date.now();
      const client = mqtt.connect(`mqtt://${ip}:${port}`, {
        connectTimeout: 3000,
        clientId: `mqtt-explorer-${Date.now()}`
      });

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          client.end(true);
          resolve(null);
        }, 3000);

        client.on('connect', () => {
          clearTimeout(timeout);
          
          const brokerInfo = {
            id: `${ip}:${port}`,
            host: ip,
            port: port,
            protocol: 'MQTT',
            version: client.options.protocolVersion === 5 ? 'v5.0' : 'v3.1.1',
            status: 'online',
            discoveryMethod: 'Port Scan',
            lastSeen: new Date(),
            responseTime: Date.now() - connectStart, // measured connect RTT
            secure: port === 8883 || port === 8884,
            clientId: null,
            topics: 0,
            clients: 0
          };
          
          client.end();
          resolve(brokerInfo);
        });

        client.on('error', () => {
          clearTimeout(timeout);
          resolve(null);
        });
      });
    } catch (error) {
      return null;
    }
  }

  async mdnsDiscovery() {
    if (!this.options.enableMDNS) return;

    let bonjour;
    try {
      const { Bonjour } = require('bonjour-service');
      bonjour = new Bonjour();
    } catch (error) {
      console.warn('bonjour-service not installed; skipping mDNS discovery.');
      return;
    }

    console.log('🔍 Starting mDNS discovery (_mqtt._tcp.local.)...');

    return new Promise((resolve) => {
      const browser = bonjour.find({ type: 'mqtt' });

      browser.on('up', (service) => {
        if (!this.isDiscovering) return;
        const host = (service.addresses || []).find((addr) => addr.includes('.')) || service.host;
        if (!host || !service.port) return;
        this.addDiscoveredBroker({
          id: `mdns:${host}:${service.port}`,
          host,
          port: service.port,
          protocol: 'MQTT',
          version: 'unknown',
          status: 'online',
          discoveryMethod: 'mDNS',
          lastSeen: new Date(),
          secure: service.port === 8883,
          clientId: service.name || null,
          topics: 0,
          clients: 0
        });
      });

      const stop = () => {
        try {
          browser.stop();
          bonjour.destroy();
        } catch (error) {
          // best-effort cleanup
        }
        resolve();
      };
      setTimeout(stop, this.options.timeout || 5000);
    });
  }

  async ssdpDiscovery() {
    if (!this.options.enableSSDP) return;

    const dgram = require('dgram');
    console.log('🔍 Starting SSDP discovery (M-SEARCH)...');

    return new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const message = Buffer.from(
        'M-SEARCH * HTTP/1.1\r\n' +
          'HOST: 239.255.255.250:1900\r\n' +
          'MAN: "ssdp:discover"\r\n' +
          'MX: 2\r\n' +
          'ST: ssdp:all\r\n\r\n'
      );
      const seen = new Set();

      const close = () => {
        try {
          socket.close();
        } catch (error) {
          // already closed
        }
        resolve();
      };

      socket.on('message', (msg, rinfo) => {
        if (!this.isDiscovering) return;
        // SSDP rarely advertises MQTT directly, so only surface responders whose
        // advertisement actually mentions MQTT (never fabricate a broker).
        if (!/mqtt/i.test(msg.toString()) || seen.has(rinfo.address)) return;
        seen.add(rinfo.address);
        this.addDiscoveredBroker({
          id: `ssdp:${rinfo.address}`,
          host: rinfo.address,
          port: 1883,
          protocol: 'MQTT',
          version: 'unknown',
          status: 'online',
          discoveryMethod: 'SSDP',
          lastSeen: new Date(),
          secure: false,
          clientId: null,
          topics: 0,
          clients: 0
        });
      });

      socket.on('error', close);
      socket.bind(() => {
        try {
          socket.send(message, 0, message.length, 1900, '239.255.255.250');
        } catch (error) {
          // send failed; the timeout below will still resolve
        }
      });
      setTimeout(close, this.options.timeout || 5000);
    });
  }

  addDiscoveredBroker(brokerInfo) {
    this.discoveredBrokers.set(brokerInfo.id, brokerInfo);
    
    console.log(`📡 Discovered MQTT broker: ${brokerInfo.host}:${brokerInfo.port} (${brokerInfo.discoveryMethod})`);
    
    this.io.emit('broker-discovered', brokerInfo);
    this.emit('broker-discovered', brokerInfo);
  }

  updateBroker(brokerId, updates) {
    const broker = this.discoveredBrokers.get(brokerId);
    if (broker) {
      Object.assign(broker, updates);
      this.io.emit('broker-updated', broker);
      this.emit('broker-updated', broker);
    }
  }

  getDiscoveredBrokers() {
    return Array.from(this.discoveredBrokers.values());
  }

  getBrokerById(brokerId) {
    return this.discoveredBrokers.get(brokerId) || null;
  }

  removeBroker(brokerId) {
    const existed = this.discoveredBrokers.has(brokerId);
    if (existed) {
      this.discoveredBrokers.delete(brokerId);
      this.io.emit('broker-removed', { brokerId });
    }
    return existed;
  }

  getDiscoveryStatus() {
    return {
      isDiscovering: this.isDiscovering,
      brokersFound: this.discoveredBrokers.size,
      options: this.options,
      lastScan: this.lastScan || null
    };
  }

  // Periodic discovery
  startPeriodicDiscovery(intervalMinutes = 30) {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
    }

    this.periodicTimer = setInterval(() => {
      if (!this.isDiscovering) {
        console.log('🔄 Starting periodic discovery...');
        this.startDiscovery();
      }
    }, intervalMinutes * 60 * 1000);
  }

  stopPeriodicDiscovery() {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }
}

module.exports = MQTTDiscoveryService;