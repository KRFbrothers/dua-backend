// Background task reaper (Phase 3 item 2.1).
//
// Before this module, a task's time limit was lazy: expireOverdue() in orhan-tasks.mjs
// only ran when someone read or started a task. A task the user closed the app on stayed
// `running` in the database forever, and the one-running-task-per-owner rule then blocked
// every new task.
//
// This reaper runs on a timer, independent of any request, and moves abandoned tasks to
// failed/timeout. It is safe to run in more than one process: the database function
// dua_orhan_tasks_reap() does the conditional UPDATE, so a task is reaped once.
//
// It needs the service role key because it acts without a user request. It never reads
// prompt text or step output, only ids and timestamps.

import { createTaskEventWriter } from './task-events.mjs';

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MAX_MINUTES = 10;

const noop = () => {};

/**
 * One reaper pass. Returns the tasks it moved, so a caller can log or test it.
 *
 * @param {object} options
 * @param {object} [options.env]
 * @param {Function} [options.fetcher]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.maxMinutes]
 * @param {Function} [options.log]
 */
export async function reapOnce({ env = process.env, fetcher = fetch, signal, maxMinutes = DEFAULT_MAX_MINUTES, log = noop } = {}) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!base.startsWith('https://') || !key) {
    log('reaper_not_configured');
    return [];
  }
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const db = (path, init = {}) => fetcher(base + path, {
    redirect: 'error',
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
    signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(20000)]),
  });

  let reaped = [];
  try {
    const response = await db('/rest/v1/rpc/dua_orhan_tasks_reap', {
      method: 'POST',
      body: JSON.stringify({ p_max_minutes: Math.max(1, Math.trunc(maxMinutes)) }),
    });
    if (!response.ok) { log('reaper_rpc_failed', { status: response.status }); return []; }
    const rows = await response.json();
    reaped = Array.isArray(rows) ? rows : [];
  } catch {
    log('reaper_unavailable');
    return [];
  }

  // Append one 'reaped' event per task. A failure here is logged, never thrown.
  for (const row of reaped) {
    const append = createTaskEventWriter({ db, ownerId: row.owner_id, taskId: row.task_id, signal });
    const ok = await append('reaped', { endReason: 'timeout', fromStatus: 'running', toStatus: 'failed' });
    if (!ok) log('reaper_event_failed', { taskId: row.task_id });
  }
  if (reaped.length) log('reaped', { count: reaped.length });
  return reaped;
}

/**
 * Starts the reaper loop. Returns a stop function.
 * The loop never throws: a failed pass is logged and the next tick retries.
 */
export function startTaskReaper({ env = process.env, fetcher = fetch, intervalMs = DEFAULT_INTERVAL_MS, maxMinutes = DEFAULT_MAX_MINUTES, log = noop } = {}) {
  const stop = new AbortController();
  const tick = async () => {
    while (!stop.signal.aborted) {
      try { await reapOnce({ env, fetcher, signal: stop.signal, maxMinutes, log }); }
      catch { log('reaper_pass_failed'); }
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

/** True when the reaper should run in this process. Off by default, opt in per deployment. */
export function reaperEnabled(env = process.env) {
  return String(env.DUA_TASK_REAPER || '').trim() === '1';
}
