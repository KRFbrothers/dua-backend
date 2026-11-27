import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskEventWriter, readTaskEvents, TASK_EVENTS } from '../src/core/task-events.mjs';

const OWNER = '11111111-2222-4333-8444-555555555555';
const TASK = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** A fake PostgREST that serves the seq RPC and records inserts. */
function fakeDb({ seqFails = false, insertFails = false } = {}) {
  const inserts = [];
  let seq = 0;
  const db = async (path, init = {}) => {
    if (path.endsWith('/rpc/dua_task_events_next_seq')) {
      if (seqFails) return Response.json({ error: 'boom' }, { status: 500 });
      seq += 1;
      return Response.json(seq);
    }
    if (path.startsWith('/rest/v1/dua_task_events') && init.method === 'POST') {
      if (insertFails) return Response.json({ error: 'boom' }, { status: 500 });
      inserts.push(JSON.parse(init.body));
      return new Response(null, { status: 201 });
    }
    if (path.startsWith('/rest/v1/dua_task_events') && (init.method || 'GET') === 'GET') {
      return Response.json(inserts.map((row, i) => ({ seq: row.seq, event: row.event, step_id: row.step_id, detail: row.detail, created_at: `t${i}` })));
    }
    throw new Error('unexpected ' + path);
  };
  db.inserts = inserts;
  return db;
}

test('an event is written with a database-assigned sequence', async () => {
  const db = fakeDb();
  const append = createTaskEventWriter({ db, ownerId: OWNER, taskId: TASK });
  assert.equal(await append('created', { status: 'waiting' }), true);
  assert.equal(await append('started', { fromStatus: 'waiting', toStatus: 'running' }), true);
  assert.deepEqual(db.inserts.map(r => r.seq), [1, 2]);
  assert.equal(db.inserts[0].owner_id, OWNER);
  assert.equal(db.inserts[0].task_id, TASK);
  assert.equal(db.inserts[0].event, 'created');
});

test('unknown event names are refused before any network call', async () => {
  const db = fakeDb();
  const append = createTaskEventWriter({ db, ownerId: OWNER, taskId: TASK });
  assert.equal(await append('not_a_real_event'), false);
  assert.equal(db.inserts.length, 0);
});

test('detail is filtered to the allowlist, so prompt text and output never persist', async () => {
  const db = fakeDb();
  const append = createTaskEventWriter({ db, ownerId: OWNER, taskId: TASK });
  await append('step_completed', {
    stepId: 'research', runCount: 2, status: 'completed',
    prompt: 'secret user prompt', output: 'secret model output', apiKey: 'sk-secret',
  });
  const detail = db.inserts[0].detail;
  assert.deepEqual(Object.keys(detail).sort(), ['runCount', 'status', 'stepId']);
  assert.ok(!JSON.stringify(db.inserts).includes('secret'));
});

test('a failed sequence call or insert returns false and never throws', async () => {
  const seqDb = fakeDb({ seqFails: true });
  assert.equal(await createTaskEventWriter({ db: seqDb, ownerId: OWNER, taskId: TASK })('created'), false);
  const insertDb = fakeDb({ insertFails: true });
  assert.equal(await createTaskEventWriter({ db: insertDb, ownerId: OWNER, taskId: TASK })('created'), false);
  const throwing = async () => { throw new Error('network'); };
  assert.equal(await createTaskEventWriter({ db: throwing, ownerId: OWNER, taskId: TASK })('created'), false);
});

test('a missing owner or a too-short task id is refused', async () => {
  const db = fakeDb();
  assert.equal(await createTaskEventWriter({ db, ownerId: '', taskId: TASK })('created'), false);
  assert.equal(await createTaskEventWriter({ db, ownerId: OWNER, taskId: 'short' })('created'), false);
  assert.equal(db.inserts.length, 0);
});

test('readTaskEvents returns rows oldest first and [] on failure', async () => {
  const db = fakeDb();
  const append = createTaskEventWriter({ db, ownerId: OWNER, taskId: TASK });
  await append('created');
  await append('started');
  const rows = await readTaskEvents({ db, taskId: TASK });
  assert.deepEqual(rows.map(r => r.event), ['created', 'started']);
  assert.deepEqual(await readTaskEvents({ db: async () => { throw new Error('x'); }, taskId: TASK }), []);
});

test('the exported event list matches the migration check constraint', () => {
  assert.deepEqual([...TASK_EVENTS].sort(), [
    'cancelled', 'completed', 'created', 'failed', 'heartbeat', 'reaped', 'retry',
    'started', 'step_completed', 'step_failed', 'step_started', 'timed_out',
  ]);
});
