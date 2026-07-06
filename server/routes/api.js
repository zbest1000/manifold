const express = require('express');
const router = express.Router();

// System status endpoint
router.get('/status', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const status = {
      server: 'running',
      timestamp: new Date(),
      version: '1.0.0',
      services: {
        mqttDiscovery: services.mqttDiscovery.getDiscoveryStatus(),
        mqttClients: services.mqttClientManager.getConnectionStatus(),
        aiService: services.aiService.getStatus(),
        networkScanner: services.networkScanner.getStatus(),
        dataExporter: services.dataExporter.getStatus()
      },
      system: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        platform: process.platform,
        nodeVersion: process.version
      }
    };

    res.json(status);
  } catch (error) {
    console.error('Status endpoint error:', error);
    res.status(500).json({ error: 'Failed to get system status' });
  }
});

// Get discovered brokers
router.get('/brokers', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const brokers = services.mqttDiscovery.getDiscoveredBrokers();
    res.json(brokers);
  } catch (error) {
    console.error('Get brokers error:', error);
    res.status(500).json({ error: 'Failed to get brokers' });
  }
});

// Get specific broker details
router.get('/brokers/:id', (req, res) => {
  const { services } = req.app.locals;
  const { id } = req.params;
  
  try {
    const broker = services.mqttDiscovery.getBrokerById(id);
    if (!broker) {
      return res.status(404).json({ error: 'Broker not found' });
    }
    res.json(broker);
  } catch (error) {
    console.error('Get broker details error:', error);
    res.status(500).json({ error: 'Failed to get broker details' });
  }
});

// Remove a discovered broker
router.delete('/brokers/:id', (req, res) => {
  const { services } = req.app.locals;
  const { id } = req.params;
  
  try {
    const removed = services.mqttDiscovery.removeBroker(id);
    if (!removed) {
      return res.status(404).json({ error: 'Broker not found' });
    }
    res.json({ success: true, message: 'Broker removed' });
  } catch (error) {
    console.error('Remove broker error:', error);
    res.status(500).json({ error: 'Failed to remove broker' });
  }
});

// Start broker discovery
router.post('/discovery/start', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const options = req.body;
    const brokers = services.mqttDiscovery.startDiscovery(options);
    res.json({ 
      success: true, 
      message: 'Discovery started',
      initialBrokers: brokers
    });
  } catch (error) {
    console.error('Start discovery error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Stop broker discovery
router.post('/discovery/stop', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    services.mqttDiscovery.stopDiscovery();
    res.json({ success: true, message: 'Discovery stopped' });
  } catch (error) {
    console.error('Stop discovery error:', error);
    res.status(500).json({ error: 'Failed to stop discovery' });
  }
});

// Get discovery status
router.get('/discovery/status', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const status = services.mqttDiscovery.getDiscoveryStatus();
    res.json(status);
  } catch (error) {
    console.error('Get discovery status error:', error);
    res.status(500).json({ error: 'Failed to get discovery status' });
  }
});

// Start network scan
router.post('/network/scan/start', async (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const options = req.body;
    const results = await services.networkScanner.startScan(options);
    res.json({ 
      success: true, 
      message: 'Network scan completed',
      results: results
    });
  } catch (error) {
    console.error('Network scan error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Stop network scan
router.post('/network/scan/stop', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    services.networkScanner.stopScan();
    res.json({ success: true, message: 'Network scan stopped' });
  } catch (error) {
    console.error('Stop network scan error:', error);
    res.status(500).json({ error: 'Failed to stop network scan' });
  }
});

// Get network scan results
router.get('/network/scan/results', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const results = services.networkScanner.getAllScanResults();
    res.json(results);
  } catch (error) {
    console.error('Get scan results error:', error);
    res.status(500).json({ error: 'Failed to get scan results' });
  }
});

// Get specific scan result
router.get('/network/scan/results/:scanId', (req, res) => {
  const { services } = req.app.locals;
  const { scanId } = req.params;
  
  try {
    const result = services.networkScanner.getScanResults(scanId);
    if (!result) {
      return res.status(404).json({ error: 'Scan result not found' });
    }
    res.json(result);
  } catch (error) {
    console.error('Get scan result error:', error);
    res.status(500).json({ error: 'Failed to get scan result' });
  }
});

// Get network scan history
router.get('/network/scan/history', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const history = services.networkScanner.getScanHistory();
    res.json(history);
  } catch (error) {
    console.error('Get scan history error:', error);
    res.status(500).json({ error: 'Failed to get scan history' });
  }
});

// Network health check
router.get('/network/health', async (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const targets = req.query.targets ? req.query.targets.split(',') : undefined;
    const health = await services.networkScanner.quickHealthCheck(targets);
    res.json(health);
  } catch (error) {
    console.error('Network health check error:', error);
    res.status(500).json({ error: 'Failed to perform health check' });
  }
});

