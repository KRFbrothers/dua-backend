import { readJsonLimited } from './limited-json.mjs';
import { resolveOwner, StorageError } from './storage.mjs';

const noStore = (error, status) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
const statuses = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']);
const text = (value, max, { optional = false } = {}) => {
  if (optional && (value === null || value === undefined || value === '')) return null;
  return typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : undefined;
};

export async function handleWorkflowRuns(request, { env = process.env, fetcher = fetch } = {}) {
  if (!['GET', 'PUT'].includes(request.method)) return noStore('Method not allowed.', 405);
  let owner;
  try { owner = await resolveOwner(request, { env, fetcher, feature: 'workflow history' }); }
  catch (error) { return noStore(error instanceof StorageError ? error.message : 'Account verification is unavailable. Retry.', error.status || 503); }

  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_ANON_KEY || '');
  if (!base.startsWith('https://') || !key || key.startsWith('sb_secret_')) return noStore('Workflow history storage is not configured.', 503);
  const endpoint = `${base}/rest/v1/dua_workflow_runs`;
  const headers = { apikey: key, Authorization: `Bearer ${owner.token}`, Accept: 'application/json' };

  try {
    if (request.method === 'GET') {
      const response = await fetcher(`${endpoint}?select=run_id,workflow_id,workflow_title,chat_title,agent_id,agent_name,status,started_at_ms,finished_at_ms,error,engine_run_id&order=started_at_ms.desc&limit=100`, {
        method: 'GET', redirect: 'error', headers, signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)])
      });
      if (!response.ok) return upstreamFailure(response.status);
      const rows = await response.json();
      if (!Array.isArray(rows)) return noStore('Workflow history returned an invalid response.', 502);
      return Response.json({ runs: rows.map(fromRow) }, { headers: { 'Cache-Control': 'no-store' } });
    }

    let data;
    try { data = await readJsonLimited(request, 64 * 1024); }
    catch (error) { return noStore(error.status === 413 ? 'Workflow run is too large.' : 'Invalid workflow run.', error.status || 400); }
    const values = Array.isArray(data?.runs) ? data.runs : [data];
    if (values.length < 1 || values.length > 100) return noStore('Include between 1 and 100 workflow runs.', 400);
    const rows = values.map(toRow);
    if (rows.some(row => !row)) return noStore('Invalid workflow run.', 400);
    const response = await fetcher(`${endpoint}?on_conflict=owner_id,run_id`, {
      method: 'POST', redirect: 'error',
      headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(rows.map(row => ({ ...row, owner_id: owner.user.id }))),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)])
    });
    if (!response.ok) return upstreamFailure(response.status);
    const saved = await response.json();
    if (!Array.isArray(saved) || saved.length !== rows.length) return noStore('Workflow history did not confirm the saved run.', 502);
    return Response.json({ runs: saved.map(fromRow) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return noStore('Workflow history is temporarily unavailable. Retry.', 502);
  }
}

function toRow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const runId = text(value.runId, 100), workflowId = text(value.workflowId, 100);
  const workflowTitle = text(value.workflowTitle, 120), chatTitle = text(value.chatTitle, 120);
  const agentName = text(value.agentName, 100), agentId = text(value.agentId, 100, { optional: true });
  const status = typeof value.status === 'string' ? value.status.toLowerCase() : '';
  const startedAtMs = value.startedAtMs, finishedAtMs = value.finishedAtMs ?? 0;
  const error = text(value.error, 300, { optional: true }), engineRunId = text(value.engineRunId, 100, { optional: true });
  if (!runId || !workflowId || !workflowTitle || !chatTitle || !agentName || agentId === undefined || error === undefined || engineRunId === undefined || !statuses.has(status) || !Number.isSafeInteger(startedAtMs) || startedAtMs <= 0 || !Number.isSafeInteger(finishedAtMs) || finishedAtMs < 0) return null;
  return { run_id: runId, workflow_id: workflowId, workflow_title: workflowTitle, chat_title: chatTitle, agent_id: agentId, agent_name: agentName, status, started_at_ms: startedAtMs, finished_at_ms: finishedAtMs, error, engine_run_id: engineRunId };
}

function fromRow(row) {
  return { runId: row.run_id, workflowId: row.workflow_id, workflowTitle: row.workflow_title, chatTitle: row.chat_title, agentId: row.agent_id, agentName: row.agent_name, status: row.status, startedAtMs: Number(row.started_at_ms), finishedAtMs: Number(row.finished_at_ms), error: row.error, engineRunId: row.engine_run_id };
}

function upstreamFailure(status) {
  if (status === 401 || status === 403) return noStore('Session expired or workflow history access was refused. Sign in again.', status);
  if (status === 404 || status === 400) return noStore('Workflow history storage is not installed. Apply the Dua workflow history migration.', 503);
  return noStore('Workflow history is temporarily unavailable. Retry.', 502);
}
