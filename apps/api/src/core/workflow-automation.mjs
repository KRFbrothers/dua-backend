import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolveOwner, StorageError } from './storage.mjs';
import { readJsonLimited } from './limited-json.mjs';
import { executionDb, normalizeDefinition, requireEnabled, WorkflowError } from './workflow-execution.mjs';
import { browserOriginAllowed } from './cors.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
export function publicAutomation(r) {
  return { id: r.id, workflowId: r.workflow_id, title: r.title, kind: r.kind, enabled: r.enabled, revision: r.revision,
    intervalSeconds: r.interval_seconds, startAt: r.start_at, nextDue: r.next_due, lastEnqueuedAt: r.last_enqueued_at, lastSkippedAt: r.last_skipped_at };
}

async function webhook(request, id, { env, fetcher }) {
  if (request.method !== 'POST') return reply({ error: 'Method not allowed.' }, 405);
  requireEnabled(env);
  if (env.DUA_WORKFLOW_EXTERNAL_TRIGGERS_ENABLED !== '1') return reply({ error: 'External workflow triggers are disabled.' }, 503);
  if (!uuid.test(env.DUA_WORKFLOW_OWNER_ID || '')) return reply({ error: 'External trigger owner identity is not configured.' }, 503);
  let keys;
  try { keys = JSON.parse(env.DUA_WORKFLOW_WEBHOOK_KEYS_JSON || '{}'); } catch {}
  const key = keys?.[id], timestamp = request.headers.get('x-dua-timestamp') || '', signature = request.headers.get('x-dua-signature') || '';
  if (typeof key !== 'string' || Buffer.byteLength(key) < 32 || !/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^[0-9a-f]{64}$/.test(signature))
    return reply({ error: 'Signed workflow delivery authentication failed.' }, 401);
  // Bound raw signed bytes before parsing. No prompt, tools or owner fields from senders.
  const raw = await boundedBody(request, 8192);
  const expected = createHmac('sha256', key).update(`${timestamp}\n${id}\n`).update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return reply({ error: 'Signed workflow delivery authentication failed.' }, 401);
  const data = JSON.parse(raw.toString('utf8'));
  if (!data || typeof data.eventId !== 'string' || !data.eventId.trim() || data.eventId.length > 100 || Object.keys(data).some(k => k !== 'eventId'))
    return reply({ error: 'Only a stable eventId is accepted. Event payloads cannot change workflow instructions.' }, 400);
  const run = await executionDb('rpc/dua_workflow_deliver', { env, fetcher, signal: request.signal, body: { p_owner: env.DUA_WORKFLOW_OWNER_ID, p_id: id, p_event: data.eventId } });
  return reply({ runId: run.id, status: run.status }, 202);
}

async function boundedBody(request, limit) {
  const reader = request.body?.getReader();
  if (!reader) throw new WorkflowError('Delivery body is required.', 400);
  const parts = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) throw new WorkflowError('Delivery is too large.', 413);
      parts.push(value);
    }
    return Buffer.concat(parts);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function handleWorkflowAutomation(request, { env = process.env, fetcher = fetch } = {}) {
  try {
    const url = new URL(request.url), suffix = url.pathname.slice('/api/workflow-automation'.length);
    const delivery = /^\/deliver\/([^/]+)$/.exec(suffix);
    if (delivery && uuid.test(delivery[1])) return await webhook(request, delivery[1], { env, fetcher });
    if (!browserOriginAllowed(request, url, env)) return reply({ error: 'Request origin is not allowed.' }, 403);
    const owner = await resolveOwner(request, { env, fetcher, feature: 'workflow automation' });
    const opts = { env, fetcher, signal: request.signal };
    if (request.method === 'GET' && suffix === '') {
      const filter = url.searchParams.get('workflowId');
      if (filter && filter.length > 100) return reply({ error: 'Invalid workflow ID.' }, 400);
      const rows = await executionDb(`dua_workflow_automation?owner_id=eq.${owner.user.id}${filter ? `&workflow_id=eq.${encodeURIComponent(filter)}` : ''}&select=id,workflow_id,title,kind,enabled,revision,interval_seconds,start_at,next_due,last_enqueued_at,last_skipped_at&order=updated_at.desc&limit=100`, { ...opts, method: 'GET' });
      return reply({ registrations: rows.map(publicAutomation) });
    }
    const path = /^\/(schedules|triggers)\/([^/]+)(\/disable)?$/.exec(suffix);
    if (!path || !uuid.test(path[2])) return reply({ error: 'Not found.' }, 404);
    if (request.method !== (path[3] ? 'POST' : 'PUT')) return reply({ error: 'Method not allowed.' }, 405);
    const data = await readJsonLimited(request, 128 * 1024);
    if (!Number.isSafeInteger(data?.expectedRevision) || data.expectedRevision < 0) return reply({ error: 'Expected revision is required.' }, 400);
    if (path[3]) {
      const r = await executionDb('rpc/dua_workflow_automation_disable', { ...opts, body: { p_owner: owner.user.id, p_id: path[2], p_revision: data.expectedRevision } });
      return reply({ registration: publicAutomation(r) });
    }
    requireEnabled(env);
    if (['trigger', 'cron', 'timezone'].some(k => Object.hasOwn(data, k))) return reply({ error: 'Only fixed UTC intervals and signed event deliveries are supported. Cron/timezone rules are unsupported.' }, 422);
    const definition = normalizeDefinition({ ...data, requestKey: path[2], trigger: { type: 'manual' } });
    const interval = path[1] === 'schedules';
    if (!interval && ['intervalSeconds', 'startAt'].some(k => Object.hasOwn(data, k))) return reply({ error: 'External triggers do not accept schedule fields.' }, 400);
    let due = null;
    if (interval) {
      if (!Number.isSafeInteger(data.intervalSeconds) || data.intervalSeconds < 300 || data.intervalSeconds > 2678400) return reply({ error: 'Repeat interval must be between 300 and 2678400 seconds.' }, 400);
      due = normalizeDefinition({ ...data, requestKey: path[2], trigger: { type: 'once', at: data.startAt } }).trigger.at;
    }
    if (typeof data.enabled !== 'boolean') return reply({ error: 'Enabled must be explicit.' }, 400);
    const r = await executionDb('rpc/dua_workflow_register', { ...opts, body: {
      p_owner: owner.user.id, p_id: path[2], p_revision: data.expectedRevision, p_kind: interval ? 'interval' : 'webhook', p_workflow: data.workflowId,
      p_title: data.title, p_definition: definition, p_interval: interval ? data.intervalSeconds : null, p_due: due, p_enabled: data.enabled,
    } });
    return reply({ registration: publicAutomation(r) });
  } catch (e) {
    if (e instanceof SyntaxError) return reply({ error: 'Invalid automation JSON.' }, 400);
    return reply({ error: e instanceof WorkflowError || e instanceof StorageError ? e.message : 'Workflow automation is unavailable. Check authentication and configuration.' }, e.status || 503);
  }
}
