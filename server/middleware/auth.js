const crypto = require('crypto');

// Token auth that is ENFORCED only when APP_ACCESS_TOKEN is set. This keeps the
// tool usable out of the box for local development while making it possible to
// lock down any shared or internet-exposed deployment. When no token is set we
// warn loudly so an open instance is never a silent surprise.
const ACCESS_TOKEN = process.env.APP_ACCESS_TOKEN || '';

let warned = false;
function warnIfOpen() {
  if (!ACCESS_TOKEN && !warned) {
    warned = true;
    console.warn(
      '⚠️  APP_ACCESS_TOKEN is not set — the API and WebSocket are UNAUTHENTICATED. ' +
        'Set APP_ACCESS_TOKEN before exposing this server beyond localhost.'
    );
  }
}

function tokensMatch(provided) {
  if (!provided) {
    return false;
  }
  const a = Buffer.from(String(provided));
  const b = Buffer.from(ACCESS_TOKEN);
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function extractHttpToken(req) {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  const alt = req.headers['x-api-token'];
  return typeof alt === 'string' ? alt.trim() : null;
}

function httpAuth(req, res, next) {
  warnIfOpen();
  if (!ACCESS_TOKEN) {
    return next();
  }
  if (tokensMatch(extractHttpToken(req))) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

function socketAuth(socket, next) {
  warnIfOpen();
  if (!ACCESS_TOKEN) {
    return next();
  }
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (tokensMatch(token)) {
    return next();
  }
  return next(new Error('Unauthorized'));
}

module.exports = { httpAuth, socketAuth };
