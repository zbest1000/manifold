# HTTP/JSON polling driver: notes and hardware checklist

Status: **experimental** (`describe().experimental === true`). Tested only against
`server/test/support/httpJsonSimulator.js`, written by the same person as the driver, so the tests
show the two agree. Real devices (energy meters, smart plugs, gateways) deviate in ways listed below
that no simulator of ours reproduces completely.

Protocol id `http-json`. Code: `index.js` (device, tags, execution), `selector.js` (JSONPath subset),
`../common/httpClient.js` (the one HTTP client, shared with MTConnect).

## What it does

- **GET only.** The client has a single `http(s).request` call with `method: 'GET'` and no body. There is
  no method option anywhere. A test sends every kind of read and checks the simulator saw only GET with no
  body; another test asserts the client source contains no other method.
- **One request per distinct path per poll cycle**, shared by every tag on that path (`plan()` groups by
  path; 600 tags on 3 paths are 3 requests).
- **Tag address**: `path#selector`, for example `/api/status?unit=1#$.power.total`. The API also accepts
  explicit `path` and `selector` fields. Optional per tag: `timestampSelector`, `qualitySelector` with
  `qualityEquals`, `okStatus` (list of accepted status codes, default 2xx).
- **Types**: `number`, `bool`, `string`. Number accepts JSON numbers, numeric strings and booleans (1/0);
  bool accepts booleans, 0/1 and true/false/on/off/yes/no strings; string takes any scalar and stringifies
  objects (up to 4096 characters). `scale` and `offset` are mapping features and are not duplicated here.
- **Selectors**: `$`, `.name`, `['key']`, `["key"]`, `[n]`, `[-n]` and `[?(@.a.b=="x")]` (first match of an
  equality filter against a string, number, boolean or null). Parsed into steps and walked over own
  properties only; no `eval`, no script expressions, no wildcards, no `..`, no slices or unions (each is
  refused at validation with a message). A filter is compared, never executed.
- **Quality**: Good only when the status is accepted, the body parses, the selector matches, the quality
  rule (if any) holds and the value coerces. Otherwise Bad with a reason in `qReason`: `http-<status>`,
  `timeout`, `not-json`, `selector-no-match (stopped at ...)`, `too-large`, `type-mismatch`, `null-value`,
  `quality-rule (...)`, `redirect-refused (...)`, `unsupported-encoding`. These are results of a successful
  read, so the device stays online.
- **Offline**: connection refused or reset, a dropped connection, a TLS failure, or three timeouts in a row
  (any answer resets the count) are fatal transport errors: the runtime marks every tag Bad
  (`disconnected`), closes and reconnects with backoff.
- **ETag**: `If-None-Match` is sent when the path has a cached ETag from a 2xx answer; a 304 re-reads the
  cached parsed document (values stay Good and fresh). The cache holds one document per path.
- **Source timestamp**: from `timestampSelector` (ISO 8601, epoch seconds or epoch milliseconds; only
  2000-2100 is plausible), otherwise the read time. A timestamp that does not parse keeps the value Good
  and falls back to the read time.
- **Size cap**: `options.maxResponseBytes` (default 1 MiB). A declared Content-Length over the cap, or a
  chunked body that reaches it, aborts the request at once (the socket is destroyed) and the tags go Bad
  `too-large`.
- **Redirects**: followed by hand, at most 3, only to the same host, port and scheme, and always as GET. A
  redirect anywhere else is refused (never contacted), so credentials cannot leave the device. For a
  literal-IP host (no pin) a followed redirect is re-checked against the egress guard.
- **Address pinning**: the main process resolves and validates the host name and passes
  `device.pinned.addresses`; the agent's `lookup` returns that address, `Host` and the TLS server name keep
  the configured name. The name is never resolved again in the driver process.
- **TLS**: verified by default. Per device: `tlsCa` (extra CA, PEM; a PEM pasted on one line is re-wrapped),
  `tlsFingerprint256` (pin; replaces chain validation) or `tlsInsecure` (explicit opt-out). The pin is
  checked in a custom `createConnection` after the handshake and before the request is written, because
  Node skips `checkServerIdentity` when chain validation already failed (the normal case for a self-signed
  device), which would silently turn a pin into "accept anything".
- **Authentication**: none, basic, bearer, or one custom header. Stored with the device under
  `authPassword`, `authToken`, `authHeaderSecret`; those names match the shared credential pattern, so the
  audit log and config export redact them. The device API returns `********` in their place and an edit
  that leaves them blank or sends the placeholder back keeps the stored value. A secret the chosen
  authentication does not use is dropped on save. Credentials are sent only to the device's own host.
- **Keep-alive**: one socket (`maxSockets: 1`), reused between polls; `options.keepAlive: false` sends
  `Connection: close`.
- **Browse** (`capabilities.browse`): root lists the base path `/` and every path used by a tag; opening a
  path fetches it and lists up to 500 leaf selectors (depth 10, 25 array items) with type and sample value,
  as addresses ready to use. **Probe** takes `/path` (all leaves) or `/path#$.selector` (one value).
- **Test connection**: a GET of `options.testPath` (default `/`). Any HTTP answer counts as reachable,
  except 401 and 403, which fail with the status; a 404 on the root is reachable with a note.

## Deviations handled

- Devices that serve JSON as `text/html` or `text/plain`: the Content-Type is not checked, only the body.
- UTF-8 BOM before the JSON: stripped.
- Numbers delivered as strings (`"230.4"`), booleans as 0/1 or "on"/"off": coerced as above.
- Servers that ignore `Accept-Encoding: identity` and compress anyway: the tags go Bad
  `unsupported-encoding` (the client does not decompress).
- Servers that answer 200 with an HTML login page: `not-json`, with the first bytes in the probe error.
- Single-threaded embedded servers: one connection, one request at a time, optional
  `limits.interRequestDelayMs`, overruns skipped by the runtime.

## Not supported

- Any method but GET; any request body; any write or control endpoint.
- JSONPath beyond the subset above (wildcards, recursive descent, slices, unions, comparison operators,
  `&&`/`||`, script expressions, functions).
- Pagination, cookies/sessions, login flows, OAuth, digest authentication, client certificates.
- XML, CSV or other non-JSON bodies; compressed responses; HTTP/2.
- WebSocket or server-sent events (this is a poller).
- Following a redirect to another host, port or scheme (by design).
- Multi-valued selectors (a filter yields the first match only).

## To confirm on real hardware before this leaves experimental

1. Behaviour of the target devices under 1 s polling with a single keep-alive connection (some close the
   connection after each answer; some reject `Connection: keep-alive`).
2. Whether the devices tolerate `Accept-Encoding: identity` and the `Accept` header sent.
3. That a GET on every path polled is free of side effects on the device.
4. Digest authentication, which some meters require, is not implemented: check the devices.
5. ETag handling on devices that send ETags but never answer 304.
6. TLS: self-signed certificates with the CA and the fingerprint options on a real device, including
   hostname versus IP in the certificate.
