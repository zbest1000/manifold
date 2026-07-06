# 🌐 MQTT Explore

> Real-time MQTT network discovery, monitoring, and Sparkplug B analysis for IoT and industrial engineers.

MQTT Explore is a web application for discovering MQTT brokers on a network, connecting to them, watching live topic traffic, and decoding Sparkplug B industrial payloads — with an optional AI assistant. It is a **developer/prototype tool**, not a hardened production product; see [Project status](#-project-status) for what is real vs. planned.

![Version](https://img.shields.io/badge/version-1.0.0-green)
![License](https://img.shields.io/badge/license-MIT-blue)

## ✨ Features

Legend: ✅ working · ⚠️ works but limited/demo · 🚧 not implemented yet

### 🔍 Network discovery
- ✅ **TCP port-scan discovery** of MQTT brokers across a CIDR range (parallel, bounded concurrency). Confirms brokers with a real MQTT connect.
- ✅ **Standalone network scanner** (pure-JS TCP connect scan) that categorises hosts as MQTT / web / industrial (Modbus, S7comm, EtherNet/IP) and probes MQTT brokers with a spec-correct CONNECT packet.
- ✅ **mDNS discovery** of `_mqtt._tcp.local.` brokers via `bonjour-service` (on by default). ⚠️ **SSDP** is a real M-SEARCH implementation but off by default, since SSDP rarely advertises MQTT.

### 🔗 MQTT client management
- ✅ Connect to multiple brokers with username/password and TLS (`mqtts://`, client cert/key).
- ✅ Wildcard subscriptions, publish with QoS/retain, live connection metrics.
- ✅ Per-connection isolation: a browser only receives its own connections' traffic (events are scoped per socket, and broker credentials are never broadcast).

### 🏭 Sparkplug B
- ✅ Protobuf decoding of Sparkplug B payloads (NBIRTH/DBIRTH/NDATA/DDATA/…), with **alias resolution** (names cached from BIRTH and applied to DATA), correct **signed-integer** handling, and **STATE** message parsing.
- ✅ Group → Edge Node → Device hierarchy and metric summaries.

### 🤖 AI assistant
- ⚠️ Natural-language queries and insights. Uses OpenAI when `OPENAI_API_KEY` and the `openai` package are present; **otherwise it runs in mock mode** with canned responses (the `openai` package is an optional dependency you must add — see below).

### 📤 Export & reporting
- ✅ Export collected data as **JSON, CSV, YAML, Excel (.xlsx)** (real multi-sheet workbooks via `exceljs`), network map, and Sparkplug report. Filenames are sanitised (no path traversal).

### 📊 UI
- ✅ Dashboard plus functional pages for **Brokers, Topics Explorer, Sparkplug, AI Assistant, Data Export, and Settings** — all wired to live store data and driving real actions over Socket.IO (connect/subscribe/publish/query/export). Charts via chart.js.

## 🚀 Quick start

### Prerequisites
- **Node.js 20+** and npm
- (Optional) an **OpenAI API key** for real AI responses

### Install
```bash
git clone https://github.com/zbest1000/Mqtt_explore.git
cd Mqtt_explore

# Installs root, server, and client deps. The client needs --legacy-peer-deps
# (handled by this script).
npm run install:all
```

To enable real AI responses, also install the OpenAI SDK in the server workspace:
```bash
cd server && npm install openai
```

### Configure
```bash
cp server/.env.example server/.env
# Edit server/.env — set APP_ACCESS_TOKEN before exposing the server, and
# OPENAI_API_KEY if you want real AI responses.
```

### Run (development)
```bash
npm run dev            # backend on :5000, frontend (Vite) on :3000
# or individually:
npm run server:dev
npm run client:dev
```
Open http://localhost:3000. The Vite dev server proxies `/api` and `/socket.io` to the backend on :5000, so no client URL configuration is needed.

### Run (production-style)
```bash
npm run build          # builds the client into client/dist
NODE_ENV=production npm start   # server serves the built client on :5000
```

## 🔒 Security

Authentication is **opt-in but built in**:

- Set `APP_ACCESS_TOKEN` in `server/.env`. When set, every `/api` route and the Socket.IO handshake require it (HTTP: `Authorization: Bearer <token>` or `x-api-token`; the client reads `VITE_ACCESS_TOKEN`). When **unset**, the API is open and the server logs a warning — fine for localhost, not for shared/exposed use.
- `helmet` security headers, `express-rate-limit` (stricter on AI and network endpoints), CORS scoped to `CLIENT_URL`, and a 1 MB request-body limit are all active.
- The network scanner validates targets (strict IPv4/CIDR) and MQTT connect targets (protocol/port/host). Optional `MQTT_ALLOWED_HOSTS` restricts which brokers clients may reach. Note: because this is a LAN tool, connecting to private IP ranges is intentionally allowed — protect the server with `APP_ACCESS_TOKEN` rather than relying on network-level blocks.
- `AUTO_START_DISCOVERY` defaults to **false** — scanning is an explicit action.

## 🔧 Configuration

Key `server/.env` variables (see `server/.env.example` for the full list):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5000` | Backend port |
| `CLIENT_URL` | `http://localhost:3000` | Allowed CORS origin |
| `APP_ACCESS_TOKEN` | _(empty)_ | Enables auth when set |
| `OPENAI_API_KEY` | _(empty)_ | Enables real AI responses |
| `AUTO_START_DISCOVERY` | `false` | Auto-scan the LAN on boot |
| `RATE_LIMIT_WINDOW` / `RATE_LIMIT_MAX` | `15` / `100` | API rate limit |
| `MQTT_ALLOWED_HOSTS` | _(empty)_ | Optional broker allow-list |

## 🏗️ Architecture

```
client/  React 18 + Vite + Zustand + Tailwind (dashboard, Socket.IO client)
server/  Express + Socket.IO
  ├─ routes/     HTTP endpoints (api, mqtt, ai)
  ├─ services/   mqttDiscovery, mqttClientManager, sparkplugDecoder,
  │              networkScanner, aiService, dataExporter
  └─ middleware/ auth (token gate for HTTP + sockets)
```

State is held in memory (no database). Real-time updates flow over Socket.IO, scoped to the owning browser.

## 📖 API (selected)

| Method & path | Purpose |
|---|---|
| `GET /health` | Public health check |
| `GET /api/status`, `GET /api/metrics` | System status / metrics |
| `POST /api/mqtt/connect`, `/api/mqtt/subscribe`, `/api/mqtt/publish` | MQTT operations |
| `POST /api/network/scan/start` | Start a network scan |
| `POST /api/ai/query`, `/api/ai/insights` | AI query / insights |
| `POST /api/export` | Export collected data |

Real-time is primarily driven over Socket.IO events (`connect-mqtt`, `mqtt-message`, `start-network-scan`, …).

## 📋 Project status

This project began as an ambitious prototype. The following are **honest** current states:

- **Real:** MQTT connect/subscribe/publish, Sparkplug B decoding, TCP port-scan + mDNS discovery, network scanner, JSON/CSV/YAML/Excel export, all six feature pages wired to live data, token auth, rate limiting, per-socket event scoping.
- **Demo/limited:** AI runs in mock mode without an OpenAI key; SSDP discovery is real but off by default (rarely finds MQTT).
- **Not implemented:** Docker/Kubernetes deployment, PM2 config, a built-in mock broker / traffic simulator.

Contributions that turn a 🚧/⚠️ into a ✅ are welcome.

## 📄 License

MIT — see [LICENSE](LICENSE).
