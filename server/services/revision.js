'use strict';

/**
 * Route-side half of optimistic concurrency (the store half is in profileStore.js).
 *
 * A client that wants conflict protection sends the `rev` it loaded, either as
 * the body field `rev` or as an `If-Match` header (`3`, `"3"` and `W/"3"` all
 * work; the body field wins when both are present). A request WITHOUT either keeps
 * last-write-wins, so old clients and scripts behave as before.
 *
 * A stale write is answered `409 { error, code: 'stale', current }` where
 * `current` is the stored object exactly as the matching GET would show it
 * (secrets redacted), so the client can show what changed and offer to retry.
 */

class BadRevisionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRevisionError';
  }
}

function parseOne(raw, where) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const text = String(raw).trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  if (!/^\d{1,15}$/.test(text)) throw new BadRevisionError(`${where} must be a non-negative integer revision`);
  return Number(text);
}

/** The revision the client says it is editing, or undefined (no check requested). Throws BadRevisionError. */
function expectedRev(req) {
  const fromBody = parseOne(req.body && typeof req.body === 'object' ? req.body.rev : undefined, 'rev');
  if (fromBody !== undefined) return fromBody;
  return parseOne(req.get ? req.get('If-Match') : req.headers?.['if-match'], 'If-Match');
}

/**
 * Turn a thrown error into the right response when it is a concurrency problem.
 * `present` maps the stored object to what GET returns. Returns true if handled.
 */
function handleRevisionError(res, error, present = (x) => x) {
  if (error instanceof BadRevisionError) {
    res.status(400).json({ error: error.message });
    return true;
  }
  if (error && error.code === 'stale') {
    res.status(409).json({ error: error.message, code: 'stale', current: error.current ? present(error.current) : null });
    return true;
  }
  return false;
}

/**
 * Start of a save handler: read the client's revision and refuse a stale write before anything
 * else happens. Returns the expected revision (undefined = no check requested), or `false` after
 * having answered 400/409 itself.
 */
function checkpoint(req, res, profiles, bucket, id, present) {
  try {
    const expectRev = expectedRev(req);
    if (id && profiles?.assertRev) profiles.assertRev(bucket, id, expectRev);
    return expectRev;
  } catch (error) {
    if (handleRevisionError(res, error, present)) return false;
    throw error;
  }
}

module.exports = { expectedRev, handleRevisionError, checkpoint, BadRevisionError };
