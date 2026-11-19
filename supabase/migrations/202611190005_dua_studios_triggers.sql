-- Phase 4B & 4C: Collaborative Studios & Proactive Agents
-- Migration 202611190005: Create tables for artifact versions, agent instructions, and triggers.
-- Owner RLS is strictly enforced on every table: owner_id = (select auth.uid()).

-- 1. Artifact Versions (Collaborative Studios)
create table if not exists public.dua_artifact_versions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  artifact_id text not null check (artifact_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  version_num integer not null check (version_num >= 1),
  content text not null,
  prompt_note text not null default '',
  created_at timestamptz not null default now(),
  unique (owner_id, artifact_id, version_num),
  foreign key (owner_id, artifact_id) references public.dua_artifacts(owner_id, artifact_id) on delete cascade
);

create index if not exists dua_artifact_versions_owner_idx
  on public.dua_artifact_versions (owner_id, artifact_id, version_num desc);

alter table public.dua_artifact_versions enable row level security;
revoke all on public.dua_artifact_versions from public, anon;
grant select, insert, delete on public.dua_artifact_versions to authenticated;
grant select, insert, update, delete on public.dua_artifact_versions to service_role;

drop policy if exists dua_artifact_versions_select_own on public.dua_artifact_versions;
create policy dua_artifact_versions_select_own on public.dua_artifact_versions
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists dua_artifact_versions_insert_own on public.dua_artifact_versions;
create policy dua_artifact_versions_insert_own on public.dua_artifact_versions
  for insert to authenticated with check (owner_id = (select auth.uid()));

drop policy if exists dua_artifact_versions_delete_own on public.dua_artifact_versions;
create policy dua_artifact_versions_delete_own on public.dua_artifact_versions
  for delete to authenticated using (owner_id = (select auth.uid()));

-- 2. Agent Instructions (Proactive Agents)
create table if not exists public.dua_agent_instructions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  agent_id text not null check (agent_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  instruction text not null check (char_length(instruction) between 1 and 20000),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists dua_agent_instructions_owner_idx
  on public.dua_agent_instructions (owner_id, agent_id, created_at desc);

alter table public.dua_agent_instructions enable row level security;
revoke all on public.dua_agent_instructions from public, anon;
grant select, insert, update, delete on public.dua_agent_instructions to authenticated;
grant select, insert, update, delete on public.dua_agent_instructions to service_role;

drop policy if exists dua_agent_instructions_select_own on public.dua_agent_instructions;
create policy dua_agent_instructions_select_own on public.dua_agent_instructions
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists dua_agent_instructions_insert_own on public.dua_agent_instructions;
create policy dua_agent_instructions_insert_own on public.dua_agent_instructions
  for insert to authenticated with check (owner_id = (select auth.uid()));

drop policy if exists dua_agent_instructions_update_own on public.dua_agent_instructions;
create policy dua_agent_instructions_update_own on public.dua_agent_instructions
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

drop policy if exists dua_agent_instructions_delete_own on public.dua_agent_instructions;
create policy dua_agent_instructions_delete_own on public.dua_agent_instructions
  for delete to authenticated using (owner_id = (select auth.uid()));

-- 3. Agent Triggers (Proactive Agents)
create table if not exists public.dua_agent_triggers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  agent_id text not null check (agent_id ~ '^[a-z0-9][a-z0-9-]{0,63}$') ,
  conversation_id uuid references public.dua_conversations(id) on delete set null,
  trigger_type text not null check (trigger_type in ('schedule', 'webhook', 'missed_summary')),
  cron_expr text check (cron_expr is null or char_length(cron_expr) <= 100),
  prompt text not null check (char_length(prompt) between 1 and 10000),
  enabled boolean not null default true,
  last_run_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists dua_agent_triggers_owner_idx
  on public.dua_agent_triggers (owner_id, agent_id, created_at desc);

alter table public.dua_agent_triggers enable row level security;
revoke all on public.dua_agent_triggers from public, anon;
grant select, insert, update, delete on public.dua_agent_triggers to authenticated;
grant select, insert, update, delete on public.dua_agent_triggers to service_role;

drop policy if exists dua_agent_triggers_select_own on public.dua_agent_triggers;
create policy dua_agent_triggers_select_own on public.dua_agent_triggers
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists dua_agent_triggers_insert_own on public.dua_agent_triggers;
create policy dua_agent_triggers_insert_own on public.dua_agent_triggers
  for insert to authenticated with check (owner_id = (select auth.uid()));

drop policy if exists dua_agent_triggers_update_own on public.dua_agent_triggers;
create policy dua_agent_triggers_update_own on public.dua_agent_triggers
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

drop policy if exists dua_agent_triggers_delete_own on public.dua_agent_triggers;
create policy dua_agent_triggers_delete_own on public.dua_agent_triggers
  for delete to authenticated using (owner_id = (select auth.uid()));
