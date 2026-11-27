'use strict';

/**
 * In-process MTConnect agent simulator for the mtconnect driver tests and the Playwright suite.
 *
 * It models what a real agent does that matters to a client: a bounded observation buffer with
 * monotonically increasing sequence numbers, /probe, /current and /sample?from&count with the
 * firstSequence / lastSequence / nextSequence header, OUT_OF_RANGE errors when the requested
 * sequence has left the buffer, an instanceId that changes when the agent restarts, conditions
 * with native codes, UNAVAILABLE values, time series and data set items, and the document shapes
 * of different standard versions (namespace prefixes, default namespace).
 *
 * Error injection: HTTP status per path, delays, truncated or garbage bodies, oversized answers,
 * redirects, restart (new instanceId, sequences start over), buffer overflow.
 * Only GET is served; anything else is answered 405 and logged.
 */

const http = require('http');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A small milling-machine model: axes, a controller with a path, conditions, a time series and a data set. */
function defaultDevices() {
  return [
    {
      id: 'dev1',
      name: 'mill-1',
      uuid: 'M01-UUID',
      items: [{ id: 'avail', category: 'EVENT', type: 'AVAILABILITY' }],
      components: [
        {
          kind: 'Axes', id: 'axes', name: 'Axes',
          components: [
            {
              kind: 'Linear', id: 'x', name: 'X',
              items: [
                { id: 'Xact', name: 'Xposition', category: 'SAMPLE', type: 'POSITION', subType: 'ACTUAL', units: 'MILLIMETER' },
                { id: 'Xload', category: 'SAMPLE', type: 'LOAD', units: 'PERCENT' },
                { id: 'Xtemp', category: 'SAMPLE', type: 'TEMPERATURE', units: 'CELSIUS' }
              ]
            }
          ]
        },
        {
          kind: 'Controller', id: 'ctl', name: 'controller',
          items: [{ id: 'estop', category: 'EVENT', type: 'EMERGENCY_STOP' }, { id: 'sys_cond', category: 'CONDITION', type: 'SYSTEM' }],
          components: [
            {
              kind: 'Path', id: 'path1', name: 'path',
              items: [
                { id: 'exec', category: 'EVENT', type: 'EXECUTION' },
                { id: 'mode', category: 'EVENT', type: 'CONTROLLER_MODE' },
                { id: 'line', category: 'EVENT', type: 'LINE' },
                { id: 'Sspeed', name: 'Srpm', category: 'SAMPLE', type: 'SPINDLE_SPEED', subType: 'ACTUAL', units: 'REVOLUTION/MINUTE' },
                { id: 'vib', category: 'SAMPLE', type: 'VIBRATION', units: 'HERTZ', representation: 'TIME_SERIES' },
                { id: 'vars', category: 'EVENT', type: 'VARIABLE', representation: 'DATA_SET' },
                { id: 'logic_cond', category: 'CONDITION', type: 'LOGIC_PROGRAM' }
              ]
            }
          ]
        }
      ]
    }
  ];
}

