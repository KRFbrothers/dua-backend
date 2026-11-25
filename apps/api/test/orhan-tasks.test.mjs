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
        if (rows.some(row => row.owner_id === body.owner_id && row.task_id === body.task_id)) return Response.json({ code: '23505', message: 'duplicate key value violates unique constraint' }, { status: 409 });
        rows.push(body);
        return Response.json([body], { status: 201 });
      }
      let list = rows.filter(row => row.owner_id === UID);
      const id = url.includes('task_id=eq.') ? decodeURIComponent(url.split('task_id=eq.')[1].split('&')[0]) : '';
      if (id) list = list.filter(row => row.task_id === id);
      if (url.includes('status=eq.running')) list = list.filter(row => row.status === 'running');
      const before = /started_at_ms=lt\.(\d+)/.exec(url);
      if (before) list = list.filter(row => Number(row.started_at_ms) < Number(before[1]));
      if (method === 'GET') {
        if (url.includes('select=task_id&')) return Response.json(list.map(row => ({ task_id: row.task_id })));
        return Response.json(list);
      }
      if (url.includes('status=eq.waiting')) list = list.filter(row => row.status === 'waiting');
      if (url.includes('status=eq.failed')) list = list.filter(row => row.status === 'failed');
      if (url.includes('status=in.(waiting,running)')) list = list.filter(row => ['waiting', 'running'].includes(row.status));
      for (const row of list) Object.assign(row, body);
      return Response.json(list);
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
  const { rows, fetcher } = store(plan);
  assert.equal((await handleService(call('POST', `/api/orhan/tasks/${MISSING}/start`), { env, fetcher })).status, 404);
  assert.equal((await handleService(call('POST', `/api/orhan/tasks/${MISSING}/cancel`), { env, fetcher })).status, 404);
  const task = (await (await handleService(call('POST', '/api/orhan/tasks', { prompt: 'A saved job' }), { env, fetcher })).json()).task;
  assert.equal((await handleService(call('POST', `/api/orhan/tasks/${task.id}/cancel`), { env, fetcher })).status, 200);
  // PR K3: a second stop of a cancelled task is idempotent (200); a finished task still cannot be cancelled.
  const again = await handleService(call('POST', `/api/orhan/tasks/${task.id}/cancel`), { env, fetcher });
  assert.equal(again.status, 200);
  const done = (await (await handleService(call('POST', '/api/orhan/tasks', { prompt: 'Another job' }), { env, fetcher })).json()).task;
  rows.find(row => row.task_id === done.id).status = 'completed';
  assert.equal((await handleService(call('POST', `/api/orhan/tasks/${done.id}/cancel`), { env, fetcher })).status, 409);
  const restart = await handleService(call('POST', `/api/orhan/tasks/${task.id}/start`), { env, fetcher });
  assert.equal(restart.status, 409);
});
// ---- end PR K1 ----

// ---- PR K2 (feat/task-lifecycle): lifecycleStatus, end reasons and lazy time limit ----
const TEN_MINUTES = 10 * 60 * 1000;
const steps = outputs => (url, body) => {
  if (url.endsWith('/plan')) return Response.json({ title: 'Notes', agents, steps: planSteps });
  return Response.json(outputs[body.agent]);
};
const ok = { status: 'completed', output: 'Done.' };
const send = (fetcher, method, path, body) => handleService(call(method, path, body), { env, fetcher });
const taskOf = async response => (await response.json()).task;
const createTask = async fetcher => taskOf(await send(fetcher, 'POST', '/api/orhan/tasks', { prompt: 'A saved job' }));

