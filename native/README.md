# Native ingest store (Rust / napi) — experiment & findings

This is a Rust (`napi-rs`) native addon implementing the MQTT ingest + coalescing
hot path (`TopicStore`: `ingest`, `ingest_batch`, `drain`, `get_topics`, counts).
It was built to answer a specific question: **would moving the hot path to Rust
make the server faster?**

## Measured results (this machine, Node 22, release build)

| Path | Throughput | Notes |
|---|---|---|
| **Pure JS hot path** (current default) | **4.19 M msg/s** | No FFI; minimal per-message Map work |
| Raw Rust store (`bench`, Rust owns the loop) | **12.2 M msg/s** | ~3× — but requires no per-message JS↔Rust crossing |
| Rust via **per-message FFI** (`ingest`) | 2.81 M msg/s | Slower — the napi boundary crossing costs more than it saves |
| Rust via **batched FFI** (`ingest_batch`) | 1.42 M msg/s | Slower still — marshalling arrays of strings+buffers dominates |

| Memory @ 1,000,000 topics | RSS | 
|---|---|
| JS `Map` of record objects | 532 MB |
| Rust `TopicStore` | **380 MB** (~29% less, and no GC pauses) |

## Conclusion

- **For throughput, keep the JS hot path.** It already sustains millions of
  publishes/sec, and any path that marshals MQTT data across the JS↔Rust boundary
  (per-message *or* batched) is **slower**, because copying strings + payload
  buffers over FFI costs more than the tiny JS `Map` update it replaces.
- **Rust only wins throughput if it owns the ingest loop end-to-end** — i.e. a
  Rust MQTT client (`rumqttc`) subscribing directly, with zero per-message
  marshalling. That is a "port the component", not a surgical addon, and it would
  also give up the mature `node-opcua` / `socket.io` / MCP ecosystem on that path.
- **Rust's clear, surgical win is memory + GC**: ~29% less RSS and no
  garbage-collection pauses at millions of resident topics.

So this addon is **not wired into the default path** (that would regress the
common case). It is kept as a reproducible benchmark and an optional,
memory-optimized store for deployments that hold millions of topics and are
memory/latency-bound rather than throughput-bound.

## Build & reproduce

```bash
cd native
cargo build --release
cp target/release/libtopic_canvas_native.so index.node   # .dylib on macOS
node bench.js
```

Requires a Rust toolchain (`rustup`). The compiled `.node` is intentionally not
committed; build it where you intend to run it (or wire up `napi-rs` prebuilds).
