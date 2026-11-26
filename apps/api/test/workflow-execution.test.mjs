import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWorkflowExecution, normalizeDefinition } from '../src/core/workflow-execution.mjs';
import { readAgentOutput, runWorkerOnce } from '../src/core/workflow-worker.mjs';
import { filesEnv, router, SUPA, UID } from './files-helpers.mjs';

const env = { ...filesEnv, DUA_WORKFLOWS_ENABLED: '1' };
const sample = () => ({ workflowId: 'flow', title: 'Review', requestKey: 'delivery-1', steps: [
  { id: 'research', agentName: 'Researcher', instructions: '', prompt: 'Research synthetic topic', allowedTools: ['google_search'] },
  { id: 'review', agentName: 'Reviewer', instructions: 'Check the predecessor output.', prompt: 'Review findings', allowedTools: [] },
] });
const request = (data, suffix = '') => new Request('https://dua.test/api/workflow-executions' + suffix, {
  method: 'POST', headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' }, body: JSON.stringify(data),
});
const row = { id: '11111111-2222-4333-8444-555555555555', workflow_id: 'flow', title: 'Review', status: 'queued', steps: [], attempt: 1, definition: { trigger: { type: 'manual' } } };

test('execution derives owner; client lifecycle and owner fields cannot manufacture success', async () => {
  const fetcher = router([[SUPA + '/rest/v1/rpc/dua_workflow_enqueue', (_url, _init, call) => {
    assert.equal(call.json.p_owner, UID);
    assert.equal(call.json.p_definition.status, undefined);
    assert.equal(call.json.p_definition.steps[0].status, undefined);
    assert.equal(call.headers.get('authorization'), 'Bearer user-token');
    assert.equal(call.headers.get('apikey'), 'sb_publishable_test');
    return Response.json(row);
  }]]);
  const data = { ...sample(), owner: 'other', status: 'succeeded' };
  data.steps[0].status = 'succeeded';
  const response = await handleWorkflowExecution(request(data), { env, fetcher });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).run.status, 'queued');
});

test('unsupported approval tools and implicit tool scope are refused before enqueue', () => {
  const write = sample(); write.steps[0].allowedTools = ['create_issue'];
  assert.throws(() => normalizeDefinition(write), /unsupported workflow approval/);
  delete write.steps[0].allowedTools;
  assert.throws(() => normalizeDefinition(write), /Explicit tool selection/);
  const duplicates = sample(); duplicates.steps[1].id = duplicates.steps[0].id;
  assert.throws(() => normalizeDefinition(duplicates), /Invalid agent step/);
});

test('owner mismatch and cross-site cookie requests never access execution storage', async () => {
  const fetcher = router([], { email: 'other@example.com' });
  assert.equal((await handleWorkflowExecution(request(sample()), { env, fetcher })).status, 403);
  const crossSite = request(sample()); crossSite.headers.set('sec-fetch-site', 'cross-site');
  assert.equal((await handleWorkflowExecution(crossSite, { env, fetcher })).status, 403);
  assert.equal(fetcher.find(SUPA + '/rest/v1/').length, 0);
});

test('retry forwards expected attempt to make redelivery idempotent', async () => {
  const fetcher = router([[SUPA + '/rest/v1/rpc/dua_workflow_control', (_url, _init, call) => {
    assert.equal(call.json.p_expected_attempt, 3);
    assert.equal(call.json.p_owner, UID);
    assert.equal(call.headers.get('authorization'), 'Bearer user-token');
    assert.equal(call.headers.get('apikey'), 'sb_publishable_test');
    return Response.json({ ...row, attempt: 4 });
  }]]);
  const response = await handleWorkflowExecution(request({ expectedAttempt: 3 }, `/${row.id}/retry`), { env, fetcher });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).run.attempt, 4);
});

test('maintenance blocks new execution while cancellation remains available', async () => {
  const fetcher = router([[SUPA + '/rest/v1/rpc/dua_workflow_control', () => Response.json({ ...row, status: 'cancelled' })]]);
  const paused = { ...env, DUA_MAINTENANCE: '1' };
  assert.equal((await handleWorkflowExecution(request(sample()), { env: paused, fetcher })).status, 503);
  assert.equal((await handleWorkflowExecution(request({ expectedAttempt: 1 }, `/${row.id}/cancel`), { env: paused, fetcher })).status, 200);
});

function stream(events, bytesPerChunk = 9) {
  const bytes = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
  return new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += bytesPerChunk) controller.enqueue(bytes.slice(i, i + bytesPerChunk));
    controller.close();
  } });
}
test('actual output requires done, handles fragmented UTF-8 and rejects approvals/errors/truncation', async () => {
  const signal = new AbortController().signal;
  assert.equal(await readAgentOutput(stream([{ type: 'text', delta: 'Verified तथ्य' }, { type: 'done' }], 1), signal), 'Verified तथ्य');
  for (const final of [{ type: 'error' }, { type: 'approval' }, { type: 'done', truncated: true }]) {
    await assert.rejects(readAgentOutput(stream([{ type: 'text', delta: 'Partial' }, final]), signal));
  }
  await assert.rejects(readAgentOutput(stream([{ type: 'text', delta: 'Partial' }]), signal), /without a complete output/);
});