test('K2: legacy status is unchanged and lifecycleStatus maps waiting->queued, running, completed', async () => {
  const { fetcher } = store(steps({ research: ok, checker: ok, writer: { status: 'completed', output: '# Report' } }));
  const task = await createTask(fetcher);
  assert.equal(task.status, 'waiting');
  assert.equal(task.lifecycleStatus, 'queued');
  assert.equal(task.endReason, null);
  assert.equal(task.finishedAtMs, null);
  assert.equal(task.stoppedAtMs, null);
  const started = await taskOf(await send(fetcher, 'POST', `/api/orhan/tasks/${task.id}/start`));
  assert.equal(started.status, 'running');
  assert.equal(started.lifecycleStatus, 'running');
  let current = started;
  for (let index = 0; index < 3; index += 1) current = await taskOf(await send(fetcher, 'POST', `/api/orhan/tasks/${task.id}/continue`));
  assert.equal(current.status, 'completed');
  assert.equal(current.lifecycleStatus, 'completed');
  assert.equal(current.endReason, null);
  assert.ok(current.finishedAtMs > 0);
  assert.equal(current.artifact.text, '# Report');
});

test('K2: a failed step is failed with end reason error and a finish time', async () => {
  const { fetcher } = store(steps({ research: { status: 'failed', error: 'No sources.' } }));
  const task = await createTask(fetcher);
  await send(fetcher, 'POST', `/api/orhan/tasks/${task.id}/start`);
  const failed = await taskOf(await send(fetcher, 'POST', `/api/orhan/tasks/${task.id}/continue`));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.lifecycleStatus, 'failed');
  assert.equal(failed.endReason, 'error');
  assert.equal(failed.error, 'No sources.');
  assert.ok(failed.finishedAtMs > 0);
  const retried = await taskOf(await send(fetcher, 'POST', `/api/orhan/tasks/${task.id}/retry`));
  assert.equal(retried.lifecycleStatus, 'queued');
  assert.equal(retried.endReason, null);
  assert.equal(retried.finishedAtMs, null);
});

test('K2: the step limit is failed with end reason step_limit', async () => {
  const { rows, fetcher } = store(steps({}));
  const task = await createTask(fetcher);
  await send(fetcher, 'POST', `/api/orhan/tasks/${task.id}/start`);
  rows[0].run_count = 12;
  const limited = await taskOf(await send(fetcher, 'POST', `/api/orhan/tasks/${task.id}/continue`));
  assert.equal(limited.status, 'failed');
  assert.equal(limited.lifecycleStatus, 'failed');
  assert.equal(limited.endReason, 'step_limit');
});

test('K2: cancel is stopped with end reason user_stop and a stop time', async () => {
  const { fetcher } = store(steps({}));
  const task = await createTask(fetcher);
  const stopped = await taskOf(await send(fetcher, 'POST', `/api/orhan/tasks/${task.id}/cancel`));
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.lifecycleStatus, 'stopped');
  assert.equal(stopped.endReason, 'user_stop');
  assert.ok(stopped.stoppedAtMs > 0);
});

test('K2: continue past 10 minutes is timed_out while legacy status stays failed', async () => {
  const { rows, fetcher } = store(steps({}));
  const task = await createTask(fetcher);
  await send(fetcher, 'POST', `/api/orhan/tasks/${task.id}/start`);
  rows[0].started_at_ms = Date.now() - TEN_MINUTES - 1000;
  const timedOut = await taskOf(await send(fetcher, 'POST', `/api/orhan/tasks/${task.id}/continue`));
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.lifecycleStatus, 'timed_out');
  assert.equal(timedOut.endReason, 'timeout');
});

