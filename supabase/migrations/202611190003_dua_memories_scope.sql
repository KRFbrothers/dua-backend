-- Phase 3: Universal Living Memory + Privacy Boundaries
-- Migration 202611190003: Upgrade dua_memories with scope and source_conversation_id.
-- Scope is either 'global' (visible everywhere) or 'group:<conversation_id>' (thread-specific).
-- Owner RLS is preserved: owner_id = (select auth.uid()).

alter table public.dua_memories
  add column if not exists scope text not null default 'global'
    check (scope = 'global' or scope ~ '^group:[0-9a-fA-F-]{36}$'),
  add column if not exists source_conversation_id uuid
    references public.dua_conversations(id) on delete set null;

create index if not exists dua_memories_owner_scope_idx
  on public.dua_memories (owner_id, scope, updated_at_ms desc);
