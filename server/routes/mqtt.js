const express = require('express');
const router = express.Router();

// Get all MQTT connections
router.get('/connections', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const connections = services.mqttClientManager.getConnectionStatus();
    res.json(connections);
  } catch (error) {
    console.error('Get MQTT connections error:', error);
    res.status(500).json({ error: 'Failed to get MQTT connections' });
  }
});

// Connect to an MQTT broker
router.post('/connect', async (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const connectionConfig = req.body;
    
    // Validate required fields
    if (!connectionConfig.host || !connectionConfig.port) {
      return res.status(400).json({ error: 'Host and port are required' });
    }

    const socketId = req.headers['x-socket-id'] || 'api-client';
    const result = await services.mqttClientManager.connectToBroker(connectionConfig, socketId);
    
    res.json({
      success: true,
      message: 'Connection attempt started',
      brokerId: result.brokerId,
      status: result.status
    });
  } catch (error) {
    console.error('MQTT connect error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Disconnect from an MQTT broker
router.post('/disconnect/:brokerId', (req, res) => {
  const { services } = req.app.locals;
  const { brokerId } = req.params;
  
  try {
    services.mqttClientManager.disconnectFromBroker(brokerId);
    res.json({
      success: true,
      message: `Disconnected from broker ${brokerId}`
    });
  } catch (error) {
    console.error('MQTT disconnect error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Subscribe to a topic
router.post('/subscribe', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const { brokerId, topic, qos = 0 } = req.body;
    
    if (!brokerId || !topic) {
      return res.status(400).json({ error: 'Broker ID and topic are required' });
    }

    services.mqttClientManager.subscribeToTopic(brokerId, topic, qos);
    
    res.json({
      success: true,
      message: `Subscribed to topic ${topic}`,
      brokerId,
      topic,
      qos
    });
  } catch (error) {
    console.error('MQTT subscribe error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unsubscribe from a topic
router.post('/unsubscribe', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const { brokerId, topic } = req.body;
    
    if (!brokerId || !topic) {
      return res.status(400).json({ error: 'Broker ID and topic are required' });
    }

    services.mqttClientManager.unsubscribeFromTopic(brokerId, topic);
    
    res.json({
      success: true,
      message: `Unsubscribed from topic ${topic}`,
      brokerId,
      topic
    });
  } catch (error) {
    console.error('MQTT unsubscribe error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Publish a message
router.post('/publish', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const { brokerId, topic, payload, options = {} } = req.body;
    
    if (!brokerId || !topic || payload === undefined) {
      return res.status(400).json({ error: 'Broker ID, topic, and payload are required' });
    }

    services.mqttClientManager.publishMessage(brokerId, topic, payload, options);
    
    res.json({
      success: true,
      message: `Message published to topic ${topic}`,
      brokerId,
      topic,
      options
    });
  } catch (error) {
    console.error('MQTT publish error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get topics for a broker
router.get('/:brokerId/topics', (req, res) => {
  const { services } = req.app.locals;
  const { brokerId } = req.params;
  
  try {
    const topics = services.mqttClientManager.getTopicsByBroker(brokerId);
    res.json(topics);
  } catch (error) {
    console.error('Get broker topics error:', error);
    res.status(500).json({ error: 'Failed to get broker topics' });
  }
});

// Get messages for a specific topic
router.get('/:brokerId/topics/:topicName/messages', (req, res) => {
  const { services } = req.app.locals;
  const { brokerId, topicName } = req.params;
  const { limit = 100, offset = 0 } = req.query;
  
  try {
    const topic = decodeURIComponent(topicName);
    const messages = services.mqttClientManager.getMessagesForTopic(
      brokerId, 
      topic, 
      parseInt(limit)
    );
    
    // Apply offset if needed
    const startIndex = parseInt(offset);
    const paginatedMessages = messages.slice(startIndex, startIndex + parseInt(limit));
    
    res.json({
      messages: paginatedMessages,
      total: messages.length,
      limit: parseInt(limit),
      offset: startIndex
    });
  } catch (error) {
    console.error('Get topic messages error:', error);
    res.status(500).json({ error: 'Failed to get topic messages' });
  }
});

// Get Sparkplug B specific data
router.get('/sparkplug/data', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const allData = services.mqttClientManager.getAllData();
    const sparkplugData = {
      groups: {},
      totalMessages: 0,
      messageTypes: {},
      edgeNodes: new Set(),
      devices: new Set(),
      metrics: []
    };

    // Process all messages to extract Sparkplug B data
    Object.entries(allData.messages || {}).forEach(([brokerId, messages]) => {
      messages.forEach(msg => {
        if (msg.sparkplug) {
          sparkplugData.totalMessages++;
          
          const topicParts = msg.topic.split('/');
          if (topicParts.length >= 4 && topicParts[0] === 'spBv1.0') {
            const groupId = topicParts[1];
            const messageType = topicParts[2];
            const edgeNodeId = topicParts[3];
            const deviceId = topicParts.length > 4 ? topicParts.slice(4).join('/') : null;

            // Count message types
            sparkplugData.messageTypes[messageType] = 
              (sparkplugData.messageTypes[messageType] || 0) + 1;

            // Track edge nodes and devices
            sparkplugData.edgeNodes.add(edgeNodeId);
            if (deviceId) {
              sparkplugData.devices.add(deviceId);
            }

            // Initialize group if needed
            if (!sparkplugData.groups[groupId]) {
              sparkplugData.groups[groupId] = {
                id: groupId,
                edgeNodes: {},
                messageCount: 0,
                lastActivity: null
              };
            }

            const group = sparkplugData.groups[groupId];
            group.messageCount++;
            group.lastActivity = msg.timestamp;

            // Initialize edge node if needed
            if (!group.edgeNodes[edgeNodeId]) {
              group.edgeNodes[edgeNodeId] = {
                id: edgeNodeId,
                devices: {},
                messageCount: 0,
                lastActivity: null,
                metrics: []
              };
            }

            const edgeNode = group.edgeNodes[edgeNodeId];
            edgeNode.messageCount++;
            edgeNode.lastActivity = msg.timestamp;

            // Process device if present
            if (deviceId) {
              if (!edgeNode.devices[deviceId]) {
                edgeNode.devices[deviceId] = {
                  id: deviceId,
                  messageCount: 0,
                  lastActivity: null,
                  metrics: []
                };
              }

              const device = edgeNode.devices[deviceId];
              device.messageCount++;
              device.lastActivity = msg.timestamp;

              // Add metrics to device
              if (msg.sparkplug.metrics) {
                device.metrics.push(...msg.sparkplug.metrics.map(metric => ({
                  ...metric,
                  timestamp: msg.timestamp,
                  messageType
                })));
              }
            } else {
              // Add metrics to edge node
              if (msg.sparkplug.metrics) {
                edgeNode.metrics.push(...msg.sparkplug.metrics.map(metric => ({
                  ...metric,
                  timestamp: msg.timestamp,
                  messageType
                })));
              }
            }

            // Add to global metrics
            if (msg.sparkplug.metrics) {
              sparkplugData.metrics.push(...msg.sparkplug.metrics.map(metric => ({
                ...metric,
                timestamp: msg.timestamp,
                groupId,
                edgeNodeId,
                deviceId,
                messageType,
                brokerId
              })));
            }
          }
        }
      });
    });

    // Convert sets to arrays
    sparkplugData.edgeNodes = Array.from(sparkplugData.edgeNodes);
    sparkplugData.devices = Array.from(sparkplugData.devices);

    res.json(sparkplugData);
  } catch (error) {
    console.error('Get Sparkplug data error:', error);
    res.status(500).json({ error: 'Failed to get Sparkplug data' });
  }
});

// Get Sparkplug B data for a specific group
router.get('/sparkplug/groups/:groupId', (req, res) => {
  const { services } = req.app.locals;
  const { groupId } = req.params;
  
  try {
    const allData = services.mqttClientManager.getAllData();
    const groupData = {
      id: groupId,
      edgeNodes: {},
      messages: [],
      metrics: [],
      summary: {
        messageCount: 0,
        edgeNodeCount: 0,
        deviceCount: 0,
        metricCount: 0,
        messageTypes: {}
      }
    };

    // Filter messages for this group
    Object.entries(allData.messages || {}).forEach(([brokerId, messages]) => {
      messages.forEach(msg => {
        if (msg.sparkplug && msg.topic.startsWith(`spBv1.0/${groupId}/`)) {
          groupData.messages.push(msg);
          groupData.summary.messageCount++;

          const topicParts = msg.topic.split('/');
          const messageType = topicParts[2];
          const edgeNodeId = topicParts[3];
          const deviceId = topicParts.length > 4 ? topicParts.slice(4).join('/') : null;

          // Count message types
          groupData.summary.messageTypes[messageType] = 
            (groupData.summary.messageTypes[messageType] || 0) + 1;

          // Process edge nodes
          if (!groupData.edgeNodes[edgeNodeId]) {
            groupData.edgeNodes[edgeNodeId] = {
              id: edgeNodeId,
              devices: {},
              messageCount: 0,
              metrics: []
            };
            groupData.summary.edgeNodeCount++;
          }

          const edgeNode = groupData.edgeNodes[edgeNodeId];
          edgeNode.messageCount++;

          // Process devices
          if (deviceId) {
            if (!edgeNode.devices[deviceId]) {
              edgeNode.devices[deviceId] = {
                id: deviceId,
                messageCount: 0,
                metrics: []
              };
              groupData.summary.deviceCount++;
            }

            edgeNode.devices[deviceId].messageCount++;
          }

          // Process metrics
          if (msg.sparkplug.metrics) {
            groupData.summary.metricCount += msg.sparkplug.metrics.length;
            groupData.metrics.push(...msg.sparkplug.metrics.map(metric => ({
              ...metric,
              timestamp: msg.timestamp,
              edgeNodeId,
              deviceId,
              messageType,
              brokerId
            })));
          }
        }
      });
    });

    res.json(groupData);
  } catch (error) {
    console.error('Get Sparkplug group data error:', error);
    res.status(500).json({ error: 'Failed to get Sparkplug group data' });
  }
});

// Classify a payload using AI
router.post('/classify-payload', async (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const { payload, topic, metadata = {} } = req.body;
    
    if (!payload || !topic) {
      return res.status(400).json({ error: 'Payload and topic are required' });
    }

    const classification = await services.aiService.classifyPayload(payload, topic, metadata);
    
    res.json({
      success: true,
      classification: classification
    });
  } catch (error) {
    console.error('Classify payload error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get broker connection metrics
router.get('/:brokerId/metrics', (req, res) => {
  const { services } = req.app.locals;
  const { brokerId } = req.params;
  
  try {
    const allData = services.mqttClientManager.getAllData();
    const connectionInfo = allData.connections[brokerId];
    const metrics = allData.metrics[brokerId];
    
    if (!connectionInfo) {
      return res.status(404).json({ error: 'Broker not found' });
    }

    res.json({
      brokerId,
      connection: connectionInfo,
      metrics: metrics || {},
      timestamp: new Date()
    });
  } catch (error) {
    console.error('Get broker metrics error:', error);
    res.status(500).json({ error: 'Failed to get broker metrics' });
  }
});

// Test MQTT connection without establishing persistent connection
router.post('/test-connection', async (req, res) => {
  const mqtt = require('mqtt');
  
  try {
    const { host, port, protocol = 'mqtt', username, password, timeout = 10000 } = req.body;
    
    if (!host || !port) {
      return res.status(400).json({ error: 'Host and port are required' });
    }

    const brokerUrl = `${protocol}://${host}:${port}`;
    const options = {
      connectTimeout: timeout,
      reconnectPeriod: 0, // Don't reconnect
      clean: true
    };

    if (username) {
      options.username = username;
      options.password = password || '';
    }

    const testClient = mqtt.connect(brokerUrl, options);
    
    const testResult = await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        testClient.end();
        reject(new Error('Connection timeout'));
      }, timeout);

      testClient.on('connect', (connack) => {
        clearTimeout(timeoutId);
        testClient.end();
        resolve({
          success: true,
          message: 'Connection successful',
          connack: connack,
          brokerUrl: brokerUrl
        });
      });

      testClient.on('error', (error) => {
        clearTimeout(timeoutId);
        testClient.end();
        reject(error);
      });
    });

    res.json(testResult);
  } catch (error) {
    console.error('Test connection error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
});

// Get live message feed for a broker (for SSE or polling)
router.get('/:brokerId/live-feed', (req, res) => {
  const { services } = req.app.locals;
  const { brokerId } = req.params;
  const { since, limit = 50 } = req.query;
  
  try {
    const allData = services.mqttClientManager.getAllData();
    const messages = allData.messages[brokerId] || [];
    
    let filteredMessages = messages;
    
    // Filter by timestamp if 'since' parameter is provided
    if (since) {
      const sinceDate = new Date(since);
      filteredMessages = messages.filter(msg => 
        new Date(msg.timestamp) > sinceDate
      );
    }

    // Apply limit
    const recentMessages = filteredMessages.slice(-parseInt(limit));
    
    res.json({
      brokerId,
      messages: recentMessages,
      total: filteredMessages.length,
      timestamp: new Date()
    });
  } catch (error) {
    console.error('Get live feed error:', error);
    res.status(500).json({ error: 'Failed to get live feed' });
  }
});

module.exports = router;