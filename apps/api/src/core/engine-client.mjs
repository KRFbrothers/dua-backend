// Single source for how dua-api talks to dua-ai-engine: the default engine origin, URL validation
// and the request headers. Callers keep their own body, timeout and error handling.
// DUA_ENGINE_URL overrides the origin; DUA_APP_TOKEN (optional) is added server-side only.
export const DEFAULT_ENGINE_URL = 'https://dua-ai-engine-228305912525.us-central1.run.app';

/**
 * Engine endpoint URL for `path`, or null when the configured origin is unsafe or missing.
 * The origin must be https with no credentials, query, hash or path. With `allowDefault: false`
 * an unset DUA_ENGINE_URL is treated as not configured (the workflow worker requires it).
 */
export function engineEndpoint(env, path, { allowDefault = true } = {}) {
  const configured = env?.DUA_ENGINE_URL;
  if (!configured && !allowDefault) return null;
  try {
    const url = new URL(String(configured || DEFAULT_ENGINE_URL));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) return null;
    return new URL(path, url.origin);
  } catch { return null; }
}

/**
 * Engine request headers: `Authorization: Bearer <user token>`, optional `X-Dua-App-Token`,
 * and `X-Dua-Native: 1` only when `native` is set (same contract as the Android app).
 */
export function engineHeaders(env, token, { accept = 'application/json', contentType = 'application/json', native = false } = {}) {
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  if (accept) headers.Accept = accept;
  headers.Authorization = 'Bearer ' + token;
  if (native) headers['x-dua-native'] = '1';
  if (env?.DUA_APP_TOKEN) headers['X-Dua-App-Token'] = env.DUA_APP_TOKEN;
  return headers;
}
