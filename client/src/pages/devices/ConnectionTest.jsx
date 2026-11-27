import { useState } from 'react';
import { Plug } from 'lucide-react';
import { api } from '@/lib/api';
import { Button, Banner, KeyValue } from '@/components/ui';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import { infoLabel } from './model';

/** The device's self-description as [label, value] pairs (scalars only). */
function infoItems(info) {
  if (!info) return [];
  if (typeof info === 'string') return [['Device', info]];
  return Object.entries(info)
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'object')
    .map(([k, v]) => [infoLabel(k), String(v)]);
}

/** "Test connection": a one-off connect with the unsaved configuration, and a result panel. */
export default function ConnectionTest({ buildConfig, disabled }) {
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(null);
  const readOnly = useReadOnly();
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
  const items = test?.ok ? infoItems(test.info) : [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span title={readOnly ? READ_ONLY_REASON : undefined}>
          <Button type="button" variant="secondary" onClick={run} loading={testing} disabled={disabled || readOnly}>
            <Plug size={14} aria-hidden="true" /> Test connection
          </Button>
        </span>
        <span className="helper">Opens one connection with these settings. Nothing is saved.</span>
      </div>
      <div aria-live="polite">
        {test?.ok && (
          <Banner variant="success" title={`Connected${test.latencyMs !== undefined ? ` in ${test.latencyMs} ms` : ''}`}>
            {items.length > 0 ? <KeyValue columns={2} items={items} className="mt-2 text-xs" /> : 'The device answered.'}
          </Banner>
        )}
        {test && !test.ok && (
          <Banner variant="error" title="Could not connect">
            <span className="mono break-words text-xs">{test.error || 'Connection failed'}</span>
          </Banner>
        )}
      </div>
    </div>
  );
}
