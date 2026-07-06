const mqtt = require('mqtt');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const SparkplugDecoder = require('./sparkplugDecoder');

class MQTTClientManager extends EventEmitter {
  constructor(io) {
    super();
    this.io = io;
    this.connections = new Map(); // brokerId -> connection info
    this.clients = new Map(); // brokerId -> mqtt client
    this.topicData = new Map(); // brokerId -> topic -> messages
    this.clientMetrics = new Map(); // brokerId -> metrics
    this.sparkplugDecoder = new SparkplugDecoder();
    this.messageBuffer = new Map(); // Store recent messages for AI analysis
    this.maxBufferSize = 10000; // Maximum messages to keep in buffer

    this.setupMessageHandling();
  }

  setupMessageHandling() {
    // Clean old messages periodically
    setInterval(() => {
      this.cleanupOldMessages();
    }, 300000); // Every 5 minutes
  }

  // Emits only to the browser socket that owns this broker connection instead of
  // broadcasting to every connected client. No-op for API-created connections
  // (socketId 'api-client'), which poll via REST.
  emitToOwner(brokerId, event, payload) {
    const info = this.connections.get(brokerId);
    const socketId = info && info.socketId;
    if (socketId && socketId !== 'api-client') {
      this.io.to(socketId).emit(event, payload);
    }
  }

  // Strips secrets (password, TLS material) from a connection object before it
  // is sent to any client.
  publicConnectionInfo(info) {
    if (!info || typeof info !== 'object') {
      return info;
    }
    const { password, cert, key, ca, ...safe } = info;
    return safe;
  }

  async connectToBroker(connectionConfig, socketId) {
    const brokerId = connectionConfig.id || uuidv4();
    
    try {
      // Validate connection config
      if (!connectionConfig.host || !connectionConfig.port) {
        throw new Error('Host and port are required');
      }
      this.validateConnectionTarget(connectionConfig);

      const clientId = connectionConfig.clientId || `MQTTExplore_${Date.now()}`;
      const brokerUrl = this.buildBrokerUrl(connectionConfig);

      console.log(`🔗 Connecting to MQTT broker: ${brokerUrl}`);

      // MQTT connection options
      const options = {
        clientId,
        keepalive: connectionConfig.keepalive || 60,
        connectTimeout: connectionConfig.timeout || 30000,
        reconnectPeriod: connectionConfig.reconnect ? 5000 : 0,
        clean: connectionConfig.cleanSession !== false,
        rejectUnauthorized: connectionConfig.rejectUnauthorized !== false
      };

      // Add authentication if provided
      if (connectionConfig.username) {
        options.username = connectionConfig.username;
        options.password = connectionConfig.password || '';
      }

      // Add TLS options if using secure connection
      if (connectionConfig.protocol === 'mqtts' || connectionConfig.port === 8883) {
        options.protocol = 'mqtts';
        if (connectionConfig.ca) options.ca = connectionConfig.ca;
        if (connectionConfig.cert) options.cert = connectionConfig.cert;
        if (connectionConfig.key) options.key = connectionConfig.key;
      }

      // Create MQTT client
      const client = mqtt.connect(brokerUrl, options);

      // Store connection info
      const connectionInfo = {
        id: brokerId,
        ...connectionConfig,
        clientId,
        socketId,
        status: 'connecting',
        connectedAt: null,
        lastActivity: new Date(),
        metrics: {
          messagesReceived: 0,
          messagesSent: 0,
          bytesReceived: 0,
          bytesSent: 0,
          subscriptions: 0,
          errors: 0
        }
      };

      this.connections.set(brokerId, connectionInfo);
      this.clients.set(brokerId, client);
      this.topicData.set(brokerId, new Map());
      // Same object reference (not a copy) so subscription counters and message
      // counters no longer drift across the two maps.
      this.clientMetrics.set(brokerId, connectionInfo.metrics);

      // Set up event handlers
      this.setupClientEventHandlers(client, brokerId);

      // Emit connection attempt to the owning socket only (no credentials).
      if (socketId && socketId !== 'api-client') {
        this.io.to(socketId).emit('mqtt-connection-attempt', {
          brokerId,
          connectionInfo: this.publicConnectionInfo(connectionInfo)
        });
      }

      return { brokerId, status: 'connecting' };

    } catch (error) {
      console.error(`Failed to connect to broker ${connectionConfig.host}:${connectionConfig.port}:`, error);
      if (socketId && socketId !== 'api-client') {
        this.io.to(socketId).emit('mqtt-connection-error', {
          brokerId,
          error: error.message,
          connectionConfig: this.publicConnectionInfo(connectionConfig)
        });
      }
      throw error;
    }
  }

