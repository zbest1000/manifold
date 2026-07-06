import { io } from 'socket.io-client'

class SocketService {
  constructor() {
    this.socket = null
    this.isConnected = false
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 5
    this.reconnectDelay = 1000
    this.eventListeners = new Map()
    this.pendingCallbacks = new Map()
    this.callbackId = 0
    
    // Connection state
    this.connectionState = 'disconnected' // 'disconnected', 'connecting', 'connected', 'error'
    this.lastConnected = null
    this.lastError = null
    
    // Configuration
    // Same-origin by default: Vite proxies /socket.io (ws) to the backend in dev,
    // and the backend serves the client in production.
    this.serverUrl = import.meta.env.VITE_WS_URL || window.location.origin
    this.options = {
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: this.maxReconnectAttempts,
      reconnectionDelay: this.reconnectDelay,
      timeout: 20000,
      forceNew: true,
      // Sent to the Socket.IO handshake guard when the server enforces a token.
      auth: { token: import.meta.env.VITE_ACCESS_TOKEN || '' }
    }
  }

  // Connection management
  async connect() {
    if (this.isConnected || this.connectionState === 'connecting') {
      return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
      try {
        this.connectionState = 'connecting'
        
        // Create socket connection
        this.socket = io(this.serverUrl, this.options)

        // Set up core event listeners
        this.setupCoreListeners(resolve, reject)

        // Auto-connect
        this.socket.connect()

      } catch (error) {
        this.connectionState = 'error'
        this.lastError = error
        reject(error)
      }
    })
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
    
