// Append-only task event log (Phase 3 item 2.2).
//
// The task row keeps `steps` as one JSONB blob that is rewritten on every step, so it
// cannot answer "what happened, in what order". This module writes one immutable row per
// lifecycle transition into dua_task_events (see 202611270001_dua_task_lifecycle_workers.sql).
//
// Design rules:
// - Never throws into the caller. A failed event write must not fail the task itself.
// - Never stores prompt text, step output or provider payloads. Only ids, counts and
//   short machine-readable detail, matching the privacy rule in request-logging.mjs.
// - Sequence numbers come from the database (dua_task_events_next_seq) so concurrent
//   writers cannot collide on the unique (owner_id, task_id, seq) constraint.

const EVENTS = new Set([
  'created', 'started', 'step_started', 'step_completed', 'step_failed',
  'heartbeat', 'retry', 'cancelled', 'completed', 'failed', 'timed_out', 'reaped',
]);

/** Detail keys that are safe to persist. Anything else is dropped, not truncated. */
const DETAIL_KEYS = new Set([
  'stepId', 'stepIndex', 'stepCount', 'runCount', 'attempt', 'endReason',
  'status', 'fromStatus', 'toStatus', 'workerId', 'durationMs', 'parentTaskId',
  // Task lineage, spelled exactly as 202611280004_dua_task_lineage_event_backfill.sql
  // writes it into dua_task_events.detail, so a reader can query one name for both
  // backfilled rows and rows the API writes from now on.
  'parent_task_id', 'root_task_id', 'continue_thread_id', 'idempotency_key',
  // Task lifecycle, spelled exactly as 202611280003_dua_task_links_event_backfill.sql
  // writes it into dua_task_events.detail, so the three columns added by
  // 202611250001_dua_orhan_tasks_lifecycle.sql become a cache: a reader can recover
  // why a task ended and when from the event stream alone.
  'end_reason', 'finished_at_ms', 'stopped_at_ms',
]);

function safeDetail(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const out = {};
  for (const [key, value] of Object.entries(detail)) {
    if (!DETAIL_KEYS.has(key)) continue;
    if (typeof value === 'string') { if (value.length <= 200) out[key] = value; continue; }
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    if (typeof value === 'boolean') out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Builds an event writer bound to one task and one owner.
 *
 * @param {object} options
 * @param {(path: string, init: object) => Promise<Response>} options.db  PostgREST caller
 * @param {string} options.ownerId
 * @param {string} options.taskId
 * @param {AbortSignal} [options.signal]
 * @returns {(event: string, detail?: object) => Promise<boolean>}
 */
export function createTaskEventWriter({ db, ownerId, taskId, signal }) {
  let lastSeq = 0;
  return async function append(event, detail) {
    if (!EVENTS.has(event)) return false;
    if (typeof ownerId !== 'string' || !ownerId) return false;
    if (typeof taskId !== 'string' || taskId.length < 8) return false;
    try {
      // Ask the database for the next sequence. A local counter would drift after a
      // restart or a second writer, and the unique constraint would then reject rows.
      const seqResponse = await db('/rest/v1/rpc/dua_task_events_next_seq', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_owner: ownerId, p_task: taskId }),
        signal,
      });
      if (!seqResponse.ok) return false;
      const seq = Number(await seqResponse.json());
      if (!Number.isInteger(seq) || seq < 1) return false;
      lastSeq = Math.max(lastSeq, seq);
      const row = {
        owner_id: ownerId,
        task_id: taskId,
        seq,
        event,
        step_id: typeof detail?.stepId === 'string' ? detail.stepId.slice(0, 40) : null,
        detail: safeDetail(detail),
      };
      const response = await db('/rest/v1/dua_task_events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(row),
        signal,
      });
      return response.ok;
    } catch {
      // Observability must never break the task. The caller keeps working.
      return false;
    }
  };
}

/** Reads the event trail for one task, oldest first. Returns [] on any failure. */
export async function readTaskEvents({ db, taskId, limit = 200, signal }) {
  try {
    const response = await db(
      `/rest/v1/dua_task_events?select=seq,event,step_id,detail,created_at&task_id=eq.${encodeURIComponent(taskId)}&order=seq.asc&limit=${Math.min(Math.max(1, limit), 500)}`,
      { method: 'GET', signal },
    );
    if (!response.ok) return [];
    const rows = await response.json();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export const TASK_EVENTS = Object.freeze([...EVENTS]);
