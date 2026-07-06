class APIService {
  constructor() {
    // Same-origin by default: the Vite dev server proxies /api to the backend,
    // and in production the backend serves the built client, so relative URLs work.
    this.baseURL = import.meta.env.VITE_API_URL || ''
    this.timeout = 30000 // 30 seconds
    // Sent as a Bearer token when the server enforces APP_ACCESS_TOKEN.
    this.accessToken = import.meta.env.VITE_ACCESS_TOKEN || ''
  }

  // Helper method for making requests
  async request(endpoint, options = {}) {
    const url = `${this.baseURL}${endpoint}`
    const config = {
      headers: {
        'Content-Type': 'application/json',
        ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
        ...options.headers
      },
      timeout: this.timeout,
      ...options
    }

    try {
      const response = await fetch(url, config)
      
      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        throw new Error(error.message || `HTTP ${response.status}: ${response.statusText}`)
      }

      const contentType = response.headers.get('content-type')
      if (contentType && contentType.includes('application/json')) {
        return await response.json()
      }
      
      return await response.text()
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Request timeout')
      }
      throw error
    }
  }

  // GET request
  get(endpoint, params = {}) {
    const searchParams = new URLSearchParams(params)
    const url = searchParams.toString() ? `${endpoint}?${searchParams}` : endpoint
    
    return this.request(url, {
      method: 'GET'
    })
  }

  // POST request
  post(endpoint, data = {}) {
    return this.request(endpoint, {
      method: 'POST',
      body: JSON.stringify(data)
    })
  }

  // PUT request
  put(endpoint, data = {}) {
    return this.request(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data)
    })
  }

  // DELETE request
  delete(endpoint) {
    return this.request(endpoint, {
      method: 'DELETE'
    })
  }

  // System API endpoints
  getSystemStatus() {
    return this.get('/api/status')
  }

  getSystemInfo() {
    return this.get('/api/info')
  }

  getSystemHealth() {
    return this.get('/api/health')
  }

  // Network Discovery API
  startNetworkDiscovery(options = {}) {
    return this.post('/api/discovery/start', options)
  }

  stopNetworkDiscovery() {
    return this.post('/api/discovery/stop')
  }

  getDiscoveryStatus() {
    return this.get('/api/discovery/status')
  }

  getDiscoveredBrokers() {
    return this.get('/api/discovery/brokers')
  }

  // Network Scanning API
  startNetworkScan(options = {}) {
    return this.post('/api/scan/start', options)
  }

  getNetworkScanResults(scanId) {
    return this.get(`/api/scan/results/${scanId}`)
  }

  getNetworkScanHistory() {
    return this.get('/api/scan/history')
  }

  // MQTT Connection API
  connectToBroker(brokerConfig) {
    return this.post('/api/mqtt/connect', brokerConfig)
  }

  disconnectFromBroker(brokerId) {
    return this.post(`/api/mqtt/disconnect/${brokerId}`)
  }

  getBrokerConnections() {
    return this.get('/api/mqtt/connections')
  }

  getBrokerInfo(brokerId) {
    return this.get(`/api/mqtt/brokers/${brokerId}`)
  }

  testBrokerConnection(brokerConfig) {
    return this.post('/api/mqtt/test-connection', brokerConfig)
  }

  // MQTT Topic and Message API
  subscribeToTopic(brokerId, topic, qos = 0) {
    return this.post(`/api/mqtt/subscribe/${brokerId}`, { topic, qos })
  }

  unsubscribeFromTopic(brokerId, topic) {
    return this.post(`/api/mqtt/unsubscribe/${brokerId}`, { topic })
  }

  publishMessage(brokerId, topic, message, options = {}) {
    return this.post(`/api/mqtt/publish/${brokerId}`, {
      topic,
      message,
      ...options
    })
  }

  getTopics(brokerId) {
    return this.get(`/api/mqtt/topics/${brokerId}`)
  }

  getMessages(brokerId, options = {}) {
    return this.get(`/api/mqtt/messages/${brokerId}`, options)
  }

  getTopicHistory(brokerId, topic, options = {}) {
    return this.get(`/api/mqtt/topics/${brokerId}/${encodeURIComponent(topic)}/history`, options)
  }

  // Sparkplug B API
  getSparkplugData(brokerId) {
    return this.get(`/api/mqtt/sparkplug/${brokerId}`)
  }

  getSparkplugGroups(brokerId) {
    return this.get(`/api/mqtt/sparkplug/${brokerId}/groups`)
  }

  getSparkplugDevices(brokerId, groupId) {
    return this.get(`/api/mqtt/sparkplug/${brokerId}/groups/${groupId}/devices`)
  }

  getSparkplugMetrics(brokerId, options = {}) {
    return this.get(`/api/mqtt/sparkplug/${brokerId}/metrics`, options)
  }

  // AI Service API
  queryAI(query, context = {}) {
    return this.post('/api/ai/query', { query, context })
  }

  getAIInsights(data, type = 'general') {
    return this.post('/api/ai/insights', { data, type })
  }

  analyzePayload(payload, context = {}) {
    return this.post('/api/ai/analyze-payload', { payload, context })
  }

  generateReport(data, format = 'markdown') {
    return this.post('/api/ai/generate-report', { data, format })
  }

  getAIConversationHistory() {
    return this.get('/api/ai/conversations')
  }

  clearAIConversation() {
    return this.delete('/api/ai/conversations')
  }

  // Data Export API
  exportData(exportConfig) {
    return this.post('/api/export', exportConfig)
  }

  getExportHistory() {
    return this.get('/api/export/history')
  }

  downloadExport(exportId) {
    return this.get(`/api/export/download/${exportId}`)
  }

  // Configuration API
  getConfig() {
    return this.get('/api/config')
  }

  updateConfig(config) {
    return this.put('/api/config', config)
  }

  resetConfig() {
    return this.post('/api/config/reset')
  }

  // Utility methods
  validateBrokerConfig(config) {
    const required = ['host', 'port']
    const missing = required.filter(field => !config[field])
    
    if (missing.length > 0) {
      throw new Error(`Missing required fields: ${missing.join(', ')}`)
    }

    // Validate port range
    if (config.port < 1 || config.port > 65535) {
      throw new Error('Port must be between 1 and 65535')
    }

    // Validate TLS settings
    if (config.tls) {
      if (config.tls.cert && !config.tls.key) {
        throw new Error('TLS key is required when certificate is provided')
      }
      if (config.tls.key && !config.tls.cert) {
        throw new Error('TLS certificate is required when key is provided')
      }
    }

    return true
  }

  formatBrokerUrl(broker) {
    const protocol = broker.tls ? 'mqtts' : 'mqtt'
    return `${protocol}://${broker.host}:${broker.port}`
  }

  // Error handling helpers
  isNetworkError(error) {
    return error.message.includes('network') || 
           error.message.includes('timeout') ||
           error.message.includes('ENOTFOUND') ||
           error.message.includes('ECONNREFUSED')
  }

  isAuthError(error) {
    return error.message.includes('authentication') ||
           error.message.includes('unauthorized') ||
           error.message.includes('403') ||
           error.message.includes('401')
  }

  isServerError(error) {
    return error.message.includes('500') ||
           error.message.includes('502') ||
           error.message.includes('503') ||
           error.message.includes('504')
  }

  // Retry mechanism for failed requests
  async retryRequest(requestFn, maxRetries = 3, delay = 1000) {
    let lastError
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await requestFn()
      } catch (error) {
        lastError = error
        
        // Don't retry client errors (4xx)
        if (error.message.includes('4')) {
          throw error
        }
        
        // Don't retry on last attempt
        if (attempt === maxRetries) {
          break
        }
        
        // Exponential backoff
        const waitTime = delay * Math.pow(2, attempt - 1)
        await new Promise(resolve => setTimeout(resolve, waitTime))
      }
    }
    
    throw lastError
  }

  // Health check with retry
  async healthCheck() {
    return this.retryRequest(() => this.getSystemHealth(), 2, 500)
  }

  // Batch operations
  async batchConnect(brokerConfigs) {
    const promises = brokerConfigs.map(config => 
      this.connectToBroker(config).catch(error => ({ error, config }))
    )
    
    return Promise.all(promises)
  }

  async batchSubscribe(brokerId, topics) {
    const promises = topics.map(topic => 
      this.subscribeToTopic(brokerId, topic).catch(error => ({ error, topic }))
    )
    
    return Promise.all(promises)
  }

  // WebSocket fallback for real-time data
  createEventSource(endpoint) {
    const url = `${this.baseURL}${endpoint}`
    return new EventSource(url)
  }

  // File upload helper
  async uploadFile(endpoint, file, additionalData = {}) {
    const formData = new FormData()
    formData.append('file', file)
    
    Object.entries(additionalData).forEach(([key, value]) => {
      formData.append(key, value)
    })

    return this.request(endpoint, {
      method: 'POST',
      body: formData,
      headers: {} // Let browser set content-type for FormData
    })
  }

  // Download helper
  async downloadFile(endpoint, filename) {
    const response = await fetch(`${this.baseURL}${endpoint}`)
    
    if (!response.ok) {
      throw new Error(`Download failed: ${response.statusText}`)
    }
    
    const blob = await response.blob()
    const url = window.URL.createObjectURL(blob)
    
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    
    window.URL.revokeObjectURL(url)
    document.body.removeChild(a)
  }
}

// Create singleton instance
export const apiService = new APIService()

// Export class for testing
export default APIService