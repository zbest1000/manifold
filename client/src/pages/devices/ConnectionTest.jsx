import { useState } from 'react';
import { Plug, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';

function infoText(info) {
  if (!info) return '';
  if (typeof info === 'string') return info;
  return Object.entries(info)
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'object')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' · ');
}

/** "Test connection": a one-off connect with the unsaved configuration. */
export default function ConnectionTest({ buildConfig, disabled }) {
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(null);
  const run = async () => {
    setTesting(true);
    setTest(null);
    try {
      const { tags: _tags, ...cfg } = buildConfig();
      setTest(await api.testDevice(cfg));
    } catch (e) {
      setTest({ ok: false, error: e.message || 'Test request failed' });
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" variant="outline" onClick={run} disabled={testing || disabled}>
        {testing ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />} Test connection
      </Button>
      <div aria-live="polite" className="min-w-0 text-xs">
        {test?.ok && (
          <span className="inline-flex items-start gap-1.5 text-emerald-300">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
            <span>
              Connected{test.latencyMs !== undefined ? ` in ${test.latencyMs} ms` : ''}
              {test.info ? <span className="text-slate-400"> · {infoText(test.info)}</span> : null}
            </span>
          </span>
        )}
        {test && !test.ok && (
          <span className="inline-flex items-start gap-1.5 text-rose-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> <span className="break-words">{test.error || 'Connection failed'}</span>
          </span>
        )}
      </div>
    </div>
  );
}
