-- Owner-scoped Artifacts and Memory lists for the Android app.
-- The phone and the Node API use the signed-in user's token; the API never uses a service key here.
-- Run once in the Supabase SQL editor. Safe to run again.

-- Artifacts: files, pages and decks Dua or Agent produced for this owner.
create table if not exists public.dua_artifacts (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  artifact_id text not null check (artifact_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  title text not null check (char_length(title) between 1 and 200),
  type text not null check (char_length(type) between 1 and 40),
  timestamp text not null default '' check (char_length(timestamp) <= 60),
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  url text check (url is null or char_length(url) between 1 and 2048),
  created_at_ms bigint not null check (created_at_ms > 0),
  updated_at_ms bigint not null check (updated_at_ms > 0),
  primary key (owner_id, artifact_id)
);
create index if not exists dua_artifacts_owner_updated on public.dua_artifacts (owner_id, updated_at_ms desc);

-- Memory: facts the owner asked Dua to remember.
create table if not exists public.dua_memories (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  memory_id text not null check (memory_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  title text not null check (char_length(title) between 1 and 200),
  summary text not null default '' check (char_length(summary) <= 2000),
  timestamp text not null default '' check (char_length(timestamp) <= 60),
  category text not null default '' check (char_length(category) <= 40),
  url text check (url is null or char_length(url) between 1 and 2048),
  created_at_ms bigint not null check (created_at_ms > 0),
  updated_at_ms bigint not null check (updated_at_ms > 0),
  primary key (owner_id, memory_id)
);
create index if not exists dua_memories_owner_updated on public.dua_memories (owner_id, updated_at_ms desc);

-- Row level security: a row is only ever visible to the account that owns it.
alter table public.dua_artifacts enable row level security;
revoke all on public.dua_artifacts from public, anon;
grant select, insert, update, delete on public.dua_artifacts to authenticated;
grant select, insert, update, delete on public.dua_artifacts to service_role;

drop policy if exists dua_artifacts_select_own on public.dua_artifacts;
create policy dua_artifacts_select_own on public.dua_artifacts for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists dua_artifacts_insert_own on public.dua_artifacts;
create policy dua_artifacts_insert_own on public.dua_artifacts for insert to authenticated with check (owner_id = (select auth.uid()));
drop policy if exists dua_artifacts_update_own on public.dua_artifacts;
create policy dua_artifacts_update_own on public.dua_artifacts for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists dua_artifacts_delete_own on public.dua_artifacts;
create policy dua_artifacts_delete_own on public.dua_artifacts for delete to authenticated using (owner_id = (select auth.uid()));

alter table public.dua_memories enable row level security;
revoke all on public.dua_memories from public, anon;
grant select, insert, update, delete on public.dua_memories to authenticated;
grant select, insert, update, delete on public.dua_memories to service_role;

drop policy if exists dua_memories_select_own on public.dua_memories;
create policy dua_memories_select_own on public.dua_memories for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists dua_memories_insert_own on public.dua_memories;
create policy dua_memories_insert_own on public.dua_memories for insert to authenticated with check (owner_id = (select auth.uid()));
drop policy if exists dua_memories_update_own on public.dua_memories;
create policy dua_memories_update_own on public.dua_memories for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists dua_memories_delete_own on public.dua_memories;
create policy dua_memories_delete_own on public.dua_memories for delete to authenticated using (owner_id = (select auth.uid()));

-- Keep the newest 200 rows per owner, so a long-lived account cannot grow without bound.
create or replace function public.dua_artifacts_prune()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.dua_artifacts where owner_id = new.owner_id and artifact_id in (
    select artifact_id from public.dua_artifacts where owner_id = new.owner_id order by updated_at_ms desc, artifact_id offset 200);
  return null;
end $$;
revoke all on function public.dua_artifacts_prune() from public, anon, authenticated;
drop trigger if exists dua_artifacts_prune on public.dua_artifacts;
create trigger dua_artifacts_prune after insert on public.dua_artifacts for each row execute function public.dua_artifacts_prune();

create or replace function public.dua_memories_prune()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.dua_memories where owner_id = new.owner_id and memory_id in (
    select memory_id from public.dua_memories where owner_id = new.owner_id order by updated_at_ms desc, memory_id offset 200);
  return null;
end $$;
revoke all on function public.dua_memories_prune() from public, anon, authenticated;
drop trigger if exists dua_memories_prune on public.dua_memories;
create trigger dua_memories_prune after insert on public.dua_memories for each row execute function public.dua_memories_prune();
