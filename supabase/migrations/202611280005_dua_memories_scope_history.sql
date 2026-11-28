-- Record every memory scope assignment in an append-only history table, so the
-- two columns added by `202611190003_dua_memories_scope.sql` stop being the only
-- copy of which memory was group scoped and which thread it came from.
--
-- Why: that file added `scope` and `source_conversation_id` with
-- `alter table ... add column`. Dropping them destroys every scope assignment and
-- every memory to conversation link, and nothing else records it:
-- `apps/api/src/core/artifacts-memories.mjs` line 142 derives
-- `source_conversation_id` from `scope`, so once both columns are gone the link is
-- gone. That is why the file is marked NO in `ROLLBACK_STATUS.md`.
--
-- This file is forward fix item 3 from `docs/FORWARD_FIX_PLAN_NO_ROLLBACK.md`.
-- After it, the two columns are a cache over the history: a later drop is
-- recoverable from `dua_memories_scope_history`.
--
-- No existing function is replaced here. `dua_memories_scope_record()` is new, so
-- there is no previous body to capture and no `dua_capture_function` call: the
-- helper raises `function_not_found` when the name matches nothing, and there is
-- nothing to record. `create or replace` is used only so this file can be applied
-- twice. The rollback is hand written for the same reason.
--
-- Idempotent: the table, the index and the trigger are `if not exists` or
-- `drop ... if exists` first, the function is `create or replace`, and the
-- backfill is guarded by a `not exists` on its own `change_kind = 'backfill'`
-- marker, so a second run inserts nothing.
--
-- Rollback: `202611280005_dua_memories_scope_history.rollback.sql` beside this
-- file. It drops the trigger, the function and the table, and never touches
-- `dua_memories` itself.

begin;

-- ---------------------------------------------------------------------------
-- 1. The history table
-- ---------------------------------------------------------------------------
-- `memory_id` is text, not uuid: `dua_memories` is keyed on
-- `(owner_id, memory_id)` and `memory_id` is a text slug checked against
-- `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` in `202611140002_dua_artifacts_memories.sql`.
-- The plan sketch said uuid; the real column type wins.
--
-- No foreign key to `dua_memories` on purpose. The prune trigger in
-- `202611140002` deletes the oldest rows past 200 per owner, and the whole point
-- of this table is that the scope survives the memory row.
create table if not exists public.dua_memories_scope_history (
  id bigint generated always as identity primary key,
  owner_id uuid not null,
  memory_id text not null check (char_length(memory_id) between 1 and 64),
  scope text not null check (scope = 'global' or scope ~ '^group:[0-9a-fA-F-]{36}$'),
  source_conversation_id uuid,
  -- The value before this change. Null on the first row for a memory, which is
  -- either the backfill baseline or the insert that created it.
  previous_scope text,
  previous_source_conversation_id uuid,
  -- 'backfill' for the baseline rows this file writes, 'insert' and 'update' for
  -- the rows the trigger writes. The backfill guard keys on this value.
  change_kind text not null check (change_kind in ('backfill', 'insert', 'update')),
  recorded_at timestamptz not null default clock_timestamp(),
  -- clock_timestamp(), not now(): now() is the transaction start time, so two
  -- changes in one transaction would share a timestamp and the ordering below
  -- would be ambiguous.
  recorded_by text not null default 'trigger'
);

comment on table public.dua_memories_scope_history is
  'Append-only record of every dua_memories scope assignment, so the scope and source_conversation_id columns are a cache and a later drop is recoverable.';

-- Newest first for one memory: the query a restore runs.
create index if not exists dua_memories_scope_history_memory
  on public.dua_memories_scope_history (owner_id, memory_id, recorded_at desc);

-- "What did this migration write?" and the per-owner sweep.
create index if not exists dua_memories_scope_history_kind
  on public.dua_memories_scope_history (change_kind, recorded_at desc);

-- ---------------------------------------------------------------------------
-- 2. Row level security
-- ---------------------------------------------------------------------------
-- Same shape as `dua_memories` in `202611140002`: a row is only ever visible to
-- the account that owns it. There is no insert, update or delete policy and no
-- such grant, because the only writer is the security definer trigger below. A
-- signed-in user therefore cannot forge a history row, and cannot rewrite one.
alter table public.dua_memories_scope_history enable row level security;
revoke all on public.dua_memories_scope_history from public, anon;
grant select on public.dua_memories_scope_history to authenticated;
grant all on public.dua_memories_scope_history to service_role;

drop policy if exists dua_memories_scope_history_select_own on public.dua_memories_scope_history;
create policy dua_memories_scope_history_select_own on public.dua_memories_scope_history
  for select to authenticated using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. Append-only guard
-- ---------------------------------------------------------------------------
-- Enforced in the database, not only by the missing grant, exactly like
-- `dua_task_events_immutable()` in `202611270001_dua_task_lifecycle_workers.sql`.
-- The rollback has to drop this trigger to remove the backfilled rows.
create or replace function public.dua_memories_scope_history_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'dua_memories_scope_history is append-only';
end $$;
revoke all on function public.dua_memories_scope_history_immutable() from public, anon, authenticated;

drop trigger if exists dua_memories_scope_history_no_update on public.dua_memories_scope_history;
create trigger dua_memories_scope_history_no_update
  before update or delete on public.dua_memories_scope_history
  for each row execute function public.dua_memories_scope_history_immutable();

-- ---------------------------------------------------------------------------
-- 4. The recorder
-- ---------------------------------------------------------------------------
-- `after`, so it cannot change what the write returns, and `security definer` so
-- the insert is allowed even though `authenticated` has no insert grant on the
-- history table. `search_path = ''` means every name below is schema qualified.
create or replace function public.dua_memories_scope_record()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.dua_memories_scope_history (
    owner_id, memory_id, scope, source_conversation_id,
    previous_scope, previous_source_conversation_id, change_kind, recorded_by
  ) values (
    new.owner_id,
    new.memory_id,
    new.scope,
    new.source_conversation_id,
    case when tg_op = 'UPDATE' then old.scope else null end,
    case when tg_op = 'UPDATE' then old.source_conversation_id else null end,
    case when tg_op = 'UPDATE' then 'update' else 'insert' end,
    'trigger'
  );
  return null;
end $$;
revoke all on function public.dua_memories_scope_record() from public, anon, authenticated;

drop trigger if exists dua_memories_scope_record on public.dua_memories;
create trigger dua_memories_scope_record
  after insert or update of scope, source_conversation_id on public.dua_memories
  for each row execute function public.dua_memories_scope_record();

-- ---------------------------------------------------------------------------
-- 5. Baseline for the rows that already exist
-- ---------------------------------------------------------------------------
-- One row per memory that has no history yet, carrying the value the columns hold
-- today. `owner_id` comes from the memory row, never from `auth.uid()`: a
-- migration runs without a JWT, so the column default would be null.
--
-- The guard is per memory, not global, so a memory created between two runs of
-- this file still gets its baseline on the second run and nothing is duplicated.
insert into public.dua_memories_scope_history (
  owner_id, memory_id, scope, source_conversation_id,
  previous_scope, previous_source_conversation_id, change_kind, recorded_by
)
select
  m.owner_id,
  m.memory_id,
  m.scope,
  m.source_conversation_id,
  null,
  null,
  'backfill',
  'migration:202611280005'
from public.dua_memories m
where not exists (
  select 1 from public.dua_memories_scope_history h
  where h.owner_id = m.owner_id
    and h.memory_id = m.memory_id
);

commit;
