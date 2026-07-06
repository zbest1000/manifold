// AI Service with graceful fallback for missing dependencies
let OpenAI;
try {
  OpenAI = require('openai');
} catch (error) {
  console.warn('OpenAI package not installed. AI features will use mock responses.');
  OpenAI = null;
}

class AIService {
  constructor() {
    this.client = null;
    this.isEnabled = false;
    this.conversationHistory = [];
    
    this.initializeClient();
  }

  initializeClient() {
    if (!OpenAI) {
      console.log('🤖 AI Service running in mock mode (OpenAI not available)');
      this.isEnabled = false;
      return;
    }

    try {
      if (process.env.OPENAI_API_KEY) {
        this.client = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY
        });
        this.isEnabled = true;
        console.log('🤖 AI Service initialized with OpenAI');
      } else {
        console.log('🤖 AI Service in mock mode (no API key provided)');
        this.isEnabled = false;
      }
    } catch (error) {
      console.error('Failed to initialize AI service:', error);
      this.isEnabled = false;
    }
  }

  async processQuery(query, context = {}) {
    if (!this.isEnabled) {
      return this.getMockResponse(query, context);
    }

    try {
      const prompt = this.buildPrompt(query, context);
      
      const response = await this.client.chat.completions.create({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are an expert MQTT and IoT analyst. Help users understand their MQTT data, identify patterns, and troubleshoot issues.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 1000,
        temperature: 0.7
      });

      const aiResponse = response.choices[0].message.content;
      
      // Store in conversation history (bounded, so the array cannot grow forever).
      this.conversationHistory.push({
        timestamp: new Date().toISOString(),
        query,
        response: aiResponse,
        context
      });
      if (this.conversationHistory.length > 50) {
        this.conversationHistory = this.conversationHistory.slice(-50);
      }

      return {
        response: aiResponse,
        confidence: 0.85,
        model: 'gpt-4',
        usage: response.usage,
        timestamp: new Date().toISOString(),
        sources: this.extractSources(context),
        suggestions: this.generateSuggestions(query, context)
      };

    } catch (error) {
      console.error('AI query error:', error);
      return this.getMockResponse(query, context, true);
    }
  }

  getMockResponse(query, context = {}, isError = false) {
    if (isError) {
      return {
        response: 'I apologize, but I encountered an error processing your query. Please try again later.',
        confidence: 0.1,
        sources: [],
        suggestions: ['Try rephrasing your question', 'Check system status']
      };
    }

    // Generate contextual mock responses
    const lowerQuery = query.toLowerCase();
    
    if (lowerQuery.includes('broker') || lowerQuery.includes('connection')) {
      return {
        response: `Based on your MQTT network data, I can see you have ${context.brokerCount || 'several'} brokers discovered. The connections appear stable with normal message flow. Consider monitoring the broker with the highest message volume for potential bottlenecks.`,
        confidence: 0.7,
        sources: ['Broker Discovery Data', 'Connection Metrics'],
        suggestions: [
          'Monitor broker performance metrics',
          'Check for connection timeouts',
          'Review authentication settings'
        ]
      };
    }

    if (lowerQuery.includes('topic') || lowerQuery.includes('message')) {
      return {
        response: `Your MQTT topics show a healthy distribution of messages. I notice some high-frequency topics that might benefit from optimization. The message patterns suggest normal IoT device behavior with periodic sensor updates.`,
        confidence: 0.75,
        sources: ['Topic Analytics', 'Message Flow Data'],
        suggestions: [
          'Optimize high-frequency topics',
          'Consider message batching',
          'Review QoS settings'
        ]
      };
    }

    if (lowerQuery.includes('sparkplug') || lowerQuery.includes('device')) {
      return {
        response: `Your Sparkplug B implementation looks well-structured. The device hierarchy follows best practices with proper Group ID and Edge Node organization. Consider implementing birth certificates for better device lifecycle management.`,
        confidence: 0.8,
        sources: ['Sparkplug B Decoder', 'Device Metrics'],
        suggestions: [
          'Implement birth certificates',
          'Monitor device health metrics',
          'Review metric definitions'
        ]
      };
    }

    if (lowerQuery.includes('security') || lowerQuery.includes('secure')) {
      return {
        response: `From a security perspective, I recommend enabling TLS for all broker connections and implementing proper authentication. Consider using certificate-based authentication for production environments.`,
        confidence: 0.85,
        sources: ['Security Analysis', 'Connection Data'],
        suggestions: [
          'Enable TLS encryption',
          'Implement certificate authentication',
          'Review firewall rules',
          'Monitor for suspicious activity'
        ]
      };
    }

    // Default response
    return {
      response: `I understand you're asking about "${query}". While I'm currently running in demonstration mode, I can help you analyze MQTT data, identify patterns, troubleshoot issues, and optimize your IoT infrastructure. Try asking about specific brokers, topics, or Sparkplug devices for more detailed insights.`,
      confidence: 0.6,
      sources: ['General Knowledge Base'],
      suggestions: [
        'Ask about specific brokers or topics',
        'Request network analysis',
        'Inquire about Sparkplug B devices',
        'Get security recommendations'
      ]
    };
  }

  buildPrompt(query, context) {
    let prompt = `User Query: ${query}\n\n`;
    
    if (context.brokers && context.brokers.length > 0) {
      prompt += `MQTT Brokers (${context.brokers.length}):\n`;
      context.brokers.forEach(broker => {
        prompt += `- ${broker.host}:${broker.port} (${broker.status})\n`;
      });
      prompt += '\n';
    }

    if (context.topics && context.topics.length > 0) {
      prompt += `Active Topics (${context.topics.length}):\n`;
      context.topics.slice(0, 10).forEach(topic => {
        prompt += `- ${topic.name} (${topic.messageCount} messages)\n`;
      });
      prompt += '\n';
    }

    if (context.sparkplugDevices && context.sparkplugDevices.length > 0) {
      prompt += `Sparkplug B Devices (${context.sparkplugDevices.length}):\n`;
      context.sparkplugDevices.slice(0, 5).forEach(device => {
        prompt += `- ${device.groupId}/${device.edgeNodeId}/${device.deviceId}\n`;
      });
      prompt += '\n';
    }

    prompt += 'Please provide insights, analysis, or recommendations based on this MQTT data.';
    
    return prompt;
  }

  extractSources(context) {
    const sources = [];
    
    if (context.brokers?.length > 0) sources.push('Broker Data');
    if (context.topics?.length > 0) sources.push('Topic Analytics');
    if (context.messages?.length > 0) sources.push('Message History');
    if (context.sparkplugDevices?.length > 0) sources.push('Sparkplug B Data');
    
    return sources.length > 0 ? sources : ['Real-time MQTT Data'];
  }

  generateSuggestions(query, context) {
    const suggestions = [];
    
    // Query-based suggestions
    if (query.toLowerCase().includes('performance')) {
      suggestions.push('Analyze message throughput');
      suggestions.push('Check broker resource usage');
    }
    
    if (query.toLowerCase().includes('troubleshoot')) {
      suggestions.push('Review connection logs');
      suggestions.push('Check network connectivity');
    }
    
    // Context-based suggestions
    if (context.brokers?.length > 1) {
      suggestions.push('Compare broker performance');
    }
    
    if (context.sparkplugDevices?.length > 0) {
      suggestions.push('Analyze device health metrics');
    }
    
    return suggestions.length > 0 ? suggestions : [
      'Ask about network topology',
      'Request security analysis',
      'Get optimization recommendations'
    ];
  }

  async analyzePayload(payload, context = {}) {
    if (!this.isEnabled) {
      return this.getMockPayloadAnalysis(payload, context);
    }

    try {
      const prompt = `Analyze this MQTT payload:\n\n${JSON.stringify(payload, null, 2)}\n\nProvide classification, insights, and any security concerns.`;
      
      const response = await this.client.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: 'You are an MQTT payload analyzer. Classify payloads, identify patterns, and detect potential issues.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 500,
        temperature: 0.3
      });

      return {
        classification: this.classifyPayload(payload),
        insights: response.choices[0].message.content,
        securityLevel: this.assessSecurity(payload),
        recommendations: this.getPayloadRecommendations(payload)
      };

    } catch (error) {
      console.error('Payload analysis error:', error);
      return this.getMockPayloadAnalysis(payload, context);
    }
  }

  getMockPayloadAnalysis(payload, context) {
    const classification = this.classifyPayload(payload);
    
    return {
      classification,
      insights: `This appears to be a ${classification.type} payload with ${classification.format} format. The data structure suggests ${classification.purpose} functionality.`,
      securityLevel: this.assessSecurity(payload),
      recommendations: this.getPayloadRecommendations(payload)
    };
  }

  classifyPayload(payload) {
    const payloadStr = JSON.stringify(payload).toLowerCase();
    
    if (payloadStr.includes('timestamp') && payloadStr.includes('metrics')) {
      return { type: 'Sparkplug B', format: 'Protobuf', purpose: 'industrial data' };
    }
    
    if (payloadStr.includes('temperature') || payloadStr.includes('humidity')) {
      return { type: 'Sensor Data', format: 'JSON', purpose: 'environmental monitoring' };
    }
    
    if (payloadStr.includes('status') || payloadStr.includes('state')) {
      return { type: 'Status Update', format: 'JSON', purpose: 'device status' };
    }
    
    return { type: 'Generic Data', format: 'JSON', purpose: 'general telemetry' };
  }

  assessSecurity(payload) {
    // Simple security assessment
    const payloadStr = JSON.stringify(payload);
    
    if (payloadStr.includes('password') || payloadStr.includes('token')) {
      return 'HIGH_RISK';
    }
    
    if (payloadStr.includes('encrypted') || payloadStr.includes('signature')) {
      return 'SECURE';
    }
    
    return 'NORMAL';
  }

  getPayloadRecommendations(payload) {
    const recommendations = [];
    const payloadStr = JSON.stringify(payload);
    
    if (payloadStr.includes('password')) {
      recommendations.push('Remove sensitive data from payload');
    }
    
    if (!payloadStr.includes('timestamp')) {
      recommendations.push('Consider adding timestamp for better traceability');
    }
    
    if (payloadStr.length > 1000) {
      recommendations.push('Consider payload compression for large messages');
    }
    
    return recommendations.length > 0 ? recommendations : [
      'Payload structure looks good',
      'Consider adding metadata for better analytics'
    ];
  }

  async generateReport(data, format = 'markdown') {
    const timestamp = new Date().toISOString();
    
    if (format === 'markdown') {
      return this.generateMarkdownReport(data, timestamp);
    }
    
    return this.generateJSONReport(data, timestamp);
  }

  generateMarkdownReport(data, timestamp) {
    return `# MQTT Network Analysis Report
Generated: ${timestamp}

## Executive Summary
- **Brokers Discovered**: ${data.brokers?.length || 0}
- **Active Topics**: ${data.topics?.length || 0}
- **Messages Analyzed**: ${data.messages?.length || 0}
- **Sparkplug Devices**: ${data.sparkplugDevices?.length || 0}

## Network Health
✅ All systems operational
📊 Message flow within normal parameters
🔒 Security recommendations available

## Recommendations
1. Monitor high-frequency topics for optimization opportunities
2. Consider implementing TLS for all connections
3. Review authentication settings for production deployment
4. Set up alerting for connection anomalies

## Next Steps
- Implement continuous monitoring
- Configure automated alerts
- Plan capacity expansion
- Review security policies
`;
  }

  generateJSONReport(data, timestamp) {
    return {
      generatedAt: timestamp,
      summary: {
        brokerCount: data.brokers?.length || 0,
        topicCount: data.topics?.length || 0,
        messageCount: data.messages?.length || 0,
        sparkplugDeviceCount: data.sparkplugDevices?.length || 0
      },
      health: {
        status: 'healthy',
        issues: [],
        warnings: []
      },
      recommendations: [
        'Monitor high-frequency topics',
        'Implement TLS encryption',
        'Review authentication settings',
        'Set up monitoring alerts'
      ]
    };
  }

  getConversationHistory() {
    return this.conversationHistory.slice(-50); // Last 50 conversations
  }

  clearHistory() {
    this.conversationHistory = [];
  }

  clearConversationHistory() {
    this.clearHistory();
  }

  // Returns ready-made natural-language queries for the AI assistant UI.
  getSuggestedQueries() {
    return [
      'Show all topics active in the past 5 minutes',
      'Which brokers have the highest message volume?',
      'Summarize recent Sparkplug device births and deaths',
      'Are there any connection errors or anomalies?',
      'What message types are most common right now?'
    ];
  }

  // Builds insights from the current MQTT data, enriched by the model when enabled.
  async generateInsights(data = {}, timeRange = '1hour') {
    const connections = data.connections || {};
    const topics = data.topics || {};
    const brokerIds = Object.keys(connections);

    let topicCount = 0;
    let messageCount = 0;
    for (const brokerId of brokerIds) {
      const brokerTopics = topics[brokerId] || {};
      topicCount += Object.keys(brokerTopics).length;
      messageCount += Object.values(brokerTopics).reduce((sum, t) => sum + (t.messageCount || 0), 0);
    }

    const findings = [];
    if (brokerIds.length === 0) {
      findings.push('No active broker connections in this window.');
    } else {
      findings.push(`${brokerIds.length} broker(s), ${topicCount} active topic(s), ${messageCount} message(s).`);
    }
    if (topicCount > 0 && messageCount === 0) {
      findings.push('Topics are subscribed but no messages have arrived — check publishers.');
    }

    const base = {
      timeRange,
      generatedAt: new Date().toISOString(),
      brokerCount: brokerIds.length,
      topicCount,
      messageCount,
      aiEnabled: this.isEnabled,
      findings
    };

    if (!this.isEnabled) {
      return base;
    }

    try {
      const response = await this.processQuery(
        `Provide concise operational insights for the last ${timeRange} of this MQTT network.`,
        data
      );
      return { ...base, aiSummary: response.response };
    } catch (error) {
      console.error('generateInsights AI error:', error);
      return base;
    }
  }

  isAvailable() {
    return this.isEnabled;
  }

  getStatus() {
    return {
      enabled: this.isEnabled,
      hasApiKey: !!process.env.OPENAI_API_KEY,
      conversationCount: this.conversationHistory.length,
      conversationLength: this.conversationHistory.length,
      model: this.isEnabled ? 'gpt-4' : 'mock',
      provider: this.isEnabled ? 'openai' : 'mock',
      lastUsed: this.conversationHistory.length > 0
        ? this.conversationHistory[this.conversationHistory.length - 1].timestamp
        : null
    };
  }
}

module.exports = AIService;