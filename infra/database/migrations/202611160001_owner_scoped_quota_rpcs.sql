-- Owner-scoped quota RPCs (follow-up to F-01, 202611140001_revoke_quota_authenticated.sql).
-- ============================================================================
-- After F-01, `dua_consume_imagine` and `dua_start_voice_session` may only be
-- executed by `service_role`, and the backend (Node API, and the Python engine
-- for Imagine) calls them with the service-role key. But both functions took the
-- account from `auth.uid()`, which is NULL for a service-role call, so every
-- Imagine charge and every live voice start failed with 'Sign in required'.
--
-- This migration replaces both functions with versions that take the account as
-- an explicit `owner uuid` argument. The backend verifies the caller is the
-- configured owner first (resolveOwner / owner_auth) and passes that user's id.
-- Quota logic and the returned JSON are unchanged. EXECUTE stays with
-- `service_role` only, so a signed-in user still cannot pick their own limit or
-- charge another account (keeps F-01's intent).
--
-- The old auth.uid()-based signatures are dropped so PostgREST has exactly one
-- function per name (no overload ambiguity) and nobody can call the old ones.
--
-- Order: apply this migration in the Supabase SQL editor (or `supabase db push`)
-- and deploy the matching backend in the same window: migration first, then the
-- API/engine. Until both are done, Imagine and live voice starts return 503
-- (they already do after F-01). Safe to run again.
--
-- Not changed: dua_read_imagine_usage(), dua_end_voice_session(uuid),
-- dua_read_voice_usage() still run with the owner's own token on auth.uid().
-- ============================================================================

-- Imagine: images and video-request cap (was 202610090001_dua_imagine.sql).
drop function if exists public.dua_consume_imagine(text, integer, integer);

create or replace function public.dua_consume_imagine(owner uuid, feature text, amount integer, daily_limit integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 account_id uuid := owner;
 day_utc date := (pg_catalog.now() at time zone 'UTC')::date;
 used integer;
 reset_epoch bigint;
begin
 if account_id is null then raise exception 'Sign in required' using errcode = '42501'; end if;
 if feature is null or feature not in ('image', 'video') or amount is null or amount < 1 or amount > 100
    or daily_limit is null or daily_limit < 0 or daily_limit > 100000
 then raise exception 'Invalid Imagine usage request' using errcode = '22023'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('imagine:' || account_id::text || day_utc::text, 7));
 delete from public.dua_imagine_usage where owner_id = account_id and usage_day < day_utc - 30;
 select case when feature = 'image' then images else video_seconds end into used
   from public.dua_imagine_usage where owner_id = account_id and usage_day = day_utc;
 used := coalesce(used, 0);
 reset_epoch := extract(epoch from ((day_utc + 1)::timestamp at time zone 'UTC'))::bigint;
 if used + amount > daily_limit then
  return jsonb_build_object('allowed', false, 'used', used, 'resetAt', reset_epoch);
 end if;
 insert into public.dua_imagine_usage(owner_id, usage_day, images, video_seconds)
 values (account_id, day_utc, case when feature = 'image' then amount else 0 end, case when feature = 'video' then amount else 0 end)
 on conflict (owner_id, usage_day) do update
   set images = public.dua_imagine_usage.images + excluded.images,
       video_seconds = public.dua_imagine_usage.video_seconds + excluded.video_seconds;
 return jsonb_build_object('allowed', true, 'used', used + amount, 'resetAt', reset_epoch);
end $$;
revoke all on function public.dua_consume_imagine(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.dua_consume_imagine(uuid, text, integer, integer) to service_role;

-- Live voice: session-start cap (was 202610100001_dua_voice.sql).
drop function if exists public.dua_start_voice_session(uuid, integer, integer, integer);

create or replace function public.dua_start_voice_session(owner uuid, session_id uuid, reserve_seconds integer, daily_limit_seconds integer, min_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 account_id uuid := owner;
 day_utc date := (pg_catalog.now() at time zone 'UTC')::date;
 used integer;
 active integer;
 remaining integer;
 granted integer;
 reset_epoch bigint;
begin
 if account_id is null then raise exception 'Sign in required' using errcode = '42501'; end if;
 if session_id is null or reserve_seconds is null or reserve_seconds < 1 or reserve_seconds > 7200
    or daily_limit_seconds is null or daily_limit_seconds < 0 or daily_limit_seconds > 86400
    or min_seconds is null or min_seconds < 1 or min_seconds > reserve_seconds
 then raise exception 'Invalid voice session request' using errcode = '22023'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('voice:' || account_id::text, 7));
 perform public.dua_voice_settle_overdue(account_id);
 delete from public.dua_voice_usage where owner_id = account_id and usage_day < day_utc - 30;
 delete from public.dua_voice_sessions where owner_id = account_id and ended_at is not null and usage_day < day_utc - 30;
 select seconds into used from public.dua_voice_usage where owner_id = account_id and usage_day = day_utc;
 used := coalesce(used, 0);
 select coalesce(sum(reserved_seconds), 0) into active from public.dua_voice_sessions
  where owner_id = account_id and ended_at is null and usage_day = day_utc;
 reset_epoch := extract(epoch from ((day_utc + 1)::timestamp at time zone 'UTC'))::bigint;
 remaining := greatest(0, daily_limit_seconds - used - active);
 if remaining < min_seconds then
  return jsonb_build_object('allowed', false, 'usedSeconds', used, 'activeSeconds', active, 'limitSeconds', daily_limit_seconds, 'resetAt', reset_epoch);
 end if;
 if exists (select 1 from public.dua_voice_sessions where id = session_id) then
  raise exception 'Voice session already exists' using errcode = '23505';
 end if;
 granted := least(reserve_seconds, remaining);
 insert into public.dua_voice_sessions(id, owner_id, usage_day, reserved_seconds) values (session_id, account_id, day_utc, granted);
 return jsonb_build_object('allowed', true, 'grantedSeconds', granted, 'usedSeconds', used, 'activeSeconds', active + granted,
   'limitSeconds', daily_limit_seconds, 'resetAt', reset_epoch);
end $$;
revoke all on function public.dua_start_voice_session(uuid, uuid, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.dua_start_voice_session(uuid, uuid, integer, integer, integer) to service_role;
