import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Banner, ButtonLink, PageBody, TabPanel, Tabs } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import ReadOnlyNote from '@/components/ReadOnlyNote';
import Session from './settings/Session';
import { ThemeSection, GraphSection } from './settings/Appearance';
import { McpSection, AboutSection } from './settings/Integrations';
import AlertRules from './settings/AlertRules';
import Configuration from './settings/Configuration';
import AuditTrail from './settings/AuditTrail';
import { ruleStates } from './settings/helpers';

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'alerts', label: 'Alert rules' },
  { id: 'configuration', label: 'Configuration' },
  { id: 'audit', label: 'Audit trail' }
];
const IDS = TABS.map((t) => t.id);

/** Tells the General tab's reader when alerts are firing, since the rules live on their own tab. */
function FiringNotice() {
  const { data } = usePolled(async () => {
    const [r, e] = await Promise.all([api.listAlertRules(), api.alertEvents(200)]);
    return { rules: r.rules || [], events: e.events || [] };
  });
  const firing = useMemo(() => {
    if (!data) return 0;
    const states = ruleStates(data.rules, data.events);
    return data.rules.filter((r) => states[r.id]?.key === 'firing').length;
  }, [data]);
  if (!firing) return null;
  return (
    <Banner
      variant="error"
      title={`${firing} alert ${firing === 1 ? 'rule is' : 'rules are'} firing`}
      className="mb-4"
      action={
        <ButtonLink to="/settings?tab=alerts" size="sm" variant="secondary">
          View alert rules
        </ButtonLink>
      }
    />
  );
}

export default function Settings() {
  // The tab lives in the URL (?tab=alerts) so a refresh, back/forward and shared links keep it.
  const [params, setParams] = useSearchParams();
  const tab = IDS.includes(params.get('tab')) ? params.get('tab') : 'general';
  const setTab = (t) => setParams(t === 'general' ? {} : { tab: t }, { replace: true });

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Settings" subtitle="Session, appearance, alert rules and configuration" />
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
              <McpSection />
              <AboutSection />
            </>
          )}
          {tab === 'alerts' && <AlertRules />}
          {tab === 'configuration' && <Configuration />}
          {tab === 'audit' && <AuditTrail />}
        </TabPanel>
      </PageBody>
    </div>
  );
}
