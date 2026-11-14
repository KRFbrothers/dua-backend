import test from 'node:test';
import assert from 'node:assert/strict';
import { handleService } from '../src/server/service-handler.mjs';
import { filesEnv, router, SUPA, UID } from './files-helpers.mjs';

const ENGINE = 'https://engine.test';
const env = { ...filesEnv, DUA_ENGINE_URL: ENGINE };
const agents = [
  { id: 'research', name: 'Research', tools: ['search'], can: 'Search the web and write findings from those results.', cannot: 'Email, payment, delete, and memory.' },
  { id: 'checker', name: 'Checker', tools: [], can: 'Read the research and say if it is enough to write from.', cannot: 'Search, email, payment, delete, and memory.' },
  { id: 'writer', name: 'Writer', tools: [], can: 'Write one document from the checked research.', cannot: 'Search, email, payment, delete, and memory.' },
];
const planSteps = [
  { id: 'research', agent: 'research', title: 'Research', dependsOn: [] },
  { id: 'check', agent: 'checker', title: 'Check the research', dependsOn: ['research'] },
  { id: 'document', agent: 'writer', title: 'Write the document', dependsOn: ['check'] },
];

function call(method, path, body, token = 'user-token') {
  return new Request('https://dua.test' + path, {
    method,
    headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function store(stepHandler) {
  const rows = [];
  const fetcher = router([
    [(url, init) => url.startsWith(ENGINE + '/api/orhan/'), async (url, init) => stepHandler(url, JSON.parse(init.body))],
    [(url, init) => url.startsWith(SUPA + '/rest/v1/dua_orhan_tasks'), (url, init) => {
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : null;
      if (method === 'POST') {
        rows.push(body);
        return Response.json([body], { status: 201 });
      }
      let list = rows.filter(row => row.owner_id === UID);
      const id = url.includes('task_id=eq.') ? decodeURIComponent(url.split('task_id=eq.')[1].split('&')[0]) : '';
      if (id) list = list.filter(row => row.task_id === id);
      if (url.includes('status=eq.running')) list = list.filter(row => row.status === 'running');
      if (method === 'GET') {
        if (url.includes('select=task_id&')) return Response.json(list.map(row => ({ task_id: row.task_id })));
        return Response.json(list);
      }
      const row = list[0];
      if (!row) return Response.json([]);
      if (url.includes('status=eq.waiting') && row.status !== 'waiting') return Response.json([]);
      if (url.includes('status=eq.running') && row.status !== 'running') return Response.json([]);
      if (url.includes('status=eq.failed') && row.status !== 'failed') return Response.json([]);
      if (url.includes('status=in.(waiting,running)') && !['waiting', 'running'].includes(row.status)) return Response.json([]);
      Object.assign(row, body);
      return Response.json([row]);
    }],
  ]);
  return { rows, fetcher };
}

test('a job becomes a waiting plan and runs one dependent step at a time', async () => {
  const seen = [];
  const { rows, fetcher } = store((url, body) => {
    seen.push(body.agent || 'plan');
    if (url.endsWith('/plan')) {
      assert.deepEqual(body, { prompt: 'Research three competitors and write a document' });
      return Response.json({ title: 'Competitors', agents, steps: planSteps });
    }
    if (body.agent === 'research') {
      assert.deepEqual(body.inputs, {});
      return Response.json({ status: 'completed', output: 'Source: example.com\nThree competitors.' });
    }
    if (body.agent === 'checker') {
      assert.match(body.inputs.research, /example.com/);
      assert.equal(body.inputs.memory, undefined);
      return Response.json({ status: 'failed', error: 'VERDICT: fail. No usable sources.' });
    }
    return Response.json({ status: 'completed', output: 'should not run' });
  });
  const created = await handleService(call('POST', '/api/orhan/tasks', { prompt: 'Research three competitors and write a document', ownerId: 'attacker' }), { env, fetcher });
  assert.equal(created.status, 200);
  const task = (await created.json()).task;
  assert.equal(rows[0].owner_id, UID);
  assert.equal(task.status, 'waiting');
  assert.deepEqual(task.plan.agents.map(agent => agent.tools), [['search'], [], []]);
  assert.equal(task.steps.every(step => step.status === 'pending'), true);

  const started = await handleService(call('POST', `/api/orhan/tasks/${task.id}/start`), { env, fetcher });
  assert.equal((await started.json()).task.status, 'running');
  const research = await handleService(call('POST', `/api/orhan/tasks/${task.id}/continue`), { env, fetcher });
  const afterResearch = (await research.json()).task;
  assert.equal(afterResearch.status, 'running');
  assert.equal(afterResearch.steps[0].status, 'completed');
  assert.match(afterResearch.steps[0].output, /example.com/);

  const checked = await handleService(call('POST', `/api/orhan/tasks/${task.id}/continue`), { env, fetcher });
  const failed = (await checked.json()).task;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.steps[1].status, 'failed');
  assert.equal(failed.steps[2].status, 'skipped');
  assert.equal(failed.artifact, null);
  assert.deepEqual(seen, ['plan', 'research', 'checker']);
});

test('a plan that asks for email is refused before it is saved', async () => {
  const { rows, fetcher } = store(() => Response.json({
    title: 'Mail',
    agents: agents.map(agent => agent.id === 'research' ? { ...agent, tools: ['search', 'email'] } : agent),
    steps: planSteps,
  }));
  const response = await handleService(call('POST', '/api/orhan/tasks', { prompt: 'Email the report' }), { env, fetcher });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /not allowed/);
  assert.equal(rows.length, 0);
});

test('a second task cannot start while one is running', async () => {
  const { fetcher } = store(() => Response.json({ title: 'Notes', agents, steps: planSteps }));
  const first = (await (await handleService(call('POST', '/api/orhan/tasks', { prompt: 'First job' }), { env, fetcher })).json()).task;
  const second = (await (await handleService(call('POST', '/api/orhan/tasks', { prompt: 'Second job' }), { env, fetcher })).json()).task;
  assert.equal((await handleService(call('POST', `/api/orhan/tasks/${first.id}/start`), { env, fetcher })).status, 200);
  const blocked = await handleService(call('POST', `/api/orhan/tasks/${second.id}/start`), { env, fetcher });
  assert.equal(blocked.status, 409);
});

test('waiting work can be cancelled and a signed-out request does not touch storage', async () => {
  const { fetcher } = store(() => Response.json({ title: 'Notes', agents, steps: planSteps }));
  const task = (await (await handleService(call('POST', '/api/orhan/tasks', { prompt: 'A saved job' }), { env, fetcher })).json()).task;
  const cancelled = await handleService(call('POST', `/api/orhan/tasks/${task.id}/cancel`), { env, fetcher });
  assert.equal((await cancelled.json()).task.status, 'cancelled');
  const signedOut = router([]);
  const denied = await handleService(call('POST', '/api/orhan/tasks', { prompt: 'Nope' }, ''), { env, fetcher: signedOut });
  assert.equal(denied.status, 401);
  assert.equal(signedOut.calls.length, 0);
});

test('the agent switch refuses Orhan before any storage call', async () => {
  const fetcher = router([]);
  const response = await handleService(call('POST', '/api/orhan/tasks', { prompt: 'Research competitors' }), { env: { ...env, DUA_DISABLE_AGENT: '1' }, fetcher });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).paused, 'agent');
  assert.equal(fetcher.calls.length, 0);
});
