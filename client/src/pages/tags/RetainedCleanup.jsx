import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Dialog, Button, Banner, LoadingState, Table, THead, Th, Tr, Td, StatusText, Path } from '@/components/ui';
import { READ_ONLY_REASON } from '@/store/selectors';
import { cleanupRetained } from './tagsApi';

/**
 * "Clear orphaned retained topics": first a dry run that lists every retained topic a mapping
 * published and no mapping owns any more (only topics Manifold recorded as its own, never guessed
 * from the broker), then the clear on confirmation.
 */
export default function RetainedCleanup({ readOnly, onClose }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const load = useCallback(
    () =>
      cleanupRetained(true).then(
        (data) => setState({ status: 'ok', data, error: null }),
        (e) => setState({ status: 'error', data: null, error: e.message })
      ),
    []
  );
  useEffect(() => {
    load();
  }, [load]);

  const clear = async () => {
    setBusy(true);
    try {
      const r = await cleanupRetained(false);
      setResult(r);
      toast.success(`Cleared ${r.cleared} retained topic${r.cleared === 1 ? '' : 's'}`);
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const topics = state.data?.topics || [];
  const connected = topics.filter((t) => t.connected).length;
  return (
    <Dialog
      title="Clear orphaned retained topics"
      description="Retained topics a mapping published that no mapping owns any more: deleted or renamed mappings, retain switched off, edits made while the server was down."
      onClose={onClose}
      size="xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button variant="danger" onClick={clear} loading={busy} disabled={readOnly || !connected} title={readOnly ? READ_ONLY_REASON : !connected ? 'Nothing that can be cleared now' : undefined}>
            Clear {connected || ''} topic{connected === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      {state.status === 'loading' && <LoadingState label="retained topics" rows={3} />}
      {state.status === 'error' && (
        <Banner variant="error" title="Could not list retained topics" onRetry={load}>
          {state.error}
        </Banner>
      )}
      {result && (
        <Banner variant="success" title={`Cleared ${result.cleared} topic${result.cleared === 1 ? '' : 's'}`} className="mb-3">
          {result.waiting ? `${result.waiting} wait for their broker to connect and are cleared then.` : 'Every listed topic was cleared at the broker.'}
        </Banner>
      )}
      {state.status === 'ok' &&
        (topics.length === 0 ? (
          <p className="text-sm text-muted">Nothing to clear: every retained topic Manifold recorded belongs to a mapping.</p>
        ) : (
          <>
            <p className="mb-2 text-sm text-fg">
              {topics.length} topic{topics.length === 1 ? '' : 's'} would be cleared (an empty retained message, QoS 1).{state.data.overflow ? ` ${state.data.overflow} more were never recorded because the record was full.` : ''}
            </p>
            <Table caption="Orphaned retained topics (dry run)" className="min-w-[40rem]">
              <THead>
                <Th>Topic</Th>
                <Th>Broker</Th>
                <Th>Was published by</Th>
                <Th>Why it is orphaned</Th>
              </THead>
              <tbody>
                {topics.slice(0, 500).map((t) => (
                  <Tr key={`${t.brokerId} ${t.topic}`}>
                    <Td className="max-w-[18rem]">
                      <Path value={t.topic} />
                    </Td>
                    <Td className="whitespace-nowrap text-xs">
                      {t.brokerId}
                      {!t.connected && (
                        <StatusText tone="neutral" className="block text-2xs">
                          not connected: cleared later
                        </StatusText>
                      )}
                    </Td>
                    <Td className="text-xs">{t.bindingName || t.bindingId}</Td>
                    <Td className="text-xs text-muted">{t.reason}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </>
        ))}
    </Dialog>
  );
}
