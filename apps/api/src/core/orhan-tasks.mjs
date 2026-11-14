// Orhan tasks share the owner's Supabase login. Dua chat is a different route.
// The engine plans and runs one step. This API saves the task so a closed app can resume it.
import { readJsonLimited } from './limited-json.mjs';
import { resolveOwner, StorageError } from './storage.mjs';

const DEFAULT_ENGINE_URL = 'https://dua-ai-engine-228305912525.us-central1.run.app';

const MAX_STEPS = 12;
const MAX_MINUTES = 10;
const MAX_OUTPUT = 12000;
const noStore = (error, status, extra = {}) => Response.json({ error, ...extra }, { status, headers: { 'Cache-Control': 'no-store' } });
const inflight = new Set();
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
  if (parts.length === 4 || (parts.length === 5 && !['start', 'continue', 'cancel', 'retry'].includes(action)) || (taskId && !UUID.test(taskId))) return noStore('Not found.', 404);
  if (parts.length === 3 && !['GET', 'POST'].includes(request.method)) return noStore('Method not allowed.', 405);
  if (parts.length === 5 && request.method !== 'POST') return noStore('Method not allowed.', 405);

  let owner;
  try { owner = await resolveOwner(request, { env, fetcher, feature: 'Dua Agent' }); }
  catch (error) { return noStore(error instanceof StorageError ? error.message : 'Account verification is unavailable. Retry.', error.status || 503); }

  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_ANON_KEY || '');
  if (!base.startsWith('https://') || !key || key.startsWith('sb_secret_')) return noStore('Dua Agent task storage is not configured.', 503);
  const endpoint = `${base}/rest/v1/dua_orhan_tasks`;
  const headers = { apikey: key, Authorization: `Bearer ${owner.token}`, Accept: 'application/json' };
  const db = (path, init) => fetcher(endpoint + path, { redirect: 'error', ...init, headers: { ...headers, ...(init.headers || {}) }, signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]) });

  const lockKey = `${owner.user.id}:${taskId || 'list'}`;
  if (action === 'start' || action === 'continue' || action === 'retry') {
    if (inflight.has(lockKey)) return noStore('Dua Agent is already working on this task.', 409);
    inflight.add(lockKey);
  }
  try {
    if (request.method === 'GET') return await listTasks(db);
    if (parts.length === 3) return await createTask(request, db, owner, env, fetcher);
    if (action === 'start') return await startTask(db, owner.user.id, taskId);
    if (action === 'continue') return await continueTask(db, taskId, env, fetcher, owner.token);
    if (action === 'cancel') return await cancelTask(db, taskId);
    return await retryTask(db, taskId);
  } catch (error) {
    if (error instanceof Response) return error;
    return noStore('Dua Agent is temporarily unavailable. Retry.', 502);
  } finally {
    inflight.delete(lockKey);
  }
}

async function listTasks(db) {
  const response = await db('?select=task_id,title,prompt,status,plan,steps,artifact,error,run_count,started_at_ms,created_at_ms,updated_at_ms&order=updated_at_ms.desc&limit=30', { method: 'GET' });
  if (!response.ok) return upstreamFailure(response.status);
  const rows = await response.json();
  if (!Array.isArray(rows)) return noStore('Dua Agent returned an invalid task list.', 502);
  return Response.json({ tasks: rows.map(present) }, { headers: { 'Cache-Control': 'no-store' } });
}

async function createTask(request, db, owner, env, fetcher) {
  let data;
  try { data = await readJsonLimited(request, 16 * 1024); }
  catch (error) { return noStore(error.status === 413 ? 'The job is too long.' : 'Invalid job.', error.status || 400); }
  if (typeof data?.prompt === 'string' && data.prompt.trim().length > 4000) return noStore('The job is too long.', 413);
  const prompt = clean(data?.prompt, 4000, { keepLines: true });
  if (!prompt) return noStore('Tell Dua Agent what to do.', 400);
  const team = Array.isArray(data?.team) ? data.team : null;
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
  const row = {
    owner_id: owner.user.id,
    task_id: crypto.randomUUID(),
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
  };
  const saved = await write(db, '', 'POST', row);
  if (saved instanceof Response) return saved;
  return Response.json({ task: present(saved) }, { headers: { 'Cache-Control': 'no-store' } });
}

