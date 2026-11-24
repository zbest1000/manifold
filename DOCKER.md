# Running Manifold with Docker

A one-command stack to try every feature locally — no external brokers or
servers required.

```bash
docker compose up --build
```

Then open **http://localhost:5000**.

The first build takes a few minutes (it builds the React client and installs
server dependencies). Subsequent starts are fast.

## What comes up

| Service | Image | Purpose | Host port |
|---|---|---|---|
| `app` | built from `docker/app/Dockerfile` | Manifold (server + built client) | `5000` |
| `mqtt` | `eclipse-mosquitto:2` | MQTT broker (anonymous) | `1883`, `9001` (ws) |
| `opcua` | `mcr.microsoft.com/iotedge/opc-plc` | Simulated OPC UA server | `50000` |
| `simulator` | built from `docker/simulator` | Publishes MQTT + Sparkplug B traffic | — |
| `device-sim` | the same image as `app` | Simulated Modbus TCP, Siemens S7 and EtherNet/IP devices (`server/tools/simulators.js`) | `5020`, `10102`, `44818` (host loopback) |

## Pre-seeded demo data

The app is **pre-seeded** (via `docker/app/seed/profiles.json`) to auto-connect
on startup to:

- the MQTT broker at `mqtt:1883` (auto-subscribed to `#` and `$SYS/#`)
- the OPC UA server at `opc.tcp://opcua:50000`
- three simulated devices from `device-sim`: *Demo pump (Modbus TCP)* at
  `device-sim:5020`, *Demo CPU (S7)* at `device-sim:10102` and *Demo Logix
  (EtherNet/IP)* at `device-sim:44818`, polled every second
- one binding, *Demo pump to UNS*, which publishes the Modbus device's tags as
  TVQ envelopes under `demo/plant1/pump1/` (plus a retained
  `demo/plant1/pump1/_status` and a 10 s heartbeat) to the demo broker

The simulator continuously publishes a tree of plain JSON telemetry topics
(`factory/…`, `building/…`, `energy/…`) plus valid Sparkplug B
(`spBv1.0/Plant1/…`). So the moment the page loads you should see:

- **Topics** — a live topic node graph (try the 2D / 3D / WebGL renderers)
- **Flows** — producer → topic → consumer lineage
- **Sparkplug** — the Plant1 → Line1 → Robot1 device topology with resolved metrics
- **OPC UA** — browse the OPC-PLC address space, read and monitor nodes
- **MQTT Brokers** — the connected broker with live message/topic counts
- **Devices** — three devices online with cycle times, live tag values, and the probe
- **Tags** — the *Demo pump to UNS* binding, publishing `demo/plant1/pump1/#`

## Connecting things manually

You can also add connections from the UI. Because the app runs inside the
compose network, use the **service names** as hosts:

- MQTT broker → host `mqtt`, port `1883`
- OPC UA → `opc.tcp://opcua:50000`
- Devices → host `device-sim`, ports `5020` (Modbus), `10102` (S7), `44818` (EtherNet/IP)

External tools on your host machine can use `localhost:1883` and
`opc.tcp://localhost:50000`.

## Simulated devices

`device-sim` runs `server/tools/simulators.js` from the app image. It starts
the **same simulators the test suite uses** (`server/test/support/`), listening
on all interfaces inside the container, and moves their values every second.
They are test doubles, not real devices: they accept write function codes so
the tests can count them, and they say nothing about real firmware. Never point
production tooling at them.

The app reaches them as host `device-sim`. That name resolves to a private
address on the compose network, and device targets pass the egress guard, which
refuses private addresses by default. The `app` service already sets
`MANIFOLD_ALLOW_PRIVATE_TARGETS=1` for Discovery, which is also what allows the
devices; the comment in `docker-compose.yml` says so. (Loopback device targets
are a separate opt-in, `MANIFOLD_ALLOW_LOOPBACK_DEVICES=1`, used below for
running outside Docker.)

What each simulator serves (enter these on the Devices page):

| Protocol | Device settings | Address | Type | Value |
|---|---|---|---|---|
| Modbus TCP | unit ID `1` (or `255`), address base 0 | `holding:0` | `int16`, scale `0.1` | temperature around 21.5 |
| | | `holding:1` | `uint16` | rpm around 1450 |
| | | `holding:2` | `float32` | flow |
| | | `holding:4` | `float32`, **word order little** | pressure (a word-swapped value: use Probe to see it) |
| | | `holding:6` | `uint32` | part counter |
| | | `holding:8` | `string`, length 8 | `PUMP-1` |
| | | `input:0` | `int16` | supply temperature x10 |
| | | `coil:0` / `discrete:0` | `bool` | running / alarm |
| S7 | rack `0`, slot `1` | `DB1.DBW0` | `INT` | temperature x10 |
| | | `DB1.DBD2` | `REAL` | pressure |
| | | `DB1.DBX6.0` | `BOOL` | running |
| | | `DB1.DBD8` | `DINT` | counter |
| | | `DB1.DBB12` | `STRING`, length 16 | `PUMP-1` |
| | | `DB1.DBD30` | `REAL` | flow |
| | | `MW0` | `INT` | level |
| EtherNet/IP | slot `0` | `RealTag`, `DintTag`, `BoolTag` | (resolved from the controller) | temperature, counter, running |
| | | `Motor.Speed`, `Motor.Count`, `Motor.Running` | UDT members | speed, count, running |
| | | `Program:MainProgram.LocalReal` | | program-scope tag |