// Export data
router.post('/export', async (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const options = req.body;
    const mqttData = services.mqttClientManager.getAllData();
    const exportResult = await services.dataExporter.exportData(mqttData, options);
    
    res.json({
      success: true,
      export: exportResult
    });
  } catch (error) {
    console.error('Export data error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get export history
router.get('/export/history', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const history = services.dataExporter.getExportHistory();
    res.json(history);
  } catch (error) {
    console.error('Get export history error:', error);
    res.status(500).json({ error: 'Failed to get export history' });
  }
});

// Download export file
router.get('/export/:exportId/download', async (req, res) => {
  const { services } = req.app.locals;
  const { exportId } = req.params;
  
  try {
    const exportFile = await services.dataExporter.getExportFile(exportId);
    
    res.setHeader('Content-Disposition', `attachment; filename="${exportFile.filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(exportFile.content);
  } catch (error) {
    console.error('Download export error:', error);
    res.status(404).json({ error: 'Internal server error' });
  }
});

// Delete export file
router.delete('/export/:exportId', async (req, res) => {
  const { services } = req.app.locals;
  const { exportId } = req.params;
  
  try {
    await services.dataExporter.deleteExportFile(exportId);
    res.json({ success: true, message: 'Export deleted' });
  } catch (error) {
    console.error('Delete export error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all MQTT data
router.get('/data', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const data = services.mqttClientManager.getAllData();
    res.json(data);
  } catch (error) {
    console.error('Get MQTT data error:', error);
    res.status(500).json({ error: 'Failed to get MQTT data' });
  }
});

// Get topics for a specific broker
router.get('/data/brokers/:brokerId/topics', (req, res) => {
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
router.get('/data/brokers/:brokerId/topics/:topicName/messages', (req, res) => {
  const { services } = req.app.locals;
  const { brokerId, topicName } = req.params;
  const { limit = 100 } = req.query;
  
  try {
    const topic = decodeURIComponent(topicName);
    const messages = services.mqttClientManager.getMessagesForTopic(brokerId, topic, parseInt(limit));
    res.json(messages);
  } catch (error) {
    console.error('Get topic messages error:', error);
    res.status(500).json({ error: 'Failed to get topic messages' });
  }
});

// Configuration endpoints
router.get('/config', (req, res) => {
  try {
    const config = {
      aiEnabled: process.env.OPENAI_API_KEY ? true : false,
      autoStartDiscovery: process.env.AUTO_START_DISCOVERY === 'true',
      defaultNetworkRange: process.env.DEFAULT_NETWORK_RANGE || '192.168.1.0/24',
      maxConnections: process.env.MAX_CONNECTIONS || 10,
      messageBufferSize: process.env.MESSAGE_BUFFER_SIZE || 10000
    };
    
    res.json(config);
  } catch (error) {
    console.error('Get config error:', error);
    res.status(500).json({ error: 'Failed to get configuration' });
  }
});

// Update configuration (basic implementation)
router.post('/config', (req, res) => {
  try {
    // In a real implementation, you'd validate and apply the configuration
    const updates = req.body;
    
    res.json({ 
      success: true, 
      message: 'Configuration updated',
      note: 'Some changes may require server restart'
    });
  } catch (error) {
    console.error('Update config error:', error);
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

// System metrics
router.get('/metrics', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const metrics = {
      timestamp: new Date(),
      system: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage()
      },
      mqtt: {
        activeBrokers: Object.keys(services.mqttClientManager.getConnectionStatus()).length,
        totalMessages: Object.values(services.mqttClientManager.getAllData().messages || {})
          .reduce((sum, messages) => sum + messages.length, 0)
      },
      discovery: {
        discoveredBrokers: services.mqttDiscovery.getDiscoveredBrokers().length,
        isScanning: services.mqttDiscovery.getDiscoveryStatus().isDiscovering
      },
      network: {
        isScanning: services.networkScanner.isScanning(),
        totalScans: services.networkScanner.getStatus().totalScans
      },
      exports: {
        totalExports: services.dataExporter.getStatus().totalExports
      }
    };
    
    res.json(metrics);
  } catch (error) {
    console.error('Get metrics error:', error);
    res.status(500).json({ error: 'Failed to get metrics' });
  }
});

// Clear all data (for development/testing)
router.post('/clear', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    // Disconnect all MQTT clients
    const connections = services.mqttClientManager.getConnectionStatus();
    Object.keys(connections).forEach(brokerId => {
      services.mqttClientManager.disconnectFromBroker(brokerId);
    });
    
    // Clear scan history
    services.networkScanner.clearHistory();
    
    res.json({ 
      success: true, 
      message: 'All data cleared'
    });
  } catch (error) {
    console.error('Clear data error:', error);
    res.status(500).json({ error: 'Failed to clear data' });
  }
});

module.exports = router;