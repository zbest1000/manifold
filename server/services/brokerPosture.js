'use strict';

/**
 * Security posture of one MQTT connection: a read-only assessment built from what Manifold already knows
 * about the session. Nothing is probed, nothing is published and no extra connection is made.
 *
 * assess(facts) is pure. Each finding is { id, severity, title, detail, fix }; severity is
 * high | medium | low | info, and findings are listed worst first. There is no score or grade.
 *
 * Loopback hosts (localhost, 127.x, ::1) lower the findings that are about traffic crossing a network,
 * because on a loopback connection nothing leaves the machine. Private (LAN) addresses do not: plaintext on a
 * plant network is a real finding.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const CERT_WARN_DAYS = 30;
const CERT_URGENT_DAYS = 7;
const STORM_DROPS = 5; // unexpected session drops ...
const STORM_WINDOW_MS = 5 * 60 * 1000; // ... within this window

const SEVERITIES = ['high', 'medium', 'low', 'info'];
const RANK = { high: 0, medium: 1, low: 2, info: 3 };

function isLoopback(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
}

/** Days until `validTo` (a date string or ms), floored; negative when expired; null when unknown. */
function daysLeft(validTo, now) {
  const ms = typeof validTo === 'number' ? validTo : Date.parse(validTo);
  if (!Number.isFinite(ms)) return null;
  return Math.floor((ms - now) / DAY_MS);
}

/**
 * @param {object} f facts: { protocol, host, port, tls, tlsVerify, hasCa, certificate: { validTo, subject, issuer,
 *   selfSigned } | null, username, hasPassword, mqttVersion, subscribeFilter, autoSubscribe, effectiveFilters[],
 *   sysReadable, drops: number[] (timestamps of unexpected session drops), sessionTakenOver: number }
 * @param {{ now?: number }} [opts]
 */
