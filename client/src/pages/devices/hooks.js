import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useStore } from '@/store/store';
import { cleanTag } from '@/lib/deviceTags';

const VALIDATE_DEBOUNCE_MS = 600;

/**
 * Debounced server-side tag validation. Returns results keyed by tag key
 * ({ ok, normalized, error }), a pending flag and a visible error with retry.
 * Stale responses (the user kept typing) are discarded.
 */
export function useTagValidation(protocol, options, tags) {
  // `key` names the request the stored results/error answer; "pending" is derived: a request is in
  // flight whenever the current request key has not been answered yet.
  const [state, setState] = useState({ key: null, results: {}, error: '' });
  const [nonce, setNonce] = useState(0);

  // Only what the server cares about participates in the dependency.
  const payload = JSON.stringify(
    tags.filter((t) => t.key && String(t.address ?? '').trim()).map(cleanTag).map(({ key, address, type, length, bit, byteOrder, wordOrder }) => ({ key, address, type, length, bit, byteOrder, wordOrder }))
  );
  const optionsJson = JSON.stringify(options || {});
  const active = Boolean(protocol) && payload !== '[]';
  const requestKey = `${nonce}|${protocol}|${optionsJson}|${payload}`;

  useEffect(() => {
    if (!active) return undefined;
    let stale = false; // the user kept typing (or unmounted): discard this response
    const timer = setTimeout(async () => {
      try {
        const res = await api.validateDeviceTags(protocol, JSON.parse(optionsJson), JSON.parse(payload));
        if (stale) return;
        const results = {};
        for (const r of res.results || []) results[r.key] = r;
        setState({ key: requestKey, results, error: '' });
      } catch (e) {
        if (stale) return;
        setState((s) => ({ ...s, key: requestKey, error: e.message || 'Validation request failed' }));
      }
    }, VALIDATE_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [active, protocol, payload, optionsJson, requestKey]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  if (!active) return { results: {}, pending: false, error: '', retry };
  return { results: state.results, pending: state.key !== requestKey, error: state.error, retry };
}

/**
 * Live values for a saved device: seeds the store from GET /values, then the
 * socket keeps `deviceValues[id]` current. Selecting one device's map means
 * other devices' updates do not re-render this component.
 */
export function useDeviceValues(deviceId) {
  const values = useStore((s) => (deviceId ? s.deviceValues[deviceId] : undefined));
  const seed = useStore((s) => s.seedDeviceValues);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!deviceId) return undefined;
    let alive = true;
    api
      .deviceValues(deviceId)
      .then((r) => {
        if (!alive) return;
        // Per tag, keep whichever of the snapshot and the socket-fed store is newer.
        const current = useStore.getState().deviceValues[deviceId] || {};
        const merged = { ...(r.values || {}) };
        for (const [k, v] of Object.entries(current)) if (!merged[k] || (v?.tRead || 0) >= (merged[k].tRead || 0)) merged[k] = v;
        seed(deviceId, merged);
        setError('');
      })
      .catch((e) => alive && setError(e.message || 'Could not load live values'));
    return () => {
      alive = false;
    };
  }, [deviceId, seed, nonce]);

  return { values: values || {}, error, retry: () => setNonce((n) => n + 1) };
}
