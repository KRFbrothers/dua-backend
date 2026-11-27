-- Phase 3: task lifecycle, parent/continue links, worker registry.
-- Additive and nullable only. No data rewrite, no change to existing status checks,
-- RLS policies or grants on dua_orhan_tasks. Safe to run again.
--
-- Covers Phase 3 items:
--   2.2  task_events append-only table
--   3.1  parent_task_id
--   3.2  root_task_id
--   3.3  continue_thread_id
--   3.4  attempt
--   3.5  idempotency_key
--   4.1  dua_workers table
--   4.2  worker columns (last_seen, capacity, version, draining)

-- ---------------------------------------------------------------------------
-- 3. Parent task / continue thread columns on dua_orhan_tasks
-- ---------------------------------------------------------------------------
alter table public.dua_orhan_tasks add column if not exists parent_task_id text;
alter table public.dua_orhan_tasks add column if not exists root_task_id text;
alter table public.dua_orhan_tasks add column if not exists continue_thread_id uuid;
alter table public.dua_orhan_tasks add column if not exists attempt integer not null default 1;
alter table public.dua_orhan_tasks add column if not exists idempotency_key text;

-- A parent link must point at a task of the same owner. The composite FK uses the
-- existing (owner_id, task_id) primary key, so a cross-owner link is impossible.
alter table public.dua_orhan_tasks drop constraint if exists dua_orhan_tasks_parent_fk;
alter table public.dua_orhan_tasks add constraint dua_orhan_tasks_parent_fk
  foreign key (owner_id, parent_task_id) references public.dua_orhan_tasks (owner_id, task_id)
  on delete set null;

alter table public.dua_orhan_tasks drop constraint if exists dua_orhan_tasks_root_fk;
alter table public.dua_orhan_tasks add constraint dua_orhan_tasks_root_fk
  foreign key (owner_id, root_task_id) references public.dua_orhan_tasks (owner_id, task_id)
  on delete set null;

alter table public.dua_orhan_tasks drop constraint if exists dua_orhan_tasks_attempt_check;
alter table public.dua_orhan_tasks add constraint dua_orhan_tasks_attempt_check
  check (attempt between 1 and 100);

alter table public.dua_orhan_tasks drop constraint if exists dua_orhan_tasks_idempotency_check;
alter table public.dua_orhan_tasks add constraint dua_orhan_tasks_idempotency_check
  check (idempotency_key is null or char_length(idempotency_key) between 1 and 200);