function assess(f = {}, { now = Date.now() } = {}) {
  const findings = [];
  const add = (id, severity, title, detail, fix) => findings.push({ id, severity, title, detail, fix });
  const loopback = isLoopback(f.host);
  const tls = Boolean(f.tls);
  const authenticated = Boolean(f.username);
  const endpoint = `${f.protocol}://${f.host}:${f.port}`;

  const cert = f.certificate || null;
  const certDays = cert ? daysLeft(cert.validTo, now) : null;

  if (!tls) {
    add(
      'plaintext-transport',
      loopback ? 'info' : 'medium',
      loopback ? 'Unencrypted connection (loopback)' : 'Connection is not encrypted',
      loopback
        ? `${endpoint} is plain MQTT, but it stays on this machine.`
        : `${endpoint} sends every topic and payload unencrypted. Anyone on the network path can read it and inject messages.`,
      `Use ${f.protocol === 'ws' ? 'wss' : 'mqtts'} and leave certificate verification on.`
    );
    if (authenticated && f.hasPassword) {
      add(
        'password-plaintext',
        loopback ? 'info' : 'high',
        loopback ? 'Password sent unencrypted (loopback)' : 'Password is sent unencrypted',
        loopback
          ? 'The password for this connection is sent in clear text, but only to this machine.'
          : `The password for "${f.username}" is sent in clear text on every connect. Anyone who can see the traffic can reuse it.`,
        'Move this connection to TLS first, then change the password.'
      );
    }
  } else {
    if (f.tlsVerify === false) {
      add(
        'tls-verify-off',
        'high',
        'Certificate verification is off',
        'The connection is encrypted but accepts any certificate, so someone on the path can pose as the broker without being noticed.',
        f.hasCa
          ? 'Turn "Verify TLS certificate" on. The CA certificate you configured will be used.'
          : 'Turn "Verify TLS certificate" on. For a broker with its own CA, give Manifold the CA certificate instead of switching verification off.'
      );
    }
    if (certDays !== null) {
      const who = cert.subject || 'the broker certificate';
      if (certDays < 0) {
        add('cert-expired', 'high', 'Broker certificate has expired', `The certificate for ${who} expired ${-certDays} day${certDays === -1 ? '' : 's'} ago. Clients that verify certificates will refuse to connect.`, 'Renew the broker certificate and reload the broker.');
      } else if (certDays < CERT_URGENT_DAYS) {
        add('cert-expiring', 'high', `Broker certificate expires in ${certDays} day${certDays === 1 ? '' : 's'}`, `The certificate for ${who} lapses soon. Verifying clients stop connecting the moment it does.`, 'Renew the broker certificate now and set up automatic renewal.');
      } else if (certDays < CERT_WARN_DAYS) {
        add('cert-expiring', 'medium', `Broker certificate expires in ${certDays} days`, `The certificate for ${who} is valid for ${certDays} more days.`, 'Renew the broker certificate before it expires.');
      }
    }
  }

  if (!authenticated) {
    add(
      'anonymous',
      loopback ? 'low' : 'medium',
      'Connecting without a username',
      'The broker accepts this client anonymously, so its publishes and subscriptions cannot be attributed or limited per client.',
      'Create a user for Manifold on the broker, restrict it with an ACL, and set the username and password on this connection.'
    );
  }

  const filters = f.effectiveFilters && f.effectiveFilters.length ? f.effectiveFilters : f.autoSubscribe === false ? [] : [f.subscribeFilter];
  const root = filters.find((x) => x === '#');
  if (root) {
    add(
      'wildcard-root',
      'low',
      'Subscribed to everything on the broker (#)',
      'Manifold receives every topic on this broker, including topics of other systems, and keeps their latest values in memory.',
      'Narrow the subscription filter to the namespaces you need, for example plant1/#.'
    );
  } else if (filters.some((x) => x === '+/#')) {
    add('wildcard-root', 'low', 'Subscribed to nearly everything on the broker (+/#)', 'This filter matches every topic with two or more levels.', 'Narrow the subscription filter to the namespaces you need.');
  }

  if (f.mqttVersion === 4) {
    add('mqtt-version', 'info', 'MQTT 3.1.1', 'MQTT 3.1.1 has no reason codes, session expiry or enhanced authentication. Nothing is wrong with it if the broker does not offer MQTT 5.', 'Use MQTT 5 where the broker supports it.');
  }

  const drops = (f.drops || []).filter((t) => now - t <= STORM_WINDOW_MS);
  if (f.sessionTakenOver > 0) {
    add(
      'client-id-collision',
      'high',
      'Another client is using this client ID',
      `The broker closed this session ${f.sessionTakenOver} time${f.sessionTakenOver === 1 ? '' : 's'} because another connection took over client ID "${f.clientId}". Both clients keep disconnecting each other.`,
      'Give each client a unique client ID (Connection settings), or stop the other client.'
    );
  } else if (drops.length >= STORM_DROPS) {
    add(
      'reconnect-storm',
      'medium',
      'Connection keeps dropping',
      `${drops.length} unexpected disconnects in the last 5 minutes. A common cause is two clients sharing a client ID: the broker drops the older one, which reconnects and drops the other.`,
      'Check that the client ID is unique (Connection settings), then look at the broker log for the reason.'
    );
  }

  if (f.sysReadable) {
    add('sys-readable', 'low', 'The $SYS topics are readable', 'This client can read the broker’s $SYS tree: version, uptime and client counts. That helps an attacker pick known weaknesses.', 'Allow $SYS reads only for administrative users in the broker ACL.');
  }

  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((x) => x.severity === s).length]));
  return {
    findings,
    summary: { ...counts, worst: findings.find((x) => x.severity !== 'info')?.severity || (findings.length ? 'info' : 'none') },
    facts: {
      transport: tls ? 'TLS' : 'plaintext',
      certificateVerified: tls ? f.tlsVerify !== false : null,
      certificateDaysLeft: tls ? certDays : null,
      certificateValidTo: tls && cert ? cert.validTo || null : null,
      authentication: authenticated ? 'username and password' : 'anonymous',
      mqttVersion: f.mqttVersion === 5 ? 'MQTT 5' : 'MQTT 3.1.1',
      subscription: filters.length ? filters.join(', ') : 'none (auto-subscribe is off)',
      sysReadable: Boolean(f.sysReadable)
    }
  };
}

module.exports = { assess, isLoopback, STORM_DROPS, STORM_WINDOW_MS };
