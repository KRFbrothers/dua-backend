-- Owner-scoped relational chats: conversations and their messages.
-- The Node API uses the signed-in user's token and the anon key only; RLS decides every row.
-- service_role keeps a table grant only for the scheduled backup job; the API never uses it here.
-- Starts clean: nothing is migrated from dua_cloud_snapshots (dummy data only); /api/cloud is unchanged.

create table if not exists public.dua_conversations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  agent_id text not null default 'dua-agent' check (agent_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  title text not null default 'New chat' check (char_length(title) between 1 and 200),
  pinned boolean not null default false,
  last_message_preview text not null default '' check (char_length(last_message_preview) <= 200),
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (id, owner_id)
);
create index if not exists dua_conversations_owner_recent
  on public.dua_conversations (owner_id, pinned desc, last_message_at desc, id desc);

create table if not exists public.dua_messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  conversation_id uuid not null,
  agent_id text check (agent_id is null or agent_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content text not null check (char_length(content) <= 200000),
  model text check (model is null or char_length(model) between 1 and 120),
  token_count integer check (token_count is null or token_count >= 0),
  usage jsonb check (usage is null or (jsonb_typeof(usage) = 'object' and pg_column_size(usage) <= 8192)),
  created_at timestamptz not null default now(),
  -- A message can only belong to a conversation of the same owner (FK checks bypass RLS).
  foreign key (conversation_id, owner_id) references public.dua_conversations (id, owner_id) on delete cascade
);
create index if not exists dua_messages_conversation_created
  on public.dua_messages (conversation_id, created_at, id);

alter table public.dua_conversations enable row level security;
revoke all on public.dua_conversations from public, anon;
grant select, insert, delete on public.dua_conversations to authenticated;
grant update (title, pinned) on public.dua_conversations to authenticated;
grant select, insert, update, delete on public.dua_conversations to service_role;

drop policy if exists dua_conversations_select_own on public.dua_conversations;
create policy dua_conversations_select_own on public.dua_conversations for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists dua_conversations_insert_own on public.dua_conversations;
create policy dua_conversations_insert_own on public.dua_conversations for insert to authenticated with check (owner_id = (select auth.uid()));
drop policy if exists dua_conversations_update_own on public.dua_conversations;
create policy dua_conversations_update_own on public.dua_conversations for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists dua_conversations_delete_own on public.dua_conversations;
create policy dua_conversations_delete_own on public.dua_conversations for delete to authenticated using (owner_id = (select auth.uid()));

alter table public.dua_messages enable row level security;
revoke all on public.dua_messages from public, anon;
grant select, insert on public.dua_messages to authenticated;
grant select, insert, update, delete on public.dua_messages to service_role;

drop policy if exists dua_messages_select_own on public.dua_messages;
create policy dua_messages_select_own on public.dua_messages for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists dua_messages_insert_own on public.dua_messages;
create policy dua_messages_insert_own on public.dua_messages for insert to authenticated with check (owner_id = (select auth.uid()));

-- Keep the conversation list cheap: the newest message updates its preview and recency.
create or replace function public.dua_messages_touch_conversation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.dua_conversations
     set last_message_at = greatest(last_message_at, new.created_at),
         last_message_preview = left(regexp_replace(new.content, '\s+', ' ', 'g'), 200)
   where id = new.conversation_id and owner_id = new.owner_id;
  return null;
end $$;
revoke all on function public.dua_messages_touch_conversation() from public, anon, authenticated;
drop trigger if exists dua_messages_touch_conversation on public.dua_messages;
create trigger dua_messages_touch_conversation after insert on public.dua_messages
  for each row execute function public.dua_messages_touch_conversation();
