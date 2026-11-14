import test from 'node:test';
import assert from 'node:assert/strict';
import { handleService } from '../src/server/service-handler.mjs';
import { filesEnv, router, SUPA, UID } from './files-helpers.mjs';

const sample = { runId: 'run-1', workflowId: 'flow-1', workflowTitle: 'Review', chatTitle: 'Chat', agentId: 'agent-1', agentName: 'Reviewer', status: 'RUNNING', startedAtMs: 1762000000000, finishedAtMs: 0, error: null, engineRunId: null };
const request = (method = 'GET', body) => new Request('https://dua.test/api/workflow-runs', { method, headers: { authorization: 'Bearer user-token', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });

test('workflow history reads and writes with owner bearer and no owner identity from client', async () => {
  const fetcher = router([[(url, init) => url.startsWith(SUPA + '/rest/v1/dua_workflow_runs'), (url, init) => {
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer user-token');
    if (init.method === 'GET') return Response.json([]);
    const rows = JSON.parse(init.body);
    assert.equal(rows[0].owner_id, UID);
    assert.equal(rows[0].status, 'running');
    assert.equal(rows[0].agent_name, 'Reviewer');
    return Response.json(rows, { status: 201 });
  }]]);
  const read = await handleService(request(), { env: filesEnv, fetcher });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { runs: [] });
  const write = await handleService(request('PUT', { ...sample, ownerId: 'attacker' }), { env: filesEnv, fetcher });
  assert.equal(write.status, 200);
  assert.equal((await write.json()).runs[0].status, 'running');
});

test('workflow history rejects invalid run state and unsupported methods before PostgREST', async () => {
  const fetcher = router([]);
  const invalid = await handleService(request('PUT', { ...sample, status: 'scheduled' }), { env: filesEnv, fetcher });
  assert.equal(invalid.status, 400);
  assert.equal(fetcher.find(SUPA + '/rest/v1/').length, 0);
  const method = await handleService(request('DELETE'), { env: filesEnv, fetcher });
  assert.equal(method.status, 405);
});
