import test from 'node:test';
import assert from 'node:assert/strict';
import { handleService } from '../src/server/service-handler.mjs';
import { filesEnv, OTHER, router, SUPA, UID } from './files-helpers.mjs';

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

test('a job longer than 4000 characters, an empty job or invalid JSON is refused before the engine or storage', async () => {
  const engineCalls = [];
  const { rows, fetcher } = store(url => { engineCalls.push(url); return Response.json({ title: 'Notes', agents, steps: planSteps }); });
  const tooLong = await handleService(call('POST', '/api/orhan/tasks', { prompt: 'x'.repeat(4001) }), { env, fetcher });
  assert.equal(tooLong.status, 413);
  assert.equal((await tooLong.json()).error, 'The job is too long.');
  const empty = await handleService(call('POST', '/api/orhan/tasks', { prompt: '   ' }), { env, fetcher });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, 'Tell Dua Agent what to do.');
  const broken = await handleService(new Request('https://dua.test/api/orhan/tasks', { method: 'POST', headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' }, body: '{not json' }), { env, fetcher });
  assert.equal(broken.status, 400);
  assert.equal(engineCalls.length, 0);
  assert.equal(rows.length, 0);
});

test('an unknown or malformed task id is not found', async () => {
  const { fetcher } = store(() => Response.json({ title: 'Notes', agents, steps: planSteps }));
  const unknown = '00000000-0000-4000-8000-000000000000';
  for (const action of ['continue', 'retry']) {
    const response = await handleService(call('POST', `/api/orhan/tasks/${unknown}/${action}`), { env, fetcher });
    assert.equal(response.status, 404, action);
    assert.equal((await response.json()).error, 'That task was not found.');
  }
  const malformed = router([]);
  const response = await handleService(call('POST', '/api/orhan/tasks/not-a-uuid/continue'), { env, fetcher: malformed });
  assert.equal(response.status, 404);
  assert.equal(malformed.calls.length, 0);
});

test('a running task past its 10 minute limit fails without calling the engine', async () => {
  const engineCalls = [];
  const { rows, fetcher } = store((url, body) => {
    engineCalls.push(body.agent || 'plan');
    if (url.endsWith('/plan')) return Response.json({ title: 'Notes', agents, steps: planSteps });
    return Response.json({ status: 'completed', output: 'should not run' });
  });
  const task = (await (await handleService(call('POST', '/api/orhan/tasks', { prompt: 'A slow job' }), { env, fetcher })).json()).task;
  assert.equal((await handleService(call('POST', `/api/orhan/tasks/${task.id}/start`), { env, fetcher })).status, 200);
  rows[0].started_at_ms = Date.now() - (10 * 60 * 1000 + 1000);
  const response = await handleService(call('POST', `/api/orhan/tasks/${task.id}/continue`), { env, fetcher });
  assert.equal(response.status, 200);
  const timedOut = (await response.json()).task;
  // Current behaviour: the time limit is reported as `failed` (there is no `timed_out` status yet).
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.error, 'This task reached its 10 minute limit.');
  assert.deepEqual(timedOut.limits, { maxSteps: 12, maxMinutes: 10 });
  assert.deepEqual(engineCalls, ['plan']);
});

test('a task at its step limit fails on continue and cannot be retried', async () => {
  const engineCalls = [];
  const { rows, fetcher } = store((url, body) => {
    engineCalls.push(body.agent || 'plan');
    if (url.endsWith('/plan')) return Response.json({ title: 'Notes', agents, steps: planSteps });
    return Response.json({ status: 'completed', output: 'should not run' });
  });
  const task = (await (await handleService(call('POST', '/api/orhan/tasks', { prompt: 'A long job' }), { env, fetcher })).json()).task;
  assert.equal((await handleService(call('POST', `/api/orhan/tasks/${task.id}/start`), { env, fetcher })).status, 200);
  rows[0].run_count = 12;
  const response = await handleService(call('POST', `/api/orhan/tasks/${task.id}/continue`), { env, fetcher });
  const limited = (await response.json()).task;
  assert.equal(limited.status, 'failed');
  assert.equal(limited.error, 'This task reached its step limit.');
  const retry = await handleService(call('POST', `/api/orhan/tasks/${task.id}/retry`), { env, fetcher });
  assert.equal(retry.status, 409);
  assert.equal((await retry.json()).error, 'This task reached its step limit.');
  assert.deepEqual(engineCalls, ['plan']);
});

// ---- PR K1 (fix/orhan-task-status): single-task status and unknown-id 404s ----
const MISSING = '00000000-0000-4000-8000-000000000000';
const plan = () => Response.json({ title: 'Notes', agents, steps: planSteps });

test('K1: get_task_status returns one owned task and 404 for an unknown id', async () => {
  const { fetcher } = store(plan);
  const task = (await (await handleService(call('POST', '/api/orhan/tasks', { prompt: 'A saved job' }), { env, fetcher })).json()).task;
  const found = await handleService(call('GET', `/api/orhan/tasks/${task.id}`), { env, fetcher });
  assert.equal(found.status, 200);
  assert.equal(found.headers.get('cache-control'), 'no-store');
  const body = (await found.json()).task;
  assert.equal(body.id, task.id);
  assert.equal(body.status, 'waiting');
  const missing = await handleService(call('GET', `/api/orhan/tasks/${MISSING}`), { env, fetcher });
  assert.equal(missing.status, 404);
  assert.equal(typeof (await missing.json()).error, 'string');
});

test('K1: a malformed task id is 404 before any account or storage call', async () => {
  for (const [method, path] of [['GET', '/api/orhan/tasks/not-a-uuid'], ['POST', '/api/orhan/tasks/not-a-uuid/start'], ['POST', '/api/orhan/tasks/not-a-uuid/cancel']]) {
    const fetcher = router([]);
    const response = await handleService(call(method, path), { env, fetcher });
    assert.equal(response.status, 404, path);
    assert.equal(fetcher.calls.length, 0, path);
  }
});

test('K1: single-task GET needs sign-in and does not touch storage', async () => {
  const fetcher = router([]);
  const response = await handleService(call('GET', `/api/orhan/tasks/${MISSING}`, null, ''), { env, fetcher });
  assert.equal(response.status, 401);
  assert.equal(fetcher.calls.length, 0);
});

test('K1: only GET is allowed on a single task path', async () => {
  const fetcher = router([]);
  const response = await handleService(call('POST', `/api/orhan/tasks/${MISSING}`, { prompt: 'x' }), { env, fetcher });
  assert.equal(response.status, 405);
  assert.equal(fetcher.calls.length, 0);
});

test('K1: another owner\'s task is 404 for get, start and cancel and is never changed', async () => {
  const { rows, fetcher } = store(plan);
  const foreign = { owner_id: OTHER, task_id: crypto.randomUUID(), title: 'Theirs', prompt: 'Their job', status: 'waiting', plan: { title: 'Theirs', agents }, steps: [], artifact: null, error: null, run_count: 0, started_at_ms: 0, created_at_ms: 1, updated_at_ms: 1 };
  rows.push(foreign);
  for (const [method, path] of [['GET', ''], ['POST', '/start'], ['POST', '/cancel']]) {
    const response = await handleService(call(method, `/api/orhan/tasks/${foreign.task_id}${path}`), { env, fetcher });
    assert.equal(response.status, 404, method + path);
  }
  assert.equal(foreign.status, 'waiting');
});

test('K1: start and cancel return 404 for an unknown id and keep 409 for a known task in the wrong state', async () => {
  const { fetcher } = store(plan);
  assert.equal((await handleService(call('POST', `/api/orhan/tasks/${MISSING}/start`), { env, fetcher })).status, 404);
  assert.equal((await handleService(call('POST', `/api/orhan/tasks/${MISSING}/cancel`), { env, fetcher })).status, 404);
  const task = (await (await handleService(call('POST', '/api/orhan/tasks', { prompt: 'A saved job' }), { env, fetcher })).json()).task;
  assert.equal((await handleService(call('POST', `/api/orhan/tasks/${task.id}/cancel`), { env, fetcher })).status, 200);
  const again = await handleService(call('POST', `/api/orhan/tasks/${task.id}/cancel`), { env, fetcher });
  assert.equal(again.status, 409);
  const restart = await handleService(call('POST', `/api/orhan/tasks/${task.id}/start`), { env, fetcher });
  assert.equal(restart.status, 409);
});
// ---- end PR K1 ----
