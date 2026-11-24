/**
 * Read-only selector hooks over the existing store. Each returns an object via
 * zustand's shallow equality, so a component re-renders only when one of the
 * picked fields actually changes (not on every store update, and never on the
 * high-frequency `dataTick` unless it asks for it).
 */
import { useShallow } from 'zustand/react/shallow';
import { useStore } from './store';

/** Graph view preferences + setters shared by the Topics toolbar and renderers. */
export const useGraphPrefs = () =>
  useStore(
    useShallow((s) => ({
      graphStyle: s.graphStyle,
      graphLayout: s.graphLayout,
      setGraphStyle: s.setGraphStyle,
      setGraphLayout: s.setGraphLayout,
      flowEnabled: s.flowEnabled,
      setFlowEnabled: s.setFlowEnabled,
      activitySize: s.activitySize,
      setActivitySize: s.setActivitySize,
      showValues: s.showValues,
      setShowValues: s.setShowValues,
      showMinimap: s.showMinimap,
      setShowMinimap: s.setShowMinimap
    }))
  );

/** Cross-view coverage paint (Flows -> Topics). */
export const useCoverage = () =>
  useStore(useShallow((s) => ({ coverage: s.coverage, setCoverage: s.setCoverage })));

/** Connections as seen by Overview. */
export const useConnections = () => useStore(useShallow((s) => ({ brokers: s.brokers, opcua: s.opcua })));

/**
 * The throttled data tick, as its own subscription so a component can opt in
 * (`const tick = useDataTick(active)`). Pass `active=false` for a hidden page:
 * it then reads a constant and never re-renders on ticks.
 */
export const useDataTick = (active = true) => useStore((s) => (active ? s.dataTick : 0));

/** Per-broker structure version (bumps only when the topic SET changes). */
export const useTopicVersion = (brokerId) => useStore((s) => s.topicVersion[brokerId] || 0);

/** Sum of the structure versions of several brokers (changes when any set changes). */
export const useTopicVersionSum = (brokerIds) =>
  useStore((s) => brokerIds.reduce((n, id) => n + (s.topicVersion[id] || 0), 0));
