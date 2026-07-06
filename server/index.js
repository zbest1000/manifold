const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const { httpAuth, socketAuth } = require('./middleware/auth');

// Import custom modules
const MQTTDiscoveryService = require('./services/mqttDiscovery');
const MQTTClientManager = require('./services/mqttClientManager');
const SparkplugDecoder = require('./services/sparkplugDecoder');
const AIService = require('./services/aiService');
const NetworkScanner = require('./services/networkScanner');
const DataExporter = require('./services/dataExporter');

// Import routes
const apiRoutes = require('./routes/api');
const mqttRoutes = require('./routes/mqtt');
const aiRoutes = require('./routes/ai');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Security middleware. CSP is disabled because the SPA it serves uses inline
// assets; the rest of helmet's headers (nosniff, frameguard, HSTS, ...) apply.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:3000' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Rate limiting: a general limit on the whole API plus a stricter limit on the
// expensive/abusable endpoints (AI calls, network scanning).
const rateWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW || '15', 10) * 60 * 1000;
const globalLimiter = rateLimit({
  windowMs: rateWindowMs,
  max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  standardHeaders: true,
  legacyHeaders: false
});
const strictLimiter = rateLimit({
  windowMs: rateWindowMs,
  max: parseInt(process.env.RATE_LIMIT_MAX_STRICT || '20', 10),
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/ai', strictLimiter);
app.use('/api/network', strictLimiter);
// Auth + general rate limit gate every /api route (health check stays public).
app.use('/api', globalLimiter, httpAuth);

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/dist')));
}

// Initialize services
const mqttDiscovery = new MQTTDiscoveryService(io);
const mqttClientManager = new MQTTClientManager(io);
const sparkplugDecoder = new SparkplugDecoder();
const aiService = new AIService();
const networkScanner = new NetworkScanner(io);
const dataExporter = new DataExporter();

// Store services in app locals for access in routes
app.locals.services = {
  mqttDiscovery,
  mqttClientManager,
  sparkplugDecoder,
  aiService,
  networkScanner,
  dataExporter
};

// Routes
app.use('/api', apiRoutes);
app.use('/api/mqtt', mqttRoutes);
app.use('/api/ai', aiRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    services: {
      mqtt: mqttClientManager.getConnectionStatus(),
      ai: aiService.isAvailable(),
      scanner: networkScanner.isScanning()
    }
  });
});

// Reject unauthenticated sockets during the handshake (enforced only when
// APP_ACCESS_TOKEN is set).
io.use(socketAuth);

// Wraps a socket handler so a thrown error or rejected promise emits an error
// back to that client instead of crashing the Node process.
function safeOn(socket, event, handler) {
  socket.on(event, async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      console.error(`Socket handler error [${event}]:`, error.message);
      socket.emit('server-error', { event, error: error.message });
    }
  });
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // MQTT Discovery events
  safeOn(socket, 'start-discovery', (options) => mqttDiscovery.startDiscovery(options));
  safeOn(socket, 'stop-discovery', () => mqttDiscovery.stopDiscovery());

  // MQTT Connection events
  safeOn(socket, 'connect-mqtt', (connectionConfig) => mqttClientManager.connectToBroker(connectionConfig, socket.id));
  safeOn(socket, 'disconnect-mqtt', (brokerId) => mqttClientManager.disconnectFromBroker(brokerId));
  safeOn(socket, 'subscribe-topic', (data) => mqttClientManager.subscribeToTopic(data.brokerId, data.topic, data.qos));
  safeOn(socket, 'unsubscribe-topic', (data) => mqttClientManager.unsubscribeFromTopic(data.brokerId, data.topic));
  safeOn(socket, 'publish-message', (data) => mqttClientManager.publishMessage(data.brokerId, data.topic, data.payload, data.options));

  // Network scanning events
  safeOn(socket, 'start-network-scan', (options) => networkScanner.startScan(options));
  safeOn(socket, 'stop-network-scan', () => networkScanner.stopScan());

  // AI Query events
  safeOn(socket, 'ai-query', async (query) => {
    try {
      const response = await aiService.processQuery(query, mqttClientManager.getAllData());
      socket.emit('ai-response', { query, response });
    } catch (error) {
      socket.emit('ai-error', { query, error: error.message });
    }
  });

  // Data export events
  safeOn(socket, 'export-data', async (options) => {
    try {
      const exportData = await dataExporter.exportData(mqttClientManager.getAllData(), options);
      socket.emit('export-ready', exportData);
    } catch (error) {
      socket.emit('export-error', { error: error.message });
    }
  });

  safeOn(socket, 'disconnect', () => {
    console.log('Client disconnected:', socket.id);
    mqttClientManager.cleanupSocketConnections(socket.id);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Serve React app in production
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist/index.html'));
  });
}

const PORT = process.env.PORT || 5000;
// Only listen when run directly (node index.js). When required by tests we export
// the app so supertest can exercise it without binding a port.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`🚀 MQTT Explore Server running on port ${PORT}`);
    console.log(`📡 WebSocket server ready for real-time communication`);

    // Start background services
    if (process.env.AUTO_START_DISCOVERY === 'true') {
      mqttDiscovery.startDiscovery();
    }
  });
}

module.exports = { app, server, io };