  setupClientEventHandlers(client, brokerId) {
    const connectionInfo = this.connections.get(brokerId);

    client.on('connect', (connack) => {
      console.log(`✅ Connected to MQTT broker: ${brokerId}`);
      
      connectionInfo.status = 'connected';
      connectionInfo.connectedAt = new Date();
      connectionInfo.connack = connack;

      this.emitToOwner(brokerId, 'mqtt-connected', {
        brokerId,
        connectionInfo: this.publicConnectionInfo(connectionInfo),
        connack
      });

      // Auto-subscribe to wildcard if enabled
      if (connectionInfo.autoSubscribeWildcard !== false) {
        this.subscribeToTopic(brokerId, '#', 0);
      }
    });

    client.on('message', (topic, message, packet) => {
      this.handleMessage(brokerId, topic, message, packet);
    });

    client.on('error', (error) => {
      console.error(`MQTT Error for ${brokerId}:`, error);
      
      connectionInfo.status = 'error';
      connectionInfo.lastError = error.message;
      connectionInfo.metrics.errors++;

      this.emitToOwner(brokerId, 'mqtt-error', {
        brokerId,
        error: error.message,
        connectionInfo: this.publicConnectionInfo(connectionInfo)
      });
    });

    client.on('close', () => {
      console.log(`🔌 MQTT connection closed: ${brokerId}`);
      
      connectionInfo.status = 'disconnected';
      connectionInfo.disconnectedAt = new Date();

      this.emitToOwner(brokerId, 'mqtt-disconnected', {
        brokerId,
        connectionInfo: this.publicConnectionInfo(connectionInfo)
      });
    });

    client.on('offline', () => {
      console.log(`📴 MQTT client offline: ${brokerId}`);
      connectionInfo.status = 'offline';

      this.emitToOwner(brokerId, 'mqtt-offline', { brokerId });
    });

    client.on('reconnect', () => {
      console.log(`🔄 MQTT client reconnecting: ${brokerId}`);
      connectionInfo.status = 'reconnecting';

      this.emitToOwner(brokerId, 'mqtt-reconnecting', { brokerId });
    });
  }

  handleMessage(brokerId, topic, message, packet) {
    const connectionInfo = this.connections.get(brokerId);
    const metrics = this.clientMetrics.get(brokerId);
    const topicMap = this.topicData.get(brokerId);

    // Update metrics
    metrics.messagesReceived++;
    metrics.bytesReceived += message.length;
    connectionInfo.lastActivity = new Date();

    // Parse message
    let parsedMessage;
    try {
      parsedMessage = JSON.parse(message.toString());
    } catch (error) {
      parsedMessage = message.toString();
    }

    // Create message object
    const messageObj = {
      id: uuidv4(),
      brokerId,
      topic,
      payload: parsedMessage,
      rawPayload: message,
      qos: packet.qos,
      retain: packet.retain,
      dup: packet.dup,
      timestamp: new Date(),
      size: message.length,
      type: this.detectMessageType(topic, parsedMessage)
    };

    // Decode Sparkplug B if applicable
    if (this.isSparkplugTopic(topic)) {
      try {
        messageObj.sparkplug = this.sparkplugDecoder.decode(message, topic);
        messageObj.type = 'sparkplug';
      } catch (error) {
        console.error('Sparkplug decode error:', error);
        messageObj.sparkplugError = error.message;
      }
    }

    // Store message in topic map
    if (!topicMap.has(topic)) {
      topicMap.set(topic, []);
    }
    const topicMessages = topicMap.get(topic);
    topicMessages.push(messageObj);

    // Keep only recent messages per topic
    if (topicMessages.length > 1000) {
      topicMessages.splice(0, topicMessages.length - 1000);
    }

    // Add to global message buffer for AI analysis
    this.addToMessageBuffer(messageObj);

    // Emit to the owning client only
    this.emitToOwner(brokerId, 'mqtt-message', messageObj);

    // Emit topic update
    this.emitToOwner(brokerId, 'topic-updated', {
      brokerId,
      topic,
      messageCount: topicMessages.length,
      lastMessage: messageObj,
      lastActivity: new Date()
    });

    // Update metrics
    this.emitToOwner(brokerId, 'broker-metrics-updated', {
      brokerId,
      metrics: { ...metrics }
    });
  }

