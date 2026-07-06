import React from 'react'
import { motion } from 'framer-motion'
import {
  Palette,
  Sun,
  Moon,
  Monitor,
  Type,
  Zap,
  Layout,
  Search,
  Network,
  Clock,
  Radio,
  Wifi,
  ScanLine,
  Fingerprint,
  Bell,
  Info,
  AlertTriangle
} from 'lucide-react'

// Store
import { useUIStore } from '../../store/uiStore'
import { useMQTTStore } from '../../store/mqttStore'

const APP_NAME = 'MQTT Explore'
const APP_VERSION = '1.0.0'

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'auto', label: 'Auto', icon: Monitor }
]

const FONT_SIZE_OPTIONS = [
  { value: 'small', label: 'Small' },
  { value: 'normal', label: 'Normal' },
  { value: 'large', label: 'Large' }
]

// Section card wrapper matching NetworkDiscovery card styling
const SettingsCard = ({ icon: Icon, title, description, delay = 0, children }) => (
  <motion.div
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ delay }}
    className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6"
  >
    <div className="flex items-center gap-2 mb-1">
      <Icon className="w-5 h-5 text-primary-600 dark:text-primary-400" />
      <h2 className="font-semibold text-gray-900 dark:text-white">{title}</h2>
    </div>
    {description && (
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">{description}</p>
    )}
    <div className={description ? '' : 'mt-4'}>{children}</div>
  </motion.div>
)

