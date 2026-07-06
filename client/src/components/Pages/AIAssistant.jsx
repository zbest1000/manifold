import React, { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import {
  Sparkles,
  Bot,
  User,
  Send,
  AlertCircle,
  Loader,
  Lightbulb,
  Info
} from 'lucide-react'

// Services
import { socketService } from '../../services/socketService'

const SUGGESTED_QUERIES = [
  'Show all topics active in the past 5 minutes',
  'Which brokers have the highest message volume?',
  'Summarize recent Sparkplug device births and deaths',
  'Are there any connection errors?'
]

const AIAssistant = () => {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  const messagesEndRef = useRef(null)

  // Subscribe to AI socket events on mount, unsubscribe on cleanup.
  useEffect(() => {
    const offResponse = socketService.on('ai-response', (data) => {
      // data.response may be a plain string OR an object
      // like { response, confidence, sources, suggestions }.
      const raw = data?.response
      const isObject = raw && typeof raw === 'object'
      const text = isObject ? raw.response : raw

      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random()}`,
          role: 'assistant',
          text: text || 'The assistant returned an empty response.',
          meta: isObject ? raw : null,
          timestamp: new Date()
        }
      ])
      setLoading(false)
    })

    const offError = socketService.on('ai-error', (data) => {
      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random()}`,
          role: 'error',
          text: data?.error || 'The assistant ran into an error processing that query.',
          timestamp: new Date()
        }
      ])
      setLoading(false)
    })

    return () => {
      offResponse()
      offError()
    }
  }, [])

  // Auto-scroll to the newest message.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const sendQuery = (rawText) => {
    const query = rawText.trim()
    if (!query || loading) return

    setMessages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random()}`,
        role: 'user',
        text: query,
        timestamp: new Date()
      }
    ])
    setInput('')
    setLoading(true)

    // Server accepts the query as a plain string.
    const sent = socketService.emit('ai-query', query)

    if (!sent) {
      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random()}`,
          role: 'error',
          text: 'Not connected to the server. Please check your connection and try again.',
          timestamp: new Date()
        }
      ])
      setLoading(false)
    }
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    sendQuery(input)
  }

  const formatTime = (date) =>
    new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const renderMessage = (message) => {
    const isUser = message.role === 'user'
    const isError = message.role === 'error'

    const avatarClasses = isUser
      ? 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
      : isError
        ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
        : 'bg-primary-600 text-white'

    const bubbleClasses = isUser
      ? 'bg-primary-600 text-white'
      : isError
        ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800'
        : 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white'

    const meta = message.meta
    const suggestions = Array.isArray(meta?.suggestions) ? meta.suggestions : []
    const sources = Array.isArray(meta?.sources) ? meta.sources : []
    const hasConfidence = typeof meta?.confidence === 'number'

    return (
      <motion.div
        key={message.id}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
      >
        <div
          className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${avatarClasses}`}
        >
          {isUser ? (
            <User className="w-4 h-4" />
          ) : isError ? (
            <AlertCircle className="w-4 h-4" />
          ) : (
            <Bot className="w-4 h-4" />
          )}
        </div>

        <div className={`max-w-[85%] sm:max-w-[75%] ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
          <div className={`px-4 py-3 rounded-lg ${bubbleClasses}`}>
            <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">
              {message.text}
            </p>

            {(hasConfidence || sources.length > 0) && (
              <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-600 space-y-2">
                {hasConfidence && (
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Confidence: {Math.round(meta.confidence * 100)}%
                  </div>
                )}
                {sources.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {sources.map((source, i) => (
                      <span
                        key={i}
                        className="px-2 py-0.5 text-xs rounded-full bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200"
                      >
                        {String(source)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {suggestions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {suggestions.map((suggestion, i) => (
                <button
                  key={i}
                  onClick={() => sendQuery(String(suggestion))}
                  disabled={loading}
                  className="px-3 py-1 text-xs rounded-full border border-primary-200 dark:border-primary-800 text-primary-700 dark:text-primary-300 hover:bg-primary-50 dark:hover:bg-primary-900/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {String(suggestion)}
                </button>
              ))}
            </div>
          )}

          <span className="mt-1 text-xs text-gray-400 dark:text-gray-500 px-1">
            {formatTime(message.timestamp)}
          </span>
        </div>
      </motion.div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-primary-600 dark:text-primary-400" />
            AI Assistant
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Ask questions about your MQTT traffic in plain language
          </p>
        </div>

        {messages.length > 0 && (
          <button
            onClick={() => setMessages([])}
            className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            Clear conversation
          </button>
        )}
      </div>

      {/* Demo mode note */}
      <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-300">
        <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <span>
          The assistant runs in <span className="font-medium">demo mode</span> with canned
          responses unless the server has an OpenAI key configured.
        </span>
      </div>

      {/* Chat card */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 flex flex-col h-[60vh] min-h-[440px]">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
          {messages.length === 0 ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="h-full flex flex-col items-center justify-center text-center"
            >
              <div className="w-16 h-16 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center mb-4">
                <Sparkles className="w-8 h-8 text-primary-600 dark:text-primary-400" />
              </div>
              <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
                Ask the MQTT Assistant
              </h3>
              <p className="text-gray-600 dark:text-gray-400 max-w-md">
                Get insights about topics, brokers, message volume, and Sparkplug device
                activity. Pick a suggestion below or type your own question to get started.
              </p>
            </motion.div>
          ) : (
            messages.map((message) => renderMessage(message))
          )}

          {loading && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex gap-3"
            >
              <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-primary-600 text-white">
                <Bot className="w-4 h-4" />
              </div>
              <div className="px-4 py-3 rounded-lg bg-gray-100 dark:bg-gray-700 flex items-center gap-2">
                <Loader className="w-4 h-4 text-primary-600 dark:text-primary-400 animate-spin" />
                <span className="text-sm text-gray-600 dark:text-gray-400">Thinking...</span>
              </div>
            </motion.div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Footer: suggestions + input */}
        <div className="border-t border-gray-200 dark:border-gray-700 p-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400">
              <Lightbulb className="w-3.5 h-3.5" />
              Try asking:
            </span>
            {SUGGESTED_QUERIES.map((query) => (
              <button
                key={query}
                onClick={() => sendQuery(query)}
                disabled={loading}
                className="px-3 py-1 text-xs rounded-full bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-primary-50 dark:hover:bg-primary-900/20 hover:text-primary-700 dark:hover:text-primary-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {query}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="flex items-center gap-3">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about your MQTT data..."
              className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <Loader className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              Send
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}

export default AIAssistant
