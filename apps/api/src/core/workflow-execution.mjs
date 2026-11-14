import { createHash } from 'node:crypto';
import { resolveOwner, StorageError } from './storage.mjs';
import { readJsonLimited } from './limited-json.mjs';
import { killSwitches } from './kill-switches.mjs';
import { browserOriginAllowed } from './cors.mjs';

// Deliberately limited to non-mutating tools. Write approval continuation is not
// supported by this worker; never silently inherit the engine's unrestricted set.
export const WORKFLOW_TOOLS = new Set(['google_search', 'fetch_url', 'list_files', 'read_file', 'search_code', 'list_issues', 'read_issue', 'search_issues', 'search_notes', 'check_pr_ci', 'inspect_pr_ci', 'search_documents']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
export class WorkflowError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}

export function executionConfig(env) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  let admin = /^sb_secret_[A-Za-z0-9_-]+$/.test(key);
  try { admin ||= JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role === 'service_role'; } catch {}
  let url;
  try { url = new URL(base); } catch {}
  if (!url || url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash || !admin)
    throw new WorkflowError('Workflow execution storage is not configured.');
  return { base, key };
}

export async function executionDb(path, { env, fetcher = fetch, method = 'POST', body, signal, single = false } = {}) {
  const { base, key } = executionConfig(env);
  const response = await fetcher(`${base}/rest/v1/${path}`, {
    method, redirect: 'error', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: single ? 'application/vnd.pgrst.object+json' : 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)]),
  });
  const data = await readJsonLimited(response, 2 * 1024 * 1024);
  if (!response.ok) {
    const reason = String(data?.message || '');
    if (reason.includes('idempotency_conflict')) throw new WorkflowError('This request key was already used for a different workflow definition.', 409);
    if (reason.includes('workflow_active') || data?.code === '23505') throw new WorkflowError('This workflow already has an active execution. Open history before starting another.', 409);
    if (reason.includes('run_missing')) throw new WorkflowError('Workflow run not found.', 404);
    if (reason.includes('schedule_past')) throw new WorkflowError('Choose a future one-shot schedule time.', 400);
    if (reason.includes('automation_revision_conflict') || reason.includes('automation_kind_conflict')) throw new WorkflowError('Automation was changed by another request. Refresh its revision before editing.', 409);
    if (reason.includes('automation_disabled')) throw new WorkflowError('This workflow trigger is disabled.', 409);
    if (reason.includes('lease_lost')) throw new WorkflowError('Worker lease lost. Execution stopped.', 409);
    throw new WorkflowError('Workflow storage is unavailable. Check the workflow migrations and server configuration.');
  }
  return data;
}

export function normalizeDefinition(data) {
  if (!str(data?.workflowId, 100) || !str(data?.title, 120) || !str(data?.requestKey, 100)) throw new WorkflowError('Workflow ID, title and request key are required.', 400);
  if (!Array.isArray(data.steps) || data.steps.length < 1 || data.steps.length > 8) throw new WorkflowError('Include between 1 and 8 ordered agent steps.', 400);
  const ids = new Set();
  const steps = data.steps.map(s => {
    if (!str(s?.id, 100) || ids.has(s.id) || !str(s.agentName, 100) || !str(s.prompt, 4000) || typeof s.instructions !== 'string' || s.instructions.length > 8000 || !Array.isArray(s.allowedTools) || s.allowedTools.length > 30 || new Set(s.allowedTools).size !== s.allowedTools.length)
      throw new WorkflowError('Invalid agent step. Explicit tool selection is required.', 400);
    ids.add(s.id);
    if (s.allowedTools.some(t => !WORKFLOW_TOOLS.has(t))) throw new WorkflowError('A selected tool requires unsupported workflow approval or is unavailable. Use a supported read tool or normal Agent chat.', 422);
    return { id: s.id, agentId: typeof s.agentId === 'string' ? s.agentId.slice(0, 100) : null, agentName: s.agentName, prompt: s.prompt, instructions: s.instructions, allowedTools: [...s.allowedTools].sort() };
  });
  const trigger = data.trigger ?? { type: 'manual' };
  if (!['manual', 'event', 'once'].includes(trigger.type)) throw new WorkflowError('Supported triggers: manual, authenticated event, one-shot UTC schedule. Recurring cron is not supported.', 422);
  if (trigger.type === 'event' && !str(trigger.eventId, 100)) throw new WorkflowError('Event ID is required; reuse its request key on redelivery.', 400);
  if (trigger.type === 'once' && (typeof trigger.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(trigger.at))) throw new WorkflowError('Use an ISO UTC schedule time ending in Z.', 400);
  const due = trigger.type === 'once' ? Date.parse(trigger.at) : null;
  // The enqueue transaction checks future time only for NEW requests, so a
  // redelivery after the scheduled time still returns the original run.
  if (trigger.type === 'once' && (!Number.isFinite(due) || due > Date.now() + 366 * 86400000)) throw new WorkflowError('Choose a valid one-shot time within one year.', 400);
  if (trigger.type === 'once' && new Date(due).toISOString().slice(0, 19) !== trigger.at.slice(0, 19)) throw new WorkflowError('Choose a valid calendar date and time.', 400);
  return { steps, trigger: trigger.type === 'once' ? { type: 'once', at: new Date(due).toISOString() } : trigger.type === 'event' ? { type: 'event', eventId: trigger.eventId } : { type: 'manual' } };
}

