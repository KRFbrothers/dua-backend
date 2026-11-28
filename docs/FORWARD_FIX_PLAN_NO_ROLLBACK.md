# Forward fix plan for the six migrations that cannot be rolled back

`supabase/migrations/ROLLBACK_STATUS.md` records 30 migrations, 24 rollback-able and 6 not.
This file is the plan for those 6. All six forward fixes have since shipped, so this file is now
the record of what was done and why, not a to-do list. The six original files are still marked
NO in `ROLLBACK_STATUS.md`, and that is correct: a forward fix does not make the original file
reversible, it makes the next change reversible and keeps the data that a drop would lose.

Read it as: what exactly is irreversible in each file, what a new migration would have to do so
that the same change is reversible next time, and in what order to do it.

## Current status

Every row below is taken from a merged PR on `main`, not from a plan. The forward fix migration
column is the file that actually landed.

| # | Migration file | Forward fix migration | PR | Status |
| --- | --- | --- | --- | --- |
| 1 | `20261102183410_workflow_identity_recovery.sql` | `202611280001_dua_function_history.sql` | #58 | shipped |
| 2 | `202611160001_owner_scoped_quota_rpcs.sql` | `202611280002_dua_quota_rpc_dispatch.sql` | #60 | shipped |
| 3 | `202611190003_dua_memories_scope.sql` | `202611280005_dua_memories_scope_history.sql` | #64 | shipped |
| 4 | `202611250001_dua_orhan_tasks_lifecycle.sql` | `202611280003_dua_task_links_event_backfill.sql` | #61 | shipped, API half in #65 |
| 5 | `202611260001_workflow_rpcs_authenticated.sql` | `202611280001_dua_function_history.sql` plus the rollback generator | #58, #59 | shipped |
| 6 | `202611270001_dua_task_lifecycle_workers.sql` | `202611280004_dua_task_lineage_event_backfill.sql` | #62 | shipped |

Item 4 needed two halves. The migration half (`202611280003`) backfilled the existing rows. The
API half landed in PR #65: `apps/api/src/core/task-events.mjs` now whitelists `end_reason`,
`finished_at_ms` and `stopped_at_ms`, and the completed, failed, cancelled, finish and reaped
paths write them into `detail`. Without that half the columns were a cache only for backfilled
rows, not for new ones.

Item 6 also needed an API half, and it landed in PR #63: the four lineage keys
(`parent_task_id`, `root_task_id`, `continue_thread_id`, `idempotency_key`) are whitelisted and
written on create.

Note on the numbering. The plan numbers the lifecycle file (three columns) as item 4 and the
lineage file (five columns) as item 6. The migration file headers say the opposite: the header
of `202611280003` calls itself item 6 and the header of `202611280004` calls itself item 4. The
content is what counts, and the table above follows the content: `202611280003` backfills
`end_reason`, `finished_at_ms` and `stopped_at_ms`, which is this plan's item 4.

## Summary

| # | File | Irreversible part | Fix | Effort | Data loss on fix |
| --- | --- | --- | --- | --- | --- |
| 1 | `20261102183410_workflow_identity_recovery.sql` | Two `create or replace` bodies from file 9 | Function definition history table | Medium | No |
| 2 | `202611160001_owner_scoped_quota_rpcs.sql` | Two `drop function` of the old signatures | Versioned name plus dispatcher | Medium | No |
| 3 | `202611190003_dua_memories_scope.sql` | `add column scope`, `add column source_conversation_id` | Append-only scope history table | Small | No |
| 4 | `202611250001_dua_orhan_tasks_lifecycle.sql` | Three `add column` on `dua_orhan_tasks` | Backfill `dua_task_events`, columns become a cache | Small | No |
| 5 | `202611260001_workflow_rpcs_authenticated.sql` | Ten `create or replace` across files 9, 10, 11 | Same history table as 1, plus a generator | Medium | No |
| 6 | `202611270001_dua_task_lifecycle_workers.sql` | Five `add column`, two tables, six functions | Backfill events with the link fields in `detail` | Medium | No |

None of the six destroyed a row when it ran. Every one of them is additive or a function
replacement. So all six can be made reversible going forward without losing data. What is
already lost is only the *previous definition* of the replaced functions, and that is still in
git history, so it can be backfilled.