test('one-shot idempotent redelivery can normalize a past timestamp; transaction decides if request is new', () => {
  const data = sample(); data.trigger = { type: 'once', at: '2020-01-01T00:00:00Z' };
  assert.equal(normalizeDefinition(data).trigger.at, '2020-01-01T00:00:00.000Z');
  data.trigger = { type: 'cron', expression: '* * * * *' };
  assert.throws(() => normalizeDefinition(data), /Recurring cron is not supported/);
});

test('worker dispatches real engine requests and saves predecessor output before the next agent', async () => {
  let run = { ...row, owner_id: UID, definition: normalizeDefinition(sample()), steps: sample().steps.map(s => ({ id: s.id, agentName: s.agentName, status: 'queued', output: '' })) };
  const dispatched = [];
  const fetcher = router([
    [SUPA + '/rest/v1/rpc/dua_workflow_claim', (_url, _init, call) => {
      assert.equal(call.headers.get('authorization'), 'Bearer user-token');
      assert.equal(call.headers.get('apikey'), 'sb_publishable_test');
      return Response.json([run]);
    }],
    [SUPA + '/rest/v1/rpc/dua_workflow_checkpoint', (_url, _init, call) => {
      assert.equal(call.headers.get('authorization'), 'Bearer user-token');
      run = { ...run, status: call.json.p_status, steps: call.json.p_steps ?? run.steps };
      return Response.json(run);
    }],
    ['https://engine.test/api/agent/capabilities', () => Response.json({ tools: ['google_search'], toolCatalog: [] })],
    ['https://engine.test/api/chat', (_url, _init, call) => {
      assert.equal(call.headers.get('authorization'), 'Bearer user-token');
      assert.deepEqual(call.json.allowedTools, dispatched.length ? [] : ['google_search']);
      if (dispatched.length) {
        assert.equal(run.steps[0].status, 'succeeded');
        assert.equal(run.steps[0].output, 'Synthetic finding');
        assert.match(call.json.messages[0].text, /Synthetic finding/);
        assert.equal(call.json.systemInstruction, 'Check the predecessor output.');
      }
      dispatched.push(call.json);
      return new Response(stream([{ type: 'text', delta: dispatched.length === 1 ? 'Synthetic finding' : 'Reviewed finding' }, { type: 'done' }]), { headers: { 'content-type': 'text/event-stream' } });
    }],
  ]);
  const getOwner = async () => ({ user: { id: UID }, token: 'user-token', request: request(sample()) });
  await runWorkerOnce({ env: { ...env, DUA_ENGINE_URL: 'https://engine.test' }, fetcher, getOwner });
  assert.equal(dispatched.length, 2);
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.steps.map(s => s.output), ['Synthetic finding', 'Reviewed finding']);
});

test('worker respects acknowledged cancellation before dispatching any provider work', async () => {
  const run = { ...row, owner_id: UID, definition: normalizeDefinition(sample()), steps: [] };
  const fetcher = router([
    [SUPA + '/rest/v1/rpc/dua_workflow_claim', () => Response.json([run])],
    [SUPA + '/rest/v1/rpc/dua_workflow_checkpoint', () => Response.json({ ...run, status: 'cancelled' })],
  ]);
  const getOwner = async () => ({ user: { id: UID }, token: 'user-token', request: request(sample()) });
  await runWorkerOnce({ env, fetcher, getOwner });
  assert.equal(fetcher.calls.some(c => c.url.includes('engine.test')), false);
});

test('history and get-one use the owner access token and the anon key', async () => {
  const fetcher = router([
    [SUPA + '/rest/v1/rpc/dua_workflow_history', (_url, _init, call) => {
      assert.equal(call.json.p_owner, UID);
      assert.equal(call.headers.get('authorization'), 'Bearer user-token');
      assert.equal(call.headers.get('apikey'), 'sb_publishable_test');
      return Response.json([{ ...row, steps: [] }]);
    }],
    [SUPA + '/rest/v1/dua_workflow_executions?', (_url, _init, call) => {
      assert.equal(call.headers.get('authorization'), 'Bearer user-token');
      assert.equal(call.method, 'GET');
      return Response.json([row]);
    }],
  ]);
  const list = await handleWorkflowExecution(new Request('https://dua.test/api/workflow-executions', { headers: { authorization: 'Bearer user-token' } }), { env, fetcher });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).runs[0].id, row.id);
  const one = await handleWorkflowExecution(new Request('https://dua.test/api/workflow-executions/' + row.id, { headers: { authorization: 'Bearer user-token' } }), { env, fetcher });
  assert.equal(one.status, 200);
});
