import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleWorkflowAutomation, latestCronSlot, parseCron, tickAgentTriggers } from '../src/core/workflow-automation.mjs';
import { runWorkerOnce } from '../src/core/workflow-worker.mjs';
import { filesEnv, router, SUPA, UID } from './files-helpers.mjs';
import { sealSession } from '../src/core/workflow-identity.mjs';

const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const secret = 'synthetic-test-signing-secret-not-valid-production';
const PROJECT = 'dua-test-project';
const env = { ...filesEnv, DUA_WORKFLOW_OWNER_ID: UID, DUA_WORKFLOWS_ENABLED: '1', DUA_WORKFLOW_EXTERNAL_TRIGGERS_ENABLED: '1', DUA_WORKFLOW_WEBHOOK_KEYS_JSON: JSON.stringify({ [id]: secret }), DUA_WORKFLOW_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'), GOOGLE_CLOUD_PROJECT: PROJECT };
const accessToken = 'fixture.' + Buffer.from(JSON.stringify({ sub: UID, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.fixture';
function ownerSessionRoutes() {
  const sealed = sealSession({ access_token: accessToken, refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600 }, env);
  return [
    ['http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', () => Response.json({ access_token: 'metadata-token' })],
    [`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/DUA_WORKFLOW_OWNER_SESSION/versions/latest:access`, () => Response.json({ payload: { data: Buffer.from(sealed, 'utf8').toString('base64') } })],
  ];
}
function signed(body = { eventId: 'delivery-1' }, timestamp = String(Math.floor(Date.now() / 1000))) {
  const raw = JSON.stringify(body);
  return new Request(`https://dua.test/api/workflow-automation/deliver/${id}`, { method: 'POST', body: raw, headers: {
    'x-dua-timestamp': timestamp, 'x-dua-signature': createHmac('sha256', secret).update(`${timestamp}\n${id}\n${raw}`).digest('hex'),
  } });
}
test('signed external delivery only passes registered trigger and event identity to the durable RPC', async () => {
  const fetcher = router([
    ...ownerSessionRoutes(),
    [SUPA + '/rest/v1/rpc/dua_workflow_deliver', (_url, _init, call) => {
      assert.deepEqual(call.json, { p_owner: UID, p_id: id, p_event: 'delivery-1' });
      assert.equal(call.headers.get('authorization'), 'Bearer ' + accessToken);
      assert.equal(call.headers.get('apikey'), 'sb_publishable_test');
      return Response.json({ id, status: 'queued' });
    }],
  ]);
  const response = await handleWorkflowAutomation(signed(), { env, fetcher });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { runId: id, status: 'queued' });
});
test('forged/stale deliveries and payload changes cannot enqueue a run', async () => {
  const fetcher = router([]), forged = signed(); forged.headers.set('x-dua-signature', '0'.repeat(64));
  assert.equal((await handleWorkflowAutomation(forged, { env, fetcher })).status, 401);
  assert.equal((await handleWorkflowAutomation(signed({}, '1000000000'), { env, fetcher })).status, 401);
  assert.equal((await handleWorkflowAutomation(signed({ eventId: 'delivery', prompt: 'replace task' }), { env, fetcher })).status, 400);
  assert.equal(fetcher.find(SUPA + '/rest/v1/').length, 0);
});
test('schedule registration derives owner, requires explicit revision, refuses writes and cron', async () => {
  const body = { expectedRevision: 0, enabled: true, workflowId: 'flow', title: 'Synthetic review', intervalSeconds: 300,
    startAt: new Date(Date.now() + 3600000).toISOString(), steps: [{ id: 'one', agentName: 'Reviewer', prompt: 'Review synthetic text', instructions: '', allowedTools: [] }] };
  const req = value => new Request(`https://dua.test/api/workflow-automation/schedules/${id}`, { method: 'PUT', headers: { authorization: 'Bearer user-token' }, body: JSON.stringify(value) });
  const fetcher = router([[SUPA + '/rest/v1/rpc/dua_workflow_register', (_url, _init, call) => {
    assert.equal(call.json.p_owner, UID); assert.equal(call.json.p_revision, 0); assert.equal(call.json.p_interval, 300);
    assert.equal(call.headers.get('authorization'), 'Bearer user-token');
    assert.equal(call.headers.get('apikey'), 'sb_publishable_test');
    return Response.json({ id, kind: 'interval', revision: 1, enabled: true });
  }]]);
  assert.equal((await handleWorkflowAutomation(req(body), { env, fetcher })).status, 200);
  assert.equal((await handleWorkflowAutomation(req({ ...body, cron: '* * * * *' }), { env, fetcher })).status, 422);
  body.steps[0].allowedTools = ['create_issue'];
  assert.equal((await handleWorkflowAutomation(req(body), { env, fetcher })).status, 422);
});
test('disabling an automation remains available while execution is paused', async () => {
  const req = new Request(`https://dua.test/api/workflow-automation/schedules/${id}/disable`, { method: 'POST', headers: { authorization: 'Bearer user-token' }, body: JSON.stringify({ expectedRevision: 2 }) });
  const fetcher = router([[SUPA + '/rest/v1/rpc/dua_workflow_automation_disable', (_url, _init, call) => {
    assert.equal(call.json.p_revision, 2); assert.equal(call.json.p_owner, UID);
    assert.equal(call.headers.get('authorization'), 'Bearer user-token');
    return Response.json({ id, kind: 'interval', enabled: false, revision: 3 });
  }]]);
  assert.equal((await handleWorkflowAutomation(req, { env: { ...env, DUA_WORKFLOWS_ENABLED: '0', DUA_MAINTENANCE: '1' }, fetcher })).status, 200);
});

// K6: PR H schedule triggers, cron read in Asia/Kolkata (UTC+05:30).
test('K6 cron: IST slots, lists/ranges/steps, day-of-week 7 = Sunday, unsupported forms rejected', () => {
  const weekdays = parseCron('30 9 * * 1-5');
  // Thu 26 Nov 2026 10:30 IST -> today 09:30 IST (04:00Z); 09:29 IST -> previous weekday.
  assert.equal(latestCronSlot(weekdays, new Date('2026-11-26T05:00:00Z')).toISOString(), '2026-11-26T04:00:00.000Z');
  assert.equal(latestCronSlot(weekdays, new Date('2026-11-26T03:59:00Z')).toISOString(), '2026-11-25T04:00:00.000Z');
  // Mon 30 Nov 08:00 IST -> back to Fri 27 Nov 09:30 IST.
  assert.equal(latestCronSlot(weekdays, new Date('2026-11-30T02:30:00Z')).toISOString(), '2026-11-27T04:00:00.000Z');
  assert.equal(latestCronSlot(parseCron('*/15 * * * *'), new Date('2026-11-26T05:07:30Z')).toISOString(), '2026-11-26T05:00:00.000Z');
  // IST midnight crosses the UTC date: 00:10 IST on 27 Nov = 18:40Z on 26 Nov.
  assert.equal(latestCronSlot(parseCron('10 0 * * *'), new Date('2026-11-26T19:00:00Z')).toISOString(), '2026-11-26T18:40:00.000Z');
  assert.equal(latestCronSlot(parseCron('0 8 * * 7'), new Date('2026-11-26T05:00:00Z')).toISOString(), '2026-11-22T02:30:00.000Z');
  assert.equal(parseCron('0 9,18 1-7/2 * *').dom.size, 4);
  for (const bad of ['0 9 * * MON', '@daily', '61 * * * *', '* * *', '0 9 * * 1 extra', '5-1 * * * *', '*/0 * * * *', ''])
    assert.equal(parseCron(bad), null, bad);
});

function triggerTickRoutes(triggers, { activeFor = null } = {}) {
  const enqueued = [], patched = [];
  const routes = [
    [SUPA + '/rest/v1/dua_agent_triggers?select=', (url, _init, call) => {
      assert.equal(call.headers.get('authorization'), 'Bearer user-token');
      assert.equal(call.headers.get('apikey'), 'sb_publishable_test');
      assert.match(url, /trigger_type=eq\.schedule/);
      assert.match(url, /enabled=is\.true/);
      return Response.json(triggers);
    }],
    [SUPA + '/rest/v1/dua_agents?', () => Response.json([{ id: 'research-bot', name: 'Research Bot' }])],
    [SUPA + '/rest/v1/rpc/dua_workflow_enqueue', (_url, _init, call) => {
      if (call.json.p_workflow === activeFor) return Response.json({ message: 'workflow_active' }, { status: 409 });
      enqueued.push(call.json);
      return Response.json({ id: crypto.randomUUID(), status: 'queued' });
    }],
    [SUPA + '/rest/v1/dua_agent_triggers?id=', (url, init, call) => { assert.equal(init.method, 'PATCH'); patched.push({ url, body: call.json }); return new Response(null, { status: 204 }); }],
  ];
  return { routes, enqueued, patched };
}
const trig = (id, extra) => ({ id, agent_id: 'research-bot', conversation_id: null, trigger_type: 'schedule', prompt: 'Digest', last_run_at: null, created_at: '2026-11-01T00:00:00Z', ...extra });
const tickOwner = { user: { id: UID }, token: 'user-token' };

test('K6 tick: only the latest due IST slot is queued once, with key trg:<id>:<slotEpoch>; invalid cron skipped and logged', async () => {
  const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000004'];
  const h = triggerTickRoutes([
    trig(ids[0], { cron_expr: '0 * * * *', last_run_at: '2026-11-25T00:00:00Z' }), // many missed hourly slots -> only the latest
    trig(ids[1], { cron_expr: '30 9 * * *', last_run_at: '2026-11-26T04:00:00Z' }), // today's slot already handled
    trig(ids[2], { cron_expr: 'every morning' }), // invalid -> skipped
    trig(ids[3], { cron_expr: '0 9 * * *', created_at: '2026-11-26T04:59:00Z' }), // created after today's slot
  ]);
  const logs = [];
  const queued = await tickAgentTriggers({ owner: tickOwner, env: filesEnv, fetcher: router(h.routes), now: new Date('2026-11-26T05:10:00Z'), log: (event, detail) => logs.push({ event, ...detail }) });
  assert.equal(queued, 1);
  assert.equal(h.enqueued.length, 1);
  const slot = Date.parse('2026-11-26T04:30:00Z') / 1000; // 10:00 IST
  assert.equal(h.enqueued[0].p_key, `trg:${ids[0]}:${slot}`);
  assert.equal(h.enqueued[0].p_workflow, 'agent-trigger:' + ids[0]);
  assert.equal(h.enqueued[0].p_owner, UID);
  assert.equal(h.enqueued[0].p_definition.source.triggerId, ids[0]);
  assert.equal(h.enqueued[0].p_title, 'Trigger: Research Bot');
  assert.deepEqual(h.patched.map(p => p.body), [{ last_run_at: '2026-11-26T04:30:00.000Z' }]);
  assert.deepEqual(logs, [{ event: 'trigger_cron_invalid', triggerId: ids[2] }]);
});

test('K6 tick: an active run for the trigger skips the slot without a duplicate', async () => {
  const id1 = 'aaaaaaaa-0000-4000-8000-000000000009';
  const h = triggerTickRoutes([trig(id1, { cron_expr: '*/5 * * * *' })], { activeFor: 'agent-trigger:' + id1 });
  const logs = [];
  const queued = await tickAgentTriggers({ owner: tickOwner, env: filesEnv, fetcher: router(h.routes), now: new Date('2026-11-26T05:10:00Z'), log: e => logs.push(e) });
  assert.equal(queued, 0);
  assert.deepEqual(logs, ['trigger_run_active']);
  assert.equal(h.patched.length, 1);
});

test('K6 tick runs from the worker only when DUA_WORKFLOW_AUTOMATION_ENABLED=1', async () => {
  for (const flag of ['0', '1']) {
    const fetcher = router([
      [SUPA + '/rest/v1/rpc/dua_workflow_tick', () => Response.json([])],
      [SUPA + '/rest/v1/dua_agent_triggers?select=', () => Response.json([])],
      [SUPA + '/rest/v1/rpc/dua_workflow_claim', () => Response.json([])],
    ]);
    const getOwner = async () => ({ user: { id: UID }, token: 'user-token' });
    assert.equal(await runWorkerOnce({ env: { ...filesEnv, DUA_WORKFLOWS_ENABLED: '1', DUA_WORKFLOW_AUTOMATION_ENABLED: flag }, fetcher, getOwner, log: () => {} }), false);
    assert.equal(fetcher.calls.some(c => c.url.includes('dua_agent_triggers')), flag === '1');
  }
});
