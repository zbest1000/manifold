import { useCallback, useEffect, useState } from 'react';
import { fetchHistorians, fetchDevices, fetchDeviceTags } from './tagsApi';

/** Loads what the wizard needs beyond the Tags page state; every failure is surfaced with a retry. */
export function useWizardData({ srcType, editing }) {
  const [hist, setHist] = useState({ list: [], loaded: false, error: null });
  const [devices, setDevices] = useState({ list: null, error: null });
  const [meta, setMeta] = useState({ map: null, error: null }); // editing a device binding: address -> node meta

  const loadHist = useCallback(async () => {
    try {
      setHist({ list: await fetchHistorians(), loaded: true, error: null });
    } catch (e) {
      setHist({ list: [], loaded: true, error: e.message });
    }
  }, []);
  const loadDevices = useCallback(async () => {
    try {
      setDevices({ list: await fetchDevices(), error: null });
    } catch (e) {
      setDevices({ list: null, error: e.message });
    }
  }, []);
  const deviceId = editing && srcType === 'device' ? editing.source.deviceId : null;
  const loadMeta = useCallback(async () => {
    if (!deviceId) return;
    try {
      const nodes = await fetchDeviceTags(deviceId);
      setMeta({ map: Object.fromEntries(nodes.map((n) => [n.address, n.meta || {}])), error: null });
    } catch (e) {
      setMeta({ map: null, error: e.message });
    }
  }, [deviceId]);

  useEffect(() => {
    if (srcType !== 'mqtt') loadHist();
  }, [srcType, loadHist]);
  useEffect(() => {
    if (srcType === 'device-profile') loadDevices();
  }, [srcType, loadDevices]);
  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  return { hist: { historians: hist.list, loaded: hist.loaded, error: hist.error, onRetry: loadHist }, devices, loadDevices, meta, loadMeta };
}