  addToMessageBuffer(message) {
    if (!this.messageBuffer.has(message.brokerId)) {
      this.messageBuffer.set(message.brokerId, []);
    }

    const buffer = this.messageBuffer.get(message.brokerId);
    buffer.push(message);

    // Keep buffer size manageable
    if (buffer.length > this.maxBufferSize) {
      buffer.splice(0, buffer.length - this.maxBufferSize);
    }
  }

  subscribeToTopic(brokerId, topic, qos = 0) {
    const client = this.clients.get(brokerId);
    const connectionInfo = this.connections.get(brokerId);

    if (!client || connectionInfo.status !== 'connected') {
      throw new Error('Client not connected');
    }

    client.subscribe(topic, { qos }, (error, granted) => {
      if (error) {
        console.error(`Subscription error for ${topic}:`, error);
        this.emitToOwner(brokerId, 'subscription-error', {
          brokerId,
          topic,
          error: error.message
        });
        return;
      }

      console.log(`📝 Subscribed to topic: ${topic} (QoS ${qos})`);
      connectionInfo.metrics.subscriptions++;

      this.emitToOwner(brokerId, 'subscription-success', {
        brokerId,
        topic,
        qos,
        granted
      });
    });
  }

  unsubscribeFromTopic(brokerId, topic) {
    const client = this.clients.get(brokerId);
    const connectionInfo = this.connections.get(brokerId);

    if (!client) {
      throw new Error('Client not found');
    }

    client.unsubscribe(topic, (error) => {
      if (error) {
        console.error(`Unsubscription error for ${topic}:`, error);
        this.emitToOwner(brokerId, 'unsubscription-error', {
          brokerId,
          topic,
          error: error.message
        });
        return;
      }

      console.log(`📝 Unsubscribed from topic: ${topic}`);
      connectionInfo.metrics.subscriptions--;

      this.emitToOwner(brokerId, 'unsubscription-success', {
        brokerId,
        topic
      });
    });
  }

  publishMessage(brokerId, topic, payload, options = {}) {
    const client = this.clients.get(brokerId);
    const connectionInfo = this.connections.get(brokerId);
    const metrics = this.clientMetrics.get(brokerId);

    if (!client || connectionInfo.status !== 'connected') {
      throw new Error('Client not connected');
    }

    const publishOptions = {
      qos: options.qos || 0,
      retain: options.retain || false,
      dup: options.dup || false
    };

    const messagePayload = typeof payload === 'string' ? payload : JSON.stringify(payload);

    client.publish(topic, messagePayload, publishOptions, (error) => {
      if (error) {
        console.error(`Publish error for ${topic}:`, error);
        metrics.errors++;
        this.emitToOwner(brokerId, 'publish-error', {
          brokerId,
          topic,
          error: error.message
        });
        return;
      }

      console.log(`📤 Published to topic: ${topic}`);
      metrics.messagesSent++;
      metrics.bytesSent += messagePayload.length;
      connectionInfo.lastActivity = new Date();

      this.emitToOwner(brokerId, 'publish-success', {
        brokerId,
        topic,
        payload: messagePayload,
        options: publishOptions,
        timestamp: new Date()
      });
    });
  }

  disconnectFromBroker(brokerId) {
    const client = this.clients.get(brokerId);

    if (client) {
      client.end(true);
    }

    console.log(`🔌 Disconnected from broker: ${brokerId}`);
    // Notify the owner before we drop the connection record it is looked up from.
    this.emitToOwner(brokerId, 'mqtt-disconnected', { brokerId });

    // Free ALL per-broker state to avoid unbounded growth across connect/disconnect.
    this.clients.delete(brokerId);
    this.connections.delete(brokerId);
    this.topicData.delete(brokerId);
    this.clientMetrics.delete(brokerId);
    this.messageBuffer.delete(brokerId);
  }

  buildBrokerUrl(config) {
    const protocol = config.protocol || (config.port === 8883 ? 'mqtts' : 'mqtt');
    return `${protocol}://${config.host}:${config.port}`;
  }