// Toggle switch row
const ToggleRow = ({ icon: Icon, label, hint, checked, onChange }) => (
  <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-700 last:border-b-0">
    <div className="flex items-start gap-3">
      {Icon && <Icon className="w-4 h-4 mt-0.5 text-gray-500 dark:text-gray-400 flex-shrink-0" />}
      <div>
        <div className="text-sm font-medium text-gray-900 dark:text-white">{label}</div>
        {hint && <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{hint}</div>}
      </div>
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 ${
        checked ? 'bg-primary-600' : 'bg-gray-300 dark:bg-gray-600'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  </div>
)

const Settings = () => {
  const {
    theme,
    setTheme,
    animations,
    setAnimations,
    compactMode,
    setCompactMode,
    fontSize,
    setFontSize,
    notifications,
    setNotifications
  } = useUIStore()

  const { discoveryOptions, setDiscoveryOptions } = useMQTTStore()

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>
          <p className="text-gray-600 dark:text-gray-400">
            Configure MQTT Explore preferences and options
          </p>
        </div>
      </div>

      {/* Appearance */}
      <SettingsCard
        icon={Palette}
        title="Appearance"
        description="Control the look and feel of the application."
        delay={0}
      >
        {/* Theme */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-900 dark:text-white mb-2">
            Theme
          </label>
          <div className="inline-flex flex-wrap gap-2">
            {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
              const active = theme === value
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTheme(value)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                    active
                      ? 'bg-primary-600 border-primary-600 text-white'
                      : 'bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Font size */}
        <div className="mb-2">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-white mb-2">
            <Type className="w-4 h-4 text-gray-500 dark:text-gray-400" />
            Font Size
          </label>
          <select
            value={fontSize}
            onChange={(e) => setFontSize(e.target.value)}
            className="w-full sm:w-64 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          >
            {FONT_SIZE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-2">
          <ToggleRow
            icon={Zap}
            label="Animations"
            hint="Enable motion and transition effects across the UI."
            checked={animations}
            onChange={setAnimations}
          />
          <ToggleRow
            icon={Layout}
            label="Compact Mode"
            hint="Reduce spacing to fit more content on screen."
            checked={compactMode}
            onChange={setCompactMode}
          />
        </div>
      </SettingsCard>

      {/* Discovery Defaults */}
      <SettingsCard
        icon={Search}
        title="Discovery Defaults"
        description="Default parameters used when scanning the network for MQTT brokers."
        delay={0.05}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {/* Network range */}
          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-white mb-2">
              <Network className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              Network Range
            </label>
            <input
              type="text"
              value={discoveryOptions.networkRange}
              onChange={(e) => setDiscoveryOptions({ networkRange: e.target.value })}
              placeholder="192.168.1.0/24"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:ring-2 focus:ring-primary-500 focus:border-transparent font-mono text-sm"
            />
          </div>

          {/* Port range */}
          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-white mb-2">
              <Radio className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              Port Range
            </label>
            <input
              type="text"
              value={discoveryOptions.portRange}
              onChange={(e) => setDiscoveryOptions({ portRange: e.target.value })}
              placeholder="1883,8883,1884,8884"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:ring-2 focus:ring-primary-500 focus:border-transparent font-mono text-sm"
            />
          </div>

          {/* Timeout */}
          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-white mb-2">
              <Clock className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              Timeout (ms)
            </label>
            <input
              type="number"
              min={0}
              step={100}
              value={discoveryOptions.timeout}
              onChange={(e) => {
                const parsed = parseInt(e.target.value, 10)
                setDiscoveryOptions({ timeout: Number.isNaN(parsed) ? 0 : parsed })
              }}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent text-sm"
            />
          </div>
        </div>

        {/* mDNS / SSDP not-implemented note */}
        <div className="flex items-start gap-2 p-3 mb-4 rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800">
          <AlertTriangle className="w-4 h-4 mt-0.5 text-yellow-600 dark:text-yellow-400 flex-shrink-0" />
          <p className="text-xs text-yellow-800 dark:text-yellow-200">
            mDNS and SSDP discovery are not implemented yet. These toggles are informational
            and only Port Scan / Fingerprinting affect discovery today.
          </p>
        </div>

        {/* Enable flags */}
        <div>
          <ToggleRow
            icon={Wifi}
            label="Enable mDNS"
            hint="Discover brokers advertised over multicast DNS. (Not implemented yet)"
            checked={discoveryOptions.enableMDNS}
            onChange={(val) => setDiscoveryOptions({ enableMDNS: val })}
          />
          <ToggleRow
            icon={Radio}
            label="Enable SSDP"
            hint="Discover brokers via Simple Service Discovery Protocol. (Not implemented yet)"
            checked={discoveryOptions.enableSSDP}
            onChange={(val) => setDiscoveryOptions({ enableSSDP: val })}
          />
          <ToggleRow
            icon={ScanLine}
            label="Enable Port Scan"
            hint="Probe the configured port range across the network range."
            checked={discoveryOptions.enablePortScan}
            onChange={(val) => setDiscoveryOptions({ enablePortScan: val })}
          />
          <ToggleRow
            icon={Fingerprint}
            label="Enable Fingerprinting"
            hint="Identify broker software and protocol version on discovered hosts."
            checked={discoveryOptions.enableFingerprinting}
            onChange={(val) => setDiscoveryOptions({ enableFingerprinting: val })}
          />
        </div>
      </SettingsCard>

      {/* Notifications */}
      <SettingsCard
        icon={Bell}
        title="Notifications"
        description="Manage in-app notification behavior."
        delay={0.1}
      >
        <ToggleRow
          icon={Bell}
          label="Enable Notifications"
          hint="Show toast notifications for broker discovery, connection status, and errors."
          checked={notifications.enabled}
          onChange={(val) => setNotifications({ enabled: val })}
        />
      </SettingsCard>

      {/* About */}
      <SettingsCard icon={Info} title="About" delay={0.15}>
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-lg bg-primary-600 flex items-center justify-center flex-shrink-0">
            <Wifi className="w-7 h-7 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{APP_NAME}</h3>
              <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                v{APP_VERSION}
              </span>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              A tool to discover, connect to, and explore MQTT brokers and Sparkplug B
              networks in real time.
            </p>
          </div>
        </div>
      </SettingsCard>
    </div>
  )
}

export default Settings
