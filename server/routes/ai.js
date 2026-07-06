const express = require('express');
const router = express.Router();

// AI status and configuration
router.get('/status', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const status = services.aiService.getStatus();
    res.json(status);
  } catch (error) {
    console.error('AI status error:', error);
    res.status(500).json({ error: 'Failed to get AI status' });
  }
});

// Process natural language query
router.post('/query', async (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const { query } = req.body;
    
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Query is required and must be a string' });
    }

    const mqttData = services.mqttClientManager.getAllData();
    const response = await services.aiService.processQuery(query, mqttData);
    
    res.json({
      success: true,
      query: query,
      response: response.response,
      usage: response.usage,
      model: response.model,
      timestamp: response.timestamp
    });
  } catch (error) {
    console.error('AI query error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      available: services.aiService.isAvailable()
    });
  }
});

// Generate insights about current MQTT data
router.post('/insights', async (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const { timeRange = '1hour' } = req.body;
    
    const mqttData = services.mqttClientManager.getAllData();
    const insights = await services.aiService.generateInsights(mqttData, timeRange);
    
    res.json({
      success: true,
      insights: insights
    });
  } catch (error) {
    console.error('AI insights error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      available: services.aiService.isAvailable()
    });
  }
});

// Classify a payload with AI
router.post('/classify', async (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const { payload, topic, metadata = {} } = req.body;
    
    if (!payload || !topic) {
      return res.status(400).json({ error: 'Payload and topic are required' });
    }

    const classification = await services.aiService.classifyPayload(payload, topic, metadata);
    
    res.json({
      success: true,
      topic: topic,
      classification: classification
    });
  } catch (error) {
    console.error('AI classify error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      available: services.aiService.isAvailable()
    });
  }
});

// Get suggested queries for the AI assistant
router.get('/suggestions', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const suggestions = services.aiService.getSuggestedQueries();
    res.json({
      suggestions: suggestions,
      timestamp: new Date()
    });
  } catch (error) {
    console.error('AI suggestions error:', error);
    res.status(500).json({ error: 'Failed to get suggestions' });
  }
});

// Get conversation history
router.get('/history', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const status = services.aiService.getStatus();
    res.json({
      conversationLength: status.conversationLength,
      available: services.aiService.isAvailable(),
      model: status.model,
      provider: status.provider
    });
  } catch (error) {
    console.error('AI history error:', error);
    res.status(500).json({ error: 'Failed to get conversation history' });
  }
});

// Clear conversation history
router.post('/history/clear', (req, res) => {
  const { services } = req.app.locals;
  
  try {
    services.aiService.clearHistory();
    res.json({
      success: true,
      message: 'Conversation history cleared'
    });
  } catch (error) {
    console.error('AI clear history error:', error);
    res.status(500).json({ error: 'Failed to clear conversation history' });
  }
});

// Analyze Sparkplug B data with AI
router.post('/analyze/sparkplug', async (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const { groupId, analysisType = 'overview' } = req.body;
    
    const mqttData = services.mqttClientManager.getAllData();
    
    // Extract Sparkplug data
    let sparkplugMessages = [];
    Object.entries(mqttData.messages || {}).forEach(([brokerId, messages]) => {
      const sparkplugMsgs = messages.filter(msg => msg.sparkplug);
      if (groupId) {
        sparkplugMsgs.filter(msg => msg.topic.includes(`/${groupId}/`));
      }
      sparkplugMessages.push(...sparkplugMsgs);
    });

    if (sparkplugMessages.length === 0) {
      return res.json({
        success: true,
        analysis: 'No Sparkplug B messages found for analysis.',
        messageCount: 0
      });
    }

    // Generate analysis query based on type
    let query;
    switch (analysisType) {
      case 'health':
        query = `Analyze the health and status of Sparkplug B devices. Look for birth/death certificates, missing metrics, and any anomalies in the data.`;
        break;
      case 'performance':
        query = `Analyze the performance metrics from Sparkplug B devices. Identify trends, outliers, and potential performance issues.`;
        break;
      case 'connectivity':
        query = `Analyze the connectivity patterns of Sparkplug B edge nodes and devices. Look for connection stability and communication patterns.`;
        break;
      default:
        query = `Provide an overview analysis of the Sparkplug B industrial network data, including device status, metrics, and any notable patterns.`;
    }

    if (groupId) {
      query += ` Focus specifically on Group ID: ${groupId}.`;
    }

    const response = await services.aiService.processQuery(query, mqttData);
    
    res.json({
      success: true,
      analysisType: analysisType,
      groupId: groupId,
      messageCount: sparkplugMessages.length,
      analysis: response.response,
      timestamp: response.timestamp
    });
  } catch (error) {
    console.error('AI Sparkplug analysis error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      available: services.aiService.isAvailable()
    });
  }
});

// Analyze network topology and communication patterns
router.post('/analyze/network', async (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const { focusArea = 'topology' } = req.body;
    
    const mqttData = services.mqttClientManager.getAllData();
    
    let query;
    switch (focusArea) {
      case 'topology':
        query = `Analyze the MQTT network topology. Describe the broker connections, topic hierarchies, and communication patterns. Identify any potential bottlenecks or optimization opportunities.`;
        break;
      case 'security':
        query = `Analyze the MQTT network from a security perspective. Look for potential security concerns, authentication patterns, and best practice recommendations.`;
        break;
      case 'performance':
        query = `Analyze the MQTT network performance. Look at message rates, broker loads, error rates, and identify any performance issues or optimization opportunities.`;
        break;
      case 'reliability':
        query = `Analyze the reliability and stability of the MQTT network. Look for connection drops, message delivery issues, and overall network health.`;
        break;
      default:
        query = `Provide a comprehensive analysis of the MQTT network including topology, performance, and any notable patterns or issues.`;
    }

    const response = await services.aiService.processQuery(query, mqttData);
    
    res.json({
      success: true,
      focusArea: focusArea,
      analysis: response.response,
      timestamp: response.timestamp
    });
  } catch (error) {
    console.error('AI network analysis error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      available: services.aiService.isAvailable()
    });
  }
});

