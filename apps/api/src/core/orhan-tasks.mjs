// Dua Work tasks (legacy Orhan routes and table) share the owner's Supabase login. Dua chat is a different route.
// The engine plans and runs one step. This API saves the task so a closed app can resume it.
import { readJsonLimited } from './limited-json.mjs';
import { resolveOwner, StorageError } from './storage.mjs';
import { engineEndpoint, engineHeaders } from './engine-client.mjs';
import { createTaskEventWriter, readTaskEvents } from './task-events.mjs';

const MAX_STEPS = 12;
const MAX_MINUTES = 10;
const MAX_OUTPUT = 12000;
const TIME_LIMIT_ERROR = 'This task reached its 10 minute limit.';
const COLUMNS = 'task_id,title,prompt,status,plan,steps,artifact,error,run_count,started_at_ms,created_at_ms,updated_at_ms,end_reason,finished_at_ms,stopped_at_ms,parent_task_id,root_task_id,continue_thread_id,attempt,idempotency_key';
// README task lifecycle. The stored `status` stays the legacy value for existing clients.
const LIFECYCLE = { waiting: 'queued', running: 'running', approval_needed: 'running', completed: 'completed', failed: 'failed', cancelled: 'stopped' };
const noStore = (error, status, extra = {}) => Response.json({ error, ...extra }, { status, headers: { 'Cache-Control': 'no-store' } });
const inflight = new Set();
const DUPLICATE = Symbol('duplicate');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENTS = {
  research: ['search'],
  checker: [],
  writer: [],
};
const EXPECTED = [
  ['research', 'research', []],
  ['check', 'checker', ['research']],
  ['document', 'writer', ['check']],
];

export async function handleOrhanTasks(request, { env = process.env, fetcher = fetch } = {}) {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'orhan' || parts[2] !== 'tasks' || parts.length > 5) return noStore('Not found.', 404);
  const taskId = parts[3] || '';
  const action = parts[4] || '';
  if ((parts.length === 5 && !['start', 'continue', 'cancel', 'retry', 'events'].includes(action)) || (taskId && !UUID.test(taskId))) return noStore('Not found.', 404);
  if (parts.length === 3 && !['GET', 'POST'].includes(request.method)) return noStore('Method not allowed.', 405);
  if (parts.length === 4 && request.method !== 'GET') return noStore('Method not allowed.', 405);
  // `events` is a read of the append-only trail; every other action is a POST.
  if (parts.length === 5 && action === 'events' && request.method !== 'GET') return noStore('Method not allowed.', 405);
  if (parts.length === 5 && action !== 'events' && request.method !== 'POST') return noStore('Method not allowed.', 405);

  let owner;
  try { owner = await resolveOwner(request, { env, fetcher, feature: 'Dua Agent' }); }
  catch (error) { return noStore(error instanceof StorageError ? error.message : 'Account verification is unavailable. Retry.', error.status || 503); }

  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_ANON_KEY || '');
  if (!base.startsWith('https://') || !key || key.startsWith('sb_secret_')) return noStore('Dua Agent task storage is not configured.', 503);
  const endpoint = `${base}/rest/v1/dua_orhan_tasks`;
  const headers = { apikey: key, Authorization: `Bearer ${owner.token}`, Accept: 'application/json' };
  const db = (path, init) => fetcher(endpoint + path, { redirect: 'error', ...init, headers: { ...headers, ...(init.headers || {}) }, signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]) });
  // The event log lives in its own table, so it needs its own base path.
  // task-events.mjs builds full /rest/v1/... paths, so this caller only adds the origin.
  const eventsDb = (path, init) => fetcher(`${base}${path}`, { redirect: 'error', ...init, headers: { ...headers, ...(init.headers || {}) }, signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]) });
  const log = (taskId, event, detail) => createTaskEventWriter({ db: eventsDb, ownerId: owner.user.id, taskId, signal: request.signal })(event, detail);

  const lockKey = `${owner.user.id}:${taskId || 'list'}`;
  if (action === 'start' || action === 'continue' || action === 'retry') {
    if (inflight.has(lockKey)) return noStore('Dua Agent is already working on this task.', 409);
    inflight.add(lockKey);
  }
  try {
    if (request.method === 'GET' && taskId && action === 'events') return await listEvents(eventsDb, taskId);
    if (request.method === 'GET' && taskId) return await getTask(db, taskId);
    if (request.method === 'GET') return await listTasks(db, owner.user.id);
    if (parts.length === 3) return await createTask(request, db, owner, env, fetcher, log);
    if (action === 'start') return await startTask(db, owner.user.id, taskId, log);
    if (action === 'continue') return await continueTask(db, taskId, env, fetcher, owner.token, log);
    if (action === 'cancel') return await cancelTask(db, taskId, log);
    return await retryTask(db, taskId, log);
  } catch (error) {
    if (error instanceof Response) return error;
    return noStore('Dua Agent is temporarily unavailable. Retry.', 502);
  } finally {
    inflight.delete(lockKey);
  }
}

