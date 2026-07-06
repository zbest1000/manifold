import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Server,
  Wifi,
  Plus,
  Power,
  ArrowDown,
  ArrowUp,
  AlertTriangle,
  ListTree,
  Clock,
  Lock,
  Loader2
} from 'lucide-react'

// Store & services
import { useMQTTStore } from '../../store/mqttStore'
import { socketService } from '../../services/socketService'

const MQTTBrokers = () => {
  const { brokerConnections, discoveredBrokers } = useMQTTStore()

  // Connect form state (controlled inputs)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('1883')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [protocol, setProtocol] = useState('mqtt')
  const [cleanSession, setCleanSession] = useState(true)

  // Live data from the store (Maps -> arrays)
  const connections = Array.from(brokerConnections.entries())
  const discoveredCount = discoveredBrokers.size

  const resetForm = () => {
    setHost('')
    setPort('1883')
    setUsername('')
    setPassword('')
    setProtocol('mqtt')
    setCleanSession(true)
  }

  const handleConnect = (e) => {
    e.preventDefault()

    // Validate host/port are non-empty before emitting
    if (!host.trim() || !String(port).trim()) return

    socketService.emit('connect-mqtt', {
      host: host.trim(),
      port: Number(port),
      username: username.trim(),
      password,
      protocol,
      cleanSession
    })

    resetForm()
  }

  const handleDisconnect = (brokerId) => {
    socketService.emit('disconnect-mqtt', brokerId)
  }

  const getStatusColor = (status) => {
    switch (status) {
      case 'connected':
        return 'text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/20'
      case 'connecting':
        return 'text-yellow-600 dark:text-yellow-400 bg-yellow-100 dark:bg-yellow-900/20'
      case 'error':
        return 'text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/20'
      case 'disconnected':
      default:
        return 'text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-700'
    }
  }

  const formatDateTime = (value) => {
    if (!value) return '—'
    const date = new Date(value)
    if (isNaN(date.getTime())) return '—'
    return date.toLocaleString()
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            MQTT Brokers
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Manage your MQTT broker connections and monitor activity
          </p>
        </div>

        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-1">
            <Wifi className="w-4 h-4 text-green-600 dark:text-green-400" />
            <span className="text-gray-600 dark:text-gray-400">
              {connections.length} Connected
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Server className="w-4 h-4 text-primary-600 dark:text-primary-400" />
            <span className="text-gray-600 dark:text-gray-400">
              {discoveredCount} Discovered
            </span>
          </div>
        </div>
      </div>

      {/* Connect to Broker form */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6"
      >
        <div className="flex items-center gap-2 mb-4">
          <Plus className="w-5 h-5 text-primary-600 dark:text-primary-400" />
          <h3 className="font-medium text-gray-900 dark:text-white">
            Connect to Broker
          </h3>
        </div>

        <form onSubmit={handleConnect} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Host */}
            <div className="lg:col-span-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Host
              </label>
              <input
                type="text"
                required
                placeholder="192.168.1.100 or broker.example.com"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </div>

            {/* Port */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Port
              </label>
              <input
                type="number"
                required
                min="1"
                max="65535"
                placeholder="1883"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </div>

            {/* Username */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Username <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </div>

            {/* Password */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Password <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </div>

            {/* Protocol */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Protocol
              </label>
              <select
                value={protocol}
                onChange={(e) => setProtocol(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              >
                <option value="mqtt">mqtt</option>
                <option value="mqtts">mqtts (TLS)</option>
              </select>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={cleanSession}
                onChange={(e) => setCleanSession(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500"
              />
              Clean session
            </label>

            <button
              type="submit"
              disabled={!host.trim() || !String(port).trim()}
              className="px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Plus className="w-4 h-4" />
              Connect
            </button>
          </div>
        </form>
      </motion.div>

      {/* Active connections */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
        <AnimatePresence>
          {connections.map(([brokerId, conn], index) => {
            const metrics = conn.metrics || {}
            return (
              <motion.div
                key={brokerId}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ delay: index * 0.1 }}
                className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 hover:shadow-lg transition-shadow"
              >
                {/* Header */}
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-2">
                    {conn.status === 'connecting' ? (
                      <Loader2 className="w-5 h-5 text-yellow-500 animate-spin" />
                    ) : (
                      <Wifi className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                    )}
                    <h3 className="font-medium text-gray-900 dark:text-white">
                      {conn.host}:{conn.port}
                    </h3>
                  </div>
                  <span className={`px-2 py-1 text-xs font-medium rounded-full ${getStatusColor(conn.status)}`}>
                    {conn.status || 'unknown'}
                  </span>
                </div>

                {/* Details */}
                <div className="space-y-3">
                  {conn.protocol && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-600 dark:text-gray-400">Protocol:</span>
                      <span className="text-gray-900 dark:text-white flex items-center gap-1">
                        {conn.protocol}
                        {conn.protocol === 'mqtts' && (
                          <Lock className="w-3 h-3 text-green-600 dark:text-green-400" />
                        )}
                      </span>
                    </div>
                  )}

                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-600 dark:text-gray-400 flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      Connected:
                    </span>
                    <span className="text-gray-900 dark:text-white">
                      {formatDateTime(conn.connectedAt)}
                    </span>
                  </div>

                  {conn.lastActivity && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-600 dark:text-gray-400">Last activity:</span>
                      <span className="text-gray-900 dark:text-white">
                        {formatDateTime(conn.lastActivity)}
                      </span>
                    </div>
                  )}
                </div>

                {/* Metrics */}
                <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                  <div className="flex items-center gap-2">
                    <ArrowDown className="w-4 h-4 text-green-600 dark:text-green-400" />
                    <div>
                      <div className="text-sm font-semibold text-gray-900 dark:text-white">
                        {metrics.messagesReceived ?? 0}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">Received</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <ArrowUp className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    <div>
                      <div className="text-sm font-semibold text-gray-900 dark:text-white">
                        {metrics.messagesSent ?? 0}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">Sent</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <ListTree className="w-4 h-4 text-primary-600 dark:text-primary-400" />
                    <div>
                      <div className="text-sm font-semibold text-gray-900 dark:text-white">
                        {metrics.subscriptions ?? 0}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">Subscriptions</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400" />
                    <div>
                      <div className="text-sm font-semibold text-gray-900 dark:text-white">
                        {metrics.errors ?? 0}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">Errors</div>
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                  <button
                    onClick={() => handleDisconnect(brokerId)}
                    className="w-full px-3 py-2 bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    <Power className="w-4 h-4" />
                    Disconnect
                  </button>
                </div>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>

      {/* Empty state */}
      {connections.length === 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-center py-12"
        >
          <Server className="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
            No active broker connections
          </h3>
          <p className="text-gray-600 dark:text-gray-400">
            Use the form above to connect to an MQTT broker and start monitoring activity.
          </p>
        </motion.div>
      )}
    </div>
  )
}

export default MQTTBrokers
