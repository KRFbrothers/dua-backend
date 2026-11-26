-- PR D-fix-2: the conversation preview follows the newest message only, and clients cannot choose
-- a message's created_at or id. Additive and safe to run again. No table, column or data changes:
-- existing previews are left as they are (the next newer message corrects them).
--
-- 1) Before: every insert overwrote last_message_preview, even when the inserted row was older than
--    last_message_at (out-of-order commits of parallel group replies, or a client-chosen created_at),
--    so the preview and the recency could disagree. Now the preview only changes when the new row is
--    at least as new as last_message_at. last_message_at still uses greatest().
-- 2) Before: authenticated could insert any column, including created_at (a future value pins a chat
--    to the top and breaks paging) and id. Now only the columns the API writes are insertable; the
--    database defaults decide id and created_at. service_role (backups) is unchanged.
begin;

create or replace function public.dua_messages_touch_conversation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.dua_conversations c
     set last_message_at = greatest(c.last_message_at, new.created_at),
         last_message_preview = case
           when new.created_at >= c.last_message_at
             then left(regexp_replace(new.content, '\s+', ' ', 'g'), 200)
           else c.last_message_preview
         end
   where c.id = new.conversation_id and c.owner_id = new.owner_id;
  return null;
end $$;
revoke all on function public.dua_messages_touch_conversation() from public, anon, authenticated;
-- The trigger dua_messages_touch_conversation (202611190001) already calls this function; it is unchanged.

-- Revoking the table-level INSERT also clears any column-level INSERT, so this pair is repeatable.
revoke insert on public.dua_messages from authenticated;
grant insert (conversation_id, owner_id, agent_id, role, content, model, token_count, usage)
  on public.dua_messages to authenticated;

commit;
