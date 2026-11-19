-- Phase 4A: Multi-Agent Group Chat
-- Migration 202611190004: Create dua_conversation_agents junction table.
-- Allows associating multiple agents with a single conversation.
-- Owner RLS is strictly enforced: owner_id = (select auth.uid()).

create table if not exists public.dua_conversation_agents (
  conversation_id uuid not null references public.dua_conversations(id) on delete cascade,
  agent_id text not null check (agent_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (conversation_id, agent_id)
);

create index if not exists dua_conversation_agents_owner_idx
  on public.dua_conversation_agents (owner_id, conversation_id, added_at asc);

alter table public.dua_conversation_agents enable row level security;
revoke all on public.dua_conversation_agents from public, anon;
grant select, insert, delete on public.dua_conversation_agents to authenticated;
grant select, insert, update, delete on public.dua_conversation_agents to service_role;

drop policy if exists dua_conversation_agents_select_own on public.dua_conversation_agents;
create policy dua_conversation_agents_select_own on public.dua_conversation_agents
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists dua_conversation_agents_insert_own on public.dua_conversation_agents;
create policy dua_conversation_agents_insert_own on public.dua_conversation_agents
  for insert to authenticated with check (owner_id = (select auth.uid()));

drop policy if exists dua_conversation_agents_delete_own on public.dua_conversation_agents;
create policy dua_conversation_agents_delete_own on public.dua_conversation_agents
  for delete to authenticated using (owner_id = (select auth.uid()));
