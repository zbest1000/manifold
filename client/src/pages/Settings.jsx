import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Palette, Terminal, Info, Check, BellRing, FileDown, FileUp, ScrollText, ArrowRight } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '@/store/store';
import { api } from '@/lib/api';
import { STYLE_LIST, LAYOUT_LIST } from '@/graph/graphStyles';
import { Card, Badge, Button } from '@/components/ui';
import PageHeader from '@/components/PageHeader';

const MCP_SNIPPET = `{
  "mcpServers": {
    "manifold": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/index.js"],
      "env": { "MANIFOLD_API_URL": "http://localhost:5000" }
    }
  }
}`;

export default function Settings() {
  const { graphStyle, graphLayout, setGraphStyle, setGraphLayout, connected } = useStore();

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Settings" subtitle="Graph appearance and integrations" />

      <div className="flex-1 space-y-6 overflow-y-auto p-6">
        <Card className="p-5">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Palette size={16} className="text-accent-400" /> Default graph style
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {STYLE_LIST.map((s) => (
              <button
                key={s.id}
                onClick={() => setGraphStyle(s.id)}
                className={clsx(
                  'group overflow-hidden rounded-xl border text-left transition',
                  s.id === graphStyle ? 'border-accent-500/70 ring-1 ring-accent-500/40' : 'border-white/10 hover:border-white/25'
                )}
              >
                <div className="h-16" style={{ background: s.background }}>
                  <svg viewBox="0 0 120 64" className="h-full w-full">
                    <line x1="30" y1="40" x2="60" y2="22" stroke={s.link.color} />
                    <line x1="60" y1="22" x2="90" y2="40" stroke={s.link.color} />
                    <line x1="60" y1="22" x2="60" y2="50" stroke={s.link.color} />
                    <circle cx="30" cy="40" r="5" fill={s.palette[0]} stroke={s.node.stroke} strokeWidth={s.node.strokeWidth || 0} />
                    <circle cx="60" cy="22" r="8" fill={s.palette[1] || s.palette[0]} stroke={s.node.stroke} strokeWidth={s.node.strokeWidth || 0} />
                    <circle cx="90" cy="40" r="5" fill={s.palette[2] || s.palette[0]} stroke={s.node.stroke} strokeWidth={s.node.strokeWidth || 0} />
                    <circle cx="60" cy="50" r="4" fill={s.palette[3] || s.palette[0]} stroke={s.node.stroke} strokeWidth={s.node.strokeWidth || 0} />
                  </svg>
                </div>
                <div className="flex items-center justify-between px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-slate-200">{s.name}</p>
                    <p className="text-[11px] text-slate-500">{s.description}</p>
                  </div>
                  {s.id === graphStyle && <Check size={15} className="shrink-0 text-accent-400" />}
                </div>
              </button>
            ))}
          </div>

          <h3 className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wide text-slate-400">Layout</h3>
          <div className="flex flex-wrap gap-2">
            {LAYOUT_LIST.map((l) => (
              <button
                key={l.id}
                onClick={() => setGraphLayout(l.id)}
                className={clsx(
                  'rounded-lg border px-3 py-1.5 text-sm font-medium transition',
                  l.id === graphLayout ? 'border-accent-500/70 bg-accent-500/10 text-accent-300' : 'border-white/10 text-slate-300 hover:border-white/25'
                )}
              >
                {l.name}
              </button>
            ))}
          </div>
        </Card>

        {/* Alert rules grew into their own page — keep a signpost here since
            Settings is where users found them for several releases. */}
        <Card className="p-5">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-200">
            <BellRing size={16} className="text-accent-400" /> Alert rules
          </h2>
          <p className="mb-3 text-sm text-slate-400">
            Alerting moved to its own page: active alarms, rule management, and the firing history now live under{' '}
            <b>Observe → Alerts</b>.
          </p>
          <Link
            to="/alerts"
            className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 px-3.5 py-2 text-sm font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/5"
          >
            Open Alerts <ArrowRight size={14} />
          </Link>
        </Card>

        <ConfigCard />

        <AuditCard />

        <Card className="p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Terminal size={16} className="text-accent-400" /> MCP integration
          </h2>
          <p className="mb-3 text-sm text-slate-400">
            Manifold ships an MCP server so AI assistants and agents can discover brokers, browse topics,
            read payloads, and walk OPC UA address spaces through the same backend. Add this to your MCP client
            config:
          </p>
          <pre className="mono overflow-x-auto rounded-xl border border-white/10 bg-surface-950/70 p-4 text-xs leading-relaxed text-slate-300">
            {MCP_SNIPPET}
          </pre>
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Info size={16} className="text-accent-400" /> System
          </h2>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Realtime link</span>
              <Badge status={connected ? 'connected' : 'disconnected'}>{connected ? 'connected' : 'offline'}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Client</span>
              <span className="mono text-slate-300">Manifold 2.0</span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

// Config as code: the whole DataOps configuration (routes, models, historians,
// recordings, contracts, bindings, mounts, alert rules) as one reviewable JSON
// file. Secrets are stripped on export and preserved server-side on re-import.
function ConfigCard() {
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);

  const doExport = async () => {
    try {
      const cfg = await api.exportConfig();
      const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'manifold-config.json';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      // pushLog captured it
    }
  };

  const doImport = async (file) => {
    // Import merges into the live config by id (overwriting existing entries) —
    // confirm before mutating a running instance's DataOps setup.
    let cfg;
    try {
      cfg = JSON.parse(await file.text());
    } catch (e) {
      setResult({ error: `Not valid JSON: ${e.message}` });
      return;
    }
    const counts = ['historians', 'pipelines', 'models', 'recordings', 'contracts', 'bindings', 'alertRules', 'mounts']
      .map((k) => (Array.isArray(cfg[k]) && cfg[k].length ? `${cfg[k].length} ${k}` : null))
      .filter(Boolean)
      .join(', ');
    if (!window.confirm(`Import this configuration?\n\n${counts || 'No recognizable items found'}.\n\nEntries with matching ids will be OVERWRITTEN in the running instance. This cannot be undone.`)) {
      return;
    }
    setImporting(true);
    setResult(null);
    try {
      const res = await api.importConfig(cfg);
      setResult(res.imported);
    } catch (e) {
      setResult({ error: e.message });
    } finally {
      setImporting(false);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
        <FileDown size={16} className="text-accent-400" /> Configuration as code
      </h2>
      <p className="mb-3 text-sm text-slate-400">
        Export pipelines, models, historians, recordings, contracts, tag bindings, mounts, and alert rules as one JSON
        file — reviewable in git, promotable between environments. Credentials are never exported; stored secrets
        survive a re-import.
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={doExport}>
          <FileDown size={14} className="mr-1" /> Export config
        </Button>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 px-3.5 py-2 text-sm text-slate-200 hover:bg-white/5">
          <FileUp size={14} /> {importing ? 'Importing…' : 'Import config'}
          <input type="file" accept=".json" className="hidden" onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])} />
        </label>
      </div>
      {result && (
        <p className={clsx('mt-2 text-xs', result.error ? 'text-rose-300' : 'text-emerald-300')}>
          {result.error || `Imported: ${Object.entries(result).map(([k, v]) => `${k} ${v}`).join(', ')}`}
        </p>
      )}
    </Card>
  );
}

