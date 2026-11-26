'use strict';

/**
 * In-process HTTP/JSON device simulator for the http-json driver tests and the Playwright suite.
 * It listens on 127.0.0.1 (http, or https with the test certificate) and serves JSON documents by
 * path. Error injection per path: status codes, slow answers, oversized or non-JSON bodies,
 * redirects, dropped connections, Content-Encoding, required credentials. Every request is
 * logged, so tests can assert that only GET was ever sent and what headers arrived.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { KEY, CERT } = require('./tlsFixture');

async function startHttpJsonSimulator({ tls = false, port = 0, host = '127.0.0.1', docs = {} } = {}) {
  const routes = new Map(); // path -> route
  const requests = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let auth = null; // { header, value } required on every request
  const sockets = new Set();
  let opened = 0;
  const notModified = new Map();

  const setJson = (path, doc, { etag = false } = {}) => {
    const body = JSON.stringify(doc);
    routes.set(path, { type: 'json', body, etag: etag ? `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 12)}"` : null });
  };
  for (const [p, d] of Object.entries(docs)) setJson(p, d);

  const handler = (req, res) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    res.on('close', () => {
      inFlight--;
    });
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, bodyBytes: Number(req.headers['content-length'] || 0) });
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' });
      res.end('read only');
      return;
    }
    if (auth && req.headers[auth.header] !== auth.value) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="sim"' });
      res.end('{"error":"unauthorized"}');
      return;
    }
    const path = req.url.split('?')[0];
    const route = routes.get(req.url) || routes.get(path);
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    const respond = () => {
      if (route.dropAfter) {
        route.dropAfter = false;
        req.socket.destroy();
        return;
      }
      if (route.type === 'redirect') {
        res.writeHead(route.status || 302, { location: route.location });
        res.end();
        return;
      }
      if (route.type === 'status') {
        res.writeHead(route.status, { 'content-type': 'application/json', ...(route.headers || {}) });
        res.end(route.body ?? '{}');
        return;
      }
      if (route.type === 'raw') {
        res.writeHead(route.status || 200, route.headers || { 'content-type': 'text/html' });
        res.end(route.body);
        return;
      }
      if (route.type === 'oversize') {
        // Chunked, no Content-Length: the client must abort on its own byte count.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"pad":"');
        let sent = 0;
        const chunk = 'x'.repeat(16 * 1024);
        const pump = () => {
          while (sent < route.bytes) {
            sent += chunk.length;
            if (!res.write(chunk)) return res.once('drain', pump);
          }
          res.end('"}');
        };
        pump();
        return;
      }
      if (route.type === 'oversize-declared') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(route.bytes) });
        res.write('{"pad":"');
        setTimeout(() => res.destroy(), 20).unref();
        return;
      }
      if (route.encoding) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': route.encoding });
        res.end(Buffer.from('not really compressed'));
        return;
      }
      const inm = req.headers['if-none-match'];
      if (route.etag && inm === route.etag) {
        notModified.set(path, (notModified.get(path) || 0) + 1);
        res.writeHead(304, { etag: route.etag });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', ...(route.etag ? { etag: route.etag } : {}) });
      res.end(route.body);
    };
    if (route.delayMs) setTimeout(respond, route.delayMs).unref();
    else respond();
  };

  const server = tls ? https.createServer({ key: KEY, cert: CERT }, handler) : http.createServer(handler);
  server.on('connection', (s) => {
    if (!tls) opened++;
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('secureConnection', (s) => {
    opened++;
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const actualPort = server.address().port;

  return {
    port: actualPort,
    scheme: tls ? 'https' : 'http',
    host,
    url: `${tls ? 'https' : 'http'}://${host}:${actualPort}`,
    requests,
    get maxInFlight() {
      return maxInFlight;
    },
    get connections() {
      return sockets.size;
    },
    /** TCP connections accepted so far (a keep-alive client opens one). */
    get opened() {
      return opened;
    },
    /** Serve a JSON document; `etag:true` adds an ETag and answers If-None-Match with 304. */
    setJson,
    /** Replace one path with a fixed status and body. */
    setStatus(path, status, body, headers) {
      routes.set(path, { type: 'status', status, body, headers });
    },
    /** Serve raw bytes with explicit headers (HTML, truncated JSON, BOM, ...). */
    setRaw(path, body, { status = 200, headers = { 'content-type': 'application/json' } } = {}) {
      routes.set(path, { type: 'raw', status, body, headers });
    },
    /** Answer after `ms`; applies to an existing or later route. */
    setDelay(path, ms) {
      const r = routes.get(path) || { type: 'json', body: '{}' };
      r.delayMs = ms;
      routes.set(path, r);
    },
    /** A body of at least `bytes` bytes, chunked. */
    setOversize(path, bytes) {
      routes.set(path, { type: 'oversize', bytes });
    },
    /** Declare a Content-Length of `bytes` and then stall. */
    setOversizeDeclared(path, bytes) {
      routes.set(path, { type: 'oversize-declared', bytes });
    },
    setRedirect(path, location, status = 302) {
      routes.set(path, { type: 'redirect', location, status });
    },
    setEncoding(path, encoding) {
      routes.set(path, { type: 'json', body: '{}', encoding });
    },
    /** Destroy the socket instead of answering, once. */
    dropNext(path) {
      const r = routes.get(path);
      if (r) r.dropAfter = true;
    },
    notModifiedCount: (path) => notModified.get(path) || 0,
    /** Require `header: value` on every request (401 otherwise). */
    requireHeader(header, value) {
      auth = header ? { header: header.toLowerCase(), value } : null;
    },
    clearRequests() {
      requests.length = 0;
    },
    /** Stop accepting and reset every open connection (device outage). */
    async stopListening() {
      const closed = new Promise((resolve) => server.close(resolve));
      for (const s of sockets) s.destroy();
      await closed;
    },
    startListening: () => new Promise((resolve) => server.listen(actualPort, host, resolve)),
    async close() {
      const closed = new Promise((resolve) => server.close(resolve));
      for (const s of sockets) s.destroy();
      await closed;
    }
  };
}

module.exports = { startHttpJsonSimulator };