test('K2: with a fake clock an abandoned running task expires on read and no longer blocks a new start', async t => {
  const start = Date.UTC(2026, 10, 25, 12, 0, 0);
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const engineCalls = [];
  const { fetcher } = store((url, body) => { engineCalls.push(body.agent || 'plan'); return steps({})(url, body); });
  const first = await createTask(fetcher);
  const second = await createTask(fetcher);
  assert.equal((await send(fetcher, 'POST', `/api/orhan/tasks/${first.id}/start`)).status, 200);
  assert.equal((await send(fetcher, 'POST', `/api/orhan/tasks/${second.id}/start`)).status, 409);
  t.mock.timers.tick(TEN_MINUTES - 1000);
  assert.equal((await taskOf(await send(fetcher, 'GET', `/api/orhan/tasks/${first.id}`))).lifecycleStatus, 'running');
  t.mock.timers.tick(2000);
  const expired = await taskOf(await send(fetcher, 'GET', `/api/orhan/tasks/${first.id}`));
  assert.equal(expired.status, 'failed');
  assert.equal(expired.lifecycleStatus, 'timed_out');
  assert.equal(expired.endReason, 'timeout');
  assert.equal(expired.error, 'This task reached its 10 minute limit.');
  assert.equal(expired.finishedAtMs, start + TEN_MINUTES + 1000);
  const listed = (await (await send(fetcher, 'GET', '/api/orhan/tasks')).json()).tasks;
  assert.equal(listed.find(item => item.id === first.id).lifecycleStatus, 'timed_out');
  const next = await send(fetcher, 'POST', `/api/orhan/tasks/${second.id}/start`);
  assert.equal(next.status, 200);
  assert.equal((await taskOf(next)).lifecycleStatus, 'running');
  assert.deepEqual(engineCalls, ['plan', 'plan']);
});

test('K2: list expiry also frees start, and an unknown id is 404 even while another task runs', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 25, 12, 0, 0) });
  const { fetcher } = store(steps({}));
  const first = await createTask(fetcher);
  const second = await createTask(fetcher);
  await send(fetcher, 'POST', `/api/orhan/tasks/${first.id}/start`);
  assert.equal((await send(fetcher, 'POST', `/api/orhan/tasks/${MISSING}/start`)).status, 404);
  t.mock.timers.tick(TEN_MINUTES + 1);
  const listed = (await (await send(fetcher, 'GET', '/api/orhan/tasks')).json()).tasks;
  assert.equal(listed.find(item => item.id === first.id).lifecycleStatus, 'timed_out');
  assert.equal((await send(fetcher, 'POST', `/api/orhan/tasks/${second.id}/start`)).status, 200);
});
// ---- end PR K2 ----

// ---- PR K3 (feat/task-idempotency): requestId replay and idempotent stop ----
const REQUEST_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('K3: the same requestId twice makes one engine call and returns the same task', async () => {
  const engineCalls = [];
  const { rows, fetcher } = store((url, body) => { engineCalls.push(body.agent || 'plan'); return Response.json({ title: 'Notes', agents, steps: planSteps }); });
  const first = await send(fetcher, 'POST', '/api/orhan/tasks', { prompt: 'A saved job', requestId: REQUEST_ID });
  assert.equal(first.status, 200);
  const created = await taskOf(first);
  assert.equal(created.id, REQUEST_ID);
  const second = await send(fetcher, 'POST', '/api/orhan/tasks', { prompt: 'A saved job', requestId: REQUEST_ID.toUpperCase() });
  assert.equal(second.status, 200);
  const replayed = await taskOf(second);
  assert.equal(replayed.id, created.id);
  assert.equal(replayed.createdAtMs, created.createdAtMs);
  assert.deepEqual(engineCalls, ['plan']);
  assert.equal(rows.length, 1);
});

test('K3: a requestId reused for a different job is 409 and nothing is saved', async () => {
  const engineCalls = [];
  const { rows, fetcher } = store((url, body) => { engineCalls.push('plan'); return Response.json({ title: 'Notes', agents, steps: planSteps }); });
  await send(fetcher, 'POST', '/api/orhan/tasks', { prompt: 'A saved job', requestId: REQUEST_ID });
  const reused = await send(fetcher, 'POST', '/api/orhan/tasks', { prompt: 'Something else', requestId: REQUEST_ID });
  assert.equal(reused.status, 409);
  assert.match((await reused.json()).error, /requestId/);
  assert.equal(engineCalls.length, 1);
  assert.equal(rows.length, 1);
});

