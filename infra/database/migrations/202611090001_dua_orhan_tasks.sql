-- Owner-scoped Orhan tasks. The phone and Node API use the signed-in user's token.
-- Run once in the Supabase SQL editor. Safe to run again.
create table if not exists public.dua_orhan_tasks (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id text not null check (char_length(task_id) between 8 and 40),
  title text not null check (char_length(title) between 1 and 120),
  prompt text not null check (char_length(prompt) between 1 and 4000),
  status text not null check (status in ('waiting', 'running', 'approval_needed', 'failed', 'completed', 'cancelled')),
  plan jsonb not null,
  steps jsonb not null,
  artifact jsonb,
  error text check (error is null or char_length(error) <= 300),
  run_count integer not null default 0 check (run_count between 0 and 12),
  started_at_ms bigint not null default 0 check (started_at_ms >= 0),
  created_at_ms bigint not null check (created_at_ms > 0),
  updated_at_ms bigint not null check (updated_at_ms > 0),
  primary key (owner_id, task_id)
);
create index if not exists dua_orhan_tasks_owner_updated on public.dua_orhan_tasks (owner_id, updated_at_ms desc);
alter table public.dua_orhan_tasks enable row level security;
revoke all on public.dua_orhan_tasks from public, anon;
grant select, insert, update on public.dua_orhan_tasks to authenticated;
grant select, insert, update, delete on public.dua_orhan_tasks to service_role;

drop policy if exists dua_orhan_tasks_select_own on public.dua_orhan_tasks;
create policy dua_orhan_tasks_select_own on public.dua_orhan_tasks for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists dua_orhan_tasks_insert_own on public.dua_orhan_tasks;
create policy dua_orhan_tasks_insert_own on public.dua_orhan_tasks for insert to authenticated with check (owner_id = (select auth.uid()));
drop policy if exists dua_orhan_tasks_update_own on public.dua_orhan_tasks;
create policy dua_orhan_tasks_update_own on public.dua_orhan_tasks for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

-- Keep the newest 30 tasks per owner.
create or replace function public.dua_orhan_tasks_prune()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.dua_orhan_tasks where owner_id = new.owner_id and task_id in (
    select task_id from public.dua_orhan_tasks where owner_id = new.owner_id order by updated_at_ms desc, task_id offset 30);
  return null;
end $$;
revoke all on function public.dua_orhan_tasks_prune() from public, anon, authenticated;
drop trigger if exists dua_orhan_tasks_prune on public.dua_orhan_tasks;
create trigger dua_orhan_tasks_prune after insert on public.dua_orhan_tasks for each row execute function public.dua_orhan_tasks_prune();
