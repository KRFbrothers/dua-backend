-- Backfill the Orhan task lifecycle values into the task event stream, so the
-- three columns added by `202611250001_dua_orhan_tasks_lifecycle.sql` stop being
-- the only copy of why a task ended and when.
--
-- Why: that file added `end_reason`, `finished_at_ms` and `stopped_at_ms` with
-- `alter table ... add column`. Dropping them loses the reason and the time of
-- every finished task, and `apps/api/src/core/orhan-tasks.mjs` line 12 selects
-- all three while lines 379 and 380 write them, so the user visible stopped and
-- timed out states depend on them. That is why the file is marked NO in
-- `ROLLBACK_STATUS.md`.
--
-- This file is forward fix item 6 from `docs/FORWARD_FIX_PLAN_NO_ROLLBACK.md`.
-- It copies the three values into `dua_task_events.detail` for every task that
-- already has them, so the columns become a cache and a later drop is
-- recoverable from the event stream.
--
-- No function is created or replaced here, so there is no
-- `dua_capture_function` call: nothing in this file can overwrite a body that a
-- rollback would need to restore. The only writes are inserts into an
-- append-only table.
--
-- Idempotent: the insert is guarded by a `not exists` on the backfill marker, so
-- running it twice inserts nothing the second time.
--
-- Rollback: `202611280003_dua_task_links_event_backfill.rollback.sql` beside this
-- file. It is hand written, not generated, because no function body changes
-- here. It has to drop the append-only trigger to delete the rows it added, then
-- put the trigger back.

begin;

-- ---------------------------------------------------------------------------
-- 1. One event per task that carries at least one of the three values
-- ---------------------------------------------------------------------------
-- `owner_id` is set from the task row, never from `auth.uid()`: a migration runs
-- without a JWT, so the column default would be null and the insert would fail
-- the not-null constraint.
--
-- The event name follows the task status, because the check constraint on
-- `dua_task_events.event` only allows the fixed list. A task that is still
-- waiting or running has no terminal value, so it gets `created`, which is the
-- neutral name for "this row exists".
insert into public.dua_task_events (owner_id, task_id, seq, event, detail)
select
  t.owner_id,
  t.task_id,
  coalesce(
    (select max(e.seq) from public.dua_task_events e
      where e.owner_id = t.owner_id and e.task_id = t.task_id),
    0
  ) + 1,
  case t.status
    when 'completed' then 'completed'
    when 'failed' then 'failed'
    when 'cancelled' then 'cancelled'
    else 'created'
  end,
  jsonb_build_object(
    'end_reason', t.end_reason,
    'finished_at_ms', t.finished_at_ms,
    'stopped_at_ms', t.stopped_at_ms,
    'backfilled', true,
    'backfill_migration', '202611280003'
  )
from public.dua_orhan_tasks t
where (t.end_reason is not null
       or t.finished_at_ms is not null
       or t.stopped_at_ms is not null)
  and not exists (
    select 1 from public.dua_task_events e
    where e.owner_id = t.owner_id
      and e.task_id = t.task_id
      and e.detail->>'backfill_migration' = '202611280003'
  );

commit;