    this.isConnected = false
    this.connectionState = 'disconnected'
    this.reconnectAttempts = 0
  }

  // Setup core socket event listeners
  setupCoreListeners(connectResolve, connectReject) {
    this.socket.on('connect', () => {
      this.isConnected = true
      this.connectionState = 'connected'
      this.lastConnected = new Date().toISOString()
      this.reconnectAttempts = 0
      this.lastError = null
      
      console.log('✅ Connected to MQTT Explore server')
      
      // Emit any pending callbacks
      this.processPendingCallbacks()
      
      if (connectResolve) {
        connectResolve()
        connectResolve = null
      }
    })

    this.socket.on('disconnect', (reason) => {
      this.isConnected = false
      this.connectionState = 'disconnected'
      
      console.log('❌ Disconnected from server:', reason)
      
      // Handle auto-reconnection
      if (reason === 'io server disconnect') {
        // Server initiated disconnect - don't reconnect automatically
        this.socket.connect()
      }
    })

    this.socket.on('connect_error', (error) => {
      this.isConnected = false
      this.connectionState = 'error'
      this.lastError = error
      this.reconnectAttempts++
      
      console.error('🔥 Connection error:', error.message)
      
      if (connectReject && this.reconnectAttempts >= this.maxReconnectAttempts) {
        connectReject(error)
        connectReject = null
      }
    })

    this.socket.on('reconnect', (attemptNumber) => {
      console.log(`🔄 Reconnected after ${attemptNumber} attempts`)
      this.reconnectAttempts = 0
    })

    this.socket.on('reconnect_attempt', (attemptNumber) => {
      console.log(`🔄 Reconnection attempt ${attemptNumber}`)
    })

    this.socket.on('reconnect_error', (error) => {
      console.error('🔄❌ Reconnection error:', error.message)
    })

    this.socket.on('reconnect_failed', () => {
      console.error('🔄❌ Reconnection failed - max attempts reached')
      this.connectionState = 'error'
    })

    // Handle server-side errors
    this.socket.on('error', (error) => {
      console.error('🔥 Socket error:', error)
      this.lastError = error
    })

    // Handle response callbacks
    this.socket.on('response', (data) => {
      this.handleResponse(data)
    })
  }

  // Event listener management
  on(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set())
    }
    
    this.eventListeners.get(event).add(callback)
    
    // Add listener to socket if connected
    if (this.socket) {
      this.socket.on(event, callback)
    }
    
    return () => this.off(event, callback)
  }

  off(event, callback) {
    const listeners = this.eventListeners.get(event)
    if (listeners) {
      listeners.delete(callback)
      if (listeners.size === 0) {
        this.eventListeners.delete(event)
      }
    }
    
    // Remove from socket
    if (this.socket) {
      this.socket.off(event, callback)
    }
  }

  once(event, callback) {
    const wrappedCallback = (...args) => {
      callback(...args)
      this.off(event, wrappedCallback)
    }
    
    return this.on(event, wrappedCallback)
  }

  // Emit with callback support
  emit(event, data = {}, callback = null) {
    if (!this.isConnected) {
      if (callback) {
        callback(new Error('Not connected to server'))
      }
      return false
    }

    if (callback) {
      const callbackId = this.generateCallbackId()
      this.pendingCallbacks.set(callbackId, callback)
      
      // Add timeout for callback
      setTimeout(() => {
        if (this.pendingCallbacks.has(callbackId)) {
          this.pendingCallbacks.delete(callbackId)
          callback(new Error('Request timeout'))
        }
      }, 30000) // 30 second timeout
      
      this.socket.emit(event, { ...data, _callbackId: callbackId })
    } else {
      this.socket.emit(event, data)
    }
    
    return true
  }

  // Promise-based emit
  emitAsync(event, data = {}) {
    return new Promise((resolve, reject) => {
      this.emit(event, data, (error, response) => {
        if (error) {
          reject(error)
        } else {
          resolve(response)
        }
      })
    })
  }

  // Handle callback responses
  handleResponse(data) {
    const { _callbackId, error, result } = data
    
    if (_callbackId && this.pendingCallbacks.has(_callbackId)) {
      const callback = this.pendingCallbacks.get(_callbackId)
      this.pendingCallbacks.delete(_callbackId)
      
      if (error) {
        callback(new Error(error))
      } else {
        callback(null, result)
      }
    }
  }

  // Process pending callbacks after reconnection
  processPendingCallbacks() {
    // Clear old callbacks on reconnect (they're stale)
    this.pendingCallbacks.clear()
  }

  // Generate unique callback ID
  generateCallbackId() {
    return `cb_${++this.callbackId}_${Date.now()}`
  }

  // MQTT Discovery methods
  async startDiscovery(options = {}) {
    return this.emitAsync('start-discovery', options)
  }

  async stopDiscovery() {
    return this.emitAsync('stop-discovery')
  }

  async getDiscoveryStatus() {
    return this.emitAsync('get-discovery-status')
  }

  // Network scanning methods
  async startNetworkScan(options = {}) {
    return this.emitAsync('start-network-scan', options)
  }

  async stopNetworkScan(scanId) {
    return this.emitAsync('stop-network-scan', { scanId })
  }

  // MQTT connection methods
  async connectToBroker(brokerConfig) {
    return this.emitAsync('connect-broker', brokerConfig)
  }

  async disconnectFromBroker(brokerId) {
    return this.emitAsync('disconnect-broker', { brokerId })
  }

  async subscribeToTopic(brokerId, topic, qos = 0) {
    return this.emitAsync('subscribe-topic', { brokerId, topic, qos })
  }

  async unsubscribeFromTopic(brokerId, topic) {
    return this.emitAsync('unsubscribe-topic', { brokerId, topic })
  }

  async publishMessage(brokerId, topic, message, options = {}) {
    return this.emitAsync('publish-message', {
      brokerId,
      topic,
      message,
      ...options
    })
  }

  // AI service methods
  async queryAI(query, context = {}) {
    return this.emitAsync('ai-query', { query, context })
  }

  async analyzePayload(payload, context = {}) {
    return this.emitAsync('ai-analyze-payload', { payload, context })
  }

  // Data export methods
  async requestExport(exportConfig) {
    return this.emitAsync('request-export', exportConfig)
  }

  // Utility methods
  getConnectionState() {
    return this.connectionState
  }

  getLastError() {
    return this.lastError
  }

  getReconnectAttempts() {
    return this.reconnectAttempts
  }

  isSocketConnected() {
    return this.isConnected
  }

  // Health check
  async ping() {
    if (!this.isConnected) {
      throw new Error('Not connected')
    }
    
    const start = Date.now()
    await this.emitAsync('ping')
    const end = Date.now()
    
    return end - start // Return latency in ms
  }

  // Connection quality monitoring
  async measureLatency() {
    try {
      return await this.ping()
    } catch (error) {
      return -1
    }
  }

  // Subscribe to multiple events at once
  subscribeToEvents(eventHandlers) {
    const unsubscribers = []
    
    Object.entries(eventHandlers).forEach(([event, handler]) => {
      const unsubscribe = this.on(event, handler)
      unsubscribers.push(unsubscribe)
    })
    
    // Return function to unsubscribe from all events
    return () => {
      unsubscribers.forEach(unsubscribe => unsubscribe())
    }
  }

  // Batch operations
  async batchEmit(operations) {
    const promises = operations.map(({ event, data }) => 
      this.emitAsync(event, data).catch(error => ({ error, event, data }))
    )
    
    return Promise.all(promises)
  }

  // Connection statistics
  getConnectionStats() {
    return {
      isConnected: this.isConnected,
      connectionState: this.connectionState,
      lastConnected: this.lastConnected,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
      serverUrl: this.serverUrl,
      activeListeners: this.eventListeners.size,
      pendingCallbacks: this.pendingCallbacks.size
    }
  }

  // Debug helpers
  enableDebugMode() {
    if (this.socket) {
      this.socket.onAny((event, ...args) => {
        console.log(`[Socket] ${event}:`, args)
      })
    }
  }

  disableDebugMode() {
    if (this.socket) {
      this.socket.offAny()
    }
  }

  // Clean up resources
  destroy() {
    this.disconnect()
    this.eventListeners.clear()
    this.pendingCallbacks.clear()
  }
}

// Create singleton instance
export const socketService = new SocketService()

// Export class for testing
export default SocketService