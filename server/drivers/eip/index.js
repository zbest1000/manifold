'use strict';

/**
 * Read-only EtherNet/IP (CIP explicit messaging) driver for Rockwell Logix
 * controllers (ControlLogix / CompactLogix). EXPERIMENTAL until verified on
 * real hardware — see NOTES.md.
 *
 * Contract: southbound-drivers.md section 4.1, as specialised for the
 * driver runtime (plan / execute / bisect / browse / probe).
 */

const cip = require('./cip');
const frame = require('./frame');
const { parseAddress, formatAddress, encodePath } = require('./address');
const { ATOMIC, TYPE_BY_NAME, DecodeError, LayoutError, decodeTagReply, probeDecodings } = require('./decode');
const { planReads, bisect } = require('./planner');
const { EipClient, EipTransportError, parseIdentity, LARGE_SIZE, SMALL_SIZE } = require('./client');
const { fetchSymbols, fetchTemplate, SymbolError } = require('./symbols');

const protocol = 'ethernet-ip';
const { TYPE } = cip;

const TAG_TYPES = ['BOOL', 'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT', 'REAL', 'LREAL', 'STRING'];
const INTEGER_CODES = new Set([TYPE.SINT, TYPE.INT, TYPE.DINT, TYPE.LINT, TYPE.USINT, TYPE.UINT, TYPE.UDINT, TYPE.ULINT, TYPE.BYTE, TYPE.WORD, TYPE.DWORD, TYPE.LWORD]);

function describe() {
  return {
    protocol,
    label: 'EtherNet/IP (Logix)',
    experimental: true,
    defaultPort: 44818,
    deviceFields: [
      { key: 'slot', label: 'Controller slot', type: 'number', default: 0, min: 0, max: 255, help: 'Backplane slot of the controller (CompactLogix: 0).' },
      {
        key: 'routePath',
        label: 'Route path',
        type: 'string',
        optional: true,
        advanced: true,
        help: 'Full CIP route as port,link pairs, e.g. "1,0" or "1,2,2,10.0.0.5,1,0". Overrides the slot.',
      },
    ],
    optionFields: [
      {
        key: 'connectionSize',
        label: 'Connection size',
        type: 'select',
        options: ['auto', String(LARGE_SIZE), String(SMALL_SIZE)],
        default: 'auto',
        help: 'auto tries a Large Forward Open (4002 bytes) and falls back to 504 bytes if the controller rejects it.',
      },
      { key: 'packing', label: 'Pack reads (Multiple Service Packet)', type: 'boolean', default: true },
      {
        key: 'maxPacketBytes',
        label: 'Max packed reply bytes',
        type: 'number',
        optional: true,
        advanced: true,
        help: 'Cap for one packed reply; leave empty for the connection size.',
      },
    ],
    tagTypes: TAG_TYPES,
    addressHelp:
      'Logix tag names: Tag, Program:MainProgram.Tag, Motor.Speed (UDT member), Arr[3], Arr[1,2], Word.5 (bit of an integer). ' +
      'Type is optional: it is resolved from the controller.',
    prerequisites:
      'Each tag\'s External Access must be "Read Only" or "Read/Write" (tags set to "None" are shown as inaccessible). ' +
      'Plain EtherNet/IP has no authentication: anything that can reach port 44818 can also write to the controller. ' +
      'Manifold never sends write services, but use a read-only network path (firewall rule) where a hard guarantee is required. ' +
      'The driver holds one CIP connection on the controller/communication module.',
  };
}

/**
 * @param {{key:string, address:string, type?:string, pollGroup?:string}} tag
 * @returns {{ok:true, normalized:object}|{ok:false, error:string}}
 */
