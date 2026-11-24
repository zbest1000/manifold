import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useStore } from '@/store/store';
import { listProfiles } from './devicesApi';

const REFRESH_MS = 5000; // cycle statistics only travel over REST; phases arrive live over the socket

/**
 * Devices (with hosts and protocol descriptors) and profiles, polled together.
 * A failing profiles request never hides the devices: each has its own error.
 */
export function useDevicesData() {
  const [data, setData] = useState(null); // { devices, hosts, protocols }
  const [profiles, setProfiles] = useState(null);
  const [error, setError] = useState('');
  const [profilesError, setProfilesError] = useState('');
  const [loading, setLoading] = useState(true);
  const devicesVersion = useStore((s) => s.devicesVersion);
  const alive = useRef(true);

  const load = useCallback(async () => {
    const [d, p] = await Promise.allSettled([api.devices(), listProfiles()]);
    if (!alive.current) return;
    if (d.status === 'fulfilled') {
      setData({ devices: d.value.devices || [], hosts: d.value.hosts || {}, protocols: d.value.protocols || [] });
      setError('');
    } else setError(d.reason?.message || 'Could not load devices');
    if (p.status === 'fulfilled') {
      setProfiles(p.value);
      setProfilesError('');
    } else setProfilesError(p.reason?.message || 'Could not load profiles');
    setLoading(false);
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    load();
  }, [load, devicesVersion]);
  useEffect(() => {
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  return { data, profiles, error, profilesError, loading, load };
}
