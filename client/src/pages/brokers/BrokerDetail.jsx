import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Drawer, Button, Banner, KeyValue, StatusText, Mono, LoadingState } from '@/components/ui';
import { canaryWord, canaryTone, ms, sinceWord, severityTone } from '@/lib/brokerHealth';

/**
 * Broker details (drawer): what the broker granted, the canary round trip, and the security assessment.
 * Everything here is read from the server; the canary and the assessment refresh while the drawer is open.
 */

const SEVERITY_WORD = { high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };

export default function BrokerDetail({ broker, onClose, onEdit }) {
  const posture = usePolled(() => api.brokerPosture(broker.id), { interval: 10_000, deps: [broker.id] });
  const canary = usePolled(() => api.brokerCanary(broker.id), { interval: 5_000, deps: [broker.id] });
  const intake = broker.intake || {};

  return (
    <Drawer
      title={broker.name || broker.host}
      width="max-w-xl"
      onClose={onClose}
      actions={
        <Button variant="secondary" size="sm" onClick={() => onEdit(broker)}>
          Edit
        </Button>
      }
    >
      <div className="space-y-6 px-4 py-4" data-testid="broker-detail">
        <section aria-labelledby="bd-sub" className="space-y-2">
          <h3 id="bd-sub" className="text-sm font-medium text-fg">
            Subscription
          </h3>
          <KeyValue
            items={[
              ['Endpoint', <Mono key="e">{`${broker.protocol}://${broker.host}:${broker.port}`}</Mono>],
              ['Requested filter', broker.autoSubscribe === false ? 'None (auto-subscribe is off)' : <Mono key="r">{intake.requested || broker.subscribeFilter}</Mono>],
              broker.autoSubscribe !== false && ['Granted by the broker', grantedText(intake)]
            ]}
          />
          {intake.via === 'fallback' && (
            <Banner variant="warn" title="The broker refused the requested filter">
              Its access rules refuse <Mono>{intake.requested}</Mono>. Manifold subscribed to <Mono>{intake.granted}</Mono> instead, which covers everything with more levels.
              Topics with a single level are not received.
            </Banner>
          )}
          {intake.via === 'refused' && (
            <Banner variant="error" title="The broker refused the subscription">
              Nothing is being received through <Mono>{intake.requested}</Mono>. Allow the subscription in the broker&apos;s access rules, or use another filter.
            </Banner>
          )}
        </section>

        <section aria-labelledby="bd-canary" className="space-y-2" data-testid="canary-section">
          <h3 id="bd-canary" className="text-sm font-medium text-fg">
            Canary
          </h3>
          <CanaryBody query={canary} broker={broker} onEdit={onEdit} />
        </section>

        <section aria-labelledby="bd-sec" className="space-y-2" data-testid="posture-section">
          <h3 id="bd-sec" className="text-sm font-medium text-fg">
            Security
          </h3>
          <PostureBody query={posture} />
        </section>
      </div>
    </Drawer>
  );
}

function grantedText(intake) {
  if (!intake.via) return 'Not yet';
  if (intake.via === 'refused') return 'Refused';
  return (
    <span>
      <Mono>{intake.granted}</Mono> at QoS {intake.qos}
      {intake.via === 'fallback' ? ' (fallback)' : ''}
    </span>
  );
}

