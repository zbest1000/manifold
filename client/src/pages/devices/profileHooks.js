import { useMemo } from 'react';
import { expandForValidation } from '@/lib/deviceProfiles';
import { useTagValidation } from './hooks';

/**
 * Driver validation of profile tags, with parameter defaults standing in for the
 * placeholders. Results are keyed by the template key; tags that use a parameter
 * without a default are `skipped` (the server checks them per instance).
 */
export function useProfileValidation(protocol, options, tags, params) {
  const { list, keyMap, skipped } = useMemo(() => expandForValidation(tags, params), [tags, params]);
  const v = useTagValidation(protocol, options, list);
  const results = useMemo(() => {
    const out = {};
    for (const [k, r] of Object.entries(v.results)) if (keyMap[k] !== undefined) out[keyMap[k]] = r;
    return out;
  }, [v.results, keyMap]);
  return { ...v, results, skipped };
}