async function startTask(db, ownerId, taskId) {
  const running = await db(`?select=task_id&owner_id=eq.${ownerId}&status=eq.running&limit=1`, { method: 'GET' });
  if (!running.ok) return upstreamFailure(running.status);
  const active = await running.json();
  if (!Array.isArray(active)) return noStore('Dua Agent returned an invalid task list.', 502);
  if (active.length) return noStore('Dua Agent is already running a task. Wait for it to finish or cancel it.', 409);
  const now = Date.now();
  const saved = await write(db, `?task_id=eq.${taskId}&status=eq.waiting`, 'PATCH', { status: 'running', error: null, started_at_ms: now, updated_at_ms: now });
  if (saved instanceof Response) return saved;
  if (!saved) return noStore('This task is no longer waiting.', 409);
  return Response.json({ task: present(saved) }, { headers: { 'Cache-Control': 'no-store' } });
}

async function continueTask(db, taskId, env, fetcher, token) {
  const current = await load(db, taskId);
  if (current instanceof Response) return current;
  if (current.status !== 'running') return noStore('Start the task first.', 409);
  if (Date.now() - Number(current.started_at_ms) > MAX_MINUTES * 60 * 1000) {
    return await finish(db, taskId, current, 'failed', 'This task reached its 10 minute limit.');
  }
  if (Number(current.run_count) >= MAX_STEPS) {
    return await finish(db, taskId, current, 'failed', 'This task reached its step limit.');
  }
  const steps = current.steps.map(step => ({ ...step }));
  const step = nextStep(steps);
  if (!step) return await finish(db, taskId, { ...current, steps }, outcome(steps), current.error);
  const target = engineUrl(env, '/api/orhan/step');
  if (!target) return noStore('Dua Agent\'s AI engine is not configured.', 503);
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
  const artifact = status === 'completed' ? { title: fresh.title, text: updated.find(item => item.id === 'document').output, mime: 'text/markdown' } : fresh.artifact;
  const saved = await write(db, `?task_id=eq.${taskId}&status=eq.running`, 'PATCH', {
    steps: updated,
    status,
    artifact: artifact || null,
    error: currentStep.status === 'failed' ? currentStep.error : null,
    run_count: Number(fresh.run_count) + 1,
    updated_at_ms: Date.now(),
  });
  if (saved instanceof Response) return saved;
  if (!saved) return loadResponse(db, taskId);
  return Response.json({ task: present(saved) }, { headers: { 'Cache-Control': 'no-store' } });
}

async function cancelTask(db, taskId) {
  const saved = await write(db, `?task_id=eq.${taskId}&status=in.(waiting,running)`, 'PATCH', { status: 'cancelled', updated_at_ms: Date.now() });
  if (saved instanceof Response) return saved;
  if (!saved) return noStore('This task can no longer be cancelled.', 409);
  return Response.json({ task: present(saved) }, { headers: { 'Cache-Control': 'no-store' } });
}

async function retryTask(db, taskId) {
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
  const saved = await write(db, `?task_id=eq.${taskId}&status=eq.failed`, 'PATCH', { status: 'waiting', steps, error: null, artifact: null, updated_at_ms: Date.now() });
  if (saved instanceof Response) return saved;
  if (!saved) return noStore('This task is no longer failed.', 409);
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

async function finish(db, taskId, current, status, error) {
  const saved = await write(db, `?task_id=eq.${taskId}&status=eq.running`, 'PATCH', {
    status, error, steps: current.steps, updated_at_ms: Date.now(),
  });
  if (saved instanceof Response) return saved;
  if (!saved) return loadResponse(db, taskId);
  return Response.json({ task: present(saved) }, { headers: { 'Cache-Control': 'no-store' } });
}

async function load(db, taskId) {
  const response = await db(`?select=task_id,title,prompt,status,plan,steps,artifact,error,run_count,started_at_ms,created_at_ms,updated_at_ms&task_id=eq.${taskId}&limit=1`, { method: 'GET' });
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

async function write(db, query, method, body) {
  const response = await db(query, {
    method,
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
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
    plan: row.plan,
    steps: row.steps,
    artifact: row.artifact || null,
    error: row.error || null,
    runCount: Number(row.run_count) || 0,
    startedAtMs: Number(row.started_at_ms) || 0,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    limits: { maxSteps: MAX_STEPS, maxMinutes: MAX_MINUTES },
  };
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

function engineHeaders(env, token) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` };
  if (env.DUA_APP_TOKEN) headers['X-Dua-App-Token'] = env.DUA_APP_TOKEN;
  return headers;
}

function engineUrl(env, path) {
  try {
    const url = new URL(String(env.DUA_ENGINE_URL || DEFAULT_ENGINE_URL));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) return null;
    return new URL(path, url.origin).href;
  } catch { return null; }
}

function upstreamFailure(status) {
  if (status === 401 || status === 403) return noStore('Session expired. Sign in again to use Dua Agent.', status);
  if (status === 404 || status === 400) return noStore('Dua Agent task storage is not installed. Apply the Dua Orhan tasks migration.', 503);
  return noStore('Dua Agent is temporarily unavailable. Retry.', 502);
}
