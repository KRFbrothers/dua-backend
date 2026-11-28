import test from 'node:test';
import assert from 'node:assert/strict';
import { handleService } from '../src/server/service-handler.mjs';
import { filesEnv, router, SUPA, UID } from './files-helpers.mjs';

const ENGINE = 'https://engine.test';
const env = { ...filesEnv, DUA_ENGINE_URL: ENGINE };
const agents = [
  { id: 'research', name: 'Research', tools: ['search'], can: 'Search.', cannot: 'Email.' },
  { id: 'checker', name: 'Checker', tools: [], can: 'Check.', cannot: 'Search.' },
  { id: 'writer', name: 'Writer', tools: [], can: 'Write.', cannot: 'Search.' },
];
const planSteps = [
  { id: 'research', agent: 'research', title: 'Research', dependsOn: [] },
  { id: 'check', agent: 'checker', title: 'Check', dependsOn: ['research'] },
  { id: 'document', agent: 'writer', title: 'Write', dependsOn: ['check'] },
];

function call(method, path, body) {
  return new Request('https://dua.test' + path, {
    method,
    headers: { authorization: 'Bearer user-token', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** Store that also serves dua_task_events, so the event trail can be asserted. */
function store() {
  const rows = [];
  const events = [];
  let seq = 0;
  const fetcher = router([
    [(url) => url.startsWith(ENGINE + '/api/orhan/'), async () => Response.json({ title: 'T', agents, steps: planSteps })],
    [(url) => url.includes('/rpc/dua_task_events_next_seq'), async () => Response.json(++seq)],
    [(url) => url.startsWith(SUPA + '/rest/v1/dua_task_events'), (url, init) => {
      if ((init.method || 'GET') === 'POST') { events.push(JSON.parse(init.body)); return new Response(null, { status: 201 }); }
      return Response.json(events);
    }],
    [(url) => url.startsWith(SUPA + '/rest/v1/dua_orhan_tasks'), (url, init) => {
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : null;
      if (method === 'POST') {
        if (rows.some(r => r.owner_id === body.owner_id && r.task_id === body.task_id)) return Response.json({ code: '23505' }, { status: 409 });
        rows.push(body);
        return Response.json([body], { status: 201 });
      }
      let list = rows.filter(r => r.owner_id === UID);
      const id = url.includes('task_id=eq.') ? decodeURIComponent(url.split('task_id=eq.')[1].split('&')[0]) : '';
      if (id) list = list.filter(r => r.task_id === id);
      const key = /idempotency_key=eq\.([^&]+)/.exec(url);
      if (key) list = list.filter(r => r.idempotency_key === decodeURIComponent(key[1]));
      if (url.includes('status=eq.running')) list = list.filter(r => r.status === 'running');
      if (method === 'GET') {
        if (url.includes('select=task_id&')) return Response.json(list.map(r => ({ task_id: r.task_id })));
        return Response.json(list);
      }
      if (url.includes('status=eq.waiting')) list = list.filter(r => r.status === 'waiting');
      if (url.includes('status=eq.failed')) list = list.filter(r => r.status === 'failed');
      if (url.includes('status=in.(waiting,running)')) list = list.filter(r => ['waiting', 'running'].includes(r.status));
      for (const row of list) Object.assign(row, body);
      return Response.json(list);
    }],
  ]);
  return { rows, events, fetcher };
}

test('a new task is its own root and starts at attempt 1', async () => {
  const { rows, fetcher } = store();
  const response = await handleService(call('POST', '/api/orhan/tasks', { prompt: 'Plan a trip' }), { env, fetcher });
  assert.equal(response.status, 200);
  const { task } = await response.json();
  assert.equal(task.rootTaskId, task.id);
  assert.equal(task.parentTaskId, null);
  assert.equal(task.attempt, 1);
  assert.equal(rows[0].root_task_id, rows[0].task_id);
});

test('a child task inherits the parent root and thread', async () => {
  const { rows, fetcher } = store();
  const first = await (await handleService(call('POST', '/api/orhan/tasks', { prompt: 'One' }), { env, fetcher })).json();
  const parentId = first.task.id;
  // Give the parent a thread, as a client would.
  rows[0].continue_thread_id = '99999999-8888-4777-8666-555555555555';
  const second = await handleService(call('POST', '/api/orhan/tasks', { prompt: 'Two', parentTaskId: parentId }), { env, fetcher });
  assert.equal(second.status, 200);
  const { task } = await second.json();
  assert.equal(task.parentTaskId, parentId);
  assert.equal(task.rootTaskId, parentId);
  assert.equal(task.continueThreadId, '99999999-8888-4777-8666-555555555555');
});

test('the created event carries the four lineage keys, so the trail alone shows the chain', async () => {
  const { rows, events, fetcher } = store();
  const first = await (await handleService(call('POST', '/api/orhan/tasks', { prompt: 'One' }), { env, fetcher })).json();
  const parentId = first.task.id;
  rows[0].continue_thread_id = '99999999-8888-4777-8666-555555555555';
  const second = await (await handleService(call('POST', '/api/orhan/tasks', {
    prompt: 'Two', parentTaskId: parentId, idempotencyKey: 'client-key-2',
  }), { env, fetcher })).json();
  const created = events.filter(e => e.event === 'created');
  assert.equal(created.length, 2);
  // A first task is its own root and has no parent, so only root_task_id is present.
  assert.equal(created[0].detail.root_task_id, parentId);
  assert.equal(created[0].detail.parent_task_id, undefined);
  assert.equal(created[0].detail.continue_thread_id, undefined);
  assert.equal(created[0].detail.idempotency_key, undefined);
  // The child carries all four, spelled as the 202611280004 backfill spells them.
  assert.equal(created[1].detail.parent_task_id, parentId);
  assert.equal(created[1].detail.root_task_id, parentId);
  assert.equal(created[1].detail.continue_thread_id, '99999999-8888-4777-8666-555555555555');
  assert.equal(created[1].detail.idempotency_key, 'client-key-2');
  assert.equal(created[1].task_id, second.task.id);
});

test('an unknown parent is refused with 404, not silently ignored', async () => {
  const { fetcher } = store();
  const response = await handleService(call('POST', '/api/orhan/tasks', {
    prompt: 'x', parentTaskId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  }), { env, fetcher });
  assert.equal(response.status, 404);
});

test('a malformed parent id is refused with 400', async () => {
  const { fetcher } = store();
  const response = await handleService(call('POST', '/api/orhan/tasks', { prompt: 'x', parentTaskId: 'nope' }), { env, fetcher });
  assert.equal(response.status, 400);
});

test('a reused idempotency key returns the original task instead of a duplicate', async () => {
  const { rows, fetcher } = store();
  const body = { prompt: 'Same request', idempotencyKey: 'client-key-1' };
  const first = await (await handleService(call('POST', '/api/orhan/tasks', body), { env, fetcher })).json();
  const second = await (await handleService(call('POST', '/api/orhan/tasks', body), { env, fetcher })).json();
  assert.equal(second.task.id, first.task.id);
  assert.equal(rows.length, 1);
});

test('the event trail records created, started and cancelled in order', async () => {
  const { events, fetcher } = store();
  const { task } = await (await handleService(call('POST', '/api/orhan/tasks', { prompt: 'x' }), { env, fetcher })).json();
  await handleService(call('POST', `/api/orhan/tasks/${task.id}/start`), { env, fetcher });
  await handleService(call('POST', `/api/orhan/tasks/${task.id}/cancel`), { env, fetcher });
  assert.deepEqual(events.map(e => e.event), ['created', 'started', 'cancelled']);
  assert.deepEqual(events.map(e => e.seq), [1, 2, 3]);
});

test('GET /events returns the trail and rejects a POST', async () => {
  const { fetcher } = store();
  const { task } = await (await handleService(call('POST', '/api/orhan/tasks', { prompt: 'x' }), { env, fetcher })).json();
  const read = await handleService(call('GET', `/api/orhan/tasks/${task.id}/events`), { env, fetcher });
  assert.equal(read.status, 200);
  const body = await read.json();
  assert.equal(body.events[0].event, 'created');
  const post = await handleService(call('POST', `/api/orhan/tasks/${task.id}/events`), { env, fetcher });
  assert.equal(post.status, 405);
});

test('a retry increments attempt and logs a retry event', async () => {
  const { rows, events, fetcher } = store();
  const { task } = await (await handleService(call('POST', '/api/orhan/tasks', { prompt: 'x' }), { env, fetcher })).json();
  // Force the task into a failed state, as a real failure would.
  Object.assign(rows[0], { status: 'failed', run_count: 1, steps: rows[0].steps.map((s, i) => i === 0 ? { ...s, status: 'failed' } : s) });
  const response = await handleService(call('POST', `/api/orhan/tasks/${task.id}/retry`), { env, fetcher });
  assert.equal(response.status, 200);
  const { task: retried } = await response.json();
  assert.equal(retried.attempt, 2);
  assert.equal(retried.status, 'waiting');
  assert.ok(events.some(e => e.event === 'retry' && e.detail.attempt === 2));
});

test('every response carries a server-generated X-Request-Id', async () => {
  const { fetcher } = store();
  const response = await handleService(call('GET', '/api/orhan/tasks'), { env, fetcher });
  const id = response.headers.get('x-request-id');
  assert.match(id, /^[0-9a-f-]{36}$/);
});

test('a client-supplied X-Request-Id is not adopted', async () => {
  const { fetcher } = store();
  const request = new Request('https://dua.test/api/orhan/tasks', {
    method: 'GET', headers: { authorization: 'Bearer user-token', 'x-request-id': 'forged-id-123456' },
  });
  const response = await handleService(request, { env, fetcher });
  assert.notEqual(response.headers.get('x-request-id'), 'forged-id-123456');
});
