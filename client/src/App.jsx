import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import { PageSkeleton } from './components/ui';

// Route-level code splitting: every page loads on first visit, so the main
// bundle only carries the shell (router, layout, store, shared primitives).
const Overview = lazy(() => import('./pages/Overview'));
const TopicGraph = lazy(() => import('./pages/TopicGraph'));
const Uns = lazy(() => import('./pages/Uns'));
const Flows = lazy(() => import('./pages/Flows'));
const Trends = lazy(() => import('./pages/Trends'));
const Alerts = lazy(() => import('./pages/Alerts'));
const Pipelines = lazy(() => import('./pages/Pipelines'));
const Tags = lazy(() => import('./pages/Tags'));
const Brokers = lazy(() => import('./pages/Brokers'));
const Devices = lazy(() => import('./pages/Devices'));
const OpcUa = lazy(() => import('./pages/OpcUa'));
const Cesmii = lazy(() => import('./pages/Cesmii'));
const I3x = lazy(() => import('./pages/I3x'));
const Discovery = lazy(() => import('./pages/Discovery'));
const System = lazy(() => import('./pages/System'));
const Settings = lazy(() => import('./pages/Settings'));

// Internal, unlinked benchmark/verification page for the big-graph renderers.
const Bench = lazy(() => import('./pages/Bench'));

const S = ({ children }) => <Suspense fallback={<PageSkeleton />}>{children}</Suspense>;

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<S><Overview /></S>} />
        <Route path="topics" element={<S><TopicGraph /></S>} />
        <Route path="uns" element={<S><Uns /></S>} />
        <Route path="flows" element={<S><Flows /></S>} />
        <Route path="trends" element={<S><Trends /></S>} />
        <Route path="alerts" element={<S><Alerts /></S>} />
        <Route path="pipelines" element={<S><Pipelines /></S>} />
        <Route path="tags" element={<S><Tags /></S>} />
        <Route path="brokers" element={<S><Brokers /></S>} />
        <Route path="devices" element={<S><Devices /></S>} />
        <Route path="opcua" element={<S><OpcUa /></S>} />
        <Route path="cesmii" element={<S><Cesmii /></S>} />
        <Route path="i3x" element={<S><I3x /></S>} />
        <Route path="discovery" element={<S><Discovery /></S>} />
        <Route path="system" element={<S><System /></S>} />
        <Route path="settings" element={<S><Settings /></S>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
      {import.meta.env.DEV && (
        // Internal renderer benchmark harness — dev builds only.
        <Route
          path="/bench"
          element={
            <Suspense fallback={<PageSkeleton />}>
              <Bench />
            </Suspense>
          }
        />
      )}
    </Routes>
  );
}
