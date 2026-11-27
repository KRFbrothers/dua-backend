-- Function definition history, so a replaced function body can be restored.
--
-- Why: `20261102183410_workflow_identity_recovery.sql` replaced two functions and
-- `202611260001_workflow_rpcs_authenticated.sql` replaced ten, all with
-- `create or replace`. Once replaced, the previous body existed only in git, so a
-- rollback could not re-apply it. This file adds the missing record: one row per
-- captured function version, written before the body is overwritten.
--
-- Additive only. No existing table, function, policy or grant is changed. Safe to
-- run again: the table, the helper and the indexes are all `if not exists`, and the
-- baseline capture skips a function whose current body is already the newest row.
--
-- Rollback: `202611280001_dua_function_history.rollback.sql` beside this file.

begin;

-- ---------------------------------------------------------------------------
-- 1. The history table
-- ---------------------------------------------------------------------------
create table if not exists public.dua_function_history (
  id bigint generated always as identity primary key,
  schema_name text not null default 'public',
  function_name text not null,
  identity_args text not null,
  definition text not null,
  captured_at timestamptz not null default clock_timestamp(),
  captured_by text not null default 'migration',
  -- clock_timestamp(), not now(): now() is the transaction start time, so two
  -- captures in one migration would collide on this key.
  constraint dua_function_history_key unique (schema_name, function_name, identity_args, captured_at),
  constraint dua_function_history_name_check check (function_name ~ '^[a-z_][a-z0-9_]{0,62}$'),
  constraint dua_function_history_schema_check check (schema_name ~ '^[a-z_][a-z0-9_]{0,62}$'),
  constraint dua_function_history_definition_check check (length(definition) between 1 and 1000000)
);

comment on table public.dua_function_history is
  'Append-only record of function definitions captured before a create or replace. Read by a rollback, never by the app.';

-- Infrastructure table, not user data: the server role reads and writes it, and
-- no signed-in user may see another owner's function bodies. Same shape as
-- public.dua_workers in 202611270001.
alter table public.dua_function_history enable row level security;
revoke all on public.dua_function_history from public, anon, authenticated;
grant all on public.dua_function_history to service_role;

-- ---------------------------------------------------------------------------
-- 2. Lookup indexes
-- ---------------------------------------------------------------------------
-- Newest version of one function: the query a rollback runs.
create index if not exists dua_function_history_latest_idx
  on public.dua_function_history (schema_name, function_name, identity_args, captured_at desc);

-- "What did this migration capture?" and the retention sweep.
create index if not exists dua_function_history_captured_idx
  on public.dua_function_history (captured_at desc, captured_by);

-- ---------------------------------------------------------------------------
-- 3. Capture helper
-- ---------------------------------------------------------------------------
-- Copies the current definition of one function into the history table. Call it
-- immediately before a `create or replace` that would overwrite that function.
--
-- Raises `function_not_found` when the name and argument list match nothing, so a
-- typo in a migration fails loudly instead of recording nothing. That is the whole
-- point: a silent no-op here would leave the next rollback with no body to restore.
create or replace function public.dua_capture_function(
  p_name text,
  p_args text,
  p_captured_by text default 'migration'
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_definition text;
  v_id bigint;
begin
  if p_name is null or p_name !~ '^[a-z_][a-z0-9_]{0,62}$' then
    raise exception 'invalid_function_name' using detail = coalesce(p_name, 'null');
  end if;
  if p_args is null then
    raise exception 'invalid_function_args' using detail = 'null';
  end if;

  select pg_get_functiondef(p.oid)
    into v_definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = p_name
     -- Types only, no parameter names: pg_get_function_identity_arguments returns
     -- 'p_worker uuid, p_owner uuid', which would never match a caller writing
     -- 'uuid, uuid'. oidvectortypes gives exactly the type list.
     and oidvectortypes(p.proargtypes) = p_args;

  if v_definition is null then
    raise exception 'function_not_found'
      using detail = format('public.%s(%s)', p_name, p_args),
            hint = 'Check the name and the type list, for example uuid, text.';
  end if;

  -- Nothing changed since the last capture: keep the table free of duplicates.
  if exists (
    select 1 from public.dua_function_history h
     where h.schema_name = 'public'
       and h.function_name = p_name
       and h.identity_args = p_args
       and h.definition = v_definition
  ) then
    return null;
  end if;

  insert into public.dua_function_history (schema_name, function_name, identity_args, definition, captured_by)
  values ('public', p_name, p_args, v_definition, coalesce(p_captured_by, 'migration'))
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.dua_capture_function(text, text, text) is
  'Records the current definition of public.<p_name>(<p_args>) before it is replaced. Returns the new row id, or null when the body is unchanged.';

revoke all on function public.dua_capture_function(text, text, text) from public, anon, authenticated;
grant execute on function public.dua_capture_function(text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Baseline capture
-- ---------------------------------------------------------------------------
-- The twelve functions that files 10 and 23 replaced in place. Their current
-- bodies are recorded now, so the next change to any of them has a restore point
-- that predates it. A function that does not exist yet is skipped with a notice,
-- never silently: the notice names it.
do $$
declare
  v_target record;
  v_id bigint;
begin
  for v_target in
    select * from (values
      ('dua_workflow_history', 'uuid, text'),
      ('dua_workflow_enqueue', 'uuid, text, text, text, text, jsonb, timestamp with time zone'),
      ('dua_workflow_claim', 'uuid, uuid'),
      ('dua_workflow_control', 'uuid, uuid, text, integer'),
      ('dua_workflow_checkpoint', 'uuid, uuid, uuid, jsonb, text, text'),
      ('dua_workflow_recover', 'uuid'),
      ('dua_workflow_register', 'uuid, uuid, integer, text, text, text, jsonb, integer, timestamp with time zone, boolean'),
      ('dua_workflow_automation_disable', 'uuid, uuid, integer'),
      ('dua_workflow_tick', 'uuid'),
      ('dua_workflow_deliver', 'uuid, uuid, text'),
      ('dua_workflow_identity', 'uuid, text, uuid, bigint, text')
    ) as t(function_name, identity_args)
  loop
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname = v_target.function_name
         and oidvectortypes(p.proargtypes) = v_target.identity_args
    ) then
      v_id := public.dua_capture_function(v_target.function_name, v_target.identity_args, 'migration:202611280001');
      if v_id is not null then
        raise notice 'captured public.%(%) as history id %', v_target.function_name, v_target.identity_args, v_id;
      end if;
    else
      raise notice 'skipped public.%(%) : not present in this database', v_target.function_name, v_target.identity_args;
    end if;
  end loop;
end;
$$;

commit;
