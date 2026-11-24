import { useState } from 'react';
import { Workflow, Boxes, Database, CircleDot, FileCheck2 } from 'lucide-react';
import { useStore } from '@/store/store';
import PageHeader from '@/components/PageHeader';
import ViewTab from '@/components/ViewTab';
import { Banner, HelpButton, PageBody } from '@/components/ui';
import PipelinesHelp from './pipelines/PipelinesHelp';
import RoutesTab from './pipelines/RoutesTab';
import ModelsTab from './pipelines/ModelsTab';
import HistoriansTab from './pipelines/HistoriansTab';
import RecorderTab from './pipelines/RecorderTab';
import ContractsTab from './pipelines/ContractsTab';

/**
 * Pipelines — Manifold's DataOps surface. Five tabs over the same live stream:
 *   Routes      source → transforms → target, with trie-backed dry-run
 *   Models      multi-source attributes merged into one object at a UNS path
 *   Historians  InfluxDB / Timebase / TimescaleDB connections pipelines+recorder write into
 *   Recorder    time-series capture to disk or a historian, plus replay
 *   Contracts   locked payload schemas with drift violations
 * Each tab lives in pages/pipelines/.
 */
export default function Pipelines() {
  const [tab, setTab] = useState('routes');
  const allBrokers = useStore((s) => s.brokers);
  const brokers = allBrokers.filter((b) => b.status === 'connected');

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Pipelines"
        subtitle="Route, reshape, contextualize, and record the live stream"
        actions={
          <>
            <div role="group" aria-label="Pipeline sections" className="flex max-w-full overflow-x-auto rounded-xl border border-white/10">
              <ViewTab active={tab === 'routes'} onClick={() => setTab('routes')} icon={Workflow} label="Routes" />
              <ViewTab active={tab === 'models'} onClick={() => setTab('models')} icon={Boxes} label="Models" />
              <ViewTab active={tab === 'historians'} onClick={() => setTab('historians')} icon={Database} label="Historians" />
              <ViewTab active={tab === 'recorder'} onClick={() => setTab('recorder')} icon={CircleDot} label="Recorder" />
              <ViewTab active={tab === 'contracts'} onClick={() => setTab('contracts')} icon={FileCheck2} label="Contracts" />
            </div>
            <HelpButton title="How Pipelines work">
              <PipelinesHelp />
            </HelpButton>
          </>
        }
      />
      <PageBody>
        {brokers.length === 0 && (
          <Banner variant="warn" title="No connected brokers">
            Sources and targets need at least one live MQTT connection. Connect one on the MQTT Brokers page.
          </Banner>
        )}
        {tab === 'routes' && <RoutesTab brokers={brokers} />}
        {tab === 'models' && <ModelsTab brokers={brokers} />}
        {tab === 'historians' && <HistoriansTab />}
        {tab === 'recorder' && <RecorderTab brokers={brokers} />}
        {tab === 'contracts' && <ContractsTab brokers={brokers} />}
      </PageBody>
    </div>
  );
}
