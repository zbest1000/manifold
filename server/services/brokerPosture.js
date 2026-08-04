// Broker security posture scorecard — grades one MQTT connection's transport
// and auth hygiene as A–D with itemized findings and fixes.
//
// assess() is deliberately PURE: it takes plain facts (the manager's public
// connection info, an optional TLS peer certificate, the broker-admin config)
// and returns a verdict — no I/O, no manager access — so the whole rubric is
// unit-testable with literal objects. The route does the thin "gather" step
// (mqttManager.getTransportSecurity + getBrokerAdmin).
//
// Scoring model: start at 100 and subtract a per-finding deduction, clamped to
// 0..100. Severity drives both the deduction and the grade:
//
//   id                          deduct  severity  when
//   plaintext-transport           35     high     mqtt/ws to a non-internal host
//   credentials-over-plaintext    20     high     username + plaintext transport.
//                                                 Stacks with plaintext-transport
//                                                 (55 total) so credentials in
//                                                 the clear always grade BELOW
//                                                 anonymous plaintext (47 total):
//                                                 leaking a reusable secret is
//                                                 worse than leaking nothing.
//   tls-no-verify                 30     high     TLS with rejectUnauthorized=false
//   cert-expired                  30     high     peer cert past its valid_to
//   cert-expiring                 15     medium   peer cert expires in <30 days
//   anonymous                     12     medium   no username, non-internal host
//   legacy-protocol               12     medium   MQTT 3.1 (protocol level < 4)
//   admin-http                    12     medium   broker admin API over http://
//                                                 to a non-internal host
//   *-internal variants            0     info     the same facts on a loopback /
//                                                 compose-internal host — context,
//                                                 not a penalty. The demo's
//                                                 in-cluster brokers are plaintext
//                                                 by design and must not scream
//                                                 red misleadingly.
//
// Grade bands: A >= 90, B >= 72, C >= 55, D below — and any high finding caps
// the grade at C regardless of score (an MITM-able link is never a "B").

const CERT_WARN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const GRADES = [
  ['A', 90],
  ['B', 72],
  ['C', 55]
];

const DEDUCTIONS = {
  'plaintext-transport': 35,
  'credentials-over-plaintext': 20,
  'tls-no-verify': 30,
  'cert-expired': 30,
  'cert-expiring': 15,
  anonymous: 12,
  'legacy-protocol': 12,
  'admin-http': 12
};

// Loopback and cluster-internal hosts: the compose demo's brokers are reached
// as bare service names (mqtt, mqtt2...) and local dev as localhost — plaintext
// there is normal, not a red flag. RFC1918 LAN IPs deliberately do NOT count as
// internal: plaintext across a plant network is a real finding.
function isInternalHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0.0.0.0' || h.startsWith('127.')) return true;
  if (h === 'host.docker.internal' || h.endsWith('.internal')) return true;
  if (h.endsWith('.local')) return true;
  // Single-label hostnames (no dot, no colon) are compose/k8s service names or
  // LAN shortnames — cluster-internal by construction. IP literals never match
  // this branch (IPv4 contains '.', IPv6 contains ':').
  if (!h.includes('.') && !h.includes(':')) return true;
  return false;
}

function assessCertificate(peerCert, findings) {
  if (!peerCert || !peerCert.valid_to) return;
  const validTo = Date.parse(peerCert.valid_to);
  if (!Number.isFinite(validTo)) return;
  const cn = peerCert.subject?.CN || 'broker certificate';
  const daysLeft = Math.floor((validTo - Date.now()) / DAY_MS);
  if (daysLeft < 0) {
    findings.push({
      id: 'cert-expired',
      severity: 'high',
      title: 'TLS certificate has expired',
      detail: `The broker's certificate (${cn}) expired on ${peerCert.valid_to}. Clients that verify will refuse to connect; anything still connected is one restart away from an outage.`,
      fix: 'Renew and redeploy the broker certificate, then reconnect.'
    });
  } else if (daysLeft < CERT_WARN_DAYS) {
    findings.push({
      id: 'cert-expiring',
      severity: 'medium',
      title: `TLS certificate expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
      detail: `The broker's certificate (${cn}) is valid until ${peerCert.valid_to}. Verifying clients will start failing the moment it lapses.`,
      fix: 'Renew the broker certificate before it expires (automate rotation if possible).'
    });
  }
}

function assessAdminApi(adminConfig, findings) {
  if (!adminConfig || !adminConfig.configured || !adminConfig.url) return;
  let url;
  try {
    url = new URL(adminConfig.url);
  } catch {
    return; // unparseable URL — nothing honest to say about its transport
  }
  if (url.protocol !== 'http:') return;
  if (isInternalHost(url.hostname)) {
    findings.push({
      id: 'admin-http-internal',
      severity: 'info',
      title: 'Broker admin API over http:// (internal host)',
      detail: `The admin API at ${adminConfig.url} is unencrypted, but the host looks loopback/cluster-internal.`,
      fix: 'Fine for local networks; switch to https:// if the admin API is ever reachable beyond this host or cluster.'
    });
  } else {
    findings.push({
      id: 'admin-http',
      severity: 'medium',
      title: 'Broker admin API over http://',
      detail: `The admin API at ${adminConfig.url} sends its API key/secret unencrypted on every request.`,
      fix: 'Serve the broker admin API over https:// (or tunnel it) so the API credentials are not readable on the wire.'
    });
  }
}

