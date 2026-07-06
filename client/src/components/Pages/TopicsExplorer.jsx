import React, { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search,
  Send,
  Plus,
  X,
  Server,
  Hash,
  Clock,
  Radio,
  Inbox,
  Activity,
  MessageCircle
} from 'lucide-react'

// Store & Services
import { useMQTTStore } from '../../store/mqttStore'
import { socketService } from '../../services/socketService'

const QOS_OPTIONS = [0, 1, 2]

const TopicsExplorer = () => {
  const {
    brokerConnections,
    topicsByBroker,
    getMessages,
    getSubscriptions
  } = useMQTTStore()

  // Broker + topic selection
  const [selectedBrokerId, setSelectedBrokerId] = useState('')
  const [selectedTopic, setSelectedTopic] = useState(null)

  // Subscribe form
  const [subscribeTopic, setSubscribeTopic] = useState('')
  const [subscribeQos, setSubscribeQos] = useState('0')

  // Publish form
  const [publishTopic, setPublishTopic] = useState('')
  const [publishPayload, setPublishPayload] = useState('')
  const [publishQos, setPublishQos] = useState('0')
  const [publishRetain, setPublishRetain] = useState(false)

  // Filters
  const [topicFilter, setTopicFilter] = useState('')
  const [messageSearch, setMessageSearch] = useState('')

  const brokerList = Array.from(brokerConnections.entries()).map(([id, conn]) => ({
    id,
    ...conn
  }))

  // Auto-select the first broker, and keep selection valid as brokers change.
  useEffect(() => {
    if (brokerList.length === 0) {
      if (selectedBrokerId) setSelectedBrokerId('')
      return
    }
    const stillExists = brokerList.some((b) => b.id === selectedBrokerId)
    if (!stillExists) {
      setSelectedBrokerId(brokerList[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brokerConnections])

  // Reset the selected topic when switching brokers.
  useEffect(() => {
    setSelectedTopic(null)
  }, [selectedBrokerId])

  const brokerLabel = (conn) => {
    if (conn?.host) {
      return conn.port ? `${conn.host}:${conn.port}` : conn.host
    }
    return conn?.clientId || conn?.id
  }

  const formatTimestamp = (ts) => {
    if (!ts) return '—'
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return String(ts)
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  const formatPayload = (payload) => {
    if (payload === null || payload === undefined) return ''
    if (typeof payload === 'object') {
      try {
        return JSON.stringify(payload)
      } catch {
        return String(payload)
      }
    }
    return String(payload)
  }

  const truncate = (text, max = 160) =>
    text.length > max ? `${text.slice(0, max)}…` : text

  // Derived data for the selected broker
  const topicsMap = selectedBrokerId
    ? topicsByBroker.get(selectedBrokerId) || new Map()
    : new Map()

  const topics = Array.from(topicsMap.entries())
    .map(([topic, info]) => ({ topic, ...info }))
    .filter((t) =>
      topicFilter ? t.topic.toLowerCase().includes(topicFilter.toLowerCase()) : true
    )
    .sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0))

  const subscriptions = selectedBrokerId
    ? Array.from(getSubscriptions(selectedBrokerId))
    : []

  const messages = selectedBrokerId ? getMessages(selectedBrokerId, 300) : []

  const filteredMessages = messages
    .filter((m) => (selectedTopic ? m.topic === selectedTopic : true))
    .filter((m) => {
      if (!messageSearch) return true
      const query = messageSearch.toLowerCase()
      return (
        (m.topic || '').toLowerCase().includes(query) ||
        formatPayload(m.payload).toLowerCase().includes(query)
      )
    })
    .slice()
    .reverse()

  const handleSubscribe = (e) => {
    e.preventDefault()
    const topic = subscribeTopic.trim()
    if (!selectedBrokerId || !topic) return
    socketService.emit('subscribe-topic', {
      brokerId: selectedBrokerId,
      topic,
      qos: Number(subscribeQos)
    })
    setSubscribeTopic('')
  }

  const handleUnsubscribe = (topic) => {
    if (!selectedBrokerId) return
    socketService.emit('unsubscribe-topic', {
      brokerId: selectedBrokerId,
      topic
    })
  }

  const handlePublish = (e) => {
    e.preventDefault()
    const topic = publishTopic.trim()
    if (!selectedBrokerId || !topic) return
    socketService.emit('publish-message', {
      brokerId: selectedBrokerId,
      topic,
      payload: publishPayload,
      options: { qos: Number(publishQos), retain: publishRetain }
    })
  }

  const inputClasses =
    'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:ring-2 focus:ring-primary-500 focus:border-transparent'

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Topics Explorer
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Subscribe, publish, and monitor MQTT message flow in real time
          </p>
        </div>

        {brokerList.length > 0 && (
          <div className="flex items-center gap-2">
            <Server className="w-5 h-5 text-primary-600 dark:text-primary-400" />
            <select
              value={selectedBrokerId}
              onChange={(e) => setSelectedBrokerId(e.target.value)}
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500"
            >
              {brokerList.map((broker) => (
                <option key={broker.id} value={broker.id}>
                  {brokerLabel(broker)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Empty state — no connected brokers */}
      {brokerList.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-12 text-center"
        >
          <Server className="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
            No connected brokers
          </h3>
          <p className="text-gray-600 dark:text-gray-400">
            Connect to a broker first to explore topics and monitor messages.
          </p>
        </motion.div>
      ) : (
        <>
          {/* Subscribe + Publish forms */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Subscribe */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6"
            >
              <div className="flex items-center gap-2 mb-4">
                <Radio className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                <h3 className="font-medium text-gray-900 dark:text-white">Subscribe</h3>
              </div>

              <form onSubmit={handleSubscribe} className="space-y-3">
                <input
                  type="text"
                  value={subscribeTopic}
                  onChange={(e) => setSubscribeTopic(e.target.value)}
                  placeholder="Topic filter (e.g. sensors/# )"
                  className={inputClasses}
                />
                <div className="flex items-center gap-3">
                  <select
                    value={subscribeQos}
                    onChange={(e) => setSubscribeQos(e.target.value)}
                    className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  >
                    {QOS_OPTIONS.map((q) => (
                      <option key={q} value={q}>
                        QoS {q}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    disabled={!subscribeTopic.trim()}
                    className="flex-1 px-4 py-2 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    <Plus className="w-4 h-4" />
                    Subscribe
                  </button>
                </div>
              </form>

              {/* Active subscriptions */}
              <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
                  Active Subscriptions ({subscriptions.length})
                </p>
                {subscriptions.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    No active subscriptions yet.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {subscriptions.map((topic) => (
                      <span
                        key={topic}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-mono rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300"
                      >
                        {topic}
                        <button
                          type="button"
                          onClick={() => handleUnsubscribe(topic)}
                          className="hover:text-red-600 dark:hover:text-red-400"
                          title="Unsubscribe"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>

            {/* Publish */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6"
            >
              <div className="flex items-center gap-2 mb-4">
                <Send className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                <h3 className="font-medium text-gray-900 dark:text-white">Publish</h3>
              </div>

              <form onSubmit={handlePublish} className="space-y-3">
                <input
                  type="text"
                  value={publishTopic}
                  onChange={(e) => setPublishTopic(e.target.value)}
                  placeholder="Topic (e.g. sensors/temperature )"
                  className={inputClasses}
                />
                <textarea
                  value={publishPayload}
                  onChange={(e) => setPublishPayload(e.target.value)}
                  placeholder="Payload"
                  rows={3}
                  className={`${inputClasses} font-mono resize-y`}
                />
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <select
                      value={publishQos}
                      onChange={(e) => setPublishQos(e.target.value)}
                      className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                    >
                      {QOS_OPTIONS.map((q) => (
                        <option key={q} value={q}>
                          QoS {q}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                      <input
                        type="checkbox"
                        checked={publishRetain}
                        onChange={(e) => setPublishRetain(e.target.checked)}
                        className="rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500"
                      />
                      Retain
                    </label>
                  </div>
                  <button
                    type="submit"
                    disabled={!publishTopic.trim()}
                    className="px-4 py-2 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center gap-2"
                  >
                    <Send className="w-4 h-4" />
                    Publish
                  </button>
                </div>
              </form>
            </motion.div>
          </div>

          {/* Topics list + Message log */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Topics list */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 flex flex-col"
            >
              <div className="p-4 border-b border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-2 mb-3">
                  <Hash className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                  <h3 className="font-medium text-gray-900 dark:text-white">
                    Topics ({topics.length})
                  </h3>
                </div>
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    value={topicFilter}
                    onChange={(e) => setTopicFilter(e.target.value)}
                    placeholder="Filter topics..."
                    className={`${inputClasses} pl-10`}
                  />
                </div>
              </div>

              <div className="max-h-[28rem] overflow-y-auto">
                {topics.length === 0 ? (
                  <div className="p-8 text-center">
                    <Inbox className="w-10 h-10 text-gray-400 mx-auto mb-3" />
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      No topics observed yet.
                    </p>
                  </div>
                ) : (
                  <ul className="divide-y divide-gray-200 dark:divide-gray-700">
                    {topics.map((topic) => (
                      <li key={topic.topic}>
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedTopic(
                              selectedTopic === topic.topic ? null : topic.topic
                            )
                          }
                          className={`w-full text-left px-4 py-3 transition-colors ${
                            selectedTopic === topic.topic
                              ? 'bg-primary-50 dark:bg-primary-900/20'
                              : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-sm text-gray-900 dark:text-white truncate">
                              {topic.topic}
                            </span>
                            <span className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 shrink-0">
                              <Activity className="w-3 h-3" />
                              {topic.messageCount || 0}
                            </span>
                          </div>
                          <div className="flex items-center gap-1 mt-1 text-xs text-gray-500 dark:text-gray-400">
                            <Clock className="w-3 h-3" />
                            {formatTimestamp(topic.lastActivity)}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </motion.div>

            {/* Message log */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
              className="lg:col-span-2 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 flex flex-col"
            >
              <div className="p-4 border-b border-gray-200 dark:border-gray-700">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
                  <div className="flex items-center gap-2">
                    <MessageCircle className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                    <h3 className="font-medium text-gray-900 dark:text-white">
                      Messages ({filteredMessages.length})
                    </h3>
                  </div>
                  {selectedTopic && (
                    <button
                      type="button"
                      onClick={() => setSelectedTopic(null)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 self-start"
                    >
                      <span className="font-mono truncate max-w-[16rem]">{selectedTopic}</span>
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    value={messageSearch}
                    onChange={(e) => setMessageSearch(e.target.value)}
                    placeholder="Search messages by topic or payload..."
                    className={`${inputClasses} pl-10`}
                  />
                </div>
              </div>

              <div className="max-h-[28rem] overflow-y-auto">
                {filteredMessages.length === 0 ? (
                  <div className="p-8 text-center">
                    <Inbox className="w-10 h-10 text-gray-400 mx-auto mb-3" />
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {messageSearch || selectedTopic
                        ? 'No messages match the current filter.'
                        : 'No messages received yet. Subscribe to a topic to start monitoring.'}
                    </p>
                  </div>
                ) : (
                  <ul className="divide-y divide-gray-200 dark:divide-gray-700">
                    <AnimatePresence initial={false}>
                      {filteredMessages.map((message) => (
                        <motion.li
                          key={message.id}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          className="px-4 py-3"
                        >
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className="font-mono text-sm text-gray-900 dark:text-white truncate">
                              {message.topic}
                            </span>
                            <div className="flex items-center gap-2 shrink-0 text-xs">
                              <span className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                                QoS {message.qos ?? 0}
                              </span>
                              {message.retain && (
                                <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">
                                  retain
                                </span>
                              )}
                              <span className="flex items-center gap-1 text-gray-500 dark:text-gray-400">
                                <Clock className="w-3 h-3" />
                                {formatTimestamp(message.timestamp)}
                              </span>
                            </div>
                          </div>
                          <pre className="font-mono text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words bg-gray-50 dark:bg-gray-900/40 rounded p-2">
                            {truncate(formatPayload(message.payload)) || '(empty payload)'}
                          </pre>
                        </motion.li>
                      ))}
                    </AnimatePresence>
                  </ul>
                )}
              </div>
            </motion.div>
          </div>
        </>
      )}
    </div>
  )
}

export default TopicsExplorer
