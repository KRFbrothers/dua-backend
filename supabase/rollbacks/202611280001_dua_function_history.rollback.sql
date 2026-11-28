-- Rollback for 202611280001_dua_function_history.sql
--
-- Removes exactly what the forward file added: the capture helper, the two
-- indexes and the history table. Nothing else in the schema is touched, and no
-- other migration's object is referenced.
--
-- Data loss: every captured function definition is deleted. That is the point of
-- the rollback, but it also means a function replaced after this migration ran
-- loses its restore point. Export the table first if any body is still needed:
--   copy (select * from public.dua_function_history) to stdout with (format csv, header true);
--
-- Safe to run again: every statement is `if exists`.

begin;

-- 1. The helper first, so nothing can write to the table while it is dropped.
drop function if exists public.dua_capture_function(text, text, text);

-- 2. Indexes go with the table, but drop them explicitly so a partial earlier
--    run leaves no orphan.
drop index if exists public.dua_function_history_latest_idx;
drop index if exists public.dua_function_history_captured_idx;

-- 3. The table.
drop table if exists public.dua_function_history;

commit;