function CanaryBody({ query, broker, onEdit }) {
  const { data: c, error, loading } = query;
  if (loading && !c) return <LoadingState label="canary" rows={2} />;
  if (error && !c) return <Banner variant="error" title="Could not load the canary">{error.message}</Banner>;
  if (!c || c.state === 'off') {
    return (
      <div className="space-y-2 text-sm text-muted">
        <p>
          The canary is off. When it is on, Manifold <strong className="font-medium text-fg">publishes</strong> a small message to this broker every few seconds, receives it back through its own
          subscription and measures how long that took. It shows whether the broker really delivers, which a connected session does not.
        </p>
        <Button variant="secondary" size="sm" onClick={() => onEdit(broker)}>
          Turn on in the broker settings
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="flex flex-wrap items-center gap-x-2 text-sm">
        <span data-testid="canary-state" data-state={c.state}>
          <StatusText tone={canaryTone(c.state)} className="font-medium">
            {canaryWord(c.state)}
          </StatusText>
        </span>
        <span className="text-muted">{c.detail}</span>
      </p>
      {c.state === 'not-permitted' && (
        <Banner variant="warn" title={`The broker refused the canary ${c.refused === 'subscribe' ? 'subscription' : 'publish'}`}>
          The access rules do not let this client {c.refused === 'subscribe' ? 'subscribe to' : 'publish to'} <Mono>{c.topic}</Mono>. Allow it, or give the canary a topic this client may use.
        </Banner>
      )}
      <KeyValue
        columns={2}
        items={[
          ['Success rate', c.successRate === null ? 'n/a' : `${Math.round(c.successRate * 100)}% of the last ${c.window}`],
          ['Last success', c.sinceLastSuccessMs === null ? 'never' : sinceWord(c.sinceLastSuccessMs)],
          ['Latency p50', ms(c.p50Ms)],
          ['Latency p95', ms(c.p95Ms)],
          ['Probes sent', c.sent.toLocaleString()],
          ['Every', `${c.intervalSec} s, QoS ${c.qos}`],
          ['Topic', <Mono key="t" title={c.topic}>{c.topic}</Mono>],
          ['Slow above', ms(c.slowMs)]
        ]}
      />
      {c.lastError && c.state !== 'ok' && (
        <p className="text-xs text-subtle">
          Last problem: <span className="mono">{c.lastError}</span>
        </p>
      )}
      <p className="text-xs text-subtle">
        The probe is a small message that is never retained. Manifold keeps it out of the topic tree, the UNS, recordings, pipelines and mappings.
      </p>
    </div>
  );
}

function PostureBody({ query }) {
  const { data: p, error, loading } = query;
  if (loading && !p) return <LoadingState label="security assessment" rows={3} />;
  if (error && !p) return <Banner variant="error" title="Could not load the assessment">{error.message}</Banner>;
  if (!p) return null;
  const f = p.facts;
  return (
    <div className="space-y-3">
      <p className="text-xs text-subtle">Built from the connection settings and the live session. Nothing is probed and nothing is sent to the broker.</p>
      <KeyValue
        columns={2}
        items={[
          ['Transport', f.transport],
          f.certificateVerified !== null && ['Certificate check', f.certificateVerified ? 'On' : 'Off'],
          f.transport === 'TLS' && ['Certificate expires', certText(f)],
          ['Authentication', f.authentication],
          ['Protocol', f.mqttVersion],
          ['Subscribed to', <Mono key="s">{f.subscription}</Mono>],
          ['$SYS readable', f.sysReadable ? 'Yes' : 'No']
        ]}
      />
      {p.findings.length === 0 ? (
        <p className="text-sm text-muted" data-testid="posture-clean">
          No findings.
        </p>
      ) : (
        <ol className="divide-y divide-line rounded-lg border border-line" aria-label="Security findings, worst first">
          {p.findings.map((x) => (
            <li key={x.id} className="space-y-1 px-3 py-2.5 text-sm" data-testid={`finding-${x.id}`} data-severity={x.severity}>
              <p className="flex flex-wrap items-center gap-x-2">
                <StatusText tone={severityTone(x.severity)} className="text-xs font-medium">
                  {SEVERITY_WORD[x.severity]}
                </StatusText>
                <span className="font-medium text-fg">{x.title}</span>
              </p>
              <p className="text-muted">{x.detail}</p>
              <p className="text-fg">
                <span className="text-muted">What to change: </span>
                {x.fix}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function certText(f) {
  if (f.certificateDaysLeft === null) return 'Not available on this transport';
  if (f.certificateDaysLeft < 0) return <span>Expired {-f.certificateDaysLeft} days ago</span>;
  return (
    <span>
      in {f.certificateDaysLeft} days{f.certificateValidTo ? <span className="text-subtle"> ({new Date(f.certificateValidTo).toLocaleDateString()})</span> : null}
    </span>
  );
}