// Analyze specific topic patterns
router.post('/analyze/topics', async (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const { topicPattern, analysisDepth = 'standard' } = req.body;
    
    if (!topicPattern) {
      return res.status(400).json({ error: 'Topic pattern is required' });
    }

    const mqttData = services.mqttClientManager.getAllData();
    
    // Filter messages by topic pattern
    let matchingMessages = [];
    Object.entries(mqttData.messages || {}).forEach(([brokerId, messages]) => {
      const filtered = messages.filter(msg => {
        if (topicPattern.includes('*') || topicPattern.includes('+')) {
          // Simple wildcard matching
          const pattern = topicPattern.replace(/\*/g, '.*').replace(/\+/g, '[^/]+');
          const regex = new RegExp(`^${pattern}$`);
          return regex.test(msg.topic);
        } else {
          return msg.topic.includes(topicPattern);
        }
      });
      matchingMessages.push(...filtered);
    });

    if (matchingMessages.length === 0) {
      return res.json({
        success: true,
        analysis: `No messages found matching topic pattern: ${topicPattern}`,
        messageCount: 0
      });
    }

    let query = `Analyze the MQTT messages for topic pattern "${topicPattern}". `;
    
    if (analysisDepth === 'detailed') {
      query += `Provide a detailed analysis including payload structure, message frequency, QoS patterns, and any anomalies or trends.`;
    } else {
      query += `Provide a summary of the message patterns, frequency, and key insights.`;
    }

    const response = await services.aiService.processQuery(query, mqttData);
    
    res.json({
      success: true,
      topicPattern: topicPattern,
      messageCount: matchingMessages.length,
      analysisDepth: analysisDepth,
      analysis: response.response,
      timestamp: response.timestamp
    });
  } catch (error) {
    console.error('AI topic analysis error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      available: services.aiService.isAvailable()
    });
  }
});

// Generate report with AI
router.post('/report', async (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const { 
      reportType = 'comprehensive',
      timeRange = '24hours',
      includeSparkplug = true,
      includeMetrics = true,
      format = 'markdown'
    } = req.body;
    
    const mqttData = services.mqttClientManager.getAllData();
    
    let query = `Generate a ${reportType} report of the MQTT network activity for the past ${timeRange}. `;
    
    if (includeSparkplug) {
      query += `Include analysis of Sparkplug B industrial devices and metrics. `;
    }
    
    if (includeMetrics) {
      query += `Include performance metrics and statistics. `;
    }
    
    query += `Format the report in ${format} format with clear sections and actionable insights.`;

    const response = await services.aiService.processQuery(query, mqttData);
    
    res.json({
      success: true,
      reportType: reportType,
      timeRange: timeRange,
      format: format,
      report: response.response,
      generatedAt: response.timestamp
    });
  } catch (error) {
    console.error('AI report generation error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      available: services.aiService.isAvailable()
    });
  }
});

// Troubleshoot issues with AI
router.post('/troubleshoot', async (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const { issue, context = {} } = req.body;
    
    if (!issue) {
      return res.status(400).json({ error: 'Issue description is required' });
    }

    const mqttData = services.mqttClientManager.getAllData();
    
    const query = `Help troubleshoot this MQTT network issue: "${issue}". 
    
    Analyze the current network data and provide:
    1. Possible causes of the issue
    2. Diagnostic steps to investigate further
    3. Recommended solutions
    4. Preventive measures
    
    Context: ${JSON.stringify(context)}`;

    const response = await services.aiService.processQuery(query, mqttData);
    
    res.json({
      success: true,
      issue: issue,
      troubleshooting: response.response,
      timestamp: response.timestamp
    });
  } catch (error) {
    console.error('AI troubleshoot error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      available: services.aiService.isAvailable()
    });
  }
});

// Get AI-powered data summary
router.get('/summary', async (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const { timeRange = '1hour' } = req.query;
    
    const mqttData = services.mqttClientManager.getAllData();
    
    const query = `Provide a concise summary of the current MQTT network status and activity for the past ${timeRange}. Include key metrics, notable events, and overall health assessment.`;

    const response = await services.aiService.processQuery(query, mqttData);
    
    res.json({
      success: true,
      timeRange: timeRange,
      summary: response.response,
      timestamp: response.timestamp
    });
  } catch (error) {
    console.error('AI summary error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      available: services.aiService.isAvailable()
    });
  }
});

// Batch analyze multiple queries
router.post('/batch', async (req, res) => {
  const { services } = req.app.locals;
  
  try {
    const { queries } = req.body;
    
    if (!Array.isArray(queries) || queries.length === 0) {
      return res.status(400).json({ error: 'Queries array is required' });
    }

    if (queries.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 queries allowed per batch' });
    }

    const mqttData = services.mqttClientManager.getAllData();
    const results = [];

    for (const query of queries) {
      try {
        const response = await services.aiService.processQuery(query, mqttData);
        results.push({
          query: query,
          response: response.response,
          success: true,
          timestamp: response.timestamp
        });
      } catch (error) {
        results.push({
          query: query,
          error: 'Internal server error',
          success: false,
          timestamp: new Date()
        });
      }
    }
    
    res.json({
      success: true,
      batchSize: queries.length,
      results: results
    });
  } catch (error) {
    console.error('AI batch error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      available: services.aiService.isAvailable()
    });
  }
});

module.exports = router;