test('K3: a concurrent create that loses the insert race returns the saved task', async () => {
  const { rows, fetcher } = store((url, body) => {
    // Another request with the same requestId saves first while this one is planning.
    rows.push({ owner_id: UID, task_id: REQUEST_ID, title: 'Notes', prompt: 'A saved job', status: 'waiting', plan: { title: 'Notes', agents }, steps: [], artifact: null, error: null, run_count: 0, started_at_ms: 0, created_at_ms: 1, updated_at_ms: 1 });
    return Response.json({ title: 'Notes', agents, steps: planSteps });
  });
  const response = await send(fetcher, 'POST', '/api/orhan/tasks', { prompt: 'A saved job', requestId: REQUEST_ID });
  assert.equal(response.status, 200);
  const task = await taskOf(response);
  assert.equal(task.id, REQUEST_ID);
  assert.equal(task.createdAtMs, 1);
  assert.equal(rows.length, 1);
});

test('K3: an invalid requestId is 400 before the engine or storage', async () => {
  for (const requestId of ['not-a-uuid', 123, '', null]) {
    const engineCalls = [];
    const { rows, fetcher } = store(() => { engineCalls.push('plan'); return Response.json({ title: 'Notes', agents, steps: planSteps }); });
    const response = await send(fetcher, 'POST', '/api/orhan/tasks', { prompt: 'A saved job', requestId });
    assert.equal(response.status, 400, String(requestId));
    assert.equal((await response.json()).error, 'Invalid requestId.');
    assert.equal(engineCalls.length, 0);
    assert.equal(rows.length, 0);
    assert.equal(fetcher.calls.filter(item => item.url.includes('/rest/v1/')).length, 0);
  }
});

test('K3: without requestId every create is a new task (unchanged)', async () => {
  const { rows, fetcher } = store(() => Response.json({ title: 'Notes', agents, steps: planSteps }));
  const first = await createTask(fetcher);
  const second = await createTask(fetcher);
  assert.notEqual(first.id, second.id);
  assert.equal(rows.length, 2);
});

test('K3: stopping twice returns 200 with the same stopped task', async () => {
  const { fetcher } = store(steps({}));
  const task = await createTask(fetcher);
  const first = await send(fetcher, 'POST', `/api/orhan/tasks/${task.id}/cancel`);
  assert.equal(first.status, 200);
  const stopped = await taskOf(first);
  const second = await send(fetcher, 'POST', `/api/orhan/tasks/${task.id}/cancel`);
  assert.equal(second.status, 200);
  const again = await taskOf(second);
  assert.equal(again.lifecycleStatus, 'stopped');
  assert.equal(again.stoppedAtMs, stopped.stoppedAtMs);
  assert.equal(again.updatedAtMs, stopped.updatedAtMs);
});
// ---- end PR K3 ----

// ---- PR K4 (test/control-plane-actions): README/AGENTS.md control-plane actions ----
// create_task = POST /api/orhan/tasks, get_task_status = GET /api/orhan/tasks/:id,
// stop_task = POST /api/orhan/tasks/:id/cancel (direct_reply is covered in chat.test.mjs).
const TASK_ROUTES = id => [
  ['GET', '/api/orhan/tasks'],
  ['POST', '/api/orhan/tasks', { prompt: 'A saved job' }],
  ['GET', `/api/orhan/tasks/${id}`],
  ['POST', `/api/orhan/tasks/${id}/start`],
  ['POST', `/api/orhan/tasks/${id}/continue`],
  ['POST', `/api/orhan/tasks/${id}/cancel`],
  ['POST', `/api/orhan/tasks/${id}/retry`],
];

