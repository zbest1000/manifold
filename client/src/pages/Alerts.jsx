import { useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { useActiveAlarms } from '@/lib/useActiveAlarms';
import { PageBody, TabPanel, Tabs } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import ReadOnlyNote from '@/components/ReadOnlyNote';
import ActiveAlarms from './alerts/ActiveAlarms';
import AlarmHistory from './alerts/AlarmHistory';
import AlertRules from './alerts/AlertRules';

const IDS = ['active', 'history', 'rules'];

/**
 * Alerts: the one place for alarms. Active (what is firing now, acknowledge), History (every firing,
 * resolution and acknowledgement, kept across restarts, CSV export) and Rules (what to watch).
 * The tab lives in the URL (?tab=history); ?alarm=<id> opens Active with that alarm highlighted.
 */
export default function Alerts() {
  const [params, setParams] = useSearchParams();
  const tab = IDS.includes(params.get('tab')) ? params.get('tab') : 'active';
  const highlight = params.get('alarm');
  const active = useActiveAlarms();
  // Rule names for the history filter and the tab count (the Rules tab loads its own, richer copy).
  const rulesQ = usePolled(() => api.listAlertRules(), { interval: 15_000 });
  const setTab = (t) => {
    setParams(t === 'active' ? {} : { tab: t }, { replace: true });
    rulesQ.reload(); // rules added or removed on the Rules tab show up in the count and the filter at once
  };
  const counts = active.data?.counts;
  const activeCount = counts ? counts.firing + counts.breached : null;

  const tabs = [
    { id: 'active', label: 'Active', count: activeCount },
    { id: 'history', label: 'History' },
    { id: 'rules', label: 'Rules', count: rulesQ.data ? rulesQ.data.rules.length : null }
  ];

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Alerts" subtitle="Active alarms, their history, and the rules that raise them" />
      <div className="shrink-0 px-4 pt-2 sm:px-6">
        <Tabs tabs={tabs} value={tab} onChange={setTab} label="Alerts sections" idPrefix="alerts" />
      </div>
      <PageBody>
        <ReadOnlyNote className="" />
        <TabPanel idPrefix="alerts" id={tab}>
          {tab === 'active' && <ActiveAlarms q={active} highlight={highlight} onShowRules={() => setTab('rules')} />}
          {tab === 'history' && <AlarmHistory rules={rulesQ.data?.rules || []} />}
          {tab === 'rules' && <AlertRules onChange={rulesQ.reload} />}
        </TabPanel>
      </PageBody>
    </div>
  );
}