// Audit trail: every mutating action against the control plane, newest first.
function AuditCard() {
  const [events, setEvents] = useState([]);
  useEffect(() => {
    const load = () => api.auditRecent(50).then((r) => setEvents(r.events)).catch(() => {});
    load();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 10_000);
    return () => clearInterval(t);
  }, []);
  return (
    <Card className="p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
        <ScrollText size={16} className="text-accent-400" /> Audit trail
      </h2>
      <p className="mb-3 text-sm text-slate-400">
        Who changed what: every mutating API call and control socket event, with role and outcome. Persisted to
        <span className="mono"> data/audit.jsonl</span>; secrets are redacted before logging.
      </p>
      {events.length === 0 && <p className="text-xs text-slate-500">No mutating actions recorded yet.</p>}
      <div className="max-h-56 space-y-0.5 overflow-y-auto font-mono text-[11px]">
        {events.map((e, i) => (
          <div key={i} className="flex items-baseline gap-2 rounded bg-black/20 px-2 py-1">
            <span className="shrink-0 text-slate-500">{new Date(e.ts).toLocaleTimeString()}</span>
            <span className={clsx('shrink-0', e.status >= 400 ? 'text-rose-300' : 'text-emerald-300')}>{e.status || e.method}</span>
            <span className="shrink-0 text-sky-300">{e.role}</span>
            <span className="min-w-0 truncate text-slate-300">
              {e.method} {e.path}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

