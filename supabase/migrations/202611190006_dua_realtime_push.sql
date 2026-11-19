-- Phase 5A & 5B: Cross-Device Supabase Realtime Sync & FCM HTTP v1 Push Notifications
-- Migration 202611190006: Add realtime publications and create device tokens and notifications tables.
-- Owner RLS is strictly enforced on all new tables: owner_id = (select auth.uid()).

-- 1. Phase 5A: Realtime Publications
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.dua_conversations;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.dua_messages;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.dua_agents;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.dua_artifacts;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.dua_artifact_versions;
    exception when duplicate_object then null;
    end;
  end if;
end $$;

-- 2. Phase 5B: Device Tokens (FCM HTTP v1)
create table if not exists public.dua_device_tokens (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  token text not null check (char_length(token) between 1 and 1000),
  platform text not null check (platform in ('android', 'web')),
  device_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, token)
);

create index if not exists dua_device_tokens_owner_idx
  on public.dua_device_tokens (owner_id, updated_at desc);

alter table public.dua_device_tokens enable row level security;
revoke all on public.dua_device_tokens from public, anon;
grant select, insert, update, delete on public.dua_device_tokens to authenticated;
grant select, insert, update, delete on public.dua_device_tokens to service_role;

drop policy if exists dua_device_tokens_select_own on public.dua_device_tokens;
create policy dua_device_tokens_select_own on public.dua_device_tokens
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists dua_device_tokens_insert_own on public.dua_device_tokens;
create policy dua_device_tokens_insert_own on public.dua_device_tokens
  for insert to authenticated with check (owner_id = (select auth.uid()));

drop policy if exists dua_device_tokens_update_own on public.dua_device_tokens;
create policy dua_device_tokens_update_own on public.dua_device_tokens
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

drop policy if exists dua_device_tokens_delete_own on public.dua_device_tokens;
create policy dua_device_tokens_delete_own on public.dua_device_tokens
  for delete to authenticated using (owner_id = (select auth.uid()));

-- 3. Phase 5B: Notifications
create table if not exists public.dua_notifications (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  conversation_id uuid references public.dua_conversations(id) on delete set null,
  agent_id text check (agent_id is null or agent_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  title text not null check (char_length(title) between 1 and 200),
  body text not null check (char_length(body) between 1 and 4000),
  data jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'read')),
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists dua_notifications_owner_idx
  on public.dua_notifications (owner_id, created_at desc);

alter table public.dua_notifications enable row level security;
revoke all on public.dua_notifications from public, anon;
grant select, insert, update, delete on public.dua_notifications to authenticated;
grant select, insert, update, delete on public.dua_notifications to service_role;

drop policy if exists dua_notifications_select_own on public.dua_notifications;
create policy dua_notifications_select_own on public.dua_notifications
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists dua_notifications_insert_own on public.dua_notifications;
create policy dua_notifications_insert_own on public.dua_notifications
  for insert to authenticated with check (owner_id = (select auth.uid()));

drop policy if exists dua_notifications_update_own on public.dua_notifications;
create policy dua_notifications_update_own on public.dua_notifications
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

drop policy if exists dua_notifications_delete_own on public.dua_notifications;
create policy dua_notifications_delete_own on public.dua_notifications
  for delete to authenticated using (owner_id = (select auth.uid()));
