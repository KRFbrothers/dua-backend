-- Orhan task lifecycle details (PR K2). Additive and nullable only: no data rewrite,
-- no change to the status check, RLS policies or grants. Safe to run again.
-- The API maps status + end_reason to queued/running/completed/failed/stopped/timed_out.
alter table public.dua_orhan_tasks add column if not exists end_reason text;
alter table public.dua_orhan_tasks add column if not exists finished_at_ms bigint;
alter table public.dua_orhan_tasks add column if not exists stopped_at_ms bigint;

alter table public.dua_orhan_tasks drop constraint if exists dua_orhan_tasks_end_reason_check;
alter table public.dua_orhan_tasks add constraint dua_orhan_tasks_end_reason_check
  check (end_reason is null or end_reason in ('timeout', 'step_limit', 'user_stop', 'error'));
alter table public.dua_orhan_tasks drop constraint if exists dua_orhan_tasks_finished_at_ms_check;
alter table public.dua_orhan_tasks add constraint dua_orhan_tasks_finished_at_ms_check
  check (finished_at_ms is null or finished_at_ms > 0);
alter table public.dua_orhan_tasks drop constraint if exists dua_orhan_tasks_stopped_at_ms_check;
alter table public.dua_orhan_tasks add constraint dua_orhan_tasks_stopped_at_ms_check
  check (stopped_at_ms is null or stopped_at_ms > 0);
