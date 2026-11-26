'use strict';

/**
 * SNMPv3 User-based Security Model (RFC 3414, RFC 3826, RFC 7860) with Node's
 * built-in crypto only.
 *
 *   auth: HMAC-MD5-96, HMAC-SHA-96 (RFC 3414); HMAC-SHA-2 with the truncations
 *         of RFC 7860 (SHA-224 -> 16, SHA-256 -> 24, SHA-384 -> 32, SHA-512 -> 48 bytes)
 *   priv: CBC-DES (RFC 3414 8) and CFB128-AES-128 (RFC 3826)
 *
 * DES: OpenSSL 3 moved single DES to its legacy provider, which Node does not
 * load. Triple DES (EDE) with K1 = K2 = K3 is mathematically single DES
 * (E_K(D_K(E_K(x))) = E_K(x)), so CBC-DES runs as des-ede3-cbc with the key
 * repeated three times.
 */

const crypto = require('crypto');

const AUTH = Object.freeze({
  md5: { hash: 'md5', macLength: 12, label: 'HMAC-MD5-96' },
  sha: { hash: 'sha1', macLength: 12, label: 'HMAC-SHA-96' },
  sha224: { hash: 'sha224', macLength: 16, label: 'HMAC-SHA-224 (128)' },
  sha256: { hash: 'sha256', macLength: 24, label: 'HMAC-SHA-256 (192)' },
  sha384: { hash: 'sha384', macLength: 32, label: 'HMAC-SHA-384 (256)' },
  sha512: { hash: 'sha512', macLength: 48, label: 'HMAC-SHA-512 (384)' },
});

const PRIV = Object.freeze({
  des: { keyLength: 16, label: 'CBC-DES' }, // 8 key + 8 pre-IV
  aes: { keyLength: 16, label: 'CFB128-AES-128' },
});

const SECURITY_LEVELS = ['noAuthNoPriv', 'authNoPriv', 'authPriv'];

/** usmStats report OIDs (RFC 3414 5) and the other report counters an agent may send. */
const REPORT_OIDS = Object.freeze({
  '1.3.6.1.6.3.15.1.1.1.0': 'unsupportedSecLevels',
  '1.3.6.1.6.3.15.1.1.2.0': 'notInTimeWindows',
  '1.3.6.1.6.3.15.1.1.3.0': 'unknownUserNames',
  '1.3.6.1.6.3.15.1.1.4.0': 'unknownEngineIDs',
  '1.3.6.1.6.3.15.1.1.5.0': 'wrongDigests',
  '1.3.6.1.6.3.15.1.1.6.0': 'decryptionErrors',
  '1.3.6.1.6.3.11.2.1.1.0': 'unknownSecurityModels',
  '1.3.6.1.6.3.11.2.1.2.0': 'invalidMsgs',
  '1.3.6.1.6.3.11.2.1.3.0': 'unknownPDUHandlers',
  '1.3.6.1.6.3.12.1.4.0': 'unavailableContexts',
  '1.3.6.1.6.3.12.1.5.0': 'unknownContexts',
});

const REPORT_MESSAGES = Object.freeze({
  unsupportedSecLevels: 'the agent does not support the requested security level for this user',
  notInTimeWindows: 'the request was outside the agent\'s time window (engine boots/time out of sync)',
  unknownUserNames: 'the agent does not know this user name',
  unknownEngineIDs: 'the agent does not recognise the engine ID',
  wrongDigests: 'authentication failed: wrong authentication password or protocol',
  decryptionErrors: 'the agent could not decrypt the request: wrong privacy password or protocol',
  unknownSecurityModels: 'the agent does not support the User-based Security Model',
  invalidMsgs: 'the agent considered the message invalid',
  unknownPDUHandlers: 'the agent has no handler for this PDU type',
  unavailableContexts: 'the requested context is unavailable',
  unknownContexts: 'the agent does not know the requested context name',
});

const ONE_MEG = 1048576;

/** RFC 3414 A.2: password -> Ku (hash of the password repeated to 1 MiB). */
function passwordToKey(password, authProtocol) {
  const alg = AUTH[authProtocol];
  if (!alg) throw new Error(`unknown authentication protocol "${authProtocol}"`);
  const pw = Buffer.isBuffer(password) ? password : Buffer.from(String(password), 'utf8');
  if (!pw.length) throw new Error('password must not be empty');
  const h = crypto.createHash(alg.hash);
  // A block whose length is a whole number of password repeats, so consecutive
  // blocks continue the repetition seamlessly; the last one is cut to 1 MiB.
  const block = Buffer.alloc(pw.length * Math.ceil(65536 / pw.length));
  for (let i = 0; i < block.length; i++) block[i] = pw[i % pw.length];
  let index = 0;
  while (index < ONE_MEG) {
    const n = Math.min(block.length, ONE_MEG - index);
    h.update(n === block.length ? block : block.subarray(0, n));
    index += n;
  }
  return h.digest();
}

