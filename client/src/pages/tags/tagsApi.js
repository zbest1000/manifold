// Thin wrappers over the shared api client for the Tags page. lib/api.js keeps
// its low-level request helper private, so every call here goes through the
// existing `api` methods (no new endpoints are needed).
import { api } from '@/lib/api';

export const fetchSources = () => api.tagSources().then((r) => r.sources || []);
export const browse = (source, node = '') => api.tagBrowse(source.type, source.id, node).then((r) => r.children || []);
export const fetchBindings = () => api.listBindings();
export const saveBinding = (b) => api.saveBinding(b);
export const removeBinding = (id) => api.deleteBinding(id);
export const savePipeline = (p) => api.savePipeline(p);
export const setHostState = (body) => api.sparkplugState(body);
