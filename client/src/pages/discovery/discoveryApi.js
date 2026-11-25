import { useEffect, useState } from 'react';
import { getAuthToken } from '@/lib/api';

/**
 * Discovery REST calls. Unlike a plain request helper these keep the machine-readable parts of
 * a refusal (`err.code`, `err.flag`, `err.status`) so the page can name the exact setting to change.
 */
async function request(path, { method = 'GET', body } = {}) {
  const token = getAuthToken();
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw Object.assign(new Error(e.message || 'Network request failed'), { code: 'NETWORK' });
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, code: data.code, flag: data.flag });
  }
  return data;
}

export const discoveryDefaults = () => request('/api/system/discovery/defaults');
// ?soft=1: a refused range comes back as 200 { refused } instead of a 400 (this is asked on every edit).
export const discoveryPlan = async (options) => {
  const r = await request('/api/system/discovery/plan?soft=1', { method: 'POST', body: options });
  if (r.refused) throw Object.assign(new Error(r.refused.error), { status: 400, code: r.refused.code, flag: r.refused.flag });
  return r;
};
export const startScan = (options) => request('/api/system/discovery/start', { method: 'POST', body: options });
export const stopScan = () => request('/api/system/discovery/stop', { method: 'POST' });
export const scanState = () => request('/api/system/discovery/results');

/**
 * What the scan WOULD do for these options, asked of the server (the same code that runs it):
 * `{ plan, error }`. Debounced; a refusal arrives as `error` with `code` / `flag`.
 */
export function usePlan(options, { enabled = true, delay = 350 } = {}) {
  const [state, setState] = useState({ plan: null, error: null });
  const key = JSON.stringify(options);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const t = setTimeout(() => {
      discoveryPlan(JSON.parse(key)).then(
        (plan) => alive && setState({ plan, error: null }),
        (error) => alive && setState({ plan: null, error })
      );
    }, delay);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key, enabled, delay]);
  return state;
}

/** A boolean kept in localStorage (a per-viewer convenience: reads and writes never throw). */
export function usePersistentFlag(key, initial = false) {
  const [value, setValue] = useState(() => {
    try {
      return window.localStorage.getItem(key) === '1' ? true : initial;
    } catch {
      return initial;
    }
  });
  const set = (next) => {
    setValue(next);
    try {
      window.localStorage.setItem(key, next ? '1' : '0');
    } catch {
      /* private window or blocked storage: the choice just lasts for this visit */
    }
  };
  return [value, set];
}