/** RFC 3414 A.2.2: Kul = H(Ku || engineID || Ku). */
function localizeKey(ku, engineId, authProtocol) {
  const alg = AUTH[authProtocol];
  return crypto.createHash(alg.hash).update(Buffer.concat([ku, engineId, ku])).digest();
}

function localizedKey(password, engineId, authProtocol) {
  return localizeKey(passwordToKey(password, authProtocol), engineId, authProtocol);
}

function macLength(authProtocol) {
  return AUTH[authProtocol].macLength;
}

/** HMAC over the whole message (with the auth field zeroed), truncated per protocol. */
function computeMac(authProtocol, key, wholeMessage) {
  const alg = AUTH[authProtocol];
  return crypto.createHmac(alg.hash, key).update(wholeMessage).digest().subarray(0, alg.macLength);
}

function verifyMac(authProtocol, key, wholeMessage, mac) {
  const want = computeMac(authProtocol, key, wholeMessage);
  return mac.length === want.length && crypto.timingSafeEqual(want, mac);
}

// ── privacy ──────────────────────────────────────────────────────────────

function desKey(privKey) {
  const k = privKey.subarray(0, 8);
  return Buffer.concat([k, k, k]);
}

/**
 * Encrypt a scoped PDU. Returns { encrypted, privParams }.
 * `salt` is a caller-maintained counter (number/bigint) so salts never repeat.
 */
function encrypt(privProtocol, privKey, plaintext, { engineBoots, engineTime, salt }) {
  if (privProtocol === 'des') {
    const saltBuf = Buffer.alloc(8);
    saltBuf.writeUInt32BE(engineBoots >>> 0, 0);
    saltBuf.writeUInt32BE(Number(BigInt(salt) & 0xffffffffn), 4);
    const preIv = privKey.subarray(8, 16);
    const iv = Buffer.alloc(8);
    for (let i = 0; i < 8; i++) iv[i] = preIv[i] ^ saltBuf[i];
    const padLen = (8 - (plaintext.length % 8)) % 8;
    const padded = padLen ? Buffer.concat([plaintext, Buffer.alloc(padLen)]) : plaintext;
    const c = crypto.createCipheriv('des-ede3-cbc', desKey(privKey), iv);
    c.setAutoPadding(false);
    return { encrypted: Buffer.concat([c.update(padded), c.final()]), privParams: saltBuf };
  }
  if (privProtocol === 'aes') {
    const saltBuf = Buffer.alloc(8);
    saltBuf.writeBigUInt64BE(BigInt.asUintN(64, BigInt(salt)));
    const iv = Buffer.alloc(16);
    iv.writeUInt32BE(engineBoots >>> 0, 0);
    iv.writeUInt32BE(engineTime >>> 0, 4);
    saltBuf.copy(iv, 8);
    const c = crypto.createCipheriv('aes-128-cfb', privKey.subarray(0, 16), iv);
    return { encrypted: Buffer.concat([c.update(plaintext), c.final()]), privParams: saltBuf };
  }
  throw new Error(`unknown privacy protocol "${privProtocol}"`);
}

/** Decrypt an encryptedPDU with the sender's boots/time (from the security parameters). */
function decrypt(privProtocol, privKey, encrypted, { engineBoots, engineTime, privParams }) {
  if (!privParams || privParams.length !== 8) throw new Error('privacy parameters must be 8 bytes');
  if (privProtocol === 'des') {
    if (encrypted.length % 8 !== 0) throw new Error('DES ciphertext is not a multiple of 8 bytes');
    const preIv = privKey.subarray(8, 16);
    const iv = Buffer.alloc(8);
    for (let i = 0; i < 8; i++) iv[i] = preIv[i] ^ privParams[i];
    const d = crypto.createDecipheriv('des-ede3-cbc', desKey(privKey), iv);
    d.setAutoPadding(false);
    return Buffer.concat([d.update(encrypted), d.final()]);
  }
  if (privProtocol === 'aes') {
    const iv = Buffer.alloc(16);
    iv.writeUInt32BE(engineBoots >>> 0, 0);
    iv.writeUInt32BE(engineTime >>> 0, 4);
    privParams.copy(iv, 8);
    const d = crypto.createDecipheriv('aes-128-cfb', privKey.subarray(0, 16), iv);
    return Buffer.concat([d.update(encrypted), d.final()]);
  }
  throw new Error(`unknown privacy protocol "${privProtocol}"`);
}

module.exports = {
  AUTH,
  PRIV,
  SECURITY_LEVELS,
  REPORT_OIDS,
  REPORT_MESSAGES,
  passwordToKey,
  localizeKey,
  localizedKey,
  macLength,
  computeMac,
  verifyMac,
  encrypt,
  decrypt,
};
