import { useCallback, useEffect, useState } from 'react';
import { fetchSchema, fetchDevices, fetchHistorians, suggestMapping } from '../tagsApi';

/**
 * Everything the mapping editor loads besides the page state: the option schema, the devices
 * (effective tag definitions, profile instances), suggestions and historians. Each part has its
 * own status so a failure shows where it matters, with a retry.
 *   part = { status: 'loading' | 'ok' | 'error' | 'off', data, error }
 */
export function useEditorData({ srcType, deviceId = null, profileId = null, opcuaTags = null, mqttFilter = null }) {
  const [schema, setSchema] = useState({ status: 'loading', data: null, error: null });
  const [devices, setDevices] = useState({ status: srcType === 'device' || srcType === 'device-profile' ? 'loading' : 'off', data: null, error: null });
  const [hist, setHist] = useState({ status: 'loading', data: [], error: null });
  const [suggest, setSuggest] = useState({ status: 'loading', data: null, error: null });

  // Promise chains (not async/await) keep every setState inside a callback.
  const loadSchema = useCallback(
    () =>
      fetchSchema().then(
        (data) => setSchema({ status: 'ok', data, error: null }),
        (e) => setSchema({ status: 'error', data: null, error: e.message })
      ),
    []
  );
  const loadDevices = useCallback(
    () =>
      fetchDevices().then(
        (data) => setDevices({ status: 'ok', data, error: null }),
        (e) => setDevices({ status: 'error', data: null, error: e.message })
      ),
    []
  );
  const loadHist = useCallback(
    () =>
      fetchHistorians().then(
        (data) => setHist({ status: 'ok', data, error: null }),
        (e) => setHist({ status: 'error', data: [], error: e.message })
      ),
    []
  );
  const suggestKey = JSON.stringify(
    srcType === 'device'
      ? { type: 'device', deviceId }
      : srcType === 'device-profile'
        ? { type: 'device-profile', profileId }
        : srcType === 'opcua' && opcuaTags?.length
          ? { type: 'opcua', tags: opcuaTags }
          : mqttFilter?.filter
            ? { type: 'mqtt', brokerId: mqttFilter.brokerId, tags: 'all', filter: mqttFilter.filter }
            : null
  );
  const suggestOff = (() => {
    const s = JSON.parse(suggestKey);
    return !s || (s.type === 'device-profile' && !s.profileId);
  })();
  const loadSuggest = useCallback(() => {
    const source = JSON.parse(suggestKey);
    if (!source || (source.type === 'device-profile' && !source.profileId)) return Promise.resolve();
    return suggestMapping(source).then(
      (data) => setSuggest({ status: 'ok', data, error: null }),
      (e) => setSuggest({ status: 'error', data: null, error: e.message })
    );
  }, [suggestKey]);

  useEffect(() => {
    loadSchema();
  }, [loadSchema]);
  useEffect(() => {
    if (srcType === 'device' || srcType === 'device-profile') loadDevices();
  }, [srcType, loadDevices]);
  useEffect(() => {
    loadHist();
  }, [loadHist]);
  // A typed MQTT filter is asked for once typing pauses.
  const debounceMs = srcType === 'mqtt' ? 300 : 0;
  useEffect(() => {
    const t = setTimeout(loadSuggest, debounceMs);
    return () => clearTimeout(t);
  }, [loadSuggest, debounceMs]);

  return {
    schema: { ...schema, retry: loadSchema },
    devices: { ...devices, retry: loadDevices },
    historians: { ...hist, retry: loadHist },
    suggest: suggestOff ? { status: 'off', data: null, error: null, retry: loadSuggest } : { ...suggest, retry: loadSuggest }
  };
}

/** The tag definitions of the mapping's source: the device's effective tags or the profile's tags (null while unknown). */
export function tagDefsFor({ srcType, deviceId, profile, devices }) {
  if (srcType === 'device-profile') return profile ? profile.tags || [] : null;
  if (srcType === 'device') {
    if (!devices) return null;
    const d = devices.find((x) => x.id === deviceId);
    return d ? d.tags || [] : [];
  }
  return null;
}
