import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolveOwner, StorageError } from './storage.mjs';
import { readJsonLimited } from './limited-json.mjs';
import { agentTriggerDefinition, enqueueExecution, executionConfig, executionDb, normalizeDefinition, requireEnabled, WorkflowError } from './workflow-execution.mjs';
import { createWorkflowIdentity } from './workflow-identity.mjs';
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
  const session = await createWorkflowIdentity({ env, fetcher }).getOwner(env, fetcher, request.signal);
  if (session.user.id !== env.DUA_WORKFLOW_OWNER_ID) throw new WorkflowError('Worker session does not belong to its configured owner.', 403);
  const run = await executionDb('rpc/dua_workflow_deliver', { env, fetcher, signal: request.signal, token: session.token, body: { p_owner: session.user.id, p_id: id, p_event: data.eventId } });
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
    const opts = { env, fetcher, signal: request.signal, token: owner.token };
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

// ---------------------------------------------------------------------------
// K6: PR H schedule triggers (dua_agent_triggers.trigger_type = 'schedule').
// cron_expr is a 5-field cron (minute hour day-of-month month day-of-week), always read in
// Asia/Kolkata (IST, UTC+05:30, no DST). Supported: *, numbers, lists (a,b), ranges (a-b),
// steps (*/n, a-b/n); day-of-week 0-7 (0 and 7 = Sunday). Names (MON, JAN) and macros are not
// supported: such triggers are skipped and logged by the worker, the API still accepts them.
// ---------------------------------------------------------------------------
const IST_OFFSET_MS = 330 * 60 * 1000;
const CRON_FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const CRON_LOOKBACK_DAYS = 366;

function cronField(text, [min, max]) {
  const values = new Set();
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    let lo = min, hi = max;
    if (m[1] !== '*') { lo = Number(m[2]); hi = m[3] === undefined ? (m[4] ? max : lo) : Number(m[3]); }
    const step = m[4] === undefined ? 1 : Number(m[4]);
    if (lo < min || hi > max || lo > hi || step < 1) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

/** Parses a 5-field IST cron expression; returns null when it is not supported. */
export function parseCron(expr) {
  if (typeof expr !== 'string' || expr.length > 120) return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields = parts.map((part, i) => cronField(part, CRON_FIELDS[i]));
  if (fields.some(f => !f || !f.size)) return null;
  const [minutes, hours, dom, months, dowRaw] = fields;
  const dow = new Set([...dowRaw].map(d => d % 7));
  return { minutes, hours, dom, months, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

function cronDayMatches(cron, date) {
  if (!cron.months.has(date.getUTCMonth() + 1)) return false;
  const domOk = cron.dom.has(date.getUTCDate()), dowOk = cron.dow.has(date.getUTCDay());
  // Standard cron: when both day fields are restricted, either one may match.
  if (cron.domAny || cron.dowAny) return (cron.domAny || domOk) && (cron.dowAny || dowOk);
  return domOk || dowOk;
}

/** Latest IST cron slot at or before `now` (UTC Date), or null if none in the last year. */
export function latestCronSlot(cron, now = new Date()) {
  const local = new Date(Math.floor((now.getTime() + IST_OFFSET_MS) / 60000) * 60000);
  const hours = [...cron.hours].sort((a, b) => b - a), minutes = [...cron.minutes].sort((a, b) => b - a);
  for (let day = 0; day <= CRON_LOOKBACK_DAYS; day++) {
    const date = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - day));
    if (!cronDayMatches(cron, date)) continue;
    for (const h of hours) {
      if (day === 0 && h > local.getUTCHours()) continue;
      for (const m of minutes) {
        if (day === 0 && h === local.getUTCHours() && m > local.getUTCMinutes()) continue;
        return new Date(date.getTime() + (h * 60 + m) * 60000 - IST_OFFSET_MS);
      }
    }
  }
  return null;
}

/**
 * Worker tick (only with DUA_WORKFLOW_AUTOMATION_ENABLED=1): for each enabled schedule trigger of the
 * owner, queue only the latest due IST slot that is newer than last_run_at (or created_at). Request key
 * trg:<id>:<slotEpoch> makes redelivery idempotent; an already active run for the trigger is skipped.
 */
export async function tickAgentTriggers({ owner, env, fetcher = fetch, signal, now = new Date(), log = () => {} }) {
  const { base, key } = executionConfig(env);
  const ownerId = encodeURIComponent(owner.user.id);
  const headers = { apikey: key, Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' };
  const sig = () => AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)]);
  const list = await fetcher(`${base}/rest/v1/dua_agent_triggers?select=id,agent_id,conversation_id,trigger_type,cron_expr,prompt,last_run_at,created_at&owner_id=eq.${ownerId}&trigger_type=eq.schedule&enabled=is.true&order=created_at.asc&limit=100`,
    { headers, redirect: 'error', signal: sig() });
  if (!list.ok) throw new WorkflowError('Agent triggers are unavailable.');
  const triggers = await list.json();
  let agents = null;
  let queued = 0;
  for (const trigger of Array.isArray(triggers) ? triggers : []) {
    const cron = parseCron(trigger.cron_expr);
    if (!cron) { log('trigger_cron_invalid', { triggerId: trigger.id }); continue; }
    const slot = latestCronSlot(cron, now);
    const since = Date.parse(trigger.last_run_at || trigger.created_at || '');
    if (!slot || (Number.isFinite(since) && slot.getTime() <= since)) continue;
    if (agents === null) {
      const res = await fetcher(`${base}/rest/v1/dua_agents?select=id,name&owner_id=eq.${ownerId}&limit=200`, { headers, redirect: 'error', signal: sig() });
      agents = new Map((res.ok ? await res.json() : []).map(a => [a.id, a.name]));
    }
    const slotEpoch = Math.floor(slot.getTime() / 1000);
    try {
      const job = agentTriggerDefinition(trigger, agents.get(trigger.agent_id) || trigger.agent_id);
      await enqueueExecution({ ownerId: owner.user.id, requestKey: `trg:${trigger.id}:${slotEpoch}`, ...job }, { env, fetcher, signal, token: owner.token });
      queued++;
    } catch (e) {
      log(e?.status === 409 ? 'trigger_run_active' : 'trigger_enqueue_failed', { triggerId: trigger.id });
      if (e?.status !== 409) continue;
    }
    // Mark the slot as handled (also when a run was still active) so it is not retried every tick.
    await fetcher(`${base}/rest/v1/dua_agent_triggers?id=eq.${encodeURIComponent(trigger.id)}&owner_id=eq.${ownerId}`, {
      method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' }, redirect: 'error', signal: sig(),
      body: JSON.stringify({ last_run_at: slot.toISOString() }),
    }).catch(() => log('trigger_mark_failed', { triggerId: trigger.id }));
  }
  return queued;
}
