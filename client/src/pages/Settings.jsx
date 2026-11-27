import { Navigate, useSearchParams } from 'react-router-dom';
import { useActiveAlarms } from '@/lib/useActiveAlarms';
import { Banner, ButtonLink, PageBody, TabPanel, Tabs } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import ReadOnlyNote from '@/components/ReadOnlyNote';
import Session from './settings/Session';
import { ThemeSection, GraphSection } from './settings/Appearance';
import { McpSection, AboutSection } from './settings/Integrations';
import Configuration from './settings/Configuration';
import AuditTrail from './settings/AuditTrail';
import Section from './settings/Section';

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'configuration', label: 'Configuration' },
  { id: 'audit', label: 'Audit trail' }
];
const IDS = TABS.map((t) => t.id);

/** Tells the General tab's reader when alarms are firing unacknowledged, with the way to them. */
function FiringNotice() {
  const { data } = useActiveAlarms({ interval: 30_000 });
  const n = data?.counts?.unacknowledged || 0;
  if (!n) return null;
  return (
    <Banner
      variant="error"
      title={`${n} ${n === 1 ? 'alarm is' : 'alarms are'} firing unacknowledged`}
      className="mb-4"
      action={
        <ButtonLink to="/alerts" size="sm" variant="secondary">
          View alarms
        </ButtonLink>
      }
    />
  );
}

/** Alert rules moved to the Alerts page; this keeps the old place findable. */
function AlertsSection() {
  return (
    <Section title="Alert rules" description="Rules, active alarms and their history are on the Alerts page.">
      <ButtonLink to="/alerts?tab=rules" variant="secondary">
        Open alert rules
      </ButtonLink>
    </Section>
  );
}

export default function Settings() {
  // The tab lives in the URL (?tab=audit) so a refresh, back/forward and shared links keep it.
  const [params, setParams] = useSearchParams();
  // Old links and bookmarks to the alert rules tab land on the Alerts page.
  if (params.get('tab') === 'alerts') return <Navigate to="/alerts?tab=rules" replace />;
  const tab = IDS.includes(params.get('tab')) ? params.get('tab') : 'general';
  const setTab = (t) => setParams(t === 'general' ? {} : { tab: t }, { replace: true });

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Settings" subtitle="Session, appearance, configuration and audit trail" />
      <div className="shrink-0 px-4 pt-2 sm:px-6">
        <Tabs tabs={TABS} value={tab} onChange={setTab} label="Settings sections" idPrefix="settings" />
      </div>
      <PageBody>
        <ReadOnlyNote className="" />
        <TabPanel idPrefix="settings" id={tab}>
          {tab === 'general' && (
            <>
              <FiringNotice />
              <Session />
              <ThemeSection />
              <GraphSection />
              <AlertsSection />
              <McpSection />
              <AboutSection />
            </>
          )}
          {tab === 'configuration' && <Configuration />}
          {tab === 'audit' && <AuditTrail />}
        </TabPanel>
      </PageBody>
    </div>
  );
}
