-- Owner-scoped custom agents and skills (dua_agents, dua_agent_skills).
-- The Node API uses the signed-in user's token and the anon key only; RLS decides every row.
-- Two official pinned agents ('personal-agent', 'dua-agent') cannot be deleted.
-- Starter skills live in apps/ai-engine/dua_engine/agent/dua_agent_prompts.json;
-- dua_agent_skills stores user-created skills plus starter overrides (decision 2).

create table if not exists public.dua_agents (
  id text not null check (id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  description text not null default '' check (char_length(description) <= 500),
  mode text not null default 'auto' check (mode in ('auto', 'agent', 'reasoning', 'build')),
  system_prompt text not null default '' check (char_length(system_prompt) <= 20000),
  model text check (model is null or char_length(model) between 1 and 120),
  pinned boolean not null default false,
  is_official boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id, owner_id)
);
create index if not exists dua_agents_owner_idx
  on public.dua_agents (owner_id, pinned desc, updated_at desc, id);

create table if not exists public.dua_agent_skills (
  id text not null check (id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  agent_id text not null default 'dua-agent' check (agent_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  title text not null check (char_length(title) between 1 and 100),
  summary text not null default '' check (char_length(summary) <= 500),
  body text not null default '' check (char_length(body) <= 50000),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id, owner_id)
);
create index if not exists dua_agent_skills_owner_idx
  on public.dua_agent_skills (owner_id, agent_id, updated_at desc, id);

alter table public.dua_agents enable row level security;
revoke all on public.dua_agents from public, anon;
grant select, insert, update, delete on public.dua_agents to authenticated;
grant select, insert, update, delete on public.dua_agents to service_role;

drop policy if exists dua_agents_select_own on public.dua_agents;
create policy dua_agents_select_own on public.dua_agents for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists dua_agents_insert_own on public.dua_agents;
create policy dua_agents_insert_own on public.dua_agents for insert to authenticated with check (owner_id = (select auth.uid()));
drop policy if exists dua_agents_update_own on public.dua_agents;
create policy dua_agents_update_own on public.dua_agents for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists dua_agents_delete_own on public.dua_agents;
create policy dua_agents_delete_own on public.dua_agents for delete to authenticated using (owner_id = (select auth.uid()) and not is_official);

alter table public.dua_agent_skills enable row level security;
revoke all on public.dua_agent_skills from public, anon;
grant select, insert, update, delete on public.dua_agent_skills to authenticated;
grant select, insert, update, delete on public.dua_agent_skills to service_role;

drop policy if exists dua_agent_skills_select_own on public.dua_agent_skills;
create policy dua_agent_skills_select_own on public.dua_agent_skills for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists dua_agent_skills_insert_own on public.dua_agent_skills;
create policy dua_agent_skills_insert_own on public.dua_agent_skills for insert to authenticated with check (owner_id = (select auth.uid()));
drop policy if exists dua_agent_skills_update_own on public.dua_agent_skills;
create policy dua_agent_skills_update_own on public.dua_agent_skills for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists dua_agent_skills_delete_own on public.dua_agent_skills;
create policy dua_agent_skills_delete_own on public.dua_agent_skills for delete to authenticated using (owner_id = (select auth.uid()));