async function startMtconnectSimulator({
  port = 0, host = '127.0.0.1', devices = defaultDevices(), bufferSize = 100, version = '1.7', namespaces = 'default', outOfRangeStatus = 404, instanceId = 1700000000
} = {}) {
  const requests = [];
  const sockets = new Set();
  let instance = instanceId;
  let first = 1n;
  let next = 1n;
  let buffer = []; // { seq, id, ts, attrs, value, level? }
  const faults = new Map(); // path -> fault
  const items = new Map(); // id -> { item, device, component }
  const currentValue = new Map(); // id -> last non-condition observation
  const conditions = new Map(); // id -> Map(nativeCode -> obs) ; '' key holds a normal/unavailable marker
  const sampleHits = [];
  let sampleCalls = 0;

  const indexComponent = (device, comp) => {
    for (const it of comp.items || []) items.set(it.id, { item: it, device, component: comp });
    for (const c of comp.components || []) indexComponent(device, c);
  };
  for (const d of devices) indexComponent(d, { kind: 'Device', id: d.id, name: d.name, items: d.items, components: d.components });
  const nowIso = () => new Date().toISOString();

  // ---- state changes ----
  const push = (id, value, extra = {}) => {
    const rec = items.get(id);
    if (!rec) throw new Error(`unknown data item ${id}`);
    const obs = { seq: next, id, ts: extra.ts || nowIso(), value: String(value), attrs: extra.attrs || {}, level: extra.level };
    next += 1n;
    buffer.push(obs);
    while (buffer.length > bufferSize) {
      buffer.shift();
    }
    first = buffer.length ? buffer[0].seq : next;
    return obs;
  };
  const initial = () => {
    for (const [id, rec] of items) {
      if (rec.item.category === 'CONDITION') {
        const o = push(id, '', { level: 'Unavailable' });
        conditions.set(id, new Map([['', o]]));
      } else currentValue.set(id, push(id, 'UNAVAILABLE'));
    }
  };
  initial();

  const setValue = (id, value, extra) => {
    const rec = items.get(id);
    if (rec.item.category === 'CONDITION') throw new Error('use setCondition for conditions');
    const attrs = { ...(extra && extra.attrs) };
    if (rec.item.representation === 'TIME_SERIES') attrs.sampleCount = String(String(value).trim().split(/\s+/).length);
    const o = push(id, value, { ...extra, attrs });
    currentValue.set(id, o);
    return o;
  };

  const setCondition = (id, level, { nativeCode = '', text = '', qualifier = '', severity = '', ts } = {}) => {
    const lv = level[0].toUpperCase() + level.slice(1).toLowerCase();
    const attrs = {};
    if (nativeCode) attrs.nativeCode = nativeCode;
    if (qualifier) attrs.qualifier = qualifier;
    if (severity) attrs.nativeSeverity = severity;
    const o = push(id, text, { attrs, level: lv, ts });
    let m = conditions.get(id);
    if (!m) conditions.set(id, (m = new Map()));
    if (lv === 'Normal') {
      if (nativeCode) m.delete(nativeCode);
      else m.clear();
      if (!m.size) m.set('', o);
    } else if (lv === 'Unavailable') {
      m.clear();
      m.set('', o);
    } else {
      m.delete('');
      m.set(nativeCode, o);
    }
    return o;
  };

  // ---- documents ----
  const nsAttrs = (kind) => {
    const urn = (k) => `urn:mtconnect.org:${k}:${version}`;
    if (namespaces === 'prefixed') return { prefix: 'm:', attrs: `xmlns:m="${urn(kind)}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${urn(kind)} http://schemas.mtconnect.org/schemas/${kind}_${version}.xsd"` };
    if (namespaces === 'none') return { prefix: '', attrs: '' };
    return { prefix: '', attrs: `xmlns:m="${urn(kind)}" xmlns="${urn(kind)}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"` };
  };
  // nextSeq: a /sample answer reports where THAT answer ends; lastSequence is always the buffer's last.
  const header = (nextSeq = next) =>
    `<Header creationTime="${nowIso()}" sender="mtc-sim" instanceId="${instance}" version="${version}.0.0" bufferSize="${bufferSize}" firstSequence="${first}" lastSequence="${next - 1n}" nextSequence="${nextSeq}"/>`;

  const pre = (kind) => {
    const { prefix, attrs } = nsAttrs(kind);
    return { open: `<${prefix}${kind} ${attrs}>`, close: `</${prefix}${kind}>`, p: prefix };
  };

  const itemXml = (it) =>
    `<DataItem id="${esc(it.id)}"${it.name ? ` name="${esc(it.name)}"` : ''} category="${it.category}" type="${it.type}"${it.subType ? ` subType="${it.subType}"` : ''}${it.units ? ` units="${it.units}"` : ''}${it.representation ? ` representation="${it.representation}"` : ''}/>`;
  const compXml = (c) =>
    `<${c.kind} id="${esc(c.id)}" name="${esc(c.name)}">` +
    (c.items && c.items.length ? `<DataItems>${c.items.map(itemXml).join('')}</DataItems>` : '') +
    (c.components && c.components.length ? `<Components>${c.components.map(compXml).join('')}</Components>` : '') +
    `</${c.kind}>`;
  const probeDoc = (only) => {
    const { open, close } = pre('MTConnectDevices');
    const list = devices.filter((d) => !only || d.name === only || d.uuid === only);
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n${open}${header()}<Devices>` +
      list
        .map(
          (d) =>
            `<Device id="${d.id}" name="${esc(d.name)}" uuid="${d.uuid}"><Description manufacturer="Sim"/>` +
            (d.items && d.items.length ? `<DataItems>${d.items.map(itemXml).join('')}</DataItems>` : '') +
            `<Components>${(d.components || []).map(compXml).join('')}</Components></Device>`
        )
        .join('') +
      `</Devices>${close}`
    );
  };

  const obsXml = (o) => {
    const rec = items.get(o.id);
    const it = rec.item;
    const attrs = Object.entries(o.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
    const common = ` dataItemId="${esc(o.id)}" timestamp="${o.ts}" sequence="${o.seq}"${it.name ? ` name="${esc(it.name)}"` : ''}${it.subType ? ` subType="${it.subType}"` : ''}`;
    const camel = it.type.toLowerCase().replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());
    if (it.category === 'CONDITION') return `<${o.level}${common} type="${it.type}"${attrs}>${esc(o.value)}</${o.level}>`;
    if (it.representation === 'DATA_SET') {
      const entries = o.value === 'UNAVAILABLE' ? '' : o.value.split(/\s+/).map((kv) => `<Entry key="${esc(kv.split('=')[0])}">${esc(kv.split('=')[1] ?? '')}</Entry>`).join('');
      return `<${camel}${common} count="${entries ? o.value.split(/\s+/).length : 0}"${o.value === 'UNAVAILABLE' ? ' resetTriggered=""' : ''}>${o.value === 'UNAVAILABLE' ? 'UNAVAILABLE' : entries}</${camel}>`;
    }
    return `<${camel}${common}${attrs}>${esc(o.value)}</${camel}>`;
  };

  const streamsDoc = (obs, only, nextSeq) => {
    const { open, close } = pre('MTConnectStreams');
    const byDevice = new Map();
    for (const o of obs) {
      const rec = items.get(o.id);
      if (only && rec.device.name !== only && rec.device.uuid !== only) continue;
      if (!byDevice.has(rec.device)) byDevice.set(rec.device, new Map());
      const comps = byDevice.get(rec.device);
      if (!comps.has(rec.component)) comps.set(rec.component, []);
      comps.get(rec.component).push(o);
    }
    let body = '';
    for (const [d, comps] of byDevice) {
      body += `<DeviceStream name="${esc(d.name)}" uuid="${d.uuid}">`;
      for (const [c, list] of comps) {
        const group = (cat) => list.filter((o) => items.get(o.id).item.category === cat).map(obsXml).join('');
        const s = group('SAMPLE');
        const e = group('EVENT');
        const cd = group('CONDITION');
        body += `<ComponentStream component="${c.kind}" name="${esc(c.name)}" componentId="${esc(c.id)}">` + (s ? `<Samples>${s}</Samples>` : '') + (e ? `<Events>${e}</Events>` : '') + (cd ? `<Condition>${cd}</Condition>` : '') + '</ComponentStream>';
      }
      body += '</DeviceStream>';
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n${open}${header(nextSeq)}<Streams>${body}</Streams>${close}`;
  };

  const currentObs = () => {
    const out = [];
    for (const [id, rec] of items) {
      if (rec.item.category === 'CONDITION') for (const o of (conditions.get(id) || new Map()).values()) out.push(o);
      else if (currentValue.has(id)) out.push(currentValue.get(id));
    }
    return out;
  };

  const errorDoc = (code, text) => {
    const { open, close } = pre('MTConnectError');
    return `<?xml version="1.0" encoding="UTF-8"?>\n${open}${header()}<Errors><Error errorCode="${code}">${esc(text)}</Error></Errors>${close}`;
  };

  const handler = (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, bodyBytes: Number(req.headers['content-length'] || 0) });
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' });
      res.end('read only');
      return;
    }
    const u = new URL(req.url, 'http://x');
    const segs = u.pathname.split('/').filter(Boolean);
    let only = null;
    if (segs.length === 2) only = decodeURIComponent(segs[0]);
    const op = segs[segs.length - 1];
    const fault = faults.get(op) || faults.get('*');
    const send = (status, body, type = 'text/xml') => {
      const out = () => {
        if (fault && fault.type === 'drop') {
          req.socket.destroy();
          return;
        }
        if (fault && fault.type === 'status') {
          res.writeHead(fault.status, { 'content-type': 'text/html' });
          res.end(fault.body ?? '<html>error</html>');
          return;
        }
        if (fault && fault.type === 'redirect') {
          res.writeHead(302, { location: fault.location });
          res.end();
          return;
        }
        if (fault && fault.type === 'garbage') {
          res.writeHead(200, { 'content-type': 'text/xml' });
          res.end('this is not xml at all');
          return;
        }
        if (fault && fault.type === 'truncate') {
          res.writeHead(200, { 'content-type': type });
          res.end(body.slice(0, Math.floor(body.length * fault.fraction)));
          return;
        }
        if (fault && fault.type === 'oversize') {
          res.writeHead(200, { 'content-type': type });
          res.write(body.slice(0, body.indexOf('</Header>') + 9 || 200));
          let n = 0;
          const pump = () => {
            while (n < fault.bytes) {
              n += 8192;
              if (!res.write(`<!-- ${'x'.repeat(8180)} -->`)) return res.once('drain', pump);
            }
            res.end();
          };
          pump();
          return;
        }
        res.writeHead(status, { 'content-type': type });
        res.end(body);
      };
      if (fault && fault.delayMs) setTimeout(out, fault.delayMs).unref();
      else out();
    };

    if (only && !devices.some((d) => d.name === only || d.uuid === only)) {
      return send(404, errorDoc('NO_DEVICE', `Could not find the device '${only}'`));
    }
    if (op === 'probe') return send(200, probeDoc(only));
    if (op === 'current') return send(200, streamsDoc(currentObs(), only));
    if (op === 'sample') {
      sampleCalls++;
      const from = u.searchParams.get('from');
      const count = Number(u.searchParams.get('count') ?? 100);
      sampleHits.push({ from, count });
      let f;
      try {
        f = from === null ? first : BigInt(from);
      } catch {
        return send(400, errorDoc('INVALID_REQUEST', "'from' must be a non-negative integer"));
      }
      if (!(count >= 1)) return send(400, errorDoc('INVALID_REQUEST', "'count' must be a positive integer"));
      if (f < first || f > next) return send(outOfRangeStatus, errorDoc('OUT_OF_RANGE', `'from' must be between ${first} and ${next}`));
      const picked = buffer.filter((o) => o.seq >= f).slice(0, count);
      const nextSeq = picked.length ? picked[picked.length - 1].seq + 1n : f;
      return send(200, streamsDoc(picked, only, nextSeq));
    }
    return send(404, errorDoc('UNSUPPORTED', `no such request ${u.pathname}`));
  };

  const server = http.createServer(handler);
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const actualPort = server.address().port;

  return {
    port: actualPort,
    host,
    url: `http://${host}:${actualPort}`,
    requests,
    devices,
    get sampleCalls() {
      return sampleCalls;
    },
    sampleHits,
    get instanceId() {
      return instance;
    },
    get nextSequence() {
      return next;
    },
    get firstSequence() {
      return first;
    },
    /** SAMPLE / EVENT value. Pass `{ ts }` to fix the observation time. */
    setValue,
    setCondition,
    setUnavailable(id) {
      const rec = items.get(id);
      if (rec.item.category === 'CONDITION') setCondition(id, 'unavailable');
      else setValue(id, 'UNAVAILABLE');
    },
    /** Push `n` throw-away observations so a small buffer evicts everything older. */
    overflow(n = bufferSize + 5) {
      for (let i = 0; i < n; i++) setValue('line', i);
    },
    /** The agent restarts: a new instanceId, an empty buffer, sequences start over, values UNAVAILABLE again. */
    restart({ newInstance = instance + 1, startAt = 1n } = {}) {
      instance = newInstance;
      buffer = [];
      first = startAt;
      next = startAt;
      currentValue.clear();
      conditions.clear();
      initial();
    },
    /** Inject a fault on /probe, /current, /sample or '*' (every request); null clears it. Types: status, delay, garbage, truncate, oversize, redirect, drop. */
    fault(path, f) {
      if (f) faults.set(path, f);
      else faults.delete(path);
    },
    clearFaults() {
      faults.clear();
    },
    clearRequests() {
      requests.length = 0;
      sampleHits.length = 0;
    },
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

module.exports = { startMtconnectSimulator, defaultDevices };
