// Health and readiness endpoints (Phase 3 items 8.1, 8.2).
//
// Before this module, dua-api had no /healthz or /readyz at all: Cloud Run fell back to
// a TCP check, which passes even when Supabase or the engine is unreachable. dua-ai-engine
// had `/` but it only reported configuration, it never checked a dependency.
//
// Two different questions, deliberately kept apart:
//   /healthz  liveness  - is this process able to answer? Never touches the network.
//   /readyz   readiness - can this process do real work? Checks its dependencies.
//
// A readiness failure returns 503 so a load balancer or Cloud Run revision stops sending
// traffic, while liveness stays 200 so the platform does not kill a healthy process.

const noStore = (body, status) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/** Liveness: no I/O, no secrets, no dependency. Always 200 while the process runs. */
export function healthResponse({ service = 'dua-api', version = '' } = {}) {
  return noStore({ status: 'ok', service, version, uptimeSeconds: Math.round(process.uptime()) }, 200);
}

async function checkSupabase({ env, fetcher, signal }) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_ANON_KEY || '');
  if (!base.startsWith('https://') || !key) return { ok: false, reason: 'not_configured' };
  try {
    // A cheap authenticated-free read: the auth health endpoint answers without a session.
    const response = await fetcher(`${base}/auth/v1/health`, {
      method: 'GET', redirect: 'error',
      headers: { apikey: key },
      signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(4000)]),
    });
    return response.ok ? { ok: true } : { ok: false, reason: `status_${response.status}` };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

async function checkEngine({ env, fetcher, signal }) {
  const configured = String(env.DUA_ENGINE_URL || '').trim();
  if (!configured) return { ok: true, skipped: 'not_configured' };
  let origin;
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:') return { ok: false, reason: 'invalid_url' };
    origin = url.origin;
  } catch { return { ok: false, reason: 'invalid_url' }; }
  try {
    const response = await fetcher(`${origin}/`, {
      method: 'GET', redirect: 'error',
      signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(4000)]),
    });
    return response.ok ? { ok: true } : { ok: false, reason: `status_${response.status}` };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

/**
 * Readiness: checks the dependencies this service actually needs.
 * `required` lists which checks must pass. A check that is not required is reported
 * but does not fail readiness, so a deployment can run without an engine configured.
 */
export async function readinessResponse({ env = process.env, fetcher = fetch, signal, service = 'dua-api', version = '', required = ['supabase'] } = {}) {
  const checks = {};
  const wanted = new Set(required);
  if (wanted.has('supabase')) checks.supabase = await checkSupabase({ env, fetcher, signal });
  if (wanted.has('engine')) checks.engine = await checkEngine({ env, fetcher, signal });
  const failed = Object.entries(checks).filter(([, value]) => !value.ok).map(([name]) => name);
  const ready = failed.length === 0;
  return noStore({
    status: ready ? 'ready' : 'not_ready',
    service,
    version,
    checks,
    ...(ready ? {} : { failed }),
  }, ready ? 200 : 503);
}

/** Routes /healthz and /readyz. Returns null when the path is not a health path. */
export async function handleHealth(request, { env = process.env, fetcher = fetch, service = 'dua-api', version = '', required } = {}) {
  const path = new URL(request.url).pathname;
  if (path !== '/healthz' && path !== '/readyz') return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return noStore({ error: 'Method not allowed.' }, 405);
  if (path === '/healthz') return healthResponse({ service, version });
  return readinessResponse({ env, fetcher, signal: request.signal, service, version, required });
}
