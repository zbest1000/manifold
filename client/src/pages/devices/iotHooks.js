import { useEffect, useState } from 'react';
import { jsonRequest } from './devicesApi';
import { tagDefsFromIot } from './iotModel';

// Data hooks for IoT devices over MQTT. Read-only API: GET lists and one PUT for the detection config.

export const fetchIotBrokers = () => jsonRequest('/api/iot/brokers').then((d) => d.brokers || []);
export const fetchIotDevices = () => jsonRequest('/api/iot/devices').then((d) => d.devices || []);
export const fetchIotDevice = (brokerId, deviceId) => jsonRequest(`/api/iot/devices/${encodeURIComponent(brokerId)}/${encodeURIComponent(deviceId)}`).then((d) => d.device);
export const saveIotConfig = (brokerId, body) => jsonRequest(`/api/iot/brokers/${encodeURIComponent(brokerId)}`, { method: 'PUT', body });

/** Tag definitions of an IoT device for the mapping editor: null while loading, [] when unavailable. */
export function useIotTagDefs(ref) {
  const brokerId = ref?.brokerId;
  const deviceId = ref?.deviceId;
  const [defs, setDefs] = useState({ key: null, value: null });
  const key = brokerId && deviceId ? `${brokerId}|${deviceId}` : null;
  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    fetchIotDevice(brokerId, deviceId).then(
      (d) => live && setDefs({ key, value: tagDefsFromIot(d?.tags) }),
      () => live && setDefs({ key, value: [] })
    );
    return () => {
      live = false;
    };
  }, [key, brokerId, deviceId]);
  if (!key) return null;
  return defs.key === key ? defs.value : null;
}