export function publicExecution(row) {
  return { id: row.id, workflowId: row.workflow_id, title: row.title, status: row.status, steps: row.steps,
    attempt: row.attempt, cancelRequested: row.cancel_requested, createdAt: row.created_at, updatedAt: row.updated_at,
    dueAt: row.due_at, finishedAt: row.finished_at, error: row.error, trigger: row.definition?.trigger };
}

export async function handleWorkflowExecution(request, { env = process.env, fetcher = fetch } = {}) {
  try {
    // Bearer native clients and same-origin browser sessions only.
    const url = new URL(request.url);
    if (!browserOriginAllowed(request, url, env)) return reply({ error: 'Request origin is not allowed.' }, 403);
    const owner = await resolveOwner(request, { env, fetcher, feature: 'workflow execution' });
    const opts = { env, fetcher, signal: request.signal };
    const suffix = url.pathname.slice('/api/workflow-executions'.length);
    if (request.method === 'GET' && suffix === '') {
      const filter = url.searchParams.get('workflowId');
      if (filter && filter.length > 100) return reply({ error: 'Invalid workflow ID.' }, 400);
      const rows = await executionDb('rpc/dua_workflow_history', { ...opts, body: { p_owner: owner.user.id, p_workflow: filter || null } });
      return reply({ runs: rows.map(publicExecution), supportedTools: [...WORKFLOW_TOOLS] });
    }
    if (request.method === 'GET' && uuid.test(suffix.slice(1))) {
      const rows = await executionDb(`dua_workflow_executions?owner_id=eq.${encodeURIComponent(owner.user.id)}&id=eq.${suffix.slice(1)}&select=id,workflow_id,title,status,steps,attempt,cancel_requested,created_at,updated_at,due_at,finished_at,error`, { ...opts, method: 'GET' });
      return rows.length ? reply({ run: publicExecution(rows[0]) }) : reply({ error: 'Workflow run not found.' }, 404);
    }
    if (request.method !== 'POST') return reply({ error: 'Method not allowed.' }, 405);
    const control = /^\/([0-9a-f-]+)\/(cancel|retry)$/.exec(suffix);
    if (control && uuid.test(control[1])) {
      if (control[2] === 'retry') requireEnabled(env);
      const controlBody = await readJsonLimited(request, 1024);
      if (!Number.isSafeInteger(controlBody?.expectedAttempt) || controlBody.expectedAttempt < 1) return reply({ error: 'Expected attempt is required.' }, 400);
      // Explicit retry resumes the same run; repeated retry while active is a no-op.
      const row = await executionDb('rpc/dua_workflow_control', { ...opts, single: true, body: { p_owner: owner.user.id, p_id: control[1], p_action: control[2], p_expected_attempt: controlBody.expectedAttempt } });
      return reply({ run: publicExecution(row) });
    }
    if (suffix !== '') return reply({ error: 'Not found.' }, 404);
    requireEnabled(env);
    const data = await readJsonLimited(request, 128 * 1024);
    const definition = normalizeDefinition(data);
    const fingerprint = createHash('sha256').update(JSON.stringify({ workflowId: data.workflowId, title: data.title, definition })).digest('hex');
    const requestKey = definition.trigger.type === 'event'
      ? 'event-' + createHash('sha256').update(JSON.stringify([data.workflowId, definition.trigger.eventId])).digest('hex')
      : data.requestKey;
    const row = await executionDb('rpc/dua_workflow_enqueue', { ...opts, single: true, body: {
      p_owner: owner.user.id, p_workflow: data.workflowId, p_title: data.title, p_key: requestKey,
      p_fingerprint: fingerprint, p_definition: definition, p_due: definition.trigger.at || new Date().toISOString(),
    } });
    return reply({ run: publicExecution(row) }, 202);
  } catch (e) {
    if (e instanceof SyntaxError) return reply({ error: 'Invalid workflow JSON.' }, 400);
    if (e.status === 413) return reply({ error: 'Workflow request is too large.' }, 413);
    return reply({ error: e instanceof WorkflowError || e instanceof StorageError ? e.message : 'Workflow execution is unavailable. Retry with the same request key.' }, e.status || 503);
  }
}

export function requireEnabled(env) {
  if (env.DUA_WORKFLOWS_ENABLED !== '1') throw new WorkflowError('Workflow worker is not enabled on this service.');
  const switches = killSwitches(env);
  if (switches.maintenance.enabled || switches.agent) throw new WorkflowError('Workflow execution is paused by the service.');
}
