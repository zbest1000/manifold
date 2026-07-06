import React, { useEffect, useState, useRef } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'

// Components
import Layout from './components/Layout/Layout'
import Dashboard from './components/Pages/Dashboard'
import NetworkDiscovery from './components/Pages/NetworkDiscovery'
import MQTTBrokers from './components/Pages/MQTTBrokers'
import TopicsExplorer from './components/Pages/TopicsExplorer'
import SparkplugView from './components/Pages/SparkplugView'
import AIAssistant from './components/Pages/AIAssistant'
import DataExport from './components/Pages/DataExport'
import Settings from './components/Pages/Settings'
import ErrorBoundary from './components/Common/ErrorBoundary'

// Services
import { socketService } from './services/socketService'
import { apiService } from './services/apiService'

// Store
import { useAppStore } from './store/appStore'
import { useMQTTStore } from './store/mqttStore'
import { useUIStore } from './store/uiStore'

function App() {
  const [isInitialized, setIsInitialized] = useState(false)
  const [systemStatus, setSystemStatus] = useState(null)
  
  // Store hooks
  const { setConnected, setConnectionStatus } = useAppStore()
  const { addBroker, updateBroker, updateTopics } = useMQTTStore()
  const { theme, setTheme } = useUIStore()

  // Batch incoming MQTT messages so we do one store write + re-render per ~150ms
  // instead of one per message (the previous path was O(n^2) under real traffic).
  const messageBatch = useRef(new Map())
  const flushScheduled = useRef(false)
  const initializedRef = useRef(false)

  const flushMessages = () => {
    flushScheduled.current = false
    const batch = messageBatch.current
    if (batch.size === 0) return
    messageBatch.current = new Map()
    const { addMessages } = useMQTTStore.getState()
    batch.forEach((msgs, brokerId) => addMessages(brokerId, msgs))
  }

  const queueMessage = (message) => {
    if (!message || !message.brokerId) return
    const arr = messageBatch.current.get(message.brokerId) || []
    arr.push(message)
    messageBatch.current.set(message.brokerId, arr)
    if (!flushScheduled.current) {
      flushScheduled.current = true
      setTimeout(flushMessages, 150)
    }
  }

  // Initialize once. The guard stops React StrictMode's dev double-invoke from
  // registering socket listeners twice.
  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true
    initializeApp()
  }, [])

  // Theme management
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  const initializeApp = async () => {
    try {
      // Check system status
      const status = await apiService.getSystemStatus()
      setSystemStatus(status)
      
      // Initialize WebSocket connection
      await socketService.connect()

      // Set up socket event listeners
      setupSocketListeners()

      // Seed connection state: the 'connect' listener is registered after
      // connect() already resolved, so it would otherwise miss the first event.
      setConnected(true)
      setConnectionStatus('connected')

      // Auto-discover brokers if enabled
      if (status.services?.mqttDiscovery?.isDiscovering) {
        toast.success('Network discovery is already running')
      }
      
      setIsInitialized(true)
      toast.success('MQTT Explore initialized successfully')
      
    } catch (error) {
      console.error('Failed to initialize app:', error)
      toast.error('Failed to initialize MQTT Explore')
      setIsInitialized(true) // Still show UI even if init fails
    }
  }

  const setupSocketListeners = () => {
    // Connection status
    socketService.on('connect', () => {
      setConnected(true)
      setConnectionStatus('connected')
      toast.success('Connected to MQTT Explore server')
    })

    socketService.on('disconnect', () => {
      setConnected(false)
      setConnectionStatus('disconnected')
      toast.error('Disconnected from server')
    })

    socketService.on('connect_error', (error) => {
      setConnected(false)
      setConnectionStatus('error')
      toast.error(`Connection error: ${error.message}`)
    })

    // MQTT Discovery events
    socketService.on('broker-discovered', (broker) => {
      addBroker(broker)
      toast.success(`New MQTT broker discovered: ${broker.host}:${broker.port}`)
    })

    socketService.on('broker-updated', (broker) => {
      updateBroker(broker.id, broker)
    })

    socketService.on('discovery-started', (data) => {
      toast.success('Network discovery started')
    })

    socketService.on('discovery-stopped', () => {
      toast.info('Network discovery stopped')
    })

    socketService.on('discovery-error', (data) => {
      toast.error(`Discovery error: ${data.error}`)
    })

    // MQTT Connection events
    socketService.on('mqtt-connected', (data) => {
      updateBroker(data.brokerId, { 
        status: 'connected',
        connectedAt: data.connectionInfo.connectedAt 
      })
      toast.success(`Connected to broker: ${data.brokerId}`)
    })

    socketService.on('mqtt-disconnected', (data) => {
      updateBroker(data.brokerId, { status: 'disconnected' })
      toast.info(`Disconnected from broker: ${data.brokerId}`)
    })

    socketService.on('mqtt-error', (data) => {
      updateBroker(data.brokerId, { status: 'error' })
      toast.error(`MQTT Error: ${data.error}`)
    })

    // Message events
    socketService.on('mqtt-message', (message) => {
      queueMessage(message)
    })

    socketService.on('topic-updated', (data) => {
      updateTopics(data.brokerId, { [data.topic]: data })
    })

    // AI events
    socketService.on('ai-response', (data) => {
      toast.success('AI analysis complete')
    })

    socketService.on('ai-error', (data) => {
      toast.error(`AI Error: ${data.error}`)
    })

    // Network scan events
    socketService.on('network-scan-started', (data) => {
      toast.success('Network scan started')
    })

    socketService.on('network-scan-completed', (data) => {
      toast.success(`Network scan completed: ${data.results.hosts.length} hosts found`)
    })

    socketService.on('network-scan-progress', (data) => {
      // Progress updates handled by specific components
    })

    // Export events
    socketService.on('export-ready', (data) => {
      toast.success('Data export completed')
    })

    socketService.on('export-error', (data) => {
      toast.error(`Export error: ${data.error}`)
    })
  }

  // Loading screen
  if (!isInitialized) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center text-white"
        >
          <div className="w-16 h-16 border-4 border-white border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <h2 className="text-2xl font-bold mb-2">MQTT Explore</h2>
          <p className="text-primary-100">Initializing network discovery...</p>
        </motion.div>
      </div>
    )
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 transition-colors duration-200">
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="discovery" element={<NetworkDiscovery />} />
            <Route path="brokers" element={<MQTTBrokers />} />
            <Route path="topics" element={<TopicsExplorer />} />
            <Route path="sparkplug" element={<SparkplugView />} />
            <Route path="ai" element={<AIAssistant />} />
            <Route path="export" element={<DataExport />} />
            <Route path="settings" element={<Settings />} />
            
            {/* Broker-specific routes */}
            <Route path="brokers/:brokerId" element={<MQTTBrokers />} />
            <Route path="brokers/:brokerId/topics" element={<TopicsExplorer />} />
            <Route path="brokers/:brokerId/topics/:topicName" element={<TopicsExplorer />} />
            
            {/* Sparkplug-specific routes */}
            <Route path="sparkplug/:groupId" element={<SparkplugView />} />
            <Route path="sparkplug/:groupId/:edgeNodeId" element={<SparkplugView />} />
            <Route path="sparkplug/:groupId/:edgeNodeId/:deviceId" element={<SparkplugView />} />
            
            {/* Catch all route */}
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Route>
        </Routes>

        {/* Global components */}
        <AnimatePresence>
          {/* Add global modals, notifications, etc. here */}
        </AnimatePresence>
      </div>
    </ErrorBoundary>
  )
}

export default App