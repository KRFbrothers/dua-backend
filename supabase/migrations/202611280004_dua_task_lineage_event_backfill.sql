-- Backfill the Orhan task lineage fields into the task event stream, so the five
-- columns added by `202611270001_dua_task_lifecycle_workers.sql` stop being the
-- only copy of a task's parent, root, thread, attempt and idempotency link.
--
-- Why: that file added `parent_task_id`, `root_task_id`, `continue_thread_id`,
-- `attempt` and `idempotency_key` with `alter table ... add column`. Dropping
-- them loses the parent and root links, the attempt counter and the idempotency
-- key, so retry and continue history is gone. `apps/api/src/core/orhan-tasks.mjs`
-- line 12 selects all five, lines 175 to 180 write them on create, line 341
-- increments `attempt` on retry, and lines 482 to 486 read them back. That is
-- why the file is marked NO in `ROLLBACK_STATUS.md`.
--
-- This file is forward fix item 4 from `docs/FORWARD_FIX_PLAN_NO_ROLLBACK.md`
-- (the plan numbers it item 6; the three lifecycle values were the earlier
-- backfill in `202611280003_dua_task_links_event_backfill.sql`).
-- It copies the five values into `dua_task_events.detail` for every task that
-- already carries at least one of them, so the columns become a cache and a
-- later drop is recoverable from the event stream.
--
-- No function is created or replaced here, so there is no
-- `dua_capture_function` call: nothing in this file can overwrite a body that a
-- rollback would need to restore. The only writes are inserts into an
-- append-only table.
--
-- Idempotent: the insert is guarded by a `not exists` on this file's own
-- backfill marker, so running it twice inserts nothing the second time. The
-- marker is the full file name, not the short number, so it cannot collide with
-- the `202611280003` marker used by the lifecycle backfill.
--
-- Rollback: `202611280004_dua_task_lineage_event_backfill.rollback.sql` beside
-- this file. It is hand written, not generated, because no function body changes
-- here. It has to drop the append-only trigger to delete the rows it added, then
-- put the trigger back.

begin;

-- ---------------------------------------------------------------------------
-- 1. One event per task that carries at least one of the five link values
-- ---------------------------------------------------------------------------
-- `owner_id` is set from the task row, never from `auth.uid()`: a migration runs
-- without a JWT, so the column default would be null and the insert would fail
-- the not-null constraint.
--
-- The event name is `created`, because these five values describe how the task
-- came into existence (its parent, its root, its thread, its attempt number and
-- its idempotency key), not how it ended. `created` is also in the check
-- constraint list on `dua_task_events.event`.
--
-- `attempt` is `not null default 1`, so `attempt > 1` is the only way to tell a
-- retried task from a first attempt. A task on attempt 1 with no other link is
-- skipped, because there is nothing to record that the column does not already
-- say by default.
insert into public.dua_task_events (owner_id, task_id, seq, event, detail)
select
  t.owner_id,
  t.task_id,
  coalesce(
    (select max(e.seq) from public.dua_task_events e
      where e.owner_id = t.owner_id and e.task_id = t.task_id),
    0
  ) + 1,
  'created',
  jsonb_build_object(
    'parent_task_id', t.parent_task_id,
    'root_task_id', t.root_task_id,
    'continue_thread_id', t.continue_thread_id,
    'attempt', t.attempt,
    'idempotency_key', t.idempotency_key,
    'backfilled', true,
    'backfill_migration', '202611280004_dua_task_lineage_event_backfill'
  )
from public.dua_orhan_tasks t
where (t.parent_task_id is not null
       or t.root_task_id is not null
       or t.continue_thread_id is not null
       or t.attempt > 1
       or t.idempotency_key is not null)
  and not exists (
    select 1 from public.dua_task_events e
    where e.owner_id = t.owner_id
      and e.task_id = t.task_id
      and e.detail->>'backfill_migration' = '202611280004_dua_task_lineage_event_backfill'
  );

commit;
