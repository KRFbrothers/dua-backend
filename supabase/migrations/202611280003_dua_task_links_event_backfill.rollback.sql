-- Rollback for 202611280003_dua_task_links_event_backfill.sql
--
-- Hand written, not generated: this file creates and replaces no function, so
-- `apps/api/scripts/generate-function-rollback.mjs` has nothing to restore from
-- `dua_function_history`. The only change is a set of inserted rows.
--
-- What it undoes: every event row this migration inserted, identified by
-- `detail->>'backfill_migration' = '202611280003'`. Rows written by the API are
-- never touched, because they do not carry that marker.
--
-- Why the trigger has to move: `dua_task_events` is append-only, enforced by the
-- `dua_task_events_no_update` trigger calling `dua_task_events_immutable()`,
-- which raises on any update or delete. A delete is impossible while it is
-- attached, so this file drops the trigger, deletes, and puts the trigger back
-- with the same definition as `202611270001_dua_task_lifecycle_workers.sql`
-- lines 99 to 101.
--
-- Data loss: none. The three values still live in `dua_orhan_tasks.end_reason`,
-- `finished_at_ms` and `stopped_at_ms`, which this migration only read. The
-- columns are not dropped here, because this file did not add them.
--
-- Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 202611280003_dua_task_links_event_backfill.rollback.sql
--
-- Safe to run again: the delete matches nothing the second time and the trigger
-- is dropped with `if exists` before being recreated.

begin;

-- 1. Take the append-only guard off so the backfilled rows can be removed.
drop trigger if exists dua_task_events_no_update on public.dua_task_events;

-- 2. Remove only the rows this migration inserted.
delete from public.dua_task_events
where detail->>'backfill_migration' = '202611280003';

-- 3. Put the append-only guard back, exactly as file 25 defined it.
create trigger dua_task_events_no_update
  before update or delete on public.dua_task_events
  for each row execute function public.dua_task_events_immutable();

commit;
