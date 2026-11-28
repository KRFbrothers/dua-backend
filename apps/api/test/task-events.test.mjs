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

test('the four lineage keys survive safeDetail, so the trail can answer where a task came from', async () => {
  const db = fakeDb();
  const append = createTaskEventWriter({ db, ownerId: OWNER, taskId: TASK });
  const parent = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const thread = 'cccccccc-dddd-4eee-8fff-000000000000';
  await append('created', {
    parent_task_id: parent,
    root_task_id: parent,
    continue_thread_id: thread,
    idempotency_key: 'client-key-1',
    status: 'waiting',
  });
  const detail = db.inserts[0].detail;
  assert.deepEqual(Object.keys(detail).sort(), [
    'continue_thread_id', 'idempotency_key', 'parent_task_id', 'root_task_id', 'status',
  ]);
  assert.equal(detail.parent_task_id, parent);
  assert.equal(detail.root_task_id, parent);
  assert.equal(detail.continue_thread_id, thread);
  assert.equal(detail.idempotency_key, 'client-key-1');
});

test('the lineage keys do not open the allowlist: unknown keys are still dropped', async () => {
  const db = fakeDb();
  const append = createTaskEventWriter({ db, ownerId: OWNER, taskId: TASK });
  await append('created', {
    parent_task_id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    rootTaskId: 'camelCase is not the backfilled name',
    continueThreadId: 'camelCase is not the backfilled name',
    idempotencyKey: 'camelCase is not the backfilled name',
    prompt: 'secret user prompt',
    output: 'secret model output',
    apiKey: 'sk-secret',
  });
  const detail = db.inserts[0].detail;
  assert.deepEqual(Object.keys(detail), ['parent_task_id']);
  assert.ok(!JSON.stringify(db.inserts).includes('secret'));
});

test('a lineage value longer than 200 characters is dropped, not truncated', async () => {
  const db = fakeDb();
  const append = createTaskEventWriter({ db, ownerId: OWNER, taskId: TASK });
  await append('created', { idempotency_key: 'k'.repeat(201), parent_task_id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' });
  const detail = db.inserts[0].detail;
  assert.deepEqual(Object.keys(detail), ['parent_task_id']);
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

test('the three lifecycle keys survive safeDetail, so the trail can answer why and when', async () => {
  const db = fakeDb();
  const append = createTaskEventWriter({ db, ownerId: OWNER, taskId: TASK });
  await append('failed', {
    toStatus: 'failed', endReason: 'error',
    end_reason: 'timeout', finished_at_ms: 1764000000000, stopped_at_ms: 1764000000001,
  });
  const detail = db.inserts[0].detail;
  assert.deepEqual(Object.keys(detail).sort(), [
    'endReason', 'end_reason', 'finished_at_ms', 'stopped_at_ms', 'toStatus',
  ]);
  assert.equal(detail.end_reason, 'timeout');
  assert.equal(detail.finished_at_ms, 1764000000000);
  assert.equal(detail.stopped_at_ms, 1764000000001);
});

test('the lifecycle keys do not open the allowlist: unknown keys are still dropped', async () => {
  const db = fakeDb();
  const append = createTaskEventWriter({ db, ownerId: OWNER, taskId: TASK });
  await append('failed', {
    end_reason: 'error',
    finishedAtMs: 'camelCase is not the backfilled name',
    stoppedAtMs: 'camelCase is not the backfilled name',
    endReasonText: 'not a real key',
    prompt: 'secret user prompt',
    output: 'secret model output',
    apiKey: 'sk-secret',
  });
  const detail = db.inserts[0].detail;
  assert.deepEqual(Object.keys(detail), ['end_reason']);
  assert.ok(!JSON.stringify(db.inserts).includes('secret'));
});

test('a null lifecycle value is skipped, so an event without one keeps its old detail', async () => {
  const db = fakeDb();
  const append = createTaskEventWriter({ db, ownerId: OWNER, taskId: TASK });
  await append('completed', { toStatus: 'completed', end_reason: undefined, finished_at_ms: undefined, stopped_at_ms: undefined });
  assert.deepEqual(Object.keys(db.inserts[0].detail), ['toStatus']);
});

test('a non-finite lifecycle timestamp is dropped, not stored as NaN', async () => {
  const db = fakeDb();
  const append = createTaskEventWriter({ db, ownerId: OWNER, taskId: TASK });
  await append('failed', { finished_at_ms: Number.NaN, stopped_at_ms: Number.POSITIVE_INFINITY, end_reason: 'error' });
  assert.deepEqual(Object.keys(db.inserts[0].detail), ['end_reason']);
});