## 1. `20261102183410_workflow_identity_recovery.sql`

**What is irreversible.** Two statements overwrite functions that file 9
(`20261102180726_workflow_execution.sql`) created:

```sql
create or replace function public.dua_workflow_claim(p_worker uuid,p_owner uuid) ...
create or replace function public.dua_workflow_checkpoint(p_owner uuid,p_id uuid,p_worker uuid,p_steps jsonb,p_status text,p_error text) ...
```

A plain `drop function` on rollback leaves the workflow with no claim and no checkpoint function
at all, so nothing can be picked up or advanced. The file also creates
`public.dua_workflow_credentials`, which holds `ciphertext` (encrypted refresh tokens). Dropping
that table forces every owner to reauthorize.

**Forward fix.** Store the previous definition before replacing it. A new table keeps one row per
captured function version, and a helper captures `pg_get_functiondef` into it. Every future
`create or replace` calls the helper first, so the body that is about to be overwritten is on
disk before it is gone. Rollback then re-applies the captured body instead of guessing.

**Landed as.** `202611280001_dua_function_history.sql` (PR #58).

**SQL sketch.**

```sql
create table if not exists public.dua_function_history (
  id bigint generated always as identity primary key,
  schema_name text not null default 'public',
  function_name text not null,
  identity_args text not null,
  definition text not null,
  captured_at timestamptz not null default now(),
  captured_by text not null default 'migration',
  unique (schema_name, function_name, identity_args, captured_at)
);
alter table public.dua_function_history enable row level security;
revoke all on public.dua_function_history from public, anon, authenticated;
grant all on public.dua_function_history to service_role;

create or replace function public.dua_capture_function(p_name text, p_args text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.dua_function_history (function_name, identity_args, definition)
  select p_name, p_args, pg_get_functiondef(p.oid)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = p_name and pg_get_function_identity_arguments(p.oid) = p_args;
end $$;
revoke all on function public.dua_capture_function(text, text) from public, anon, authenticated;
grant execute on function public.dua_capture_function(text, text) to service_role;

-- One-time backfill: the file 9 bodies are still in git, so insert them here by hand.
```

**Risk and effort.** Medium. The table is inert until something calls the helper, so it cannot
break a running workflow. The backfill needs the file 9 bodies pasted in, which is a copy from
git, not a rewrite.

**Data loss.** No. Nothing is dropped and no row is rewritten.

## 2. `202611160001_owner_scoped_quota_rpcs.sql`

**What is irreversible.** Two statements remove the old signatures on purpose:

```sql
drop function if exists public.dua_consume_imagine(text, integer, integer);
drop function if exists public.dua_start_voice_session(uuid, integer, integer, integer);
```

The comment in the file says why: PostgREST must see exactly one function per name, so the
`auth.uid()` versions had to go. A rollback that only drops the new ones leaves Imagine and live
voice with no RPC, and the API already calls the new `owner` shape.

**Forward fix.** Stop overloading a name with a signature change. Give the new body a versioned
name and keep the public name as a thin dispatcher. A rollback then re-points the dispatcher,
which is a one line change, instead of recreating a dropped signature.

**Landed as.** `202611280002_dua_quota_rpc_dispatch.sql` (PR #60).

**SQL sketch.**

```sql
-- Move the current body to a versioned name.
create or replace function public.dua_consume_imagine_v2(owner uuid, feature text, amount integer, daily_limit integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
  -- body copied unchanged from 202611160001
$$;

-- Public name stays a dispatcher, so the next change is a swap, not a drop.
create or replace function public.dua_consume_imagine(owner uuid, feature text, amount integer, daily_limit integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return public.dua_consume_imagine_v2(owner, feature, amount, daily_limit);
end $$;

revoke all on function public.dua_consume_imagine_v2(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.dua_consume_imagine_v2(uuid, text, integer, integer) to service_role;
-- Same shape for dua_start_voice_session.
```

**Risk and effort.** Medium. The backend call shape does not change, so no API deploy is needed
in the same window. The risk is a missed grant on the `_v2` name, which the RLS verify script
would not catch because it only checks tables.

**Data loss.** No. Usage counters are untouched.

## 3. `202611190003_dua_memories_scope.sql`

**What is irreversible.** Two additive columns:

```sql
alter table public.dua_memories
  add column if not exists scope text not null default 'global' ...,
  add column if not exists source_conversation_id uuid references public.dua_conversations(id) on delete set null;
```

Dropping them destroys which memory was group scoped and which thread it came from. That cannot
be rebuilt from anything else: `apps/api/src/core/artifacts-memories.mjs` line 142 derives
`source_conversation_id` from `scope`, so once both are gone the link is gone.

**Forward fix.** Write the scope to an append-only history table on every insert and update, so
the assignment survives even if the columns are later dropped. The columns then become a cache
over the history.

**Landed as.** `202611280005_dua_memories_scope_history.sql` (PR #64).

**SQL sketch.**

```sql
create table if not exists public.dua_memories_scope_history (
  id bigint generated always as identity primary key,
  owner_id uuid not null,
  memory_id uuid not null,
  scope text not null,
  source_conversation_id uuid,
  recorded_at timestamptz not null default now()
);
create index if not exists dua_memories_scope_history_memory
  on public.dua_memories_scope_history (owner_id, memory_id, recorded_at desc);
alter table public.dua_memories_scope_history enable row level security;
revoke all on public.dua_memories_scope_history from public, anon;
grant select, insert on public.dua_memories_scope_history to authenticated;
grant all on public.dua_memories_scope_history to service_role;
create policy dua_memories_scope_history_select_own on public.dua_memories_scope_history
  for select to authenticated using (owner_id = (select auth.uid()));

create or replace function public.dua_memories_scope_record()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.dua_memories_scope_history (owner_id, memory_id, scope, source_conversation_id)
  values (new.owner_id, new.id, new.scope, new.source_conversation_id);
  return new;
end $$;

create trigger dua_memories_scope_record after insert or update of scope, source_conversation_id
  on public.dua_memories for each row execute function public.dua_memories_scope_record();

-- Backfill the rows that already exist.
insert into public.dua_memories_scope_history (owner_id, memory_id, scope, source_conversation_id)
select owner_id, id, scope, source_conversation_id from public.dua_memories;
```

**Risk and effort.** Small. One trigger, one table, one backfill. The trigger is `after`, so it
cannot change what the write returns.

**Data loss.** No. The backfill reads the current columns before anything is dropped.

## 4. `202611250001_dua_orhan_tasks_lifecycle.sql`

**What is irreversible.** Three additive columns plus three check constraints:

```sql
alter table public.dua_orhan_tasks add column if not exists end_reason text;
alter table public.dua_orhan_tasks add column if not exists finished_at_ms bigint;
alter table public.dua_orhan_tasks add column if not exists stopped_at_ms bigint;
```

Dropping them loses why each task ended and when. `apps/api/src/core/orhan-tasks.mjs` line 12
selects all three, and line 379 to 380 writes them, so the user visible stopped and timed out
states depend on them.

**Forward fix.** These three values are already derivable from the task event stream that file 25
adds. Backfill one event per existing task carrying the three values in `detail`, and have the
API append an event whenever it writes them. Then the columns are a cache and a drop is
recoverable.

**Landed as.** `202611280003_dua_task_links_event_backfill.sql` (PR #61), with the API half in PR #65.

**SQL sketch.**

```sql
-- Depends on dua_task_events from 202611270001, so this runs after file 25.
insert into public.dua_task_events (owner_id, task_id, seq, event, detail)
select t.owner_id, t.task_id,
       coalesce((select max(seq) from public.dua_task_events e
                 where e.owner_id = t.owner_id and e.task_id = t.task_id), 0) + 1,
       case when t.status = 'completed' then 'completed'
            when t.status = 'failed' then 'failed'
            else 'created' end,
       jsonb_build_object('end_reason', t.end_reason,
                          'finished_at_ms', t.finished_at_ms,
                          'stopped_at_ms', t.stopped_at_ms,
                          'backfilled', true)
from public.dua_orhan_tasks t
where (t.end_reason is not null or t.finished_at_ms is not null or t.stopped_at_ms is not null)
  and not exists (select 1 from public.dua_task_events e
                  where e.owner_id = t.owner_id and e.task_id = t.task_id
                    and e.detail->>'backfilled' = 'true');
```

**Risk and effort.** Small. The insert is guarded by a `not exists`, so it is safe to run twice.
The API change is a second commit, not part of the migration.

**Data loss.** No. It only reads the columns and writes events.

## 5. `202611260001_workflow_rpcs_authenticated.sql`

**What is irreversible.** Ten `create or replace function` statements, spread over three earlier
files:

| Function | Previous body in |
| --- | --- |
| `dua_workflow_history` | file 9 |
| `dua_workflow_enqueue` | file 9 |
| `dua_workflow_claim` | file 10 |
| `dua_workflow_control` | file 9 |
| `dua_workflow_checkpoint` | file 10 |
| `dua_workflow_recover` | file 10 |
| `dua_workflow_register` | file 11 |
| `dua_workflow_automation_disable` | file 11 |
| `dua_workflow_tick` | file 11 |
| `dua_workflow_deliver` | file 11 |

A drop leaves the workflow with no RPCs, and the API already calls the owner scoped shape. The
file also moves execute grants from `service_role` to `authenticated`, so a revert reopens the
access it closed.

**Forward fix.** Same mechanism as item 1, plus a generator. Once
`public.dua_function_history` exists, a small script reads the history for a given migration's
function list and writes the matching `.rollback.sql` beside it. That turns the AGENTS.md 4.11
rule from a manual promise into a generated artifact.

**Landed as.** `202611280001_dua_function_history.sql` (PR #58) plus the rollback generator (PR #59).

**SQL sketch.**

```sql
-- Capture the current bodies before any future change touches them.
select public.dua_capture_function('dua_workflow_history', 'uuid, text');
select public.dua_capture_function('dua_workflow_enqueue', 'uuid, text, text, text, text, jsonb, timestamptz');
select public.dua_capture_function('dua_workflow_claim', 'uuid, uuid');
select public.dua_capture_function('dua_workflow_control', 'uuid, uuid, text, integer');
select public.dua_capture_function('dua_workflow_checkpoint', 'uuid, uuid, uuid, jsonb, text, text');
select public.dua_capture_function('dua_workflow_recover', 'uuid');
select public.dua_capture_function('dua_workflow_register', 'uuid, uuid, integer, text, text, text, jsonb, integer, timestamptz, boolean');
select public.dua_capture_function('dua_workflow_automation_disable', 'uuid, uuid, integer');
select public.dua_capture_function('dua_workflow_tick', 'uuid');
select public.dua_capture_function('dua_workflow_deliver', 'uuid, uuid, text');
```

**Risk and effort.** Medium. The capture calls are read only. The generator is a separate script
and a separate PR, and it must not run in CI against production.

**Data loss.** No. Function definitions are copied, not moved.

## 6. `202611270001_dua_task_lifecycle_workers.sql`

**What is irreversible.** The largest surface of the six:

```sql
alter table public.dua_orhan_tasks add column if not exists parent_task_id text;
alter table public.dua_orhan_tasks add column if not exists root_task_id text;
alter table public.dua_orhan_tasks add column if not exists continue_thread_id uuid;
alter table public.dua_orhan_tasks add column if not exists attempt integer not null default 1;
alter table public.dua_orhan_tasks add column if not exists idempotency_key text;
```

plus `dua_task_events`, `dua_workers`, six functions and the append-only trigger. Dropping the
columns loses the parent and root links, the attempt counter and the idempotency key, so retry
and continue history is gone. `dua_task_events` is the audit trail and cannot be rebuilt from
anything.

**Forward fix.** Put the five link fields into the event `detail` on every write, and backfill a
`created` event for each existing task that carries them. Then the columns are a cache over the
event stream, and the event stream is the durable record.

**Landed as.** `202611280004_dua_task_lineage_event_backfill.sql` (PR #62), with the API half in PR #63.

**SQL sketch.**

```sql
insert into public.dua_task_events (owner_id, task_id, seq, event, detail)
select t.owner_id, t.task_id,
       coalesce((select max(seq) from public.dua_task_events e
                 where e.owner_id = t.owner_id and e.task_id = t.task_id), 0) + 1,
       'created',
       jsonb_build_object('parent_task_id', t.parent_task_id,
                          'root_task_id', t.root_task_id,
                          'continue_thread_id', t.continue_thread_id,
                          'attempt', t.attempt,
                          'idempotency_key', t.idempotency_key,
                          'backfilled', true)
from public.dua_orhan_tasks t
where (t.parent_task_id is not null or t.root_task_id is not null
       or t.continue_thread_id is not null or t.attempt > 1 or t.idempotency_key is not null)
  and not exists (select 1 from public.dua_task_events e
                  where e.owner_id = t.owner_id and e.task_id = t.task_id
                    and e.detail->>'backfilled' = 'true');
```

**Risk and effort.** Medium. The backfill is guarded and idempotent. The API change to write the
fields into `detail` is a second commit and needs a test that the event and the column agree.

**Data loss.** No. It reads the columns and appends events.

## Priority order

| Order | Item | Why first |
| --- | --- | --- |
| 1 | 1 and 5 together | One table and one helper fix both, and they cover 12 replaced functions. Every future function change inherits the same gap until this exists, so the cost of waiting grows with each migration. |
| 2 | 6 | Biggest surface: two tables, six functions, five columns. It is also the newest, so it has the least data to backfill. |
| 3 | 4 | Depends on `dua_task_events` from item 6, so it cannot go first. Small once 6 is done. |
| 4 | 3 | Isolated to one table and one trigger. No dependency on the others. |
| 5 | 2 | Needs a dispatcher refactor plus a backend change in the same window, and the current shape works today. Highest coordination cost, lowest urgency. |

Items 1 and 5 are one mechanism, so they should be one PR. Items 4 and 6 both write to
`dua_task_events`, so they should be one PR after 6 lands.

This order was followed and is kept for the record. All six items are shipped, so nothing here is
still waiting on a dependency.

## Pattern for new migrations

This is the same rule `AGENTS.md` 4.11 and `CONTRIBUTING.md` section 5 already state, written as
steps so a reviewer can check it:

1. **Additive first.** A migration that only adds a table, a column with a default, an index or a
   new function name is rollback-able by definition. Prefer it.
2. **Never drop a column in the migration that stops using it.** Two steps: first stop writing
   and keep the column, then drop it in a later numbered file after a release. The gap is what
   makes the drop safe.
3. **Never `create or replace` without capturing.** Call `dua_capture_function` first, so the body
   being overwritten is on disk.
4. **Never `drop function` a signature to change it.** Add a versioned name and keep the public
   name as a dispatcher. A rollback is then a one line swap.
5. **Never drop a table that holds data you cannot rebuild.** Write the values to an append-only
   history table first, then the table is a cache.
6. **Ship the rollback file beside the migration.** `202612010001_x.sql` and
   `202612010001_x.rollback.sql`, same directory, same PR. No rollback, not done.
7. **Say which of the six patterns the file uses** in the PR body, so the reviewer does not have
   to read the SQL to know whether it is reversible.

## What cannot be fixed

Nothing in these six needs a backup restore, because none of them deleted a row. Two limits are
worth stating plainly:

- **A rollback that already ran is not covered.** If someone already dropped one of these columns
  or tables, the rows are gone. The repo has no documented backup or restore procedure: a search
  for `backup` and `restore` across `docs/`, `AGENTS.md` and `CONTRIBUTING.md` returns nothing. So
  "restore from backup" is not an option this plan can point at today. Writing that procedure is
  a separate task.
- **The backfills only cover rows that exist when they run.** A task or memory created between
  the backfill and the API change that starts writing events would have no event. Run the
  backfill after the API change, or run it twice.

## What this file does not do

- It adds no migration. Every SQL block above is a sketch of what landed, kept so a reader can
  see the shape without opening the migration.
- It changes no existing file. `ROLLBACK_STATUS.md` still says 6 of 30 cannot be rolled back, and
  that stays true: the six original files are still irreversible, the forward fixes only make the
  next change reversible and keep the data a drop would lose.
- It does not claim the fixes were run against Supabase. What was actually run: every forward fix
  migration was applied on a local PostgreSQL 15 with `auth` and `storage` stubs, together with
  all the other migrations, and the backfills, the append-only guards and the rollbacks were
  exercised there. `supabase db push` against the real project has not been run, because it needs
  owner approval. So the SQL is tested, the production apply is not.
