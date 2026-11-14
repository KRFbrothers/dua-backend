import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleWorkflowAutomation } from '../src/core/workflow-automation.mjs';
import { filesEnv, router, SUPA, UID } from './files-helpers.mjs';

const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const secret = 'synthetic-test-signing-secret-not-valid-production';
const env = { ...filesEnv, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_fixture', DUA_WORKFLOW_OWNER_ID: UID, DUA_WORKFLOWS_ENABLED: '1', DUA_WORKFLOW_EXTERNAL_TRIGGERS_ENABLED: '1', DUA_WORKFLOW_WEBHOOK_KEYS_JSON: JSON.stringify({ [id]: secret }) };
function signed(body = { eventId: 'delivery-1' }, timestamp = String(Math.floor(Date.now() / 1000))) {
  const raw = JSON.stringify(body);
  return new Request(`https://dua.test/api/workflow-automation/deliver/${id}`, { method: 'POST', body: raw, headers: {
    'x-dua-timestamp': timestamp, 'x-dua-signature': createHmac('sha256', secret).update(`${timestamp}\n${id}\n${raw}`).digest('hex'),
  } });
}
test('signed external delivery only passes registered trigger and event identity to the durable RPC', async () => {
  const fetcher = router([[SUPA + '/rest/v1/rpc/dua_workflow_deliver', (_url, _init, call) => {
    assert.deepEqual(call.json, { p_owner: UID, p_id: id, p_event: 'delivery-1' });
    return Response.json({ id, status: 'queued' });
  }]]);
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
    return Response.json({ id, kind: 'interval', enabled: false, revision: 3 });
  }]]);
  assert.equal((await handleWorkflowAutomation(req, { env: { ...env, DUA_WORKFLOWS_ENABLED: '0', DUA_MAINTENANCE: '1' }, fetcher })).status, 200);
});
