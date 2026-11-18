-- F-01 fix: close the authenticated quota bypass.
-- ============================================================================
-- `dua_consume_imagine` (Phase 3) and `dua_start_voice_session` (Phase 4) are
-- SECURITY DEFINER and take their daily limit as a parameter. They were granted
-- EXECUTE to `authenticated`, so ANY signed-in user (not just the owner) could
-- call them over PostgREST with a huge limit (e.g. daily_limit=100000) and
-- bypass the real daily caps.
--
-- This migration revokes those grants and leaves execution to `service_role`
-- only: the Node API calls these RPCs with a service-role key (it already
-- verifies the caller is the owner before using them).
--
-- Run once in the Supabase SQL editor (or `supabase db push`) AFTER deploying
-- the matching backend code from this fix. Safe to run again.
-- ============================================================================

-- Imagine: images and video-request cap (202610090001_dua_imagine.sql).
revoke all on function public.dua_consume_imagine(text, integer, integer) from authenticated;
grant execute on function public.dua_consume_imagine(text, integer, integer) to service_role;

-- Live voice: session-start cap (202610100001_dua_voice.sql).
revoke all on function public.dua_start_voice_session(uuid, integer, integer, integer) from authenticated;
grant execute on function public.dua_start_voice_session(uuid, integer, integer, integer) to service_role;

-- Read-only usage endpoints stay callable by the owner's own token (they expose
-- only auth.uid()'s own row and accept no limit), so the app's /usage screens
-- keep working without a service-role key.
--   dua_read_imagine_usage(), dua_end_voice_session(uuid), dua_read_voice_usage()
-- are intentionally NOT changed by this migration.
