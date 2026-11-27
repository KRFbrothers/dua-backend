import test from 'node:test';
import assert from 'node:assert/strict';
import { reapOnce, reaperEnabled } from '../src/core/task-reaper.mjs';
import { heartbeat, staleWorkers, drainWorker, detectDeadWorkers, WORKER_KINDS } from '../src/core/worker-health.mjs';

const SUPA = 'https://proj.supabase.co';
const env = { SUPABASE_URL: SUPA, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test' };
const WORKER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function router(routes) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    for (const [match, handler] of routes) if (String(url).includes(match)) return handler(String(url), init);
    throw new Error('unexpected ' + url);
  };
  fetcher.calls = calls;
  return fetcher;
}

test('the reaper is off unless explicitly enabled', () => {
  assert.equal(reaperEnabled({}), false);
  assert.equal(reaperEnabled({ DUA_TASK_REAPER: '0' }), false);
  assert.equal(reaperEnabled({ DUA_TASK_REAPER: '1' }), true);
});

test('reapOnce returns [] and logs when the service key is missing', async () => {
  const events = [];
  const rows = await reapOnce({ env: { SUPABASE_URL: SUPA }, fetcher: () => assert.fail('no call'), log: e => events.push(e) });
  assert.deepEqual(rows, []);
  assert.deepEqual(events, ['reaper_not_configured']);
});

test('reapOnce moves overdue tasks and appends one reaped event each', async () => {
  const reaped = [
    { owner_id: '11111111-2222-4333-8444-555555555555', task_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    { owner_id: '11111111-2222-4333-8444-555555555555', task_id: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  ];
  const inserts = [];
  const fetcher = router([
    ['/rpc/dua_orhan_tasks_reap', () => Response.json(reaped)],
    ['/rpc/dua_task_events_next_seq', () => Response.json(1)],
    ['/rest/v1/dua_task_events', (url, init) => { inserts.push(JSON.parse(init.body)); return new Response(null, { status: 201 }); }],
  ]);
  const rows = await reapOnce({ env, fetcher, maxMinutes: 10 });
  assert.equal(rows.length, 2);
  assert.equal(inserts.length, 2);
  assert.ok(inserts.every(row => row.event === 'reaped'));
  assert.deepEqual(inserts.map(r => r.task_id), reaped.map(r => r.task_id));
  // The RPC is called with the configured limit, not a client value.
  assert.deepEqual(fetcher.calls[0].body, { p_max_minutes: 10 });
});

test('a failed reap RPC is logged and returns []', async () => {
  const events = [];
  const fetcher = router([['/rpc/dua_orhan_tasks_reap', () => Response.json({ error: 'x' }, { status: 500 })]]);
  assert.deepEqual(await reapOnce({ env, fetcher, log: e => events.push(e) }), []);
  assert.deepEqual(events, ['reaper_rpc_failed']);
});

test('heartbeat posts the worker row and returns it', async () => {
  const fetcher = router([['/rpc/dua_worker_heartbeat', () => Response.json({ worker_id: WORKER, kind: 'workflow' })]]);
  const row = await heartbeat({ env, fetcher, workerId: WORKER, kind: 'workflow', version: '1.2.3', capacity: 2, activeJobs: 1 });
  assert.equal(row.worker_id, WORKER);
  assert.deepEqual(fetcher.calls[0].body, { p_worker: WORKER, p_kind: 'workflow', p_version: '1.2.3', p_capacity: 2, p_active: 1 });
});

test('heartbeat refuses an unknown kind and a missing id without a call', async () => {
  const fetcher = () => assert.fail('no call');
  assert.equal(await heartbeat({ env, fetcher, workerId: WORKER, kind: 'bogus' }), null);
  assert.equal(await heartbeat({ env, fetcher, workerId: '', kind: 'workflow' }), null);
});

test('staleWorkers and drainWorker return [] and null on failure', async () => {
  const failing = async () => { throw new Error('down'); };
  assert.deepEqual(await staleWorkers({ env, fetcher: failing }), []);
  assert.equal(await drainWorker({ env, fetcher: failing, workerId: WORKER }), null);
});

test('detectDeadWorkers labels each stale worker with a reason', async () => {
  const fetcher = router([['/rpc/dua_workers_stale', () => Response.json([
    { worker_id: WORKER, kind: 'orhan', last_seen: '2026-11-27T00:00:00Z', active_jobs: 3 },
  ])]]);
  const dead = await detectDeadWorkers({ env, fetcher, staleSeconds: 90 });
  assert.equal(dead.length, 1);
  assert.equal(dead[0].workerId, WORKER);
  assert.equal(dead[0].activeJobs, 3);
  assert.equal(dead[0].reason, 'heartbeat_stale');
});

test('the worker kinds match the migration check constraint', () => {
  assert.deepEqual([...WORKER_KINDS].sort(), ['coding', 'orhan', 'workflow']);
});
