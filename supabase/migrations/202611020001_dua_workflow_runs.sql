-- Owner-scoped durable snapshots of Orhan manual Agent workflow runs.
-- The run transcript remains in the owner's chat; this table stores lifecycle/history metadata only.
create table if not exists public.dua_workflow_runs (
 owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 run_id text not null check (char_length(run_id) between 1 and 100),
 workflow_id text not null check (char_length(workflow_id) between 1 and 100),
 workflow_title text not null check (char_length(workflow_title) between 1 and 120),
 chat_title text not null check (char_length(chat_title) between 1 and 120),
 agent_id text check (agent_id is null or char_length(agent_id) <= 100),
 agent_name text not null check (char_length(agent_name) between 1 and 100),
 status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
 started_at_ms bigint not null check (started_at_ms > 0),
 finished_at_ms bigint not null default 0 check (finished_at_ms >= 0),
 error text check (error is null or char_length(error) <= 300),
 engine_run_id text check (engine_run_id is null or char_length(engine_run_id) <= 100),
 updated_at timestamptz not null default now(),
 primary key (owner_id, run_id)
);
create index if not exists dua_workflow_runs_owner_started on public.dua_workflow_runs (owner_id, started_at_ms desc);
alter table public.dua_workflow_runs enable row level security;
revoke all on public.dua_workflow_runs from public, anon;
grant select, insert, update on public.dua_workflow_runs to authenticated;
grant select, insert, update, delete on public.dua_workflow_runs to service_role;

drop policy if exists dua_workflow_runs_select_own on public.dua_workflow_runs;
create policy dua_workflow_runs_select_own on public.dua_workflow_runs for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists dua_workflow_runs_insert_own on public.dua_workflow_runs;
create policy dua_workflow_runs_insert_own on public.dua_workflow_runs for insert to authenticated with check (owner_id = (select auth.uid()));
drop policy if exists dua_workflow_runs_update_own on public.dua_workflow_runs;
create policy dua_workflow_runs_update_own on public.dua_workflow_runs for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
