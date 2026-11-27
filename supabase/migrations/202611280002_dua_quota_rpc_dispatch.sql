-- Versioned quota RPCs behind a stable public name, so a signature change stops
-- being a one way door.
--
-- Why: `202611160001_owner_scoped_quota_rpcs.sql` had to `drop function` the old
-- `auth.uid()` signatures of `dua_consume_imagine` and `dua_start_voice_session`,
-- because PostgREST must see exactly one function per name. A rollback that only
-- dropped the new ones would leave Imagine and live voice with no RPC at all, so
-- that file is marked NO in `ROLLBACK_STATUS.md`.
--
-- This file is forward fix item 2 from `docs/FORWARD_FIX_PLAN_NO_ROLLBACK.md`. It
-- moves each current body to a versioned name and keeps the public name as a thin
-- dispatcher. The next change to either RPC is then a one line swap of the
-- dispatcher target, not a dropped signature, and a rollback is a `create or
-- replace` of the dispatcher.
--
-- Behaviour is unchanged: the dispatcher passes every argument straight through,
-- the quota logic and the returned JSON are the bodies from file 15, and EXECUTE
-- stays with `service_role` only, so F-01's intent is kept.
--
-- Additive plus two `create or replace` of the same signatures, so no grant is
-- lost and no caller changes. Safe to run again.
--
-- Rollback: `202611280002_dua_quota_rpc_dispatch.rollback.sql` beside this file.
-- It restores both public bodies from `dua_function_history` and drops the two
-- versioned functions, which did not exist before this file.

begin;

-- ---------------------------------------------------------------------------
-- 1. Record the bodies this file is about to replace
-- ---------------------------------------------------------------------------
-- `dua_capture_function` raises `function_not_found` if the name and type list
-- match nothing, so a typo fails here instead of leaving the rollback with no
-- body to restore. It returns null when the body is already the newest row.
select public.dua_capture_function(
  'dua_consume_imagine',
  'uuid, text, integer, integer',
  'migration:202611280002'
);

select public.dua_capture_function(
  'dua_start_voice_session',
  'uuid, uuid, integer, integer, integer',
  'migration:202611280002'
);

-- ---------------------------------------------------------------------------
-- 2. Imagine: body moves to dua_consume_imagine_v2, unchanged
-- ---------------------------------------------------------------------------
-- Plain `create function`, not `create or replace`: this name did not exist
-- before this file, and saying so is what lets the rollback generator know the
-- function is new and must be dropped on the way back. Re-running this file
-- therefore fails loudly on this statement (42723, function already exists)
-- instead of silently doing nothing. That is the intended trade: a rollback that
-- can be generated beats a file that can be replayed.
create function public.dua_consume_imagine_v2(owner uuid, feature text, amount integer, daily_limit integer)
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

revoke all on function public.dua_consume_imagine_v2(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.dua_consume_imagine_v2(uuid, text, integer, integer) to service_role;

-- The public name stays a dispatcher. Same signature as file 15, so the existing
-- grants on it survive the replace.
create or replace function public.dua_consume_imagine(owner uuid, feature text, amount integer, daily_limit integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return public.dua_consume_imagine_v2(owner, feature, amount, daily_limit);
end $$;

revoke all on function public.dua_consume_imagine(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.dua_consume_imagine(uuid, text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Live voice: body moves to dua_start_voice_session_v2, unchanged
-- ---------------------------------------------------------------------------
-- Plain `create function` for the same reason as dua_consume_imagine_v2 above.
create function public.dua_start_voice_session_v2(owner uuid, session_id uuid, reserve_seconds integer, daily_limit_seconds integer, min_seconds integer)
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

revoke all on function public.dua_start_voice_session_v2(uuid, uuid, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.dua_start_voice_session_v2(uuid, uuid, integer, integer, integer) to service_role;

create or replace function public.dua_start_voice_session(owner uuid, session_id uuid, reserve_seconds integer, daily_limit_seconds integer, min_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return public.dua_start_voice_session_v2(owner, session_id, reserve_seconds, daily_limit_seconds, min_seconds);
end $$;

revoke all on function public.dua_start_voice_session(uuid, uuid, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.dua_start_voice_session(uuid, uuid, integer, integer, integer) to service_role;

commit;
