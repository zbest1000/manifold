import React, { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Download,
  FileText,
  Clock,
  CheckCircle,
  AlertCircle,
  Loader,
  Info,
  HardDrive,
  Database
} from 'lucide-react'

import { socketService } from '../../services/socketService'

const FORMAT_OPTIONS = [
  { value: 'json', label: 'JSON (.json)' },
  { value: 'csv', label: 'CSV (.csv)' },
  { value: 'yaml', label: 'YAML (.yaml)' }
]

const INCLUDE_OPTIONS = [
  { key: 'includeMessages', label: 'Messages', description: 'Captured MQTT message payloads and metadata' },
  { key: 'includeTopics', label: 'Topics', description: 'Discovered topic tree and hierarchy' },
  { key: 'includeMetrics', label: 'Metrics', description: 'Traffic rates, counts, and connection stats' },
  { key: 'includeBrokerInfo', label: 'Broker Info', description: 'Broker connections and configuration' },
  { key: 'includeSparkplugData', label: 'Sparkplug Data', description: 'Decoded Sparkplug B nodes and metrics' }
]

const formatBytes = (bytes) => {
  if (bytes == null || Number.isNaN(bytes)) return 'Unknown size'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(2)} MB`
}

const formatTimestamp = (timestamp) => {
  const date = timestamp ? new Date(timestamp) : new Date()
  if (Number.isNaN(date.getTime())) return 'Unknown time'
  return date.toLocaleString()
}

const DataExport = () => {
  const [format, setFormat] = useState('json')
  const [includes, setIncludes] = useState({
    includeMessages: true,
    includeTopics: true,
    includeMetrics: true,
    includeBrokerInfo: true,
    includeSparkplugData: true
  })

  const [isExporting, setIsExporting] = useState(false)
  const [exports, setExports] = useState([])
  const [feedback, setFeedback] = useState(null)

  useEffect(() => {
    const handleExportReady = (data) => {
      setIsExporting(false)
      setExports((prev) => [
        {
          id: data?.id || `export-${Date.now()}`,
          filename: data?.filename || 'export',
          filepath: data?.filepath || '',
          format: data?.format || 'json',
          size: data?.size,
          timestamp: data?.timestamp || new Date().toISOString()
        },
        ...prev
      ])
      setFeedback({
        type: 'success',
        message: `Export ready: ${data?.filename || 'file written to server/exports'}`
      })
    }

    const handleExportError = (data) => {
      setIsExporting(false)
      setFeedback({
        type: 'error',
        message: data?.error || 'Export failed. Please try again.'
      })
    }

    const unsubscribeReady = socketService.on('export-ready', handleExportReady)
    const unsubscribeError = socketService.on('export-error', handleExportError)

    return () => {
      unsubscribeReady()
      unsubscribeError()
    }
  }, [])

  const toggleInclude = (key) => {
    setIncludes((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const handleExport = () => {
    setIsExporting(true)
    setFeedback(null)
    socketService.emit('export-data', { format, ...includes })
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Data Export
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Export captured MQTT data in various formats
          </p>
        </div>

        <button
          onClick={handleExport}
          disabled={isExporting}
          className="px-4 py-2 bg-primary-600 hover:bg-primary-700 disabled:opacity-60 disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center gap-2"
        >
          {isExporting ? (
            <>
              <Loader className="w-4 h-4 animate-spin" />
              Exporting…
            </>
          ) : (
            <>
              <Download className="w-4 h-4" />
              Export
            </>
          )}
        </button>
      </div>

      {/* Feedback banner */}
      <AnimatePresence>
        {feedback && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className={`p-4 rounded-lg border flex items-center gap-3 ${
              feedback.type === 'success'
                ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
                : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
            }`}
          >
            {feedback.type === 'success' ? (
              <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400 flex-shrink-0" />
            ) : (
              <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0" />
            )}
            <span className={`text-sm ${
              feedback.type === 'success'
                ? 'text-green-800 dark:text-green-200'
                : 'text-red-800 dark:text-red-200'
            }`}>
              {feedback.message}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Export Form */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="lg:col-span-2 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6"
        >
          <h3 className="font-medium text-gray-900 dark:text-white mb-4 flex items-center gap-2">
            <Download className="w-5 h-5 text-primary-600 dark:text-primary-400" />
            Export Configuration
          </h3>

          {/* Format select */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Format
            </label>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            >
              {FORMAT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              JSON, CSV, and YAML are reliably supported. Excel (xlsx) is not yet supported.
            </p>
          </div>

          {/* Include checkboxes */}
          <div>
            <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              Include in export
            </span>
            <div className="space-y-2">
              {INCLUDE_OPTIONS.map((option) => (
                <label
                  key={option.key}
                  className="flex items-start gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={includes[option.key]}
                    onChange={() => toggleInclude(option.key)}
                    className="mt-0.5 w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500"
                  />
                  <span>
                    <span className="block text-sm font-medium text-gray-900 dark:text-white">
                      {option.label}
                    </span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <button
            onClick={handleExport}
            disabled={isExporting}
            className="mt-6 w-full px-4 py-2 bg-primary-600 hover:bg-primary-700 disabled:opacity-60 disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            {isExporting ? (
              <>
                <Loader className="w-4 h-4 animate-spin" />
                Exporting…
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                Export {format.toUpperCase()}
              </>
            )}
          </button>
        </motion.div>

        {/* Helper card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 p-6"
        >
          <h3 className="font-medium text-blue-800 dark:text-blue-200 mb-3 flex items-center gap-2">
            <Info className="w-5 h-5" />
            About exports
          </h3>
          <ul className="space-y-3 text-sm text-blue-700 dark:text-blue-300">
            <li className="flex items-start gap-2">
              <Database className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>
                Exports bundle the data you select — messages, topics, metrics, broker
                info, and Sparkplug data — into a single file.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <HardDrive className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>
                Files are written server-side to <code className="font-mono text-xs bg-blue-100 dark:bg-blue-900/40 px-1 py-0.5 rounded">server/exports</code>.
                The generated filename and size appear in the history below.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <FileText className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>
                Pick the format that fits your tooling: JSON for full structure, CSV for
                spreadsheets, YAML for readability.
              </span>
            </li>
          </ul>
        </motion.div>
      </div>

      {/* Export history */}
      <div>
        <h3 className="font-medium text-gray-900 dark:text-white mb-4 flex items-center gap-2">
          <Clock className="w-5 h-5 text-gray-600 dark:text-gray-400" />
          Export history
        </h3>

        {exports.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-12 text-center"
          >
            <Download className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <h4 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
              No exports yet
            </h4>
            <p className="text-gray-600 dark:text-gray-400">
              Configure and run an export to see generated files listed here.
            </p>
          </motion.div>
        ) : (
          <div className="space-y-3">
            <AnimatePresence>
              {exports.map((item, index) => (
                <motion.div
                  key={item.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ delay: index * 0.05 }}
                  className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 flex items-center justify-between gap-4 hover:shadow-lg transition-shadow"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="p-2 rounded-lg bg-primary-100 dark:bg-primary-900/20 flex-shrink-0">
                      <FileText className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 dark:text-white truncate">
                        {item.filename}
                      </p>
                      <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 mt-1">
                        <span className="flex items-center gap-1">
                          <HardDrive className="w-3.5 h-3.5" />
                          {formatBytes(item.size)}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5" />
                          {formatTimestamp(item.timestamp)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <span className="px-2 py-1 text-xs font-medium rounded-full uppercase bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 flex-shrink-0">
                    {item.format}
                  </span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  )
}

export default DataExport
