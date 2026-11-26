# Running the Manifold demo stack with Docker

`docker-compose.yml` starts Manifold with a broker, an OPC UA server, simulated devices and a
traffic generator, already connected, so every page has live data without your own equipment.
For running Manifold itself in production, use the published image instead (see
[Production image](#production-image)).

```bash
docker compose up --build
```

Then open **http://localhost:5000**. The first build takes a few minutes (it builds the client
and installs the server's dependencies); later starts are fast.

## What comes up

| Service | Image | Purpose | Host port |
|---|---|---|---|
| `app` | built from `docker/app/Dockerfile` | Manifold (server and built client), seeded with demo connections | `127.0.0.1:5000` |
| `mqtt` | `eclipse-mosquitto:2` | MQTT broker, anonymous (`docker/mosquitto/mosquitto.conf`) | `1883`, `9001` (WebSocket) |
| `opcua` | `mcr.microsoft.com/iotedge/opc-plc` | Simulated OPC UA server | `50000` |
| `simulator` | built from `docker/simulator` | Publishes JSON telemetry and Sparkplug B traffic (`SIM_SCALE: "3"`, about 1,000 topics) | none |
| `device-sim` | the `app` image | Simulated Modbus TCP, Siemens S7 and EtherNet/IP devices (`server/tools/simulators.js`) | `127.0.0.1:5020`, `:10102`, `:44818` |
| `i3x` | built from `docker/i3x-mock` | Mock i3X server with a small ISA-95 hierarchy | `127.0.0.1:18080` |
| `cesmii-mock` | built from `docker/cesmii-mock` | Mock CESMII SMIP GraphQL server (any credentials) | `127.0.0.1:14000` |

## How the demo is reached and secured

The demo runs **without a token**. The `app` service sets `MANIFOLD_HOST=0.0.0.0` so the server
listens on every interface inside the container, and the port mapping `127.0.0.1:5000:5000` keeps
it on your machine's loopback. Because the server is not bound to loopback, its check that
refuses requests with a non-loopback `Host` header does not apply, so do not leave the demo
running while you browse untrusted sites, and never widen the port mapping without a token.

To require a token, uncomment `MANIFOLD_AUTH_TOKEN` on the `app` service, recreate it
(`docker compose up -d app`) and enter the same token on the unlock screen. Only then is it safe to
change the mapping to `"5000:5000"`.

## Pre-seeded demo data

On first start the entrypoint copies `docker/app/seed/profiles.json` into the `app-data` volume.
The app then connects to:

- the broker `mqtt:1883` (intake subscription to `#`, plus `$SYS/#`);
- the OPC UA server `opc.tcp://opcua:50000`;
- three devices on `device-sim`, polled every second: *Demo pump (Modbus TCP)* on port 5020,
  *Demo CPU (S7)* on 10102 and *Demo Logix (EtherNet/IP)* on 44818;
- two mappings of the Modbus device: *Demo pump to UNS* publishes TVQ envelopes under
  `demo/plant1/pump1/` with a retained `_status` and a 10 s heartbeat, and *Demo pump as one
  object* publishes all tags as one JSON object to `demo/plant1/pump1-object`;
- a recording, *Built-in historian*, of `factory/#` to a file, which Trends opens by default.

The traffic generator publishes plain JSON under `factory/`, `building/`, `energy/` and similar
roots, and Sparkplug B for the edge nodes `Plant1/Line1`, `Plant1/Line2` and `Plant2/PackHall`.
The pages to look at first: **Topics** and **UNS** (the live namespace, Sparkplug included),
**Flows** (producers and consumers), **Devices** (three devices online with live values and
Probe), **Tags** (the two mappings on the Mappings tab), **OPC UA** (browse and monitor the
OPC-PLC address space) and **Trends**.

Seeding happens only when `profiles.json` does not exist yet. `docker compose down -v` wipes the
volume, and the next start seeds again.

## Connecting things by hand

The app runs inside the compose network, so use the service names as hosts:

| What | From the app | From your machine |
|---|---|---|
| MQTT broker | `mqtt`, port `1883` | `localhost:1883` |
| OPC UA | `opc.tcp://opcua:50000` | `opc.tcp://localhost:50000` |
| Devices | `device-sim`, ports `5020`, `10102`, `44818` | `127.0.0.1` on the same ports |
| i3X | `http://i3x:8080` | `http://localhost:18080` |
| CESMII SMIP | `http://cesmii-mock:4000/graphql` | `http://localhost:14000/graphql` |

## Simulated devices

`device-sim` runs `server/tools/simulators.js` from the app image: the **same simulators the test
suite uses** (`server/test/support/`), listening on every interface in the container, values
changing every second. They are test doubles, not real devices: they accept write function codes
so the tests can count them, and they say nothing about real firmware.

`device-sim` resolves to a private address on the compose network, and device targets pass the
egress guard, which refuses private addresses by default. The `app` service sets
`MANIFOLD_ALLOW_PRIVATE_TARGETS=1`, which allows both the devices and Discovery scans of the
compose subnet.

What each simulator serves (enter these under **Devices → Add device**, or use **Probe**):

| Protocol | Device settings | Address | Type | Value |
|---|---|---|---|---|
| Modbus TCP | unit ID `1` (or `255`), address base 0 | `holding:0` | `int16`, scale `0.1` | temperature around 21.5 |
| | | `holding:1` | `uint16` | rpm around 1450 |
| | | `holding:2` | `float32` | flow |
| | | `holding:4` | `float32`, **word order little** | pressure (word-swapped: use Probe to see it) |
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

The EtherNet/IP simulator also has arrays, a matrix, a BOOL array and tags with restricted
External Access; **Import from controller** on the device form lists them.

**Discovery.** Each simulator answers the read-only identification the scanner sends. On the
Discovery page, tick **Modbus TCP**, **Siemens S7** and **EtherNet/IP**, set the range to the
compose subnet (**This subnet** fills in the app container's own /24) and scan.

### Run the simulators without Docker

Needs Node and `npm ci` in `server/`:

```bash
# 1. the three simulators on loopback (defaults: Modbus 5020, S7 10102, EtherNet/IP 44818)
node server/tools/simulators.js            # options: --modbus/--s7/--eip [port], --host, --interval, --quiet

# 2. a server allowed to reach loopback devices (second terminal)
cd server && MANIFOLD_ALLOW_LOOPBACK_DEVICES=1 PORT=5099 npm start

# 3. a device against the Modbus simulator (third terminal)
curl -s -X POST localhost:5099/api/devices -H 'Content-Type: application/json' -d '{
  "name":"Pump (Modbus)","protocol":"modbus-tcp","host":"127.0.0.1","port":5020,"unitId":1,
  "pollGroups":[{"id":"fast","intervalMs":1000}],
  "tags":[
    {"key":"temperature","address":"holding:0","type":"int16","scale":0.1,"pollGroup":"fast"},
    {"key":"pressure","address":"holding:4","type":"float32","wordOrder":"little","pollGroup":"fast"},
    {"key":"running","address":"coil:0","type":"bool","pollGroup":"fast"}]}'

# 4. read the values back (the id is in the answer, or in GET /api/devices)
curl -s localhost:5099/api/devices/<id>/values
```

S7 and EtherNet/IP devices are created the same way (`"protocol":"s7"` with `"rack":0,"slot":1`;
`"protocol":"ethernet-ip"` with `"slot":0`), using the addresses in the table above.
`MANIFOLD_ALLOW_LOOPBACK_DEVICES=1` is required: without it loopback device targets and loopback
Discovery ranges are refused. The simulator tool also reads `SIM_HOST`, `SIM_MODBUS_PORT`,
`SIM_S7_PORT` and `SIM_EIP_PORT` as defaults for its flags.

## Common commands

```bash
docker compose up -d --build       # build and start in the background
docker compose logs -f app         # the app
docker compose logs -f simulator   # the traffic generator
docker compose logs -f device-sim  # the device simulators (remove --quiet in the compose file to log values)
docker compose down                # stop
docker compose down -v             # stop and wipe the app-data volume (the next start seeds again)
```

The compose file and the commands its services run were checked without a Docker daemon (the
image build and `docker compose up` itself have not been run); if something is off,
`docker compose logs app` and `docker compose logs device-sim` are the first places to look.

## Production image

The published image `ghcr.io/zbest1000/manifold` (root `Dockerfile`) is Manifold alone, with no
demo data. Without a token the server binds `127.0.0.1`, which is unreachable from outside the
container, so always pass a token:

```bash
docker run -p 5000:5000 -v manifold-data:/data \
  -e MANIFOLD_AUTH_TOKEN=$(openssl rand -hex 24) \
  ghcr.io/zbest1000/manifold:1.1.0
```

Deployment notes (reverse proxy, private targets, the data volume) are in
[ARCHITECTURE.md: Deployment](ARCHITECTURE.md#deployment) and [SECURITY.md](SECURITY.md).
