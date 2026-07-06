import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Zap,
  Layers,
  Cpu,
  Server,
  HardDrive,
  Activity,
  Clock,
  ChevronRight,
  ChevronDown
} from 'lucide-react'

// Store
import { useMQTTStore } from '../../store/mqttStore'

const SparkplugView = () => {
  const {
    sparkplugGroups,
    sparkplugDevices,
    getRecentSparkplugMetrics
  } = useMQTTStore()

  // Set of expanded tree node keys (groups and edge nodes)
  const [expanded, setExpanded] = useState(new Set())

  const toggle = (key) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  // Convert live Maps to arrays for rendering
  const groups = Array.from(sparkplugGroups.values())
  const metrics = getRecentSparkplugMetrics(200)

  // Summary stats
  const groupCount = groups.length
  const edgeNodeCount = groups.reduce(
    (sum, group) => sum + (group.edgeNodes ? group.edgeNodes.size : 0),
    0
  )
  const deviceCount = sparkplugDevices.size
  const metricCount = metrics.length

  const formatRelative = (value) => {
    if (!value) return '—'
    const then = new Date(value).getTime()
    if (Number.isNaN(then)) return '—'
    const diff = Date.now() - then
    const seconds = Math.floor(diff / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) return `${days}d ago`
    if (hours > 0) return `${hours}h ago`
    if (minutes > 0) return `${minutes}m ago`
    if (seconds > 0) return `${seconds}s ago`
    return 'Just now'
  }

  const formatTimestamp = (value) => {
    if (!value) return '—'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return '—'
    return date.toLocaleTimeString()
  }

  const formatValue = (value) => {
    if (value === null || value === undefined) return '—'
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    }
    return String(value)
  }

  const statCards = [
    { label: 'Groups', value: groupCount, icon: Layers, color: 'text-primary-600 dark:text-primary-400' },
    { label: 'Edge Nodes', value: edgeNodeCount, icon: Server, color: 'text-blue-600 dark:text-blue-400' },
    { label: 'Devices', value: deviceCount, icon: HardDrive, color: 'text-green-600 dark:text-green-400' },
    { label: 'Recent Metrics', value: metricCount, icon: Activity, color: 'text-purple-600 dark:text-purple-400' }
  ]

  const displayedMetrics = metrics.slice(-100).reverse()

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Sparkplug B
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Monitor Sparkplug B groups, edge nodes, devices, and metrics
          </p>
        </div>
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
          <Zap className="w-6 h-6 text-primary-600 dark:text-primary-400" />
        </div>
      </div>

      {/* Summary Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card, index) => {
          const Icon = card.icon
          return (
            <motion.div
              key={card.label}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05 }}
              className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {card.label}
                  </p>
                  <p className="text-3xl font-bold text-gray-900 dark:text-white mt-1">
                    {card.value}
                  </p>
                </div>
                <Icon className={`w-8 h-8 ${card.color}`} />
              </div>
            </motion.div>
          )
        })}
      </div>

      {groups.length === 0 ? (
        /* Empty State */
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-12 text-center"
        >
          <Zap className="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
            No Sparkplug B data
          </h3>
          <p className="text-gray-600 dark:text-gray-400">
            Subscribe to <span className="font-mono text-primary-600 dark:text-primary-400">spBv1.0/#</span> topics to start seeing groups, devices, and metrics.
          </p>
        </motion.div>
      ) : (
        <>
          {/* Hierarchical Tree */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700"
          >
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                <Layers className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                Device Hierarchy
              </h2>
            </div>

            <div className="p-2 sm:p-4 space-y-1">
              {groups.map(group => {
                const groupKey = `group:${group.id}`
                const groupExpanded = expanded.has(groupKey)
                const edgeNodes = group.edgeNodes ? Array.from(group.edgeNodes.values()) : []

                return (
                  <div key={groupKey}>
                    {/* Group row */}
                    <button
                      onClick={() => toggle(groupKey)}
                      className="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors text-left"
                    >
                      {groupExpanded ? (
                        <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                      )}
                      <Cpu className="w-4 h-4 text-primary-600 dark:text-primary-400 flex-shrink-0" />
                      <span className="font-medium text-gray-900 dark:text-white truncate">
                        {group.id}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {edgeNodes.length} edge node{edgeNodes.length === 1 ? '' : 's'}
                      </span>
                      <div className="ml-auto flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
                        <span className="flex items-center gap-1">
                          <Activity className="w-3 h-3" />
                          {group.messageCount ?? 0}
                        </span>
                        <span className="hidden sm:flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatRelative(group.lastActivity)}
                        </span>
                      </div>
                    </button>

                    {/* Edge nodes */}
                    <AnimatePresence initial={false}>
                      {groupExpanded && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          className="overflow-hidden ml-4 sm:ml-6 border-l border-gray-200 dark:border-gray-700 pl-2"
                        >
                          {edgeNodes.length === 0 && (
                            <p className="px-2 py-2 text-xs text-gray-400 italic">
                              No edge nodes
                            </p>
                          )}
                          {edgeNodes.map(edge => {
                            const edgeKey = `edge:${group.id}/${edge.id}`
                            const edgeExpanded = expanded.has(edgeKey)
                            const devices = edge.devices ? Array.from(edge.devices.values()) : []

                            return (
                              <div key={edgeKey}>
                                {/* Edge node row */}
                                <button
                                  onClick={() => toggle(edgeKey)}
                                  className="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors text-left"
                                >
                                  {edgeExpanded ? (
                                    <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
                                  ) : (
                                    <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                                  )}
                                  <Server className="w-4 h-4 text-blue-600 dark:text-blue-400 flex-shrink-0" />
                                  <span className="text-gray-900 dark:text-white truncate">
                                    {edge.id}
                                  </span>
                                  <span className="text-xs text-gray-500 dark:text-gray-400">
                                    {devices.length} device{devices.length === 1 ? '' : 's'}
                                  </span>
                                  <div className="ml-auto flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
                                    <span className="flex items-center gap-1">
                                      <Activity className="w-3 h-3" />
                                      {edge.messageCount ?? 0}
                                    </span>
                                    <span className="hidden sm:flex items-center gap-1">
                                      <Clock className="w-3 h-3" />
                                      {formatRelative(edge.lastActivity)}
                                    </span>
                                  </div>
                                </button>

                                {/* Devices */}
                                <AnimatePresence initial={false}>
                                  {edgeExpanded && (
                                    <motion.div
                                      initial={{ opacity: 0, height: 0 }}
                                      animate={{ opacity: 1, height: 'auto' }}
                                      exit={{ opacity: 0, height: 0 }}
                                      className="overflow-hidden ml-4 sm:ml-6 border-l border-gray-200 dark:border-gray-700 pl-2"
                                    >
                                      {devices.length === 0 && (
                                        <p className="px-2 py-2 text-xs text-gray-400 italic">
                                          No devices
                                        </p>
                                      )}
                                      {devices.map(device => (
                                        <div
                                          key={`device:${group.id}/${edge.id}/${device.id}`}
                                          className="flex items-center gap-2 px-2 py-2 rounded-lg"
                                        >
                                          <span className="w-4 h-4 flex-shrink-0" />
                                          <HardDrive className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0" />
                                          <span className="text-gray-700 dark:text-gray-300 truncate">
                                            {device.id}
                                          </span>
                                          <span className="text-xs text-gray-500 dark:text-gray-400">
                                            {device.metrics ? device.metrics.size : 0} metric{(device.metrics ? device.metrics.size : 0) === 1 ? '' : 's'}
                                          </span>
                                          <div className="ml-auto flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
                                            <span className="flex items-center gap-1">
                                              <Activity className="w-3 h-3" />
                                              {device.messageCount ?? 0}
                                            </span>
                                            <span className="hidden sm:flex items-center gap-1">
                                              <Clock className="w-3 h-3" />
                                              {formatRelative(device.lastActivity)}
                                            </span>
                                          </div>
                                        </div>
                                      ))}
                                    </motion.div>
                                  )}
                                </AnimatePresence>
                              </div>
                            )
                          })}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )
              })}
            </div>
          </motion.div>

          {/* Recent Metrics Table */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700"
          >
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                <Activity className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                Recent Metrics
              </h2>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                Showing {displayedMetrics.length} of {metricCount}
              </span>
            </div>

            {displayedMetrics.length === 0 ? (
              <div className="p-8 text-center text-gray-500 dark:text-gray-400">
                No metrics received yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-700 text-left text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">
                      <th className="px-6 py-3 font-medium">Name</th>
                      <th className="px-6 py-3 font-medium">Value</th>
                      <th className="px-6 py-3 font-medium">Datatype</th>
                      <th className="px-6 py-3 font-medium">Device Path</th>
                      <th className="px-6 py-3 font-medium">Type</th>
                      <th className="px-6 py-3 font-medium">Timestamp</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                    {displayedMetrics.map((metric, index) => {
                      const devicePath = [metric.groupId, metric.edgeNodeId, metric.deviceId]
                        .filter(Boolean)
                        .join('/')
                      return (
                        <tr
                          key={`${metric.groupId}-${metric.edgeNodeId}-${metric.deviceId}-${metric.name ?? metric.alias}-${index}`}
                          className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
                        >
                          <td className="px-6 py-3 font-medium text-gray-900 dark:text-white whitespace-nowrap">
                            {metric.name || metric.alias || '—'}
                          </td>
                          <td className="px-6 py-3 font-mono text-gray-700 dark:text-gray-300 max-w-xs truncate">
                            {formatValue(metric.value)}
                          </td>
                          <td className="px-6 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">
                            {metric.datatypeName || '—'}
                          </td>
                          <td className="px-6 py-3 font-mono text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">
                            {devicePath || '—'}
                          </td>
                          <td className="px-6 py-3 whitespace-nowrap">
                            <span className="px-2 py-1 text-xs font-medium rounded-full bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
                              {metric.messageType || '—'}
                            </span>
                          </td>
                          <td className="px-6 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">
                            {formatTimestamp(metric.timestamp)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </motion.div>
        </>
      )}
    </div>
  )
}

export default SparkplugView