/** Item 2.2 read path: the append-only trail for one task, oldest first. */
async function listEvents(eventsDb, taskId) {
  const events = await readTaskEvents({ db: eventsDb, taskId, limit: 200 });
  return Response.json({ events: events.map(row => ({
    seq: Number(row.seq),
    event: row.event,
    stepId: row.step_id || null,
    detail: row.detail || null,
    at: row.created_at,
  })) }, { headers: { 'Cache-Control': 'no-store' } });
}

async function listTasks(db, ownerId) {
  const expired = await expireOverdue(db, `&owner_id=eq.${ownerId}`);
  if (expired instanceof Response) return expired;
  const response = await db(`?select=${COLUMNS}&order=updated_at_ms.desc&limit=30`, { method: 'GET' });
  if (!response.ok) return upstreamFailure(response.status);
  const rows = await response.json();
  if (!Array.isArray(rows)) return noStore('Dua Agent returned an invalid task list.', 502);
  return Response.json({ tasks: rows.map(present) }, { headers: { 'Cache-Control': 'no-store' } });
}

async function createTask(request, db, owner, env, fetcher, log) {
  let data;
  try { data = await readJsonLimited(request, 16 * 1024); }
  catch (error) { return noStore(error.status === 413 ? 'The job is too long.' : 'Invalid job.', error.status || 400); }
  if (typeof data?.prompt === 'string' && data.prompt.trim().length > 4000) return noStore('The job is too long.', 413);
  const prompt = clean(data?.prompt, 4000, { keepLines: true });
  if (!prompt) return noStore('Tell Dua Agent what to do.', 400);
  // Optional client request ID (UUID) becomes the task ID, so a retried create returns the same task.
  if (data.requestId !== undefined && (typeof data.requestId !== 'string' || !UUID.test(data.requestId))) return noStore('Invalid requestId.', 400);
  const requestId = data.requestId?.toLowerCase() || null;
  if (requestId) {
    const existing = await findTask(db, requestId);
    if (existing) return replay(existing, prompt);
  }
  const team = Array.isArray(data?.team) ? data.team : null;
  // Items 3.1, 3.2, 3.3: a follow-up task can name the task it continues. The parent must
  // exist and belong to this owner (RLS on the read enforces that), otherwise the link is
  // refused instead of silently ignored. The root is inherited from the parent when present,
  // so a chain can be walked without recursing.
  let parent = null;
  if (data.parentTaskId !== undefined) {
    if (typeof data.parentTaskId !== 'string' || !UUID.test(data.parentTaskId)) return noStore('Invalid parentTaskId.', 400);
    parent = await findTask(db, data.parentTaskId.toLowerCase());
    if (!parent) return noStore('That parent task was not found.', 404);
  }
  let continueThreadId = null;
  if (data.continueThreadId !== undefined) {
    if (typeof data.continueThreadId !== 'string' || !UUID.test(data.continueThreadId)) return noStore('Invalid continueThreadId.', 400);
    continueThreadId = data.continueThreadId.toLowerCase();
  } else if (parent?.continue_thread_id) {
    // An explicit thread wins; otherwise the child stays on its parent's thread.
    continueThreadId = parent.continue_thread_id;
  }
  let idempotencyKey = null;
  if (data.idempotencyKey !== undefined) {
    if (typeof data.idempotencyKey !== 'string' || !data.idempotencyKey.trim() || data.idempotencyKey.length > 200) return noStore('Invalid idempotencyKey.', 400);
    idempotencyKey = data.idempotencyKey.trim();
    // A reused key returns the task that already owns it, the same way requestId does.
    const existing = await findByKey(db, idempotencyKey);
    if (existing) return replay(existing, prompt);
  }
  const target = engineUrl(env, '/api/orhan/plan');
  if (!target) return noStore('Dua Agent\'s AI engine is not configured.', 503);
  let plan;
  try {
    const response = await fetcher(target, {
      method: 'POST', redirect: 'error',
      headers: engineHeaders(env, owner.token),
      body: JSON.stringify({ prompt, ...(team ? { team } : {}) }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return noStore(clean(body.error, 300) || 'Dua Agent could not make a plan.', response.status === 503 ? 503 : 502);
    plan = validPlan(body, prompt, team);
  } catch {
    return noStore('Dua Agent\'s AI engine is not reachable. Try again.', 502);
  }
  if (!plan) return noStore('Dua Agent returned a plan with tools that are not allowed.', 502);
  const now = Date.now();
  const taskId = requestId || crypto.randomUUID();
  const row = {
    owner_id: owner.user.id,
    task_id: taskId,
    title: plan.title,
    prompt,
    status: 'waiting',
    plan: { title: plan.title, agents: plan.agents },
    steps: plan.steps.map(step => ({ ...step, status: 'pending', output: '', error: null })),
    artifact: null,
    error: null,
    run_count: 0,
    started_at_ms: 0,
    created_at_ms: now,
    updated_at_ms: now,
    parent_task_id: parent ? parent.task_id : null,
    // A first task is its own root, so every chain has exactly one root without a backfill.
    root_task_id: parent ? (parent.root_task_id || parent.task_id) : taskId,
    continue_thread_id: continueThreadId,
    attempt: 1,
    idempotency_key: idempotencyKey,
  };
  const saved = await write(db, '', 'POST', row, { duplicate: Boolean(requestId) });
  if (saved === DUPLICATE) return replay(await load(db, requestId), prompt);
  if (saved instanceof Response) return saved;
  // The four lineage values go into the event detail as well as the task row, so the
  // append-only trail alone can answer "where did this task come from". The names match
  // 202611280004_dua_task_lineage_event_backfill.sql, which backfilled the same keys.
  await log(taskId, 'created', {
    parentTaskId: parent ? parent.task_id : undefined,
    parent_task_id: row.parent_task_id || undefined,
    root_task_id: row.root_task_id || undefined,
    continue_thread_id: row.continue_thread_id || undefined,
    idempotency_key: row.idempotency_key || undefined,
    status: 'waiting',
  });
  return Response.json({ task: present(saved) }, { headers: { 'Cache-Control': 'no-store' } });
}

// Same requestId and same prompt: return the saved task. A different prompt is a 409.
function replay(row, prompt) {
  if (row.prompt !== prompt) return noStore('This requestId was already used for a different job.', 409);
  return Response.json({ task: present(row) }, { headers: { 'Cache-Control': 'no-store' } });
}

async function findTask(db, taskId) {
  try { return await load(db, taskId); }
  catch (error) {
    if (error instanceof Response && error.status === 404) return null;
    throw error;
  }
}

/** Item 3.5: look a task up by its idempotency key. Returns null when the key is unused. */
async function findByKey(db, key) {
  const response = await db(`?select=${COLUMNS}&idempotency_key=eq.${encodeURIComponent(key)}&limit=1`, { method: 'GET' });
  if (!response.ok) return null;
  const rows = await response.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function getTask(db, taskId) {
  const expired = await expireOverdue(db, `&task_id=eq.${taskId}`);
  if (expired instanceof Response) return expired;
  return loadResponse(db, taskId);
}

// Lazy time limit: a running task past MAX_MINUTES becomes failed + end_reason timeout
// when it is read or before a new start, so an abandoned task cannot block new work.
async function expireOverdue(db, filter) {
  const now = Date.now();
  const cutoff = now - MAX_MINUTES * 60 * 1000;
  const saved = await write(db, `?status=eq.running&started_at_ms=lt.${cutoff}${filter}`, 'PATCH', {
    status: 'failed', end_reason: 'timeout', error: TIME_LIMIT_ERROR, finished_at_ms: now, updated_at_ms: now,
  });
  return saved instanceof Response ? saved : null;
}

async function startTask(db, ownerId, taskId, log) {
  await load(db, taskId);
  // The lazy sweep stays as it was; its timed_out events are written by the background
  // reaper (task-reaper.mjs), which sees the rows it moved.
  const expired = await expireOverdue(db, `&owner_id=eq.${ownerId}`);
  if (expired instanceof Response) return expired;
  const running = await db(`?select=task_id&owner_id=eq.${ownerId}&status=eq.running&limit=1`, { method: 'GET' });
  if (!running.ok) return upstreamFailure(running.status);
  const active = await running.json();
  if (!Array.isArray(active)) return noStore('Dua Agent returned an invalid task list.', 502);
  if (active.length) return noStore('Dua Agent is already running a task. Wait for it to finish or cancel it.', 409);
  const now = Date.now();
  const saved = await write(db, `?task_id=eq.${taskId}&status=eq.waiting`, 'PATCH', { status: 'running', error: null, started_at_ms: now, updated_at_ms: now });
  if (saved instanceof Response) return saved;
  if (!saved) return await missingOrConflict(db, taskId, 'This task is no longer waiting.');
  await log(taskId, 'started', { fromStatus: 'waiting', toStatus: 'running' });
  return Response.json({ task: present(saved) }, { headers: { 'Cache-Control': 'no-store' } });
}

async function continueTask(db, taskId, env, fetcher, token, log) {
  const current = await load(db, taskId);
  if (current instanceof Response) return current;
  if (current.status !== 'running') return noStore('Start the task first.', 409);
  if (Date.now() - Number(current.started_at_ms) > MAX_MINUTES * 60 * 1000) {
    return await finish(db, taskId, current, 'failed', TIME_LIMIT_ERROR, 'timeout', log);
  }
  if (Number(current.run_count) >= MAX_STEPS) {
    return await finish(db, taskId, current, 'failed', 'This task reached its step limit.', 'step_limit', log);
  }
  const steps = current.steps.map(step => ({ ...step }));
  const step = nextStep(steps);
  if (!step) return await finish(db, taskId, { ...current, steps }, outcome(steps), current.error, log);
  const target = engineUrl(env, '/api/orhan/step');
  if (!target) return noStore('Dua Agent\'s AI engine is not configured.', 503);
  await log(taskId, 'step_started', { stepId: step.id, stepIndex: step.id, runCount: Number(current.run_count) });
  let result;
  try {
    const response = await fetcher(target, {
      method: 'POST', redirect: 'error',
      headers: engineHeaders(env, token),
      body: JSON.stringify({ agent: step.agent, prompt: current.prompt, inputs: inputsFor(step, steps) }),
      signal: AbortSignal.timeout(40000),
    });
    result = await response.json().catch(() => ({}));
    if (!response.ok) result = { status: 'failed', error: clean(result.error, 300) || 'Dua Agent could not finish this step.' };
  } catch {
    result = { status: 'failed', error: 'Dua Agent\'s AI engine is not reachable. Try again.' };
  }
  const fresh = await load(db, taskId);
  if (fresh instanceof Response) return fresh;
  if (fresh.status !== 'running') return Response.json({ task: present(fresh) }, { headers: { 'Cache-Control': 'no-store' } });
  const updated = fresh.steps.map(item => ({ ...item }));
  const currentStep = updated.find(item => item.id === step.id);
  const output = clean(result.output, MAX_OUTPUT, { clip: true, keepLines: true });
  if (result.status === 'completed' && output) {
    currentStep.status = 'completed';
    currentStep.output = output;
    currentStep.error = null;
  } else {
    currentStep.status = 'failed';
    currentStep.error = clean(result.error, 300, { clip: true }) || 'This step failed.';
  }
  nextStep(updated);
  const status = outcome(updated);
  // The engine's output is never written to the event log, only whether the step passed.
  await log(taskId, currentStep.status === 'completed' ? 'step_completed' : 'step_failed', {
    stepId: step.id, stepIndex: step.id, runCount: Number(fresh.run_count) + 1, status: currentStep.status,
  });
  const artifact = status === 'completed' ? { title: fresh.title, text: updated.find(item => item.id === 'document').output, mime: 'text/markdown' } : fresh.artifact;
  const now = Date.now();
  const saved = await write(db, `?task_id=eq.${taskId}&status=eq.running`, 'PATCH', {
    steps: updated,
    status,
    artifact: artifact || null,
    error: currentStep.status === 'failed' ? currentStep.error : null,
    run_count: Number(fresh.run_count) + 1,
    updated_at_ms: now,
    ...ending(status, now),
  });
  if (saved instanceof Response) return saved;
  if (!saved) return loadResponse(db, taskId);
  // The three lifecycle values go into the event detail as well as the task row, so the
  // append-only trail alone can answer why a task ended and when. The names match
  // 202611280003_dua_task_links_event_backfill.sql, which backfilled the same keys.
  const lifecycle = terminalDetail(saved);
  if (status === 'completed') await log(taskId, 'completed', { runCount: Number(fresh.run_count) + 1, toStatus: 'completed', ...lifecycle });
  else if (status === 'failed') await log(taskId, 'failed', { runCount: Number(fresh.run_count) + 1, toStatus: 'failed', endReason: 'error', ...lifecycle });
  return Response.json({ task: present(saved) }, { headers: { 'Cache-Control': 'no-store' } });
}

async function cancelTask(db, taskId, log) {
  const now = Date.now();
  const saved = await write(db, `?task_id=eq.${taskId}&status=in.(waiting,running)`, 'PATCH', { status: 'cancelled', end_reason: 'user_stop', stopped_at_ms: now, updated_at_ms: now });
  if (saved instanceof Response) return saved;
  if (!saved) {
    // Stop is idempotent: an already cancelled task is returned as it is.
    const current = await load(db, taskId);
    if (current.status === 'cancelled') return Response.json({ task: present(current) }, { headers: { 'Cache-Control': 'no-store' } });
    return noStore('This task can no longer be cancelled.', 409);
  }
  await log(taskId, 'cancelled', { toStatus: 'cancelled', endReason: 'user_stop', ...terminalDetail(saved) });
  return Response.json({ task: present(saved) }, { headers: { 'Cache-Control': 'no-store' } });
}

async function retryTask(db, taskId, log) {
  const current = await load(db, taskId);
  if (current instanceof Response) return current;
  if (current.status !== 'failed') return noStore('Only a failed task can be retried.', 409);
  if (Number(current.run_count) >= MAX_STEPS) return noStore('This task reached its step limit.', 409);
  let reset = false;
  const steps = current.steps.map(step => {
    if (step.status === 'failed') reset = true;
    if (step.status === 'failed' || (reset && step.status === 'skipped')) return { ...step, status: 'pending', output: '', error: null };
    return step;
  });
  // Item 3.4: a retry is a new attempt, so the counter moves. It is the only column that
  // answers "how many times has this task been tried", which run_count (a step counter) cannot.
  const attempt = Math.max(1, Number(current.attempt) || 1) + 1;
  const saved = await write(db, `?task_id=eq.${taskId}&status=eq.failed`, 'PATCH', { status: 'waiting', steps, error: null, artifact: null, end_reason: null, finished_at_ms: null, stopped_at_ms: null, updated_at_ms: Date.now(), attempt });
  if (saved instanceof Response) return saved;
  if (!saved) return noStore('This task is no longer failed.', 409);
  await log(taskId, 'retry', { fromStatus: 'failed', toStatus: 'waiting', attempt });
  return Response.json({ task: present(saved) }, { headers: { 'Cache-Control': 'no-store' } });
}

function nextStep(steps) {
  const byId = Object.fromEntries(steps.map(step => [step.id, step]));
  for (const step of steps) {
    if (step.status !== 'pending') continue;
    const deps = (step.dependsOn || []).map(id => byId[id]);
    if (deps.some(dep => !dep || dep.status === 'failed' || dep.status === 'skipped')) {
      step.status = 'skipped';
      continue;
    }
    if (deps.every(dep => dep.status === 'completed')) return step;
  }
  return null;
}

function inputsFor(step, steps) {
  const byId = Object.fromEntries(steps.map(item => [item.id, item]));
  if (step.agent === 'checker') return { research: byId.research?.output || '' };
  if (step.agent === 'writer') return { research: byId.research?.output || '', check: byId.check?.output || '' };
  return {};
}

function outcome(steps) {
  if (steps.some(step => step.status === 'failed')) return 'failed';
  if (steps.every(step => step.status === 'completed')) return 'completed';
  if (steps.some(step => step.status === 'pending' || step.status === 'running')) return 'running';
  return 'failed';
}

// The three lifecycle columns as event detail, spelled as 202611280003 backfilled them.
// A null column becomes undefined, which safeDetail skips, so an event that carries no
// terminal value keeps exactly the detail it had before.
function terminalDetail(row) {
  if (!row) return {};
  return {
    end_reason: row.end_reason || undefined,
    finished_at_ms: Number(row.finished_at_ms) || undefined,
    stopped_at_ms: Number(row.stopped_at_ms) || undefined,
  };
}

// Terminal fields: finished_at_ms on completed/failed; end_reason on failure (default error).
function ending(status, now, reason = 'error') {
  if (status === 'completed') return { finished_at_ms: now, end_reason: null };
  if (status === 'failed') return { finished_at_ms: now, end_reason: reason };
  return {};
}

async function finish(db, taskId, current, status, error, reason = 'error', log) {
  const now = Date.now();
  const saved = await write(db, `?task_id=eq.${taskId}&status=eq.running`, 'PATCH', {
    status, error, steps: current.steps, updated_at_ms: now, ...ending(status, now, reason),
  });
  if (saved instanceof Response) return saved;
  if (!saved) return loadResponse(db, taskId);
  // reason === 'timeout' is the one terminal failure that has its own event name.
  const event = status === 'completed' ? 'completed' : reason === 'timeout' ? 'timed_out' : 'failed';
  await log(taskId, event, { fromStatus: 'running', toStatus: status, endReason: reason, ...terminalDetail(saved) });
  return Response.json({ task: present(saved) }, { headers: { 'Cache-Control': 'no-store' } });
}

async function load(db, taskId) {
  const response = await db(`?select=${COLUMNS}&task_id=eq.${taskId}&limit=1`, { method: 'GET' });
  if (!response.ok) throw upstreamFailure(response.status);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw noStore('Dua Agent returned an invalid task.', 502);
  if (!rows[0]) throw noStore('That task was not found.', 404);
  return rows[0];
}

async function loadResponse(db, taskId) {
  try {
    const row = await load(db, taskId);
    return Response.json({ task: present(row) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Response) return error;
    return noStore('Dua Agent is temporarily unavailable. Retry.', 502);
  }
}

// A conditional PATCH that matched no row: 404 when the owner has no such task, else 409.
async function missingOrConflict(db, taskId, conflict) {
  await load(db, taskId);
  return noStore(conflict, 409);
}

async function write(db, query, method, body, { duplicate = false } = {}) {
  const response = await db(query, {
    method,
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  // PostgREST answers a primary-key conflict (23505) with 409.
  if (duplicate && response.status === 409) return DUPLICATE;
  if (!response.ok) return upstreamFailure(response.status);
  const rows = await response.json();
  if (!Array.isArray(rows)) return noStore('Dua Agent did not confirm the saved task.', 502);
  return rows[0] || null;
}

function validPlan(plan, prompt, team = null) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps) || !Array.isArray(plan.agents)) return null;
  if (!team) {
    if (plan.steps.length !== 3 || plan.agents.length !== 3) return null;
    const steps = [];
    for (let index = 0; index < EXPECTED.length; index += 1) {
      const step = plan.steps[index];
      const [id, agent, dependsOn] = EXPECTED[index];
      if (!step || step.id !== id || step.agent !== agent || JSON.stringify(step.dependsOn || []) !== JSON.stringify(dependsOn)) return null;
      const spec = plan.agents.find(item => item && item.id === agent);
      if (!spec || JSON.stringify(spec.tools || []) !== JSON.stringify(AGENTS[agent])) return null;
      if (!clean(spec.can, 200) || !clean(spec.cannot, 200) || !clean(spec.name, 40)) return null;
      steps.push({ id, agent, title: clean(step.title, 80) || spec.name, dependsOn });
    }
    return { title: clean(plan.title, 80) || clean(prompt, 80), agents: plan.agents.map(agent => ({ id: agent.id, name: clean(agent.name, 40), tools: agent.tools, can: clean(agent.can, 200), cannot: clean(agent.cannot, 200) })), steps };
  }
  if (plan.steps.length === 0 || plan.steps.length > MAX_STEPS) return null;
  const steps = [];
  for (const step of plan.steps) {
    if (!step || !step.id || !step.agent) return null;
    const spec = plan.agents.find(item => item && item.id === step.agent);
    if (!spec) return null;
    steps.push({ id: clean(step.id, 40), agent: clean(step.agent, 40), title: clean(step.title, 80) || spec.name, dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn : [] });
  }
  return { title: clean(plan.title, 80) || clean(prompt, 80), agents: plan.agents.map(agent => ({ id: clean(agent.id, 40), name: clean(agent.name, 40), tools: Array.isArray(agent.tools) ? agent.tools : [], can: clean(agent.can, 200), cannot: clean(agent.cannot, 200) })), steps };
}

function present(row) {
  return {
    id: row.task_id,
    title: row.title,
    prompt: row.prompt,
    status: row.status,
    lifecycleStatus: lifecycle(row),
    plan: row.plan,
    steps: row.steps,
    artifact: row.artifact || null,
    error: row.error || null,
    runCount: Number(row.run_count) || 0,
    startedAtMs: Number(row.started_at_ms) || 0,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    finishedAtMs: Number(row.finished_at_ms) || null,
    stoppedAtMs: Number(row.stopped_at_ms) || null,
    endReason: row.end_reason || null,
    // Phase 3 items 3.1 to 3.5. Persisted columns, echoed back so a client can walk a chain.
    parentTaskId: row.parent_task_id || null,
    rootTaskId: row.root_task_id || null,
    continueThreadId: row.continue_thread_id || null,
    attempt: Number(row.attempt) || 1,
    idempotencyKey: row.idempotency_key || null,
    limits: { maxSteps: MAX_STEPS, maxMinutes: MAX_MINUTES },
  };
}

function lifecycle(row) {
  if (row.status === 'failed' && row.end_reason === 'timeout') return 'timed_out';
  return LIFECYCLE[row.status] || 'failed';
}

function clean(value, max, { clip = false, keepLines = false } = {}) {
  if (typeof value !== 'string') return '';
  const normalized = keepLines
    ? value.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    : value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/[ \t]+/g, ' ');
  const text = normalized.trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return clip ? text.slice(0, max) : '';
}

function engineUrl(env, path) {
  return engineEndpoint(env, path)?.href ?? null;
}

function upstreamFailure(status) {
  if (status === 401 || status === 403) return noStore('Session expired. Sign in again to use Dua Agent.', status);
  if (status === 404 || status === 400) return noStore('Dua Agent task storage is not installed. Apply the dua_orhan_tasks migration.', 503);
  return noStore('Dua Agent is temporarily unavailable. Retry.', 502);
}
