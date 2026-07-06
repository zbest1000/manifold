//! Native hot path for MQTT ingest + coalescing.
//!
//! At millions of publishes/sec the per-message work and the memory cost of a
//! JS Map of record objects (plus its GC pressure) become the wall. This addon
//! owns the topic store in compact native memory: `ingest` is O(1) and
//! allocation-light, `drain` returns the coalesced latest-value-per-dirty-topic
//! batch, and `get_topics` serves the bounded REST snapshot. The expensive
//! per-message work in JS (object allocation, GC) disappears; JSON parse / type
//! detection / Sparkplug decode stay in JS but run only on the coalesced output.

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::{HashMap, HashSet};

struct Record {
  count: u64,
  qos: u8,
  retain: bool,
  ts: f64,
  payload: Vec<u8>,
}

#[napi(object)]
pub struct DrainedMsg {
  pub topic: String,
  pub payload: Buffer,
  pub qos: u8,
  pub retain: bool,
  pub ts: f64,
  pub count: f64,
}

#[napi(object)]
pub struct TopicRow {
  pub topic: String,
  pub payload: Buffer,
  pub qos: u8,
  pub retain: bool,
  pub ts: f64,
  pub count: f64,
}

#[napi]
pub struct TopicStore {
  map: HashMap<String, Record>,
  dirty: HashSet<String>,
  total: u64,
  dropped: u64,
  max_topics: usize,
}

#[napi]
impl TopicStore {
  #[napi(constructor)]
  pub fn new(max_topics: Option<u32>) -> Self {
    TopicStore {
      map: HashMap::new(),
      dirty: HashSet::new(),
      total: 0,
      dropped: 0,
      max_topics: max_topics.unwrap_or(2_000_000) as usize,
    }
  }

  /// Hot path: record the latest payload for a topic and mark it dirty. Returns
  /// false if a new topic was dropped at the cap.
  #[napi]
  pub fn ingest(&mut self, topic: String, payload: Buffer, qos: u8, retain: bool, ts: f64) -> bool {
    self.total += 1;
    let bytes: &[u8] = payload.as_ref();
    if !self.map.contains_key(&topic) {
      if self.map.len() >= self.max_topics {
        self.dropped += 1;
        return false;
      }
      self.map.insert(
        topic.clone(),
        Record { count: 0, qos, retain, ts, payload: Vec::new() },
      );
    }
    let rec = self.map.get_mut(&topic).unwrap();
    rec.count += 1;
    rec.qos = qos;
    rec.retain = retain;
    rec.ts = ts;
    rec.payload.clear();
    rec.payload.extend_from_slice(bytes);
    self.dirty.insert(topic);
    true
  }

  /// Batched hot path: ingest a whole flush window in one FFI call, amortizing
  /// the boundary crossing. Parallel arrays keep marshalling to bulk copies.
  #[napi]
  pub fn ingest_batch(
    &mut self,
    topics: Vec<String>,
    payloads: Vec<Buffer>,
    qos: Vec<u8>,
    retain: Vec<bool>,
    ts: f64,
  ) -> u32 {
    let n = topics.len().min(payloads.len());
    for i in 0..n {
      self.total += 1;
      let topic = &topics[i];
      if !self.map.contains_key(topic) {
        if self.map.len() >= self.max_topics {
          self.dropped += 1;
          continue;
        }
        self
          .map
          .insert(topic.clone(), Record { count: 0, qos: 0, retain: false, ts, payload: Vec::new() });
      }
      let rec = self.map.get_mut(topic).unwrap();
      rec.count += 1;
      rec.qos = *qos.get(i).unwrap_or(&0);
      rec.retain = *retain.get(i).unwrap_or(&false);
      rec.ts = ts;
      rec.payload.clear();
      rec.payload.extend_from_slice(payloads[i].as_ref());
      self.dirty.insert(topic.clone());
    }
    n as u32
  }

  /// Coalesced drain: one message (the latest value) per topic touched since the
  /// last drain. Clears the dirty set.
  #[napi]
  pub fn drain(&mut self) -> Vec<DrainedMsg> {
    let dirty: Vec<String> = self.dirty.drain().collect();
    let mut out = Vec::with_capacity(dirty.len());
    for topic in dirty {
      if let Some(rec) = self.map.get(&topic) {
        out.push(DrainedMsg {
          topic,
          payload: rec.payload.clone().into(),
          qos: rec.qos,
          retain: rec.retain,
          ts: rec.ts,
          count: rec.count as f64,
        });
      }
    }
    out
  }

  /// Bounded snapshot of latest values for the REST endpoint.
  #[napi]
  pub fn get_topics(&self, limit: u32) -> Vec<TopicRow> {
    let limit = limit as usize;
    let mut out = Vec::with_capacity(self.map.len().min(limit));
    for (topic, rec) in self.map.iter() {
      if out.len() >= limit {
        break;
      }
      out.push(TopicRow {
        topic: topic.clone(),
        payload: rec.payload.clone().into(),
        qos: rec.qos,
        retain: rec.retain,
        ts: rec.ts,
        count: rec.count as f64,
      });
    }
    out
  }

  /// Latest value for a single topic (or None).
  #[napi]
  pub fn get_latest(&self, topic: String) -> Option<TopicRow> {
    self.map.get(&topic).map(|rec| TopicRow {
      topic,
      payload: rec.payload.clone().into(),
      qos: rec.qos,
      retain: rec.retain,
      ts: rec.ts,
      count: rec.count as f64,
    })
  }

  #[napi]
  pub fn topic_count(&self) -> f64 {
    self.map.len() as f64
  }

  #[napi]
  pub fn total_messages(&self) -> f64 {
    self.total as f64
  }

  #[napi]
  pub fn dropped_count(&self) -> f64 {
    self.dropped as f64
  }

  /// Micro-benchmark: run `iterations` ingests across `topics` topics entirely
  /// inside Rust (no per-message FFI) and return elapsed milliseconds. Lets the
  /// harness report the store's raw capability vs the JS implementation.
  #[napi]
  pub fn bench(&mut self, topics: u32, iterations: u32) -> f64 {
    let names: Vec<String> = (0..topics)
      .map(|i| format!("factory/line/machine/sensor{}", i))
      .collect();
    let payload = b"{\"value\":1}".to_vec();
    let start = std::time::Instant::now();
    for i in 0..iterations {
      let topic = &names[(i % topics) as usize];
      self.total += 1;
      if !self.map.contains_key(topic) {
        self.map.insert(
          topic.clone(),
          Record { count: 0, qos: 0, retain: false, ts: 0.0, payload: Vec::new() },
        );
      }
      let rec = self.map.get_mut(topic).unwrap();
      rec.count += 1;
      rec.payload.clear();
      rec.payload.extend_from_slice(&payload);
      self.dirty.insert(topic.clone());
    }
    start.elapsed().as_secs_f64() * 1000.0
  }
}