The EtherNet/IP simulator also has arrays, a matrix, a BOOL array and a few
tags with restricted External Access; `GET /api/devices/<id>/browse` lists them.

### Run the simulators without Docker

Needs only Node and `npm ci` in `server/` (the simulators use no packages, but
the server in the next step does):

```bash
# 1. the three simulators (Modbus 5020, S7 10102, EtherNet/IP 44818) on loopback
node server/tools/simulators.js --modbus 5020 --s7 10102 --eip 44818
# options: --host 0.0.0.0, --interval 1000, --quiet, --help
# with no protocol flag all three start on those default ports

# 2. a server that is allowed to talk to loopback devices (second terminal)
cd server && MANIFOLD_ALLOW_LOOPBACK_DEVICES=1 PORT=5099 npm start

# 3. create a device against each simulator (third terminal)
curl -s -X POST localhost:5099/api/devices -H 'Content-Type: application/json' -d '{
  "name":"Pump (Modbus)","protocol":"modbus-tcp","host":"127.0.0.1","port":5020,"unitId":1,
  "pollGroups":[{"id":"fast","intervalMs":1000}],
  "tags":[
    {"key":"temperature","address":"holding:0","type":"int16","scale":0.1,"pollGroup":"fast"},
    {"key":"pressure","address":"holding:4","type":"float32","wordOrder":"little","pollGroup":"fast"},
    {"key":"running","address":"coil:0","type":"bool","pollGroup":"fast"}]}'

curl -s -X POST localhost:5099/api/devices -H 'Content-Type: application/json' -d '{
  "name":"CPU (S7)","protocol":"s7","host":"127.0.0.1","port":10102,"rack":0,"slot":1,
  "tags":[
    {"key":"temperature","address":"DB1.DBW0","type":"INT"},
    {"key":"pressure","address":"DB1.DBD2","type":"REAL"},
    {"key":"name","address":"DB1.DBB12","type":"STRING","length":16}]}'

curl -s -X POST localhost:5099/api/devices -H 'Content-Type: application/json' -d '{
  "name":"Logix (EIP)","protocol":"ethernet-ip","host":"127.0.0.1","port":44818,"slot":0,
  "tags":[
    {"key":"RealTag","address":"RealTag"},
    {"key":"MotorSpeed","address":"Motor.Speed"}]}'

# 4. read the values back (use the ids that GET /api/devices returns)
curl -s localhost:5099/api/devices | node -e "for (const d of JSON.parse(require('fs').readFileSync(0)).devices) console.log(d.id, d.name, d.status.state)"
curl -s localhost:5099/api/devices/<id>/values
```

Verified this way on the branch that wrote this document: all three devices
reached `online`, and `/values` returned live values with quality 192, for
example the Modbus word-swapped pressure decoded correctly with `wordOrder:
little`, the S7 `STRING` as `"PUMP-1"`, and the EtherNet/IP `Motor.Speed` UDT
member. `POST /api/devices/<id>/probe` with `{"address":"holding:4","count":2}`
showed the same registers decoded four ways, and the `CDAB` row held the right
number. With `MANIFOLD_ALLOW_LOOPBACK_DEVICES` unset, the same requests are
refused with an egress error, by design.

The S7 and EtherNet/IP simulators can only listen on loopback with a random
port, and the test support files are not modified for this tool, so for those
two `simulators.js` listens on the requested `host:port` and forwards each
connection to the loopback simulator. Modbus binds the requested address
directly.

> **Not run in Docker.** The `device-sim` compose service and the seeded
> devices were written and checked without a Docker daemon: the compose file
> passes `docker compose config`, parses as YAML, and the exact command the
> service runs (`node server/tools/simulators.js --modbus 5020 --s7 10102 --eip
> 44818 --host 0.0.0.0 --quiet`), its health check and a SIGTERM shutdown were
> run directly with Node. The seeded devices and binding were run against a
> local server and an in-process MQTT broker with the hostnames rewritten to
> loopback. `docker compose up` itself, the image build, and name resolution of
> `device-sim` on the compose network have **not** been exercised. If something
> is off, `docker compose logs device-sim` and `docker compose logs app` are the
> first places to look.

## Auth

The stack runs **open** by default (fine for localhost). To require a token,
set `MANIFOLD_AUTH_TOKEN` on the `app` service in `docker-compose.yml`, then enter the
same token in the app's unlock screen.

## Common commands

```bash
docker compose up --build        # build + start (foreground)
docker compose up -d --build     # build + start (detached)
docker compose logs -f app       # tail the app logs
docker compose logs -f simulator # watch the data generator
docker compose logs -f device-sim # the device simulators (values are quiet; remove --quiet to log them)
docker compose down              # stop
docker compose down -v           # stop + wipe saved profiles (the app-data volume)
```

## Notes

- Saved connections persist in the `app-data` Docker volume. `down -v` clears
  them and the next start re-seeds the demo connections, devices and binding.
  Seeding happens only when `profiles.json` does not exist yet, so an existing
  volume from an older version does not gain the demo devices until you run
  `docker compose down -v`.
- The simulator re-sends Sparkplug BIRTH certificates on every (re)connect, so
  metric aliases always resolve.
- The Mosquitto config allows anonymous access — it is for local testing only,
  not for exposure to an untrusted network.
