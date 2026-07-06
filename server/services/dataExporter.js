const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ExcelJS = require('exceljs');

class DataExporter {
  constructor() {
    this.exportHistory = [];
    this.maxHistoryEntries = 50;
    this.exportDirectory = path.join(__dirname, '../exports');
    this.ensureExportDirectory();
  }

  async ensureExportDirectory() {
    try {
      await fs.mkdir(this.exportDirectory, { recursive: true });
    } catch (error) {
      console.error('Failed to create export directory:', error);
    }
  }

  // Prevents path traversal: reduces any client-supplied name to a safe basename
  // inside the export directory, falling back to a generated name when invalid.
  sanitizeFilename(name, fallback) {
    if (!name || typeof name !== 'string') {
      return fallback;
    }
    const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!base || base === '.' || base === '..' || base.startsWith('.')) {
      return fallback;
    }
    return base;
  }

  async exportData(mqttData, options = {}) {
    const exportId = uuidv4();
    const timestamp = new Date();
    
    const defaultOptions = {
      format: 'json',
      includeMessages: true,
      includeTopics: true,
      includeMetrics: true,
      includeBrokerInfo: true,
      includeSparkplugData: true,
      timeRange: 'all',
      filename: null,
      compression: false
    };

    const exportOptions = { ...defaultOptions, ...options };
    
    console.log(`📤 Starting data export: ${exportOptions.format.toUpperCase()}`);

    try {
      let exportResult;

      switch (exportOptions.format.toLowerCase()) {
        case 'json':
          exportResult = await this.exportJSON(mqttData, exportOptions, exportId);
          break;
        case 'csv':
          exportResult = await this.exportCSV(mqttData, exportOptions, exportId);
          break;
        case 'excel':
          exportResult = await this.exportExcel(mqttData, exportOptions, exportId);
          break;
        case 'yaml':
          exportResult = await this.exportYAML(mqttData, exportOptions, exportId);
          break;
        case 'network-map':
          exportResult = await this.exportNetworkMap(mqttData, exportOptions, exportId);
          break;
        case 'sparkplug-report':
          exportResult = await this.exportSparkplugReport(mqttData, exportOptions, exportId);
          break;
        default:
          throw new Error(`Unsupported export format: ${exportOptions.format}`);
      }

      // Add to export history
      this.addToHistory({
        id: exportId,
        format: exportOptions.format,
        timestamp: timestamp,
        filename: exportResult.filename,
        size: exportResult.size,
        options: exportOptions,
        status: 'completed'
      });

      console.log(`✅ Data export completed: ${exportResult.filename}`);
      return exportResult;

    } catch (error) {
      console.error('Data export failed:', error);
      
      this.addToHistory({
        id: exportId,
        format: exportOptions.format,
        timestamp: timestamp,
        error: error.message,
        options: exportOptions,
        status: 'failed'
      });

      throw error;
    }
  }

  async exportJSON(mqttData, options, exportId) {
    const filename = this.sanitizeFilename(options.filename, `mqtt-export-${exportId}.json`);
    const filepath = path.join(this.exportDirectory, filename);

    const exportData = this.prepareExportData(mqttData, options);
    
    // Pretty print JSON
    const jsonContent = JSON.stringify(exportData, null, 2);
    
    await fs.writeFile(filepath, jsonContent, 'utf8');
    
    const stats = await fs.stat(filepath);
    
    return {
      id: exportId,
      filename: filename,
      filepath: filepath,
      format: 'json',
      size: stats.size,
      timestamp: new Date()
    };
  }

  async exportCSV(mqttData, options, exportId) {
    const filename = this.sanitizeFilename(options.filename, `mqtt-export-${exportId}.csv`);
    const filepath = path.join(this.exportDirectory, filename);

    const csvContent = this.generateCSVContent(mqttData, options);
    
    await fs.writeFile(filepath, csvContent, 'utf8');
    
    const stats = await fs.stat(filepath);
    
    return {
      id: exportId,
      filename: filename,
      filepath: filepath,
      format: 'csv',
      size: stats.size,
      timestamp: new Date()
    };
  }

  async exportYAML(mqttData, options, exportId) {
    const filename = this.sanitizeFilename(options.filename, `mqtt-export-${exportId}.yaml`);
    const filepath = path.join(this.exportDirectory, filename);

    const exportData = this.prepareExportData(mqttData, options);
    const yamlContent = this.generateYAMLContent(exportData);
    
    await fs.writeFile(filepath, yamlContent, 'utf8');
    
    const stats = await fs.stat(filepath);
    
    return {
      id: exportId,
      filename: filename,
      filepath: filepath,
      format: 'yaml',
      size: stats.size,
      timestamp: new Date()
    };
  }

  async exportExcel(mqttData, options, exportId) {
    const filename = this.sanitizeFilename(options.filename, `mqtt-export-${exportId}.xlsx`);
    const filepath = path.join(this.exportDirectory, filename);

    const { sheets } = this.generateWorkbookData(mqttData, options);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'MQTT Explore';
    workbook.created = new Date();

    Object.entries(sheets).forEach(([sheetName, rows]) => {
      const worksheet = workbook.addWorksheet(sheetName);
      (rows || []).forEach((row, index) => {
        const added = worksheet.addRow(row);
        if (index === 0) {
          added.font = { bold: true }; // header row
        }
      });
    });

    await workbook.xlsx.writeFile(filepath);
    const stats = await fs.stat(filepath);

    return {
      id: exportId,
      filename: filename,
      filepath: filepath,
      format: 'excel',
      size: stats.size,
      timestamp: new Date()
    };
  }

  async exportNetworkMap(mqttData, options, exportId) {
    const filename = this.sanitizeFilename(options.filename, `network-map-${exportId}.json`);
    const filepath = path.join(this.exportDirectory, filename);

    const networkMap = this.generateNetworkMapData(mqttData);
    
    const mapContent = JSON.stringify(networkMap, null, 2);
    
    await fs.writeFile(filepath, mapContent, 'utf8');
    
    const stats = await fs.stat(filepath);
    
    return {
      id: exportId,
      filename: filename,
      filepath: filepath,
      format: 'network-map',
      size: stats.size,
      timestamp: new Date(),
      mapData: networkMap
    };
  }

  async exportSparkplugReport(mqttData, options, exportId) {
    const filename = this.sanitizeFilename(options.filename, `sparkplug-report-${exportId}.json`);
    const filepath = path.join(this.exportDirectory, filename);

    const sparkplugReport = this.generateSparkplugReport(mqttData);
    
    const reportContent = JSON.stringify(sparkplugReport, null, 2);
    
    await fs.writeFile(filepath, reportContent, 'utf8');
    
    const stats = await fs.stat(filepath);
    
    return {
      id: exportId,
      filename: filename,
      filepath: filepath,
      format: 'sparkplug-report',
      size: stats.size,
      timestamp: new Date(),
      reportData: sparkplugReport
    };
  }

  prepareExportData(mqttData, options) {
    const exportData = {
      metadata: {
        exportedAt: new Date(),
        exportOptions: options,
        summary: this.generateDataSummary(mqttData)
      }
    };

    if (options.includeBrokerInfo) {
      exportData.brokers = mqttData.connections || {};
    }

    if (options.includeTopics) {
      exportData.topics = mqttData.topics || {};
    }

    if (options.includeMessages) {
      exportData.messages = this.filterMessagesByTimeRange(mqttData.messages || {}, options.timeRange);
    }

    if (options.includeMetrics) {
      exportData.metrics = mqttData.metrics || {};
    }

    if (options.includeSparkplugData) {
      exportData.sparkplugData = this.extractSparkplugData(mqttData);
    }

    return exportData;
  }

  generateCSVContent(mqttData, options) {
    const rows = [];
    
    // Headers
    const headers = [
      'Timestamp',
      'Broker ID',
      'Topic',
      'Message Type',
      'Payload Size',
      'QoS',
      'Retained',
      'Client ID',
      'Sparkplug Group',
      'Sparkplug Edge Node',
      'Sparkplug Device',
      'Metric Count'
    ];
    
    rows.push(headers.join(','));

    // Messages data
    Object.entries(mqttData.messages || {}).forEach(([brokerId, messages]) => {
      const filteredMessages = this.filterMessagesByTimeRange({ [brokerId]: messages }, options.timeRange)[brokerId] || [];
      
      filteredMessages.forEach(msg => {
        const sparkplugInfo = this.parseSparkplugFromMessage(msg);
        
        const row = [
          msg.timestamp || '',
          brokerId,
          msg.topic || '',
          msg.type || '',
          msg.size || 0,
          msg.qos || 0,
          msg.retain || false,
          msg.clientId || '',
          sparkplugInfo.groupId || '',
          sparkplugInfo.edgeNodeId || '',
          sparkplugInfo.deviceId || '',
          sparkplugInfo.metricCount || 0
        ];
        
        rows.push(row.map(field => `"${field}"`).join(','));
      });
    });

    return rows.join('\n');
  }

  generateYAMLContent(data) {
    // Simple YAML generator (in a real implementation, use 'js-yaml' library)
    const yamlLines = [];
    
    const stringifyValue = (value, indent = 0) => {
      const spacing = '  '.repeat(indent);
      
      if (value === null || value === undefined) {
        return 'null';
      }
      
      if (typeof value === 'string') {
        return value.includes('\n') ? `|\n${spacing}  ${value.replace(/\n/g, `\n${spacing}  `)}` : `"${value}"`;
      }
      
      if (typeof value === 'number' || typeof value === 'boolean') {
        return value.toString();
      }
      
      if (value instanceof Date) {
        return `"${value.toISOString()}"`;
      }
      
      if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        return '\n' + value.map(item => `${spacing}- ${stringifyValue(item, indent + 1)}`).join('\n');
      }
      
      if (typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 0) return '{}';
        return '\n' + keys.map(key => `${spacing}${key}: ${stringifyValue(value[key], indent + 1)}`).join('\n');
      }
      
      return value.toString();
    };

    Object.entries(data).forEach(([key, value]) => {
      yamlLines.push(`${key}: ${stringifyValue(value)}`);
    });

    return yamlLines.join('\n');
  }

  generateWorkbookData(mqttData, options) {
    return {
      sheets: {
        'Brokers': this.generateBrokerSheet(mqttData),
        'Topics': this.generateTopicSheet(mqttData),
        'Messages': this.generateMessageSheet(mqttData, options),
        'Metrics': this.generateMetricSheet(mqttData),
        'Sparkplug': this.generateSparkplugSheet(mqttData),
        'Summary': this.generateSummarySheet(mqttData)
      }
    };
  }

  generateBrokerSheet(mqttData) {
    const rows = [
      ['Broker ID', 'Host', 'Port', 'Status', 'Protocol', 'Connected At', 'Last Activity', 'Messages Received', 'Messages Sent']
    ];

    Object.entries(mqttData.connections || {}).forEach(([brokerId, conn]) => {
      const metrics = mqttData.metrics?.[brokerId] || {};
      rows.push([
        brokerId,
        conn.host || '',
        conn.port || '',
        conn.status || '',
        conn.protocol || '',
        conn.connectedAt || '',
        conn.lastActivity || '',
        metrics.messagesReceived || 0,
        metrics.messagesSent || 0
      ]);
    });

    return rows;
  }

  generateTopicSheet(mqttData) {
    const rows = [
      ['Broker ID', 'Topic', 'Message Count', 'Last Message Time', 'Message Type', 'Average Size']
    ];

    Object.entries(mqttData.topics || {}).forEach(([brokerId, topics]) => {
      Object.entries(topics).forEach(([topic, info]) => {
        rows.push([
          brokerId,
          topic,
          info.messageCount || 0,
          info.lastMessage?.timestamp || '',
          info.lastMessage?.type || '',
          this.calculateAverageSize(info.messages || [])
        ]);
      });
    });

    return rows;
  }

  generateMessageSheet(mqttData, options) {
    const rows = [
      ['Timestamp', 'Broker ID', 'Topic', 'Type', 'Size', 'QoS', 'Retained', 'Payload Preview']
    ];

    Object.entries(mqttData.messages || {}).forEach(([brokerId, messages]) => {
      const filteredMessages = this.filterMessagesByTimeRange({ [brokerId]: messages }, options.timeRange)[brokerId] || [];
      
      filteredMessages.slice(0, 1000).forEach(msg => { // Limit to 1000 messages for Excel
        rows.push([
          msg.timestamp || '',
          brokerId,
          msg.topic || '',
          msg.type || '',
          msg.size || 0,
          msg.qos || 0,
          msg.retain || false,
          this.getPayloadPreview(msg.payload)
        ]);
      });
    });

    return rows;
  }

  generateMetricSheet(mqttData) {
    const rows = [
      ['Broker ID', 'Messages Received', 'Messages Sent', 'Bytes Received', 'Bytes Sent', 'Subscriptions', 'Errors']
    ];

    Object.entries(mqttData.metrics || {}).forEach(([brokerId, metrics]) => {
      rows.push([
        brokerId,
        metrics.messagesReceived || 0,
        metrics.messagesSent || 0,
        metrics.bytesReceived || 0,
        metrics.bytesSent || 0,
        metrics.subscriptions || 0,
        metrics.errors || 0
      ]);
    });

    return rows;
  }

  generateSparkplugSheet(mqttData) {
    const rows = [
      ['Timestamp', 'Broker ID', 'Group ID', 'Edge Node ID', 'Device ID', 'Message Type', 'Metric Name', 'Metric Value', 'Data Type']
    ];

    Object.entries(mqttData.messages || {}).forEach(([brokerId, messages]) => {
      messages.forEach(msg => {
        if (msg.sparkplug && msg.sparkplug.metrics) {
          const sparkplugInfo = this.parseSparkplugFromMessage(msg);
          
          msg.sparkplug.metrics.forEach(metric => {
            rows.push([
              msg.timestamp || '',
              brokerId,
              sparkplugInfo.groupId || '',
              sparkplugInfo.edgeNodeId || '',
              sparkplugInfo.deviceId || '',
              sparkplugInfo.messageType || '',
              metric.name || '',
              metric.value || '',
              metric.datatypeName || ''
            ]);
          });
        }
      });
    });

    return rows;
  }

  generateSummarySheet(mqttData) {
    const summary = this.generateDataSummary(mqttData);
    
    const rows = [
      ['Metric', 'Value'],
      ['Total Brokers', summary.totalBrokers],
      ['Total Topics', summary.totalTopics],
      ['Total Messages', summary.totalMessages],
      ['Sparkplug Messages', summary.sparkplugMessages],
      ['Message Types', Object.keys(summary.messageTypes).join(', ')],
      ['Export Time', new Date().toISOString()]
    ];

    return rows;
  }

  generateNetworkMapData(mqttData) {
    const nodes = [];
    const edges = [];
    const nodeMap = new Map();

    // Create broker nodes
    Object.entries(mqttData.connections || {}).forEach(([brokerId, conn]) => {
      const brokerNode = {
        id: brokerId,
        label: `${conn.host}:${conn.port}`,
        type: 'broker',
        status: conn.status,
        data: {
          host: conn.host,
          port: conn.port,
          protocol: conn.protocol,
          connectedAt: conn.connectedAt
        }
      };
      
      nodes.push(brokerNode);
      nodeMap.set(brokerId, brokerNode);
    });

    // Create topic nodes and edges
    Object.entries(mqttData.topics || {}).forEach(([brokerId, topics]) => {
      Object.entries(topics).forEach(([topic, info]) => {
        const topicId = `${brokerId}-topic-${topic}`;
        
        // Topic node
        const topicNode = {
          id: topicId,
          label: topic,
          type: 'topic',
          data: {
            messageCount: info.messageCount,
            lastActivity: info.lastMessage?.timestamp
          }
        };
        
        nodes.push(topicNode);

        // Edge from broker to topic
        edges.push({
          id: `${brokerId}-to-${topicId}`,
          source: brokerId,
          target: topicId,
          type: 'publishes',
          data: {
            messageCount: info.messageCount
          }
        });
      });
    });

    // Add Sparkplug B specific nodes
    const sparkplugData = this.extractSparkplugData(mqttData);
    
    Object.entries(sparkplugData.groups || {}).forEach(([groupId, group]) => {
      const groupNodeId = `sparkplug-group-${groupId}`;
      
      nodes.push({
        id: groupNodeId,
        label: `Group: ${groupId}`,
        type: 'sparkplug-group',
        data: group
      });

      Object.entries(group.edgeNodes || {}).forEach(([edgeNodeId, edgeNode]) => {
        const edgeNodeNodeId = `sparkplug-edge-${groupId}-${edgeNodeId}`;
        
        nodes.push({
          id: edgeNodeNodeId,
          label: `Edge: ${edgeNodeId}`,
          type: 'sparkplug-edge',
          data: edgeNode
        });

        edges.push({
          id: `${groupNodeId}-to-${edgeNodeNodeId}`,
          source: groupNodeId,
          target: edgeNodeNodeId,
          type: 'contains'
        });

        Object.entries(edgeNode.devices || {}).forEach(([deviceId, device]) => {
          const deviceNodeId = `sparkplug-device-${groupId}-${edgeNodeId}-${deviceId}`;
          
          nodes.push({
            id: deviceNodeId,
            label: `Device: ${deviceId}`,
            type: 'sparkplug-device',
            data: device
          });

          edges.push({
            id: `${edgeNodeNodeId}-to-${deviceNodeId}`,
            source: edgeNodeNodeId,
            target: deviceNodeId,
            type: 'contains'
          });
        });
      });
    });

    return {
      nodes: nodes,
      edges: edges,
      metadata: {
        totalNodes: nodes.length,
        totalEdges: edges.length,
        generatedAt: new Date(),
        summary: this.generateDataSummary(mqttData)
      }
    };
  }

  generateSparkplugReport(mqttData) {
    const sparkplugData = this.extractSparkplugData(mqttData);
    
    return {
      summary: {
        totalGroups: Object.keys(sparkplugData.groups || {}).length,
        totalEdgeNodes: Object.values(sparkplugData.groups || {}).reduce((sum, group) => 
          sum + Object.keys(group.edgeNodes || {}).length, 0),
        totalDevices: Object.values(sparkplugData.groups || {}).reduce((sum, group) => 
          sum + Object.values(group.edgeNodes || {}).reduce((subSum, edge) => 
            subSum + Object.keys(edge.devices || {}).length, 0), 0),
        totalMetrics: sparkplugData.totalMetrics || 0,
        messageTypes: sparkplugData.messageTypes || {},
        dataTypes: sparkplugData.dataTypes || {}
      },
      groups: sparkplugData.groups || {},
      timeline: sparkplugData.timeline || [],
      metrics: sparkplugData.allMetrics || [],
      generatedAt: new Date()
    };
  }

  extractSparkplugData(mqttData) {
    const sparkplugData = {
      groups: {},
      totalMetrics: 0,
      messageTypes: {},
      dataTypes: {},
      timeline: [],
      allMetrics: []
    };

    Object.entries(mqttData.messages || {}).forEach(([brokerId, messages]) => {
      messages.forEach(msg => {
        if (msg.sparkplug) {
          const topicInfo = this.parseSparkplugFromMessage(msg);
          
          if (topicInfo.groupId) {
            // Initialize group if needed
            if (!sparkplugData.groups[topicInfo.groupId]) {
              sparkplugData.groups[topicInfo.groupId] = {
                id: topicInfo.groupId,
                edgeNodes: {},
                metrics: [],
                lastActivity: null
              };
            }

            const group = sparkplugData.groups[topicInfo.groupId];
            
            // Update last activity
            if (!group.lastActivity || new Date(msg.timestamp) > new Date(group.lastActivity)) {
              group.lastActivity = msg.timestamp;
            }

            // Initialize edge node if needed
            if (topicInfo.edgeNodeId && !group.edgeNodes[topicInfo.edgeNodeId]) {
              group.edgeNodes[topicInfo.edgeNodeId] = {
                id: topicInfo.edgeNodeId,
                devices: {},
                metrics: [],
                lastActivity: null
              };
            }

            const edgeNode = group.edgeNodes[topicInfo.edgeNodeId];
            if (edgeNode) {
              edgeNode.lastActivity = msg.timestamp;

              // Initialize device if needed
              if (topicInfo.deviceId && !edgeNode.devices[topicInfo.deviceId]) {
                edgeNode.devices[topicInfo.deviceId] = {
                  id: topicInfo.deviceId,
                  metrics: [],
                  lastActivity: null
                };
              }

              const device = topicInfo.deviceId ? edgeNode.devices[topicInfo.deviceId] : null;
              if (device) {
                device.lastActivity = msg.timestamp;
              }
            }

            // Process metrics
            if (msg.sparkplug.metrics) {
              msg.sparkplug.metrics.forEach(metric => {
                sparkplugData.totalMetrics++;
                sparkplugData.allMetrics.push({
                  ...metric,
                  timestamp: msg.timestamp,
                  groupId: topicInfo.groupId,
                  edgeNodeId: topicInfo.edgeNodeId,
                  deviceId: topicInfo.deviceId,
                  messageType: topicInfo.messageType
                });

                // Count data types
                if (metric.datatypeName) {
                  sparkplugData.dataTypes[metric.datatypeName] = 
                    (sparkplugData.dataTypes[metric.datatypeName] || 0) + 1;
                }
              });
            }

            // Count message types
            if (topicInfo.messageType) {
              sparkplugData.messageTypes[topicInfo.messageType] = 
                (sparkplugData.messageTypes[topicInfo.messageType] || 0) + 1;
            }

            // Add to timeline
            sparkplugData.timeline.push({
              timestamp: msg.timestamp,
              groupId: topicInfo.groupId,
              edgeNodeId: topicInfo.edgeNodeId,
              deviceId: topicInfo.deviceId,
              messageType: topicInfo.messageType,
              metricCount: msg.sparkplug.metrics ? msg.sparkplug.metrics.length : 0
            });
          }
        }
      });
    });

    // Sort timeline
    sparkplugData.timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    return sparkplugData;
  }

  parseSparkplugFromMessage(msg) {
    const result = {
      groupId: null,
      edgeNodeId: null,
      deviceId: null,
      messageType: null,
      metricCount: 0
    };

    if (msg.topic && msg.topic.startsWith('spBv1.0/')) {
      const parts = msg.topic.split('/');
      if (parts.length >= 4) {
        result.groupId = parts[1];
        result.messageType = parts[2];
        result.edgeNodeId = parts[3];
        if (parts.length > 4) {
          result.deviceId = parts.slice(4).join('/');
        }
      }
    }

    if (msg.sparkplug && msg.sparkplug.metrics) {
      result.metricCount = msg.sparkplug.metrics.length;
    }

    return result;
  }

  filterMessagesByTimeRange(messages, timeRange) {
    if (timeRange === 'all') {
      return messages;
    }

    const now = new Date();
    let cutoffTime;

    switch (timeRange) {
      case '1hour':
        cutoffTime = new Date(now.getTime() - 60 * 60 * 1000);
        break;
      case '6hours':
        cutoffTime = new Date(now.getTime() - 6 * 60 * 60 * 1000);
        break;
      case '24hours':
        cutoffTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case '7days':
        cutoffTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      default:
        return messages;
    }

    const filtered = {};
    Object.entries(messages).forEach(([brokerId, msgList]) => {
      filtered[brokerId] = msgList.filter(msg => 
        new Date(msg.timestamp) >= cutoffTime
      );
    });

    return filtered;
  }

  generateDataSummary(mqttData) {
    const summary = {
      totalBrokers: Object.keys(mqttData.connections || {}).length,
      totalTopics: 0,
      totalMessages: 0,
      sparkplugMessages: 0,
      messageTypes: {},
      dataRange: {
        start: null,
        end: null
      }
    };

    // Count topics
    Object.values(mqttData.topics || {}).forEach(brokerTopics => {
      summary.totalTopics += Object.keys(brokerTopics).length;
    });

    // Count messages and analyze types
    Object.values(mqttData.messages || {}).forEach(messages => {
      summary.totalMessages += messages.length;
      
      messages.forEach(msg => {
        summary.messageTypes[msg.type] = (summary.messageTypes[msg.type] || 0) + 1;
        
        if (msg.sparkplug) {
          summary.sparkplugMessages++;
        }

        // Track time range
        const msgTime = new Date(msg.timestamp);
        if (!summary.dataRange.start || msgTime < summary.dataRange.start) {
          summary.dataRange.start = msgTime;
        }
        if (!summary.dataRange.end || msgTime > summary.dataRange.end) {
          summary.dataRange.end = msgTime;
        }
      });
    });

    return summary;
  }

  calculateAverageSize(messages) {
    if (!messages || messages.length === 0) return 0;
    
    const totalSize = messages.reduce((sum, msg) => sum + (msg.size || 0), 0);
    return Math.round(totalSize / messages.length);
  }

  getPayloadPreview(payload, maxLength = 100) {
    if (payload === null || payload === undefined) {
      return '';
    }

    let preview = typeof payload === 'string' ? payload : JSON.stringify(payload);
    
    if (preview.length > maxLength) {
      preview = preview.substring(0, maxLength) + '...';
    }

    return preview.replace(/"/g, '""'); // Escape quotes for CSV
  }

  addToHistory(exportEntry) {
    this.exportHistory.unshift(exportEntry);

    // Keep history manageable
    if (this.exportHistory.length > this.maxHistoryEntries) {
      this.exportHistory = this.exportHistory.slice(0, this.maxHistoryEntries);
    }
  }

  getExportHistory() {
    return this.exportHistory;
  }

  async getExportFile(exportId) {
    const historyEntry = this.exportHistory.find(entry => entry.id === exportId);
    if (!historyEntry || !historyEntry.filename) {
      throw new Error('Export not found');
    }

    const filepath = path.join(this.exportDirectory, path.basename(historyEntry.filename));
    
    try {
      const content = await fs.readFile(filepath, 'utf8');
      return {
        content: content,
        filename: historyEntry.filename,
        format: historyEntry.format,
        size: historyEntry.size
      };
    } catch (error) {
      throw new Error('Export file not found or corrupted');
    }
  }

  async deleteExportFile(exportId) {
    const historyEntry = this.exportHistory.find(entry => entry.id === exportId);
    if (!historyEntry || !historyEntry.filename) {
      throw new Error('Export not found');
    }

    const filepath = path.join(this.exportDirectory, path.basename(historyEntry.filename));
    
    try {
      await fs.unlink(filepath);
      
      // Remove from history
      this.exportHistory = this.exportHistory.filter(entry => entry.id !== exportId);
      
      return true;
    } catch (error) {
      throw new Error('Failed to delete export file');
    }
  }

  async cleanupOldExports(maxAgeHours = 24) {
    const cutoffTime = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    
    const oldExports = this.exportHistory.filter(entry => 
      new Date(entry.timestamp) < cutoffTime
    );

    for (const exportEntry of oldExports) {
      try {
        await this.deleteExportFile(exportEntry.id);
        console.log(`🗑️  Cleaned up old export: ${exportEntry.filename}`);
      } catch (error) {
        console.error(`Failed to cleanup export ${exportEntry.id}:`, error);
      }
    }

    return oldExports.length;
  }

  getStatus() {
    return {
      totalExports: this.exportHistory.length,
      exportDirectory: this.exportDirectory,
      supportedFormats: ['json', 'csv', 'excel', 'yaml', 'network-map', 'sparkplug-report']
    };
  }
}

module.exports = DataExporter;