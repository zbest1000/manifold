# Native ingest store benchmark (Rust / napi)

**Not used by Manifold.** Nothing in the server, the client, the MCP server, the Docker images
or CI builds, loads or tests this directory (`.dockerignore` excludes it). It is a standalone
Rust (`napi-rs`) crate that answered one question: would moving the MQTT ingest and coalescing
hot path (`TopicStore`: `ingest`, `ingest_batch`, `drain`, `get_topics`, counts) to Rust make the
server faster? The answer was no, and the server uses the JavaScript store in
`server/services/topicStore.js`.

## What was measured

Node 22, release build, one machine:

| Path | Throughput |
|---|---|
| JavaScript hot path (what the server uses) | 4.19 M msg/s |
| Rust store with Rust owning the loop (`bench`) | 12.2 M msg/s |
| Rust through per-message FFI (`ingest`) | 2.81 M msg/s |
| Rust through batched FFI (`ingest_batch`) | 1.42 M msg/s |

| Memory at 1,000,000 topics | RSS |
|---|---|
| JavaScript `Map` of record objects (an earlier store) | 532 MB |
| JavaScript struct-of-arrays store (`topicStore.js`, what the server uses) | 425 MB |
| Rust `TopicStore` | 380 MB |

Crossing the JavaScript/Rust boundary for each message, or in batches, costs more than the
`Map` update it replaces. Rust only wins throughput when it owns the whole ingest loop, which
would mean a Rust MQTT client and giving up the Node ecosystem on that path. The struct-of-arrays
JavaScript store recovered most of Rust's memory advantage without a native build step.

## Reproduce

```bash
cd native
cargo build --release
cp target/release/libmanifold_native.so index.node   # .dylib on macOS
node bench.js
```

Requires a Rust toolchain. The compiled `.node` file is not committed.