/**
 * Grade a connection's security posture.
 *
 * @param {object} connectionInfo manager public info: { protocol, host, port,
 *   username, mqttVersion, ... } plus rejectUnauthorized (from the live client
 *   options — the public info doesn't carry it).
 * @param {object} [extras]
 * @param {object|null} [extras.peerCert] TLS peer certificate ({ subject,
 *   valid_to, ... }) when the underlying socket exposes one.
 * @param {object|null} [extras.adminConfig] getBrokerAdmin() result.
 * @returns {{ grade: 'A'|'B'|'C'|'D', score: number, findings: Array }}
 */
function assess(connectionInfo = {}, { peerCert = null, adminConfig = null } = {}) {
  const findings = [];
  const host = String(connectionInfo.host || '');
  const protocol = connectionInfo.protocol || 'mqtt';
  const isTls = protocol === 'mqtts' || protocol === 'wss';
  const internal = isInternalHost(host);
  const hasCredentials = Boolean(connectionInfo.username);
  const endpoint = `${protocol}://${host}:${connectionInfo.port ?? ''}`;

  if (!isTls) {
    if (internal) {
      findings.push({
        id: 'plaintext-internal',
        severity: 'info',
        title: 'Plaintext transport on an internal host',
        detail: `${endpoint} is unencrypted, but the host looks loopback/cluster-internal where traffic never crosses a shared network.`,
        fix: 'Acceptable for local/compose networks. Use mqtts:// if this broker ever becomes reachable beyond the host or cluster.'
      });
    } else {
      findings.push({
        id: 'plaintext-transport',
        severity: 'high',
        title: 'Unencrypted transport to an external broker',
        detail: `${endpoint} carries every topic and payload in cleartext across the network — anyone on the path can read and inject traffic.`,
        fix: `Switch to ${protocol === 'ws' ? 'wss://' : 'mqtts://'} (TLS) and keep certificate verification on.`
      });
      if (hasCredentials) {
        findings.push({
          id: 'credentials-over-plaintext',
          severity: 'high',
          title: 'Credentials sent over plaintext',
          detail: `The username/password for "${connectionInfo.username}" crosses the wire unencrypted on every connect — a reusable secret, not just data, is exposed.`,
          fix: 'Move this connection to TLS before anything else; rotate the password once the plaintext path is closed.'
        });
      }
    }
  } else {
    if (connectionInfo.rejectUnauthorized === false) {
      findings.push({
        id: 'tls-no-verify',
        severity: 'high',
        title: 'TLS certificate verification disabled',
        detail: 'rejectUnauthorized is off: the connection is encrypted but accepts ANY certificate, so an active attacker can silently impersonate the broker (MITM).',
        fix: 'Enable "Verify TLS certificate". For self-signed brokers, provide the CA certificate instead of disabling verification.'
      });
    }
    assessCertificate(peerCert, findings);
  }

  if (!hasCredentials) {
    if (internal) {
      findings.push({
        id: 'anonymous-internal',
        severity: 'info',
        title: 'Anonymous access (internal host)',
        detail: 'No username is configured. Common for loopback/compose-internal brokers.',
        fix: 'Enable broker authentication if this broker ever serves more than local development.'
      });
    } else {
      findings.push({
        id: 'anonymous',
        severity: 'medium',
        title: 'Anonymous access to an external broker',
        detail: 'No username is configured — the broker accepts this client (and anyone else) without identity, so publishes cannot be attributed or restricted.',
        fix: 'Create per-client broker credentials and an ACL; set the username/password on this connection.'
      });
    }
  }

  // Weak protocol level. This app only offers MQTT 3.1.1 (level 4) and MQTT 5,
  // but imported/external configs may carry the legacy 3.1 (level 3).
  const version = Number(connectionInfo.mqttVersion);
  if (Number.isFinite(version) && version > 0 && version < 4) {
    findings.push({
      id: 'legacy-protocol',
      severity: 'medium',
      title: 'Legacy MQTT 3.1 protocol',
      detail: `Protocol level ${version} (MQTT 3.1) predates 3.1.1/5 hardening and modern broker auth features.`,
      fix: 'Use MQTT 3.1.1 (level 4) or MQTT 5.'
    });
  }

  assessAdminApi(adminConfig, findings);

  let score = 100;
  for (const f of findings) score -= DEDUCTIONS[f.id] || 0;
  score = Math.max(0, Math.min(100, score));

  let grade = 'D';
  for (const [g, floor] of GRADES) {
    if (score >= floor) {
      grade = g;
      break;
    }
  }
  // A high finding is a live attack surface — never grade above C on score alone.
  if ((grade === 'A' || grade === 'B') && findings.some((f) => f.severity === 'high')) grade = 'C';

  return { grade, score, findings };
}

module.exports = { assess, isInternalHost, DEDUCTIONS, CERT_WARN_DAYS };
