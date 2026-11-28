-- Rollback for 202611280005_dua_memories_scope_history.sql
--
-- Hand written, not generated: this file replaces no existing function, so
-- `apps/api/scripts/generate-function-rollback.mjs` has nothing to restore from
-- `dua_function_history`. `dua_memories_scope_record()` and
-- `dua_memories_scope_history_immutable()` are both new names, so there is no
-- previous body to put back.
--
-- What it undoes: the whole forward fix. The trigger comes off `dua_memories`,
-- the two functions and the history table are dropped. `dua_memories` itself is
-- never touched: no column is dropped, no row is deleted, so every scope and
-- source_conversation_id value stays exactly where it is.
--
-- Data loss: the recorded history is deleted, which is the point of the rollback.
-- The current value of every memory is still in `dua_memories.scope` and
-- `dua_memories.source_conversation_id`, so nothing that exists today is lost.
-- What is lost is the ability to recover a scope after those two columns are
-- dropped, which is the gap this migration closed.
--
-- Why the append-only trigger has to move: `dua_memories_scope_history` is
-- append-only, enforced by `dua_memories_scope_history_no_update` calling
-- `dua_memories_scope_history_immutable()`, which raises on any update or delete.
-- `drop table` is not blocked by a row trigger, so the trigger does not strictly
-- have to be dropped first; it is dropped anyway so the order is explicit and a
-- partial run leaves nothing half attached.
--
-- Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 202611280005_dua_memories_scope_history.rollback.sql
--
-- Safe to run again: every statement is `drop ... if exists`, so a second run is
-- a no-op.

begin;

-- 1. Stop recording. The trigger goes before the function it calls.
drop trigger if exists dua_memories_scope_record on public.dua_memories;

-- 2. Take the append-only guard off the history table.
drop trigger if exists dua_memories_scope_history_no_update on public.dua_memories_scope_history;

-- 3. Drop the two functions this migration created.
drop function if exists public.dua_memories_scope_record();
drop function if exists public.dua_memories_scope_history_immutable();

-- 4. Drop the history table. The indexes and the select policy go with it.
drop table if exists public.dua_memories_scope_history;

commit;
