/** Browser origins allowed to call this API from a separate UI.

WEB_ORIGINS is a comma-separated list of exact origins (scheme, host, and port).
A `*` entry is ignored. Android and other clients that send no Origin header are unchanged.
Set WEB_ORIGINS=off to refuse every browser origin.
*/

export function allowedWebOrigins(env = process.env) {
  const raw = String(env.WEB_ORIGINS || env.webOrigins || '').trim();
  if (!raw || ['off', 'none', '0'].includes(raw.toLowerCase())) return new Set();
  return new Set(raw.split(',').map(item => item.trim().replace(/\/$/, '')).filter(item => item && item !== '*'));
}

/** True when the request has no Origin, the API's own origin, or a listed UI origin. */
export function requestOriginAllowed(request, url, env = process.env) {
  const origin = request.headers.get('origin') || '';
  if (!origin || origin === url.origin) return true;
  return allowedWebOrigins(env).has(origin);
}

/** Same as requestOriginAllowed, and a listed UI may send Sec-Fetch-Site: cross-site. */
export function browserOriginAllowed(request, url, env = process.env) {
  if (!requestOriginAllowed(request, url, env)) return false;
  const site = request.headers.get('sec-fetch-site') || '';
  if (site === '' || site === 'same-origin' || site === 'none') return true;
  const origin = request.headers.get('origin') || '';
  return site === 'cross-site' && Boolean(origin) && origin !== url.origin && allowedWebOrigins(env).has(origin);
}

const ALLOW_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const ALLOW_HEADERS = 'Authorization, Content-Type, Accept, X-Dua-Native, X-Dua-App-Token';

export function applyCors(response, request) {
  const origin = request.headers.get('origin') || '';
  if (!origin) return response;
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Expose-Headers', 'Content-Type, X-Dua-Requests-Remaining');
  if (!response.headers.has('Vary')) response.headers.set('Vary', 'Origin');
  return response;
}

/** Preflight for a listed UI. Returns null when this is not a CORS preflight. */
export function corsPreflight(request, url, env = process.env) {
  if (request.method !== 'OPTIONS' || !request.headers.get('access-control-request-method')) return null;
  const origin = request.headers.get('origin') || '';
  if (!origin || !requestOriginAllowed(request, url, env)) {
    return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store', Vary: 'Origin' } });
  }
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': ALLOW_METHODS,
      'Access-Control-Allow-Headers': ALLOW_HEADERS,
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
      'Cache-Control': 'no-store',
    },
  });
}
