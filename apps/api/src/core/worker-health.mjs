// Worker registry and health (Phase 3 items 4.1, 4.2, 4.4).
//
// Before this module, a worker's id was a random UUID generated per run
// (workflow-worker.mjs: `const worker = randomUUID()`), so nothing could answer
// "how many workers are alive" or "which worker is stuck". Stale leases were only
// noticed on the next claim attempt.
//
// This module registers a worker once, sends heartbeats, and reports workers whose
// last heartbeat is older than a threshold. It uses the service role because workers
// are infrastructure, not user data (dua_workers has no authenticated grant).

const DEFAULT_STALE_SECONDS = 90;

const noop = () => {};

function serviceDb(env, fetcher, signal) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!base.startsWith('https://') || !key) return null;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  return (path, init = {}) => fetcher(base + path, {
    redirect: 'error',
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
    signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)]),
  });
}

/**
 * Sends one heartbeat for a worker. Returns the stored row, or null when the
 * registry is not configured or the call failed. Never throws.
 */
export async function heartbeat({ env = process.env, fetcher = fetch, signal, workerId, kind, version = '', capacity = 1, activeJobs = 0 } = {}) {
  if (!workerId || !['workflow', 'orhan', 'coding'].includes(kind)) return null;
  const db = serviceDb(env, fetcher, signal);
  if (!db) return null;
  try {
    const response = await db('/rest/v1/rpc/dua_worker_heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        p_worker: workerId, p_kind: kind, p_version: String(version).slice(0, 40),
        p_capacity: Math.max(1, Math.trunc(capacity)), p_active: Math.max(0, Math.trunc(activeJobs)),
      }),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** Workers whose last heartbeat is older than `staleSeconds`. Returns [] on failure. */
export async function staleWorkers({ env = process.env, fetcher = fetch, signal, staleSeconds = DEFAULT_STALE_SECONDS } = {}) {
  const db = serviceDb(env, fetcher, signal);
  if (!db) return [];
  try {
    const response = await db('/rest/v1/rpc/dua_workers_stale', {
      method: 'POST',
      body: JSON.stringify({ p_stale_seconds: Math.max(1, Math.trunc(staleSeconds)) }),
    });
    if (!response.ok) return [];
    const rows = await response.json();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** Marks a worker as draining so a deploy stops new claims without killing in-flight work. */
export async function drainWorker({ env = process.env, fetcher = fetch, signal, workerId, draining = true } = {}) {
  if (!workerId) return null;
  const db = serviceDb(env, fetcher, signal);
  if (!db) return null;
  try {
    const response = await db('/rest/v1/rpc/dua_worker_drain', {
      method: 'POST',
      body: JSON.stringify({ p_worker: workerId, p_draining: Boolean(draining) }),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Starts a heartbeat loop for a worker. Returns a stop function.
 * The loop is deliberately quiet: a failed heartbeat is logged and retried, because a
 * registry outage must not stop real work.
 */
export function startHeartbeat({ env = process.env, fetcher = fetch, workerId, kind, version = '', capacity = 1, intervalMs = 15_000, getActiveJobs = () => 0, log = noop } = {}) {
  const stop = new AbortController();
  const tick = async () => {
    while (!stop.signal.aborted) {
      const row = await heartbeat({ env, fetcher, signal: stop.signal, workerId, kind, version, capacity, activeJobs: getActiveJobs() });
      if (!row) log('heartbeat_failed', { workerId });
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, intervalMs);
          stop.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('stopped')); }, { once: true });
        });
      } catch { break; }
    }
  };
  tick();
  return () => stop.abort();
}

/**
 * Dead worker detection (item 4.4). Returns the stale workers and, for each, a
 * machine-readable reason. The caller decides whether to alert or to fail their jobs.
 */
export async function detectDeadWorkers({ env = process.env, fetcher = fetch, signal, staleSeconds = DEFAULT_STALE_SECONDS, log = noop } = {}) {
  const stale = await staleWorkers({ env, fetcher, signal, staleSeconds });
  if (stale.length) log('dead_workers', { count: stale.length });
  return stale.map(worker => ({
    workerId: worker.worker_id,
    kind: worker.kind,
    lastSeen: worker.last_seen,
    activeJobs: Number(worker.active_jobs) || 0,
    reason: 'heartbeat_stale',
  }));
}

export const WORKER_KINDS = Object.freeze(['workflow', 'orhan', 'coding']);
