import axios from 'axios';

const seen: Array<Record<string, unknown>> = [];
let recording = false;

/** Configs of the requests sent through the default axios instance, in order; each call starts a fresh list. */
export function recordDefaultAxiosRequestConfigs(): Array<Record<string, unknown>> {
  if (!recording) {
    recording = true;
    axios.interceptors.request.use((config) => {
      seen.push({ ...config });
      return config;
    });
  }
  seen.length = 0;
  return seen;
}