function validateTag(tag) {
  if (!tag || typeof tag !== 'object') return { ok: false, error: 'tag must be an object' };
  if (typeof tag.key !== 'string' || !tag.key) return { ok: false, error: 'tag.key is required' };
  let parsed;
  try {
    parsed = parseAddress(tag.address);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  let type;
  if (tag.type !== undefined && tag.type !== null && tag.type !== '') {
    type = String(tag.type).toUpperCase();
    if (!TAG_TYPES.includes(type) && !/^[A-Z_][A-Z0-9_:]*$/.test(type)) return { ok: false, error: `unknown type "${tag.type}"` };
    if (parsed.bit !== null && type !== 'BOOL') return { ok: false, error: `a bit address (${tag.address}) must have type BOOL` };
  }
  const normalized = { key: tag.key, address: formatAddress(parsed) };
  if (type) normalized.type = type;
  if (tag.pollGroup !== undefined) normalized.pollGroup = tag.pollGroup;
  return { ok: true, normalized };
}

class ResolveError extends Error {
  constructor(message, qReason = 'layout') {
    super(message);
    this.name = 'ResolveError';
    this.qReason = qReason;
  }
}

const product = (dims) => dims.reduce((a, b) => a * b, 1);

class EipDriver {
  constructor(device, deps = {}) {
    if (!device || typeof device.host !== 'string' || !device.host) throw new Error('ethernet-ip device needs a host');
    this.protocol = protocol;
    this.capabilities = { browse: true, subscribe: false, maxInFlight: 1 };
    this.deps = deps;
    this.device = device;
    const options = device.options || {};
    const limits = device.limits || {};
    this.port = device.port || 44818;
    this.route = device.routePath ? cip.encodeRoutePath(device.routePath) : cip.slotRoute(Number.isInteger(device.slot) ? device.slot : 0);
    this.requestDeadlineMs = limits.requestDeadlineMs || 2000;
    this.connectTimeoutMs = limits.connectTimeoutMs || 5000;
    this.packing = options.packing !== false;
    this.maxPacketBytes = Number.isFinite(Number(options.maxPacketBytes)) && Number(options.maxPacketBytes) > 0 ? Number(options.maxPacketBytes) : Infinity;
    this.sizePreference = options.connectionSize && options.connectionSize !== 'auto' ? Number(options.connectionSize) : 'auto';
    this.tags = new Map();
    for (const t of device.tags || []) {
      let parsed = null;
      let parseError = null;
      try {
        parsed = parseAddress(t.address);
      } catch (err) {
        parseError = err.message;
      }
      this.tags.set(t.key, { key: t.key, address: t.address, type: t.type ? String(t.type).toUpperCase() : undefined, parsed, parseError });
    }
    this.client = null;
    this.connectionSize = null;
    this.largeRejected = false;
    this.identity = null;
    this.externalAccess = true;
    this._resetCaches();
    this._queue = Promise.resolve();
    this.onFrame = deps.onFrame; // test hook: observe every outgoing frame
  }

  _resetCaches() {
    this._stale = false;
    this.symbols = new Map(); // scope ('' | 'Program:X') -> { list, byName }
    this.templates = new Map(); // id -> template
    this.resolved = new Map(); // key -> resolution | { error, qReason }
  }

  /** Serialise every client operation (polling, browse, probe share one socket). */
  _serial(fn) {
    const wrapped = () => {
      // Cache invalidation requested by a previous operation (path error or
      // layout drift) is applied before the next one, so the operation that
      // detected it can still decode its siblings consistently.
      if (this._stale) this._resetCaches();
      return fn();
    };
    const run = this._queue.then(wrapped, wrapped);
    this._queue = run.catch(() => {});
    return run;
  }

  isConnected() {
    return !!this.client && this.client.isOpen;
  }

  _request(req, deadlineMs = this.requestDeadlineMs) {
    if (!this.isConnected()) {
      return Promise.reject(new EipTransportError('transport', 'not connected'));
    }
    return this.client.request(req, deadlineMs);
  }

  async connect() {
    return this._serial(async () => {
      // Release the previous connection slot in an orderly way if it is still alive.
      if (this.client && this.client.isOpen) await this.client.close(Math.min(this.requestDeadlineMs, 1000));
      else if (this.client) this.client.destroy('reconnect');
      this._resetCaches();
      const client = new EipClient({
        host: this.device.host,
        port: this.port,
        route: this.route,
        connectTimeoutMs: this.connectTimeoutMs,
        onFrame: this.onFrame,
      });
      this.client = client;
      let preferredSize = this.sizePreference === 'auto' ? (this.largeRejected ? SMALL_SIZE : LARGE_SIZE) : this.sizePreference;
      try {
        const opened = await client.open({ preferredSize, deadlineMs: this.requestDeadlineMs });
        if (this.sizePreference === 'auto' && !opened.large) this.largeRejected = true;
        this.connectionSize = opened.connectionSize;
        this.fallbackReason = opened.fallbackReason;
      } catch (err) {
        client.destroy('connect failed');
        throw new Error(`EtherNet/IP connect to ${this.device.host}:${this.port} failed: ${err.message}`);
      }
      try {
        const reply = await this._request(frame.getAttributeAll(cip.CLASS.IDENTITY, 1));
        this.identity = reply.status === 0 ? parseIdentity(reply.data) : null;
      } catch (err) {
        if (err instanceof EipTransportError) {
          client.destroy('identity failed');
          throw new Error(`EtherNet/IP identity read failed: ${err.message}`);
        }
        this.identity = null;
      }
      this.externalAccess = !this.identity || this.identity.revisionMajor >= 18;
      try {
        for (const key of this.tags.keys()) await this._resolve(key);
      } catch (err) {
        client.destroy('resolve failed');
        throw new Error(`EtherNet/IP tag resolution failed: ${err.message}`);
      }
      const result = { limits: { connectionSize: this.connectionSize } };
      if (this.identity) result.identity = this.identity;
      return result;
    });
  }

  // ── symbol / template caches ────────────────────────────────────────────

  async _getSymbols(scope) {
    const cacheKey = scope || '';
    if (this.symbols.has(cacheKey)) return this.symbols.get(cacheKey);
    let list;
    const req = (r) => this._request(r);
    try {
      list = await fetchSymbols(req, scope, { externalAccess: this.externalAccess });
    } catch (err) {
      if (this.externalAccess && err instanceof SymbolError && [0x09, 0x0a, 0x14].includes(err.status)) {
        this.externalAccess = false; // pre-v18 firmware: no attribute 10
        list = await fetchSymbols(req, scope, { externalAccess: false });
      } else throw err;
    }
    const byName = new Map(list.map((s) => [s.name.toLowerCase(), s]));
    const entry = { list, byName };
    this.symbols.set(cacheKey, entry);
    return entry;
  }

  async _getTemplate(id, depth = 0) {
    if (this.templates.has(id)) return this.templates.get(id);
    if (depth > 16) throw new ResolveError(`template nesting deeper than 16 at ${id}`);
    const tpl = await fetchTemplate((r) => this._request(r), id);
    this.templates.set(id, tpl);
    for (const m of tpl.members) if (m.kind === 'struct') await this._getTemplate(m.templateId, depth + 1);
    return tpl;
  }

  /** Symbol/template caches are stale: tags stay Bad until re-resolved by the next operation. */
  _invalidate() {
    this._stale = true;
  }

  // ── tag resolution ──────────────────────────────────────────────────────

  async _resolve(key) {
    const tag = this.tags.get(key);
    if (!tag) {
      this.resolved.set(key, { error: `unknown tag key "${key}"`, qReason: 'layout' });
      return;
    }
    try {
      this.resolved.set(key, await this._buildResolution(tag));
    } catch (err) {
      if (err instanceof EipTransportError) throw err;
      if (err instanceof frame.EipFramingError) {
        this.client.destroy(err.message);
        throw new EipTransportError('framing', err.message);
      }
      this.resolved.set(key, { error: err.message, qReason: err.qReason || 'layout' });
    }
  }

  async _buildResolution(tag) {
    if (tag.parseError) throw new ResolveError(tag.parseError, 'layout');
    const addr = tag.parsed;
    const scope = addr.program ? `Program:${addr.program}` : null;
    let syms;
    try {
      syms = await this._getSymbols(scope);
    } catch (err) {
      if (err instanceof SymbolError) throw new ResolveError(`cannot list ${scope || 'controller'} tags: ${err.message}`);
      throw err;
    }
    const first = addr.segments[0];
    const sym = syms.byName.get(first.name.toLowerCase());
    if (!sym) throw new ResolveError(`tag "${first.name}" not found in ${scope || 'controller scope'}`);
    if (sym.access === 'None') throw new ResolveError(`tag "${sym.name}" has External Access None`, 'device-exception');

    let cur;
    if (sym.struct) cur = { struct: true, templateId: sym.templateId, dims: sym.dims.slice(0, sym.dimCount) };
    else cur = { code: sym.code, dims: sym.dims.slice(0, sym.dimCount) };
    if (cur.code === TYPE.BOOL && cur.dims.length) cur.boolArray = true;

    let elements = 1;
    let boolIndex = null;
    let elementOverride;
    let boolArrayWhole = false;
    const last = addr.segments.length - 1;

    for (let i = 0; i <= last; i++) {
      const seg = addr.segments[i];
      if (i > 0) {
        if (!cur.struct || cur.dims.length) throw new ResolveError(`"${addr.segments[i - 1].name}" is not a structure${cur.dims.length ? ' element (missing index?)' : ''}`);
        const tpl = await this._getTemplate(cur.templateId);
        const m = tpl.members.find((x) => !x.hidden && x.name.toLowerCase() === seg.name.toLowerCase());
        if (!m) throw new ResolveError(`"${tpl.name}" has no member "${seg.name}"`);
        if (m.kind === 'bit') cur = { code: TYPE.BOOL, dims: [] };
        else if (m.kind === 'boolArray') cur = { code: TYPE.BOOL, dims: [m.words * 32], boolArray: true };
        else if (m.kind === 'atomic') cur = { code: m.code, dims: m.array ? [m.count] : [] };
        else cur = { struct: true, templateId: m.templateId, dims: m.array ? [m.count] : [] };
      }
      if (seg.indices) {
        if (!cur.dims.length) throw new ResolveError(`"${seg.name}" is not an array`);
        if (seg.indices.length !== cur.dims.length) throw new ResolveError(`"${seg.name}" has ${cur.dims.length} dimension(s), address gives ${seg.indices.length}`);
        seg.indices.forEach((ix, k) => {
          if (ix >= cur.dims[k]) throw new ResolveError(`index ${ix} out of range for "${seg.name}" (size ${cur.dims[k]})`);
        });
        if (cur.boolArray) {
          if (i !== last) throw new ResolveError(`BOOL array "${seg.name}" has no members`);
          boolIndex = seg.indices[0];
          elementOverride = [boolIndex >> 5];
        }
        cur = { ...cur, dims: [], boolArray: false };
      } else if (cur.dims.length) {
        if (i !== last) throw new ResolveError(`"${seg.name}" is an array: give an index before ".${addr.segments[i + 1].name}"`);
        if (cur.boolArray) {
          boolArrayWhole = true;
          elements = cur.dims[0] / 32;
          if (!Number.isInteger(elements)) throw new ResolveError(`BOOL array "${seg.name}" size ${cur.dims[0]} is not a multiple of 32`);
        } else elements = product(cur.dims);
      }
    }

    let template = null;
    let valueSize;
    let type;
    let dataTypeName;
    if (addr.bit !== null) {
      if (cur.struct || !INTEGER_CODES.has(cur.code) || elements !== 1) throw new ResolveError(`bit ${addr.bit} needs an integer tag`);
      if (addr.bit >= ATOMIC[cur.code].size * 8) throw new ResolveError(`bit ${addr.bit} out of range for ${cip.TYPE_NAME[cur.code]}`);
    }
    if (cur.struct) {
      template = await this._getTemplate(cur.templateId);
      valueSize = template.size;
      type = template.string ? 'string' : 'struct';
      dataTypeName = template.name;
    } else if (boolIndex !== null || boolArrayWhole) {
      valueSize = 4;
      type = 'bool';
      dataTypeName = 'BOOL';
    } else {
      valueSize = ATOMIC[cur.code].size;
      type = addr.bit !== null ? 'bool' : ATOMIC[cur.code].type;
      dataTypeName = addr.bit !== null ? 'BOOL' : cip.TYPE_NAME[cur.code];
    }
    if (tag.type && tag.type !== dataTypeName.toUpperCase()) {
      throw new ResolveError(`declared type ${tag.type} but the controller reports ${dataTypeName}`, 'decode');
    }
    const path = encodePath(addr, { elementOverride });
    return {
      path,
      elements,
      template,
      bit: addr.bit,
      boolIndex,
      boolArray: boolArrayWhole,
      type,
      dataTypeName,
      valueBytes: valueSize * elements,
      requestBytes: 2 + path.length + 2,
      replyBytes: 4 + 2 + (template ? 2 : 0) + valueSize * elements,
    };
  }

  // ── planning ────────────────────────────────────────────────────────────

  plan(tagKeys) {
    const keys = tagKeys ? [...new Set(tagKeys)] : [...this.tags.keys()];
    const plannable = [];
    const singles = [];
    for (const key of keys) {
      const r = this.resolved.get(key);
      if (r && !r.error) plannable.push({ key, requestBytes: r.requestBytes, replyBytes: r.replyBytes });
      else singles.push(key);
    }
    const requests = planReads(plannable, {
      connectionSize: this.connectionSize || SMALL_SIZE,
      packing: this.packing,
      maxPacketBytes: this.maxPacketBytes,
    });
    singles.forEach((key, i) => requests.push({ id: `u${i}`, kind: 'single', items: [{ key }] }));
    return requests;
  }

  bisect(request) {
    return bisect(request);
  }

  // ── execution ───────────────────────────────────────────────────────────

  _decodeCtx(r) {
    return {
      elements: r.elements,
      bit: r.bit,
      boolIndex: r.boolIndex,
      boolArray: r.boolArray,
      template: r.template,
      getTemplate: (id) => this.templates.get(id),
    };
  }

  /** Map one item's CIP reply to a result; never throws. */
  _itemResult(key, r, reply) {
    if (reply.status !== 0) {
      const layout = cip.LAYOUT_STATUSES.has(reply.status);
      if (layout) this._invalidate();
      return {
        key,
        v: null,
        type: r.type,
        q: 0,
        qReason: layout ? 'layout' : 'device-exception',
        status: reply.status,
        message: cip.statusName(reply.status, reply.ext),
      };
    }
    try {
      const { v, type } = decodeTagReply(reply.data, this._decodeCtx(r));
      return { key, v, type, q: 192 };
    } catch (err) {
      if (err instanceof LayoutError) {
        this._invalidate();
        return { key, v: null, type: r.type, q: 0, qReason: 'layout', message: err.message };
      }
      return { key, v: null, type: r.type, q: 0, qReason: 'decode', message: err.message };
    }
  }

  _badResult(key, r) {
    return { key, v: null, type: (r && r.type) || null, q: 0, qReason: (r && r.qReason) || 'layout', message: r ? r.error : 'unresolved' };
  }

  _failure(err) {
    if (err instanceof EipTransportError) return { ok: false, kind: err.kind, fatal: true, message: err.message };
    if (err instanceof frame.EipReadOnlyError) {
      return { ok: false, kind: 'exception', code: -1, name: 'read-only violation', classification: 'permanent', message: err.message };
    }
    // Anything else is a framing problem or a bug: never trust this socket again.
    if (this.client) this.client.destroy(err.message);
    return { ok: false, kind: 'framing', fatal: true, message: err.message };
  }

  async execute(request, deadlineMs = this.requestDeadlineMs) {
    return this._serial(async () => {
      const start = Date.now();
      const remaining = () => Math.max(1, deadlineMs - (Date.now() - start));
      if (!this.isConnected()) return { ok: false, kind: 'transport', fatal: true, message: 'not connected' };
      try {
        for (const { key } of request.items) if (!this.resolved.has(key)) await this._resolve(key);
        const items = request.items.map(({ key }) => ({ key, r: this.resolved.get(key) }));
        const results = new Map();
        const good = [];
        for (const it of items) {
          if (it.r.error) results.set(it.key, this._badResult(it.key, it.r));
          else good.push(it);
        }
        if (request.kind === 'fragmented' && good.length === 1) {
          results.set(good[0].key, await this._readFragmented(good[0].key, good[0].r, remaining));
        } else if (good.length === 1) {
          const { key, r } = good[0];
          const reply = await this._request(frame.readTag(r.path, r.elements), remaining());
          results.set(key, this._itemResult(key, r, reply));
        } else if (good.length > 1) {
          const msp = frame.multipleServicePacket(good.map(({ r }) => frame.readTag(r.path, r.elements)));
          const reply = await this._request(msp, remaining());
          if (reply.status !== 0 && reply.status !== 0x1e) {
            return {
              ok: false,
              kind: 'exception',
              code: reply.status,
              name: cip.statusName(reply.status, reply.ext),
              classification: cip.classifyStatus(reply.status),
              message: `Multiple Service Packet failed: ${cip.statusName(reply.status, reply.ext)}`,
            };
          }
          const inner = frame.parseMspReply(reply.data, good.length);
          inner.forEach((rep, i) => {
            const { key, r } = good[i];
            if ((rep.service & 0x7f) !== cip.SERVICE.READ_TAG) throw new frame.EipFramingError(`MSP item ${i} answers service 0x${rep.service.toString(16)}`);
            results.set(key, this._itemResult(key, r, rep));
          });
        }
        return { ok: true, results: request.items.map(({ key }) => results.get(key)) };
      } catch (err) {
        return this._failure(err);
      }
    });
  }

  async _readFragmented(key, r, remaining) {
    const parts = [];
    let headerLen = null;
    let header = null;
    let offset = 0;
    for (let guard = 0; guard < 10000; guard++) {
      const reply = await this._request(frame.readTagFragmented(r.path, r.elements, offset), remaining());
      if (reply.status !== 0 && reply.status !== 0x06) return this._itemResult(key, r, reply);
      const data = reply.data;
      if (data.length < 2) return this._itemResult(key, r, { status: 0, data });
      const hl = data.readUInt16LE(0) === cip.STRUCT_TYPE_WORD ? 4 : 2;
      if (headerLen === null) {
        headerLen = hl;
        header = data.subarray(0, hl);
      } else if (hl !== headerLen || !data.subarray(0, hl).equals(header)) {
        return { key, v: null, type: r.type, q: 0, qReason: 'decode', message: 'fragment type header changed between fragments' };
      }
      const body = data.subarray(hl);
      parts.push(body);
      offset += body.length;
      if (reply.status === 0) break;
      if (body.length === 0 || offset >= r.valueBytes) {
        return { key, v: null, type: r.type, q: 0, qReason: 'decode', message: 'fragmented read did not terminate' };
      }
    }
    return this._itemResult(key, r, { status: 0, ext: [], data: Buffer.concat([header, ...parts]) });
  }

  // ── browse / probe ──────────────────────────────────────────────────────

  _symbolNode(sym, address) {
    const dims = sym.dims.slice(0, sym.dimCount);
    let dataType;
    if (sym.struct) {
      const tpl = this.templates.get(sym.templateId);
      dataType = tpl ? tpl.name : `UDT#${sym.templateId}`;
    } else dataType = sym.typeName;
    const accessible = sym.access !== 'None';
    return {
      id: `tag:${address}`,
      name: sym.name,
      kind: 'tag',
      address,
      meta: {
        dataType,
        dims,
        struct: sym.struct,
        templateId: sym.struct ? sym.templateId : undefined,
        hasChildren: sym.struct && dims.length === 0 && accessible,
        externalAccess: sym.access || 'unknown',
        accessible,
        ...(accessible ? {} : { reason: 'External Access is None' }),
      },
    };
  }

  async _scopeNodes(scope) {
    const { list } = await this._getSymbols(scope);
    const prefix = scope ? `${scope}.` : '';
    const visible = list.filter((s) => !s.system && !s.name.startsWith('__') && !s.name.includes(':'));
    for (const s of visible) {
      if (s.struct && s.access !== 'None') {
        try {
          await this._getTemplate(s.templateId);
        } catch (err) {
          if (err instanceof EipTransportError) throw err;
        }
      }
    }
    return visible.map((s) => this._symbolNode(s, `${prefix}${s.name}`));
  }

  _memberNodes(tpl, baseAddress, idPrefix) {
    return tpl.members
      .filter((m) => !m.hidden)
      .map((m) => {
        let dataType;
        let dims = [];
        if (m.kind === 'bit') dataType = 'BOOL';
        else if (m.kind === 'boolArray') {
          dataType = 'BOOL';
          dims = [m.words * 32];
        } else if (m.kind === 'atomic') {
          dataType = cip.TYPE_NAME[m.code];
          if (m.array) dims = [m.count];
        } else {
          const sub = this.templates.get(m.templateId);
          dataType = sub ? sub.name : `UDT#${m.templateId}`;
          if (m.array) dims = [m.count];
        }
        const struct = m.kind === 'struct';
        const sub = struct ? this.templates.get(m.templateId) : null;
        const address = baseAddress ? `${baseAddress}.${m.name}` : '';
        return {
          id: baseAddress ? `tag:${address}` : `${idPrefix}.${m.name}`,
          name: m.name,
          kind: 'tag',
          address,
          meta: { dataType, dims, struct, offset: m.offset, bit: m.kind === 'bit' ? m.bit : undefined, hasChildren: struct && dims.length === 0 && !(sub && sub.string) },
        };
      });
  }

  async browse(node) {
    return this._serial(async () => {
      if (!this.isConnected()) throw new Error('not connected');
      try {
        if (!node) {
          const { list } = await this._getSymbols(null);
          const programs = list.filter((s) => /^Program:/i.test(s.name)).map((s) => s.name);
          const structIds = [...new Set(list.filter((s) => s.struct && !s.system).map((s) => s.templateId))];
          return [
            { id: 'controller', name: 'Controller tags', kind: 'folder', address: '', meta: { scope: 'controller' } },
            ...programs.map((p) => ({ id: `program:${p.slice(8)}`, name: p, kind: 'folder', address: p, meta: { scope: 'program' } })),
            { id: 'types', name: 'Data types', kind: 'folder', address: '', meta: { count: structIds.length } },
          ];
        }
        if (node === 'controller') return await this._scopeNodes(null);
        if (node.startsWith('program:')) return await this._scopeNodes(`Program:${node.slice(8)}`);
        if (node === 'types') {
          const { list } = await this._getSymbols(null);
          const ids = [...new Set(list.filter((s) => s.struct && !s.system).map((s) => s.templateId))];
          const out = [];
          for (const id of ids) {
            const tpl = await this._getTemplate(id);
            out.push({ id: `type:${id}`, name: tpl.name, kind: 'folder', address: '', meta: { templateId: id, size: tpl.size, handle: tpl.handle, string: tpl.string } });
          }
          return out;
        }
        if (node.startsWith('type:')) {
          const tpl = await this._getTemplate(Number(node.slice(5)));
          return this._memberNodes(tpl, '', node);
        }
        if (node.startsWith('tag:')) {
          const address = node.slice(4);
          const r = await this._buildResolution({ parsed: parseAddress(address) });
          if (!r.template || r.elements !== 1) return [];
          return this._memberNodes(r.template, formatAddress(parseAddress(address)), node);
        }
        throw new Error(`unknown browse node "${node}"`);
      } catch (err) {
        if (err instanceof EipTransportError || err instanceof frame.EipFramingError) {
          if (this.client) this.client.destroy(err.message);
        }
        throw err;
      }
    });
  }

  async probe({ address }) {
    return this._serial(async () => {
      if (!this.isConnected()) throw new Error('not connected');
      const parsed = parseAddress(address);
      const r = await this._buildResolution({ parsed });
      const reply = await this._request(frame.readTag(r.path, r.elements));
      if (reply.status !== 0) throw new Error(`read ${address} failed: ${cip.statusName(reply.status, reply.ext)}`);
      const hl = reply.data.length >= 2 && reply.data.readUInt16LE(0) === cip.STRUCT_TYPE_WORD ? 4 : 2;
      const raw = reply.data.subarray(hl);
      const decodings = probeDecodings(raw);
      try {
        decodings.value = decodeTagReply(reply.data, this._decodeCtx(r)).v;
      } catch (err) {
        if (!(err instanceof DecodeError || err instanceof LayoutError)) throw err;
        decodings.valueError = err.message;
      }
      return { address: formatAddress(parsed), rawHex: raw.toString('hex'), type: r.dataTypeName, decodings };
    });
  }

  async close() {
    return this._serial(async () => {
      const client = this.client;
      this.client = null;
      if (client) await client.close(Math.min(this.requestDeadlineMs, 1000));
    });
  }
}

function createDriver(device, deps) {
  return new EipDriver(device, deps);
}

module.exports = { protocol, describe, validateTag, createDriver, EipDriver, TAG_TYPES, TYPE_BY_NAME };