-- One idempotency key per owner. Partial index so existing NULL rows are unaffected.
create unique index if not exists dua_orhan_tasks_idempotency
  on public.dua_orhan_tasks (owner_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists dua_orhan_tasks_parent
  on public.dua_orhan_tasks (owner_id, parent_task_id)
  where parent_task_id is not null;

create index if not exists dua_orhan_tasks_thread
  on public.dua_orhan_tasks (owner_id, continue_thread_id)
  where continue_thread_id is not null;

-- ---------------------------------------------------------------------------
-- 2.2 task_events: append-only audit trail, one row per lifecycle transition
-- ---------------------------------------------------------------------------
create table if not exists public.dua_task_events (
  id bigint generated always as identity primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id text not null check (char_length(task_id) between 8 and 40),
  seq integer not null check (seq >= 1),
  event text not null check (event in (
    'created', 'started', 'step_started', 'step_completed', 'step_failed',
    'heartbeat', 'retry', 'cancelled', 'completed', 'failed', 'timed_out', 'reaped'
  )),
  step_id text check (step_id is null or char_length(step_id) <= 40),
  detail jsonb check (detail is null or (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 8192)),
  created_at timestamptz not null default now(),
  unique (owner_id, task_id, seq)
);
create index if not exists dua_task_events_task_seq
  on public.dua_task_events (owner_id, task_id, seq);

alter table public.dua_task_events enable row level security;
revoke all on public.dua_task_events from public, anon;
-- Append-only for the owner: select and insert only, never update or delete.
grant select, insert on public.dua_task_events to authenticated;
grant select, insert, delete on public.dua_task_events to service_role;

drop policy if exists dua_task_events_select_own on public.dua_task_events;
create policy dua_task_events_select_own on public.dua_task_events
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists dua_task_events_insert_own on public.dua_task_events;
create policy dua_task_events_insert_own on public.dua_task_events
  for insert to authenticated with check (owner_id = (select auth.uid()));

-- Append-only is enforced in the database, not only by the missing grant.
create or replace function public.dua_task_events_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'dua_task_events is append-only';
end $$;
revoke all on function public.dua_task_events_immutable() from public, anon, authenticated;

drop trigger if exists dua_task_events_no_update on public.dua_task_events;
create trigger dua_task_events_no_update before update or delete on public.dua_task_events
  for each row execute function public.dua_task_events_immutable();

-- Next sequence number for a task. Called by the API before each insert so the
-- unique (owner_id, task_id, seq) constraint stays the single source of ordering.
create or replace function public.dua_task_events_next_seq(p_owner uuid, p_task text)
returns integer language sql security invoker set search_path = '' as $$
  select coalesce(max(seq), 0) + 1 from public.dua_task_events
  where owner_id = p_owner and task_id = p_task;
$$;
revoke all on function public.dua_task_events_next_seq(uuid, text) from public, anon;
grant execute on function public.dua_task_events_next_seq(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4.1 / 4.2 dua_workers: registered workers, heartbeat and drain
-- ---------------------------------------------------------------------------
create table if not exists public.dua_workers (
  worker_id uuid primary key,
  kind text not null check (kind in ('workflow', 'orhan', 'coding')),
  version text not null default '' check (char_length(version) <= 40),
  capacity integer not null default 1 check (capacity between 1 and 1000),
  active_jobs integer not null default 0 check (active_jobs >= 0),
  last_seen timestamptz not null default now(),
  draining boolean not null default false,
  started_at timestamptz not null default now()
);
create index if not exists dua_workers_kind_seen
  on public.dua_workers (kind, last_seen desc);

alter table public.dua_workers enable row level security;
revoke all on public.dua_workers from public, anon, authenticated;
-- Workers are infrastructure, not user data: only the server role reads or writes them.
grant all on public.dua_workers to service_role;

-- Upsert a heartbeat. A worker that restarts with the same id keeps its row.
create or replace function public.dua_worker_heartbeat(
  p_worker uuid, p_kind text, p_version text, p_capacity integer, p_active integer
) returns public.dua_workers language plpgsql security invoker set search_path = '' as $$
declare r public.dua_workers;
begin
  if p_kind not in ('workflow', 'orhan', 'coding') then raise exception 'invalid_worker_kind'; end if;
  insert into public.dua_workers (worker_id, kind, version, capacity, active_jobs, last_seen, draining)
  values (p_worker, p_kind, coalesce(p_version, ''), greatest(1, coalesce(p_capacity, 1)), greatest(0, coalesce(p_active, 0)), now(), false)
  on conflict (worker_id) do update set
    kind = excluded.kind,
    version = excluded.version,
    capacity = excluded.capacity,
    active_jobs = excluded.active_jobs,
    last_seen = now()
  returning * into r;
  return r;
end $$;
revoke all on function public.dua_worker_heartbeat(uuid, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.dua_worker_heartbeat(uuid, text, text, integer, integer) to service_role;

-- Workers that have not sent a heartbeat within p_stale_seconds.
create or replace function public.dua_workers_stale(p_stale_seconds integer default 90)
returns setof public.dua_workers language sql security invoker set search_path = '' as $$
  select * from public.dua_workers
  where last_seen < now() - make_interval(secs => greatest(1, p_stale_seconds))
  order by last_seen asc;
$$;
revoke all on function public.dua_workers_stale(integer) from public, anon, authenticated;
grant execute on function public.dua_workers_stale(integer) to service_role;

-- Mark a worker as draining so a deploy can stop new claims without killing work.
create or replace function public.dua_worker_drain(p_worker uuid, p_draining boolean default true)
returns public.dua_workers language plpgsql security invoker set search_path = '' as $$
declare r public.dua_workers;
begin
  update public.dua_workers set draining = coalesce(p_draining, true), last_seen = now()
  where worker_id = p_worker returning * into r;
  if not found then raise exception 'worker_missing'; end if;
  return r;
end $$;
revoke all on function public.dua_worker_drain(uuid, boolean) from public, anon, authenticated;
grant execute on function public.dua_worker_drain(uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 2.1 Background reaper support: find abandoned running tasks without a read
-- ---------------------------------------------------------------------------
-- The API reaper calls this with the service role. It returns the tasks it moved
-- to failed/timeout so the caller can append a 'reaped' event for each one.
create or replace function public.dua_orhan_tasks_reap(p_max_minutes integer default 10)
returns setof public.dua_orhan_tasks language plpgsql security invoker set search_path = '' as $$
declare r public.dua_orhan_tasks;
begin
  for r in
    update public.dua_orhan_tasks
    set status = 'failed',
        end_reason = 'timeout',
        error = 'This task reached its ' || greatest(1, p_max_minutes) || ' minute limit.',
        finished_at_ms = (extract(epoch from now()) * 1000)::bigint,
        updated_at_ms = (extract(epoch from now()) * 1000)::bigint
    where status = 'running'
      and started_at_ms > 0
      and started_at_ms < (extract(epoch from now()) * 1000)::bigint - greatest(1, p_max_minutes) * 60000
    returning *
  loop
    return next r;
  end loop;
end $$;
revoke all on function public.dua_orhan_tasks_reap(integer) from public, anon, authenticated;
grant execute on function public.dua_orhan_tasks_reap(integer) to service_role;
