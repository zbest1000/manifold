import { useSearchParams } from 'react-router-dom';
import { useStore } from '@/store/store';
import PageHeader from '@/components/PageHeader';
import ReadOnlyNote from '@/components/ReadOnlyNote';
import { Banner, HelpButton, PageBody, TabPanel, Tabs } from '@/components/ui';
import PipelinesHelp from './pipelines/PipelinesHelp';
import RoutesTab from './pipelines/RoutesTab';
import ModelsTab from './pipelines/ModelsTab';
import HistoriansTab from './pipelines/HistoriansTab';
import RecorderTab from './pipelines/RecorderTab';
import ContractsTab from './pipelines/ContractsTab';
import CodecsTab from './pipelines/CodecsTab';

/**
 * Pipelines: the DataOps surface. Six tabs over the same live stream, each a list page with one
 * primary action and a form dialog:
 *   Routes      source → transform chain → target, with a dry run
 *   Models      several raw topics merged into one object at a UNS path
 *   Historians  time-series databases that routes and recordings write into
 *   Recorder    capture to a file or a historian, with replay
 *   Contracts   locked payload shapes, with drift
 *   Codecs      decode CBOR, MessagePack, SenML, Protobuf and Avro payloads on ingest
 * Each tab lives in pages/pipelines/.
 */
const TABS = [
  { id: 'routes', label: 'Routes' },
  { id: 'models', label: 'Models' },
  { id: 'historians', label: 'Historians' },
  { id: 'recorder', label: 'Recorder' },
  { id: 'contracts', label: 'Contracts' },
  { id: 'codecs', label: 'Codecs' }
];
const IDS = TABS.map((t) => t.id);

export default function Pipelines() {
  // The tab lives in the URL (?tab=historians) so a refresh, back/forward and shared links keep it.
  const [params, setParams] = useSearchParams();
  const tab = IDS.includes(params.get('tab')) ? params.get('tab') : 'routes';
  const setTab = (t) => setParams(t === 'routes' ? {} : { tab: t }, { replace: true });
  const allBrokers = useStore((s) => s.brokers);
  const brokers = allBrokers.filter((b) => b.status === 'connected');

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Pipelines"
        subtitle="Route, reshape and record the live message stream"
        actions={
          <HelpButton title="How Pipelines work">
            <PipelinesHelp />
          </HelpButton>
        }
      />
      <div className="shrink-0 px-4 pt-2 sm:px-6">
        <Tabs tabs={TABS} value={tab} onChange={setTab} label="Pipeline sections" idPrefix="pipelines" />
      </div>
      <PageBody>
        <ReadOnlyNote className="" />
        {brokers.length === 0 && (
          <Banner variant="warn" title="No connected brokers">
            Sources and targets need at least one live MQTT connection. Connect one on the MQTT Brokers page.
          </Banner>
        )}
        <TabPanel idPrefix="pipelines" id={tab} className="space-y-4">
          {tab === 'routes' && <RoutesTab brokers={brokers} />}
          {tab === 'models' && <ModelsTab brokers={brokers} />}
          {tab === 'historians' && <HistoriansTab />}
          {tab === 'recorder' && <RecorderTab brokers={brokers} />}
          {tab === 'contracts' && <ContractsTab brokers={brokers} />}
          {tab === 'codecs' && <CodecsTab brokers={brokers} />}
        </TabPanel>
      </PageBody>
    </div>
  );
}