  // Validates a broker target. Auth already gates who can trigger a connection;
  // this rejects malformed input and, if configured, enforces a host allow-list.
  // It deliberately does NOT block private/LAN addresses — connecting to brokers
  // on the local network is this tool's primary purpose.
  validateConnectionTarget(config) {
    const protocol = config.protocol || (config.port === 8883 ? 'mqtts' : 'mqtt');
    if (!['mqtt', 'mqtts', 'ws', 'wss'].includes(protocol)) {
      throw new Error(`Unsupported protocol: ${protocol}`);
    }
    const port = Number(config.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port: ${config.port}`);
    }
    if (typeof config.host !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(config.host)) {
      throw new Error(`Invalid host: ${config.host}`);
    }
    const allowList = (process.env.MQTT_ALLOWED_HOSTS || '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean);
    if (allowList.length > 0 && !allowList.includes(config.host)) {
      throw new Error(`Host not permitted by MQTT_ALLOWED_HOSTS: ${config.host}`);
    }
  }

  detectMessageType(topic, payload) {
    // Sparkplug B detection
    if (this.isSparkplugTopic(topic)) {
      return 'sparkplug';
    }

    // JSON detection
    if (typeof payload === 'object') {
      return 'json';
    }

    // Try to detect other patterns
    if (topic.includes('telemetry') || topic.includes('sensor')) {
      return 'telemetry';
    }

    if (topic.includes('command') || topic.includes('cmd')) {
      return 'command';
    }

    if (topic.includes('alarm') || topic.includes('alert')) {
      return 'alarm';
    }

    if (topic.includes('config') || topic.includes('settings')) {
      return 'configuration';
    }

    return 'unknown';
  }

  isSparkplugTopic(topic) {
    return topic.startsWith('spBv1.0/') || 
           topic.includes('/NBIRTH/') || 
           topic.includes('/DBIRTH/') ||
           topic.includes('/NDATA/') || 
           topic.includes('/DDATA/') ||
           topic.includes('/NDEATH/') || 
           topic.includes('/DDEATH/');
  }

  cleanupOldMessages() {
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago

    this.topicData.forEach((topicMap) => {
      topicMap.forEach((messages, topic) => {
        const filteredMessages = messages.filter(msg => msg.timestamp > cutoffTime);
        // Drop the topic key entirely when it empties out, so the map does not
        // grow unbounded under a wildcard subscription to a topic-spamming broker.
        if (filteredMessages.length === 0) {
          topicMap.delete(topic);
        } else {
          topicMap.set(topic, filteredMessages);
        }
      });
    });

    this.messageBuffer.forEach((messages, brokerId) => {
      const filteredMessages = messages.filter(msg => msg.timestamp > cutoffTime);
      this.messageBuffer.set(brokerId, filteredMessages);
    });
  }

  cleanupSocketConnections(socketId) {
    // Find and disconnect brokers associated with this socket
    this.connections.forEach((connectionInfo, brokerId) => {
      if (connectionInfo.socketId === socketId) {
        this.disconnectFromBroker(brokerId);
      }
    });
  }

  // Getter methods for other services
  getConnectionStatus() {
    const status = {};
    this.connections.forEach((info, brokerId) => {
      status[brokerId] = {
        status: info.status,
        host: info.host,
        port: info.port,
        connectedAt: info.connectedAt,
        lastActivity: info.lastActivity
      };
    });
    return status;
  }

  getAllData() {
    const data = {
      connections: {},
      topics: {},
      messages: {},
      metrics: {}
    };

    this.connections.forEach((info, brokerId) => {
      data.connections[brokerId] = { ...info };
      data.topics[brokerId] = {};
      data.messages[brokerId] = this.messageBuffer.get(brokerId) || [];
      data.metrics[brokerId] = this.clientMetrics.get(brokerId) || {};

      const topicMap = this.topicData.get(brokerId);
      if (topicMap) {
        topicMap.forEach((messages, topic) => {
          data.topics[brokerId][topic] = {
            messageCount: messages.length,
            lastMessage: messages[messages.length - 1],
            messages: messages.slice(-100) // Last 100 messages
          };
        });
      }
    });

    return data;
  }

  getTopicsByBroker(brokerId) {
    const topicMap = this.topicData.get(brokerId);
    if (!topicMap) return {};

    const result = {};
    topicMap.forEach((messages, topic) => {
      result[topic] = {
        messageCount: messages.length,
        lastMessage: messages[messages.length - 1],
        lastActivity: messages[messages.length - 1]?.timestamp
      };
    });

    return result;
  }

  getMessagesForTopic(brokerId, topic, limit = 100) {
    const topicMap = this.topicData.get(brokerId);
    if (!topicMap || !topicMap.has(topic)) return [];

    const messages = topicMap.get(topic);
    return messages.slice(-limit);
  }
}

module.exports = MQTTClientManager;