test('control plane: create_task, get_task_status and stop_task on a running task', async () => {
  const engineCalls = [];
  const { fetcher } = store((url, body) => { engineCalls.push(body.agent || 'plan'); return steps({ research: ok })(url, body); });
  const created = await send(fetcher, 'POST', '/api/orhan/tasks', { prompt: 'A saved job' });
  assert.equal(created.status, 200);
  const task = await taskOf(created);
  assert.equal((await taskOf(await send(fetcher, 'GET', `/api/orhan/tasks/${task.id}`))).lifecycleStatus, 'queued');
  await send(fetcher, 'POST', `/api/orhan/tasks/${task.id}/start`);
  await send(fetcher, 'POST', `/api/orhan/tasks/${task.id}/continue`);
  const running = await taskOf(await send(fetcher, 'GET', `/api/orhan/tasks/${task.id}`));
  assert.equal(running.lifecycleStatus, 'running');
  assert.equal(running.steps[0].status, 'completed');
  const stopped = await taskOf(await send(fetcher, 'POST', `/api/orhan/tasks/${task.id}/cancel`));
  assert.equal(stopped.lifecycleStatus, 'stopped');
  assert.equal(stopped.endReason, 'user_stop');
  const after = await send(fetcher, 'POST', `/api/orhan/tasks/${task.id}/continue`);
  assert.equal(after.status, 409);
  assert.equal((await taskOf(await send(fetcher, 'GET', `/api/orhan/tasks/${task.id}`))).lifecycleStatus, 'stopped');
  assert.deepEqual(engineCalls, ['plan', 'research']);
});

test('control plane: every task route needs sign-in (401) and the configured owner (403) before storage', async () => {
  for (const [method, path, body] of TASK_ROUTES(MISSING)) {
    const signedOut = router([]);
    const denied = await handleService(call(method, path, body, ''), { env, fetcher: signedOut });
    assert.equal(denied.status, 401, `${method} ${path}`);
    assert.equal(signedOut.calls.length, 0, `${method} ${path}`);
    const stranger = router([], { email: 'someone@example.com' });
    const refused = await handleService(call(method, path, body), { env, fetcher: stranger });
    assert.equal(refused.status, 403, `${method} ${path}`);
    assert.deepEqual(stranger.calls.map(item => item.url), [SUPA + '/auth/v1/user'], `${method} ${path}`);
  }
});

test('control plane: another owner\'s task is 404 on continue and retry and is never changed', async () => {
  const { rows, fetcher } = store(plan);
  const foreign = { owner_id: OTHER, task_id: crypto.randomUUID(), title: 'Theirs', prompt: 'Their job', status: 'failed', plan: { title: 'Theirs', agents }, steps: [], artifact: null, error: 'x', run_count: 1, started_at_ms: 1, created_at_ms: 1, updated_at_ms: 1 };
  rows.push(foreign);
  for (const action of ['continue', 'retry']) {
    assert.equal((await send(fetcher, 'POST', `/api/orhan/tasks/${foreign.task_id}/${action}`)).status, 404, action);
  }
  assert.equal(foreign.status, 'failed');
  assert.equal(foreign.updated_at_ms, 1);
});

test('control plane: task errors are JSON { error } with no-store', async () => {
  const { fetcher } = store(plan);
  const task = await createTask(fetcher);
  await send(fetcher, 'POST', `/api/orhan/tasks/${task.id}/start`);
  const cases = [
    [400, await send(fetcher, 'POST', '/api/orhan/tasks', { prompt: '' })],
    [400, await send(fetcher, 'POST', '/api/orhan/tasks', { prompt: 'A saved job', requestId: 'nope' })],
    [401, await handleService(call('GET', '/api/orhan/tasks', null, ''), { env, fetcher: router([]) })],
    [404, await send(fetcher, 'GET', `/api/orhan/tasks/${MISSING}`)],
    [404, await send(fetcher, 'GET', '/api/orhan/tasks/not-a-uuid')],
    [405, await send(fetcher, 'DELETE', `/api/orhan/tasks/${task.id}`)],
    [409, await send(fetcher, 'POST', `/api/orhan/tasks/${task.id}/retry`)],
  ];
  for (const [status, response] of cases) {
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store', String(status));
    assert.match(response.headers.get('content-type'), /application\/json/, String(status));
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ['error'], String(status));
    assert.equal(typeof body.error, 'string');
  }
});
// ---- end PR K4 ----
