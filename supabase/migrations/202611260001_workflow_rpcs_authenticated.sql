-- Workflow RPCs run as the signed-in owner (user JWT + anon key). Additive and
-- safe to run again. Table grants stay as they are: authenticated keeps SELECT
-- on executions/automation; credentials and deliveries stay locked.
-- Mutations become SECURITY DEFINER with an empty search_path and require
-- auth.uid() = p_owner. No GRANT to anon, including dua_workflow_deliver
-- (the API verifies the HMAC, then calls this RPC with the owner session).
-- dua_workflow_identity and dua_workflow_credentials are intentionally
-- unchanged (legacy store; the worker reads Secret Manager instead).
begin;

create or replace function public.dua_workflow_history(p_owner uuid, p_workflow text)
returns setof jsonb language plpgsql security invoker set search_path='' as $$
begin
  if (select auth.uid()) is distinct from p_owner then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
  select jsonb_build_object('id',r.id,'workflow_id',r.workflow_id,'title',r.title,'status',r.status,
   'attempt',r.attempt,'cancel_requested',r.cancel_requested,'created_at',r.created_at,
   'updated_at',r.updated_at,'due_at',r.due_at,'finished_at',r.finished_at,'error',r.error,
   'steps',(select jsonb_agg(s-'output' order by n) from jsonb_array_elements(r.steps) with ordinality a(s,n)))
  from public.dua_workflow_executions r where r.owner_id=p_owner and (p_workflow is null or r.workflow_id=p_workflow)
  order by (r.status in ('queued','running')) desc,r.updated_at desc limit 100;
end $$;

create or replace function public.dua_workflow_enqueue(p_owner uuid,p_workflow text,p_title text,p_key text,p_fingerprint text,p_definition jsonb,p_due timestamptz)
returns public.dua_workflow_executions language plpgsql security definer set search_path='' as $$
declare r public.dua_workflow_executions;
begin
 if (select auth.uid()) is distinct from p_owner then raise exception 'not authorized' using errcode = '42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 select * into r from public.dua_workflow_executions where owner_id=p_owner and request_key=p_key;
 if found then
  if r.fingerprint<>p_fingerprint then raise exception 'idempotency_conflict'; end if;
  return r;
 end if;
 select * into r from public.dua_workflow_executions where owner_id=p_owner and workflow_id=p_workflow and status in ('queued','running');
 if found then raise exception 'workflow_active'; end if;
 if p_definition->'trigger'->>'type'='once' and p_due<=now() then raise exception 'schedule_past'; end if;
 insert into public.dua_workflow_executions(owner_id,workflow_id,title,request_key,fingerprint,definition,steps,due_at)
 values(p_owner,p_workflow,p_title,p_key,p_fingerprint,p_definition,
  (select jsonb_agg(jsonb_build_object('id',s->>'id','agentName',s->>'agentName','status','queued','output','','error',null) order by n)
   from jsonb_array_elements(p_definition->'steps') with ordinality a(s,n)),p_due) returning * into r;
 return r;
end $$;

create or replace function public.dua_workflow_claim(p_worker uuid,p_owner uuid)
returns setof public.dua_workflow_executions language plpgsql security definer set search_path='' as $$
declare r public.dua_workflow_executions;
begin
 if (select auth.uid()) is distinct from p_owner then raise exception 'not authorized' using errcode = '42501'; end if;
 perform public.dua_workflow_recover(p_owner);
 select * into r from public.dua_workflow_executions where owner_id=p_owner and status='queued' and due_at<=clock_timestamp()
 order by due_at for update skip locked limit 1;
 if found then
  update public.dua_workflow_executions set status='running',worker_id=p_worker,lease_until=clock_timestamp()+interval '60 seconds',updated_at=now() where id=r.id returning * into r;
  return next r;
 end if;
end $$;

create or replace function public.dua_workflow_control(p_owner uuid,p_id uuid,p_action text,p_expected_attempt int)
returns public.dua_workflow_executions language plpgsql security definer set search_path='' as $$
declare r public.dua_workflow_executions;
begin
 if (select auth.uid()) is distinct from p_owner then raise exception 'not authorized' using errcode = '42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 select * into r from public.dua_workflow_executions where owner_id=p_owner and id=p_id for update;
 if not found then raise exception 'run_missing'; end if;
 if p_action='cancel' and r.status in ('queued','running') and r.attempt=p_expected_attempt then
  update public.dua_workflow_executions set cancel_requested=true,
   status=case when status='queued' then 'cancelled' else status end,
   steps=case when status='queued' then (select jsonb_agg(case when s->>'status'='succeeded' then s else s||jsonb_build_object('status','cancelled') end order by n) from jsonb_array_elements(steps) with ordinality a(s,n)) else steps end,
   finished_at=case when status='queued' then now() else null end,updated_at=now()
  where id=p_id returning * into r;
 elsif p_action='retry' and r.status in ('failed','cancelled') and r.attempt=p_expected_attempt then
  if exists(select 1 from public.dua_workflow_executions where owner_id=p_owner and workflow_id=r.workflow_id and status in ('queued','running')) then raise exception 'workflow_active'; end if;
  update public.dua_workflow_executions set status='queued',cancel_requested=false,attempt=attempt+1,due_at=now(),
   error=null,finished_at=null,worker_id=null,lease_until=null,updated_at=now(),
   steps=(select jsonb_agg(case when s->>'status'='succeeded' then s else s||jsonb_build_object('status','queued','error',null,'output','') end order by n) from jsonb_array_elements(steps) with ordinality a(s,n))
  where id=p_id returning * into r;
 end if;
 return r;
end $$;

create or replace function public.dua_workflow_checkpoint(p_owner uuid,p_id uuid,p_worker uuid,p_steps jsonb,p_status text,p_error text)
returns public.dua_workflow_executions language plpgsql security definer set search_path='' as $$
declare r public.dua_workflow_executions; actual_steps jsonb;
begin
 if (select auth.uid()) is distinct from p_owner then raise exception 'not authorized' using errcode = '42501'; end if;
 select * into r from public.dua_workflow_executions where owner_id=p_owner and id=p_id for update;
 if not found or r.worker_id is distinct from p_worker or r.status<>'running' or r.lease_until is null or r.lease_until<=clock_timestamp() then raise exception 'lease_lost'; end if;
 if p_status not in ('running','succeeded','failed','cancelled') then raise exception 'invalid_status'; end if;
 actual_steps=coalesce(p_steps,r.steps);
 if not r.cancel_requested and p_status='succeeded' and (jsonb_array_length(actual_steps)<>jsonb_array_length(r.definition->'steps') or exists(select 1 from jsonb_array_elements(actual_steps) s where s->>'status' is distinct from 'succeeded' or coalesce(s->>'output','')='')) then raise exception 'incomplete_steps'; end if;
 update public.dua_workflow_executions set
  steps=case when r.cancel_requested then (select jsonb_agg(case when s->>'status'='succeeded' then s else s||jsonb_build_object('status','cancelled') end order by n) from jsonb_array_elements(actual_steps) with ordinality a(s,n)) else actual_steps end,
  status=case when r.cancel_requested then 'cancelled' else p_status end,
  error=case when r.cancel_requested then 'Cancelled by owner.' else p_error end,
  lease_until=clock_timestamp()+interval '60 seconds',updated_at=now(),
  finished_at=case when r.cancel_requested or p_status<>'running' then now() else null end where id=p_id returning * into r;
 return r;
end $$;

create or replace function public.dua_workflow_recover(p_owner uuid)
returns int language plpgsql security definer set search_path='' as $$
declare affected int;
begin
 if (select auth.uid()) is distinct from p_owner then raise exception 'not authorized' using errcode = '42501'; end if;
 update public.dua_workflow_executions r set status=case when cancel_requested then 'cancelled' else 'failed' end,
  steps=(select jsonb_agg(case when s->>'status'='succeeded' then s else s||jsonb_build_object('status',case when r.cancel_requested or s->>'status'='queued' then 'cancelled' else 'failed' end,'error','Worker lease expired; review before retry.') end order by n) from jsonb_array_elements(r.steps) with ordinality a(s,n)),
  error='Worker lease expired; provider outcome may be unknown. Review before retry.',finished_at=now(),updated_at=now(),worker_id=null,lease_until=null
 where owner_id=p_owner and status='running' and lease_until<clock_timestamp();
 get diagnostics affected=row_count;
 return affected;
end $$;

create or replace function public.dua_workflow_register(p_owner uuid,p_id uuid,p_revision int,p_kind text,p_workflow text,p_title text,p_definition jsonb,p_interval int,p_due timestamptz,p_enabled boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.dua_workflow_automation;
begin
 if (select auth.uid()) is distinct from p_owner then raise exception 'not authorized' using errcode = '42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 select * into r from public.dua_workflow_automation where owner_id=p_owner and id=p_id for update;
 if found then
  if r.kind<>p_kind then raise exception 'automation_kind_conflict'; end if;
  if p_revision=0 and r.workflow_id=p_workflow and r.title=p_title and r.definition=p_definition and r.interval_seconds is not distinct from p_interval and r.start_at is not distinct from p_due and r.enabled=p_enabled then return to_jsonb(r); end if;
  if r.revision<>p_revision then raise exception 'automation_revision_conflict'; end if;
  update public.dua_workflow_automation set workflow_id=p_workflow,title=p_title,definition=p_definition,interval_seconds=p_interval,
   start_at=p_due,next_due=p_due,enabled=p_enabled,revision=revision+1,updated_at=now() where id=p_id returning * into r;
 else
  if p_revision<>0 then raise exception 'automation_revision_conflict'; end if;
  if p_kind='interval' and p_due<=clock_timestamp() then raise exception 'schedule_past'; end if;
  insert into public.dua_workflow_automation(id,owner_id,kind,workflow_id,title,definition,interval_seconds,start_at,next_due,enabled)
   values(p_id,p_owner,p_kind,p_workflow,p_title,p_definition,p_interval,p_due,p_due,p_enabled) returning * into r;
 end if;
 return to_jsonb(r);
end $$;

create or replace function public.dua_workflow_automation_disable(p_owner uuid,p_id uuid,p_revision int)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.dua_workflow_automation;
begin
 if (select auth.uid()) is distinct from p_owner then raise exception 'not authorized' using errcode = '42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 select * into r from public.dua_workflow_automation where id=p_id and owner_id=p_owner for update;
 if not found then raise exception 'run_missing'; end if;
 if r.revision<>p_revision then raise exception 'automation_revision_conflict'; end if;
 update public.dua_workflow_automation set enabled=false,revision=revision+1,updated_at=now() where id=p_id returning * into r;
 return to_jsonb(r);
end $$;

create or replace function public.dua_workflow_tick(p_owner uuid)
returns int language plpgsql security definer set search_path='' as $$
declare a public.dua_workflow_automation; run public.dua_workflow_executions; count_runs int=0; due_slot timestamptz;
begin
 if (select auth.uid()) is distinct from p_owner then raise exception 'not authorized' using errcode = '42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 for a in select * from public.dua_workflow_automation where owner_id=p_owner and kind='interval' and enabled and next_due<=clock_timestamp()
  order by next_due for update skip locked limit 20 loop
  due_slot=a.next_due+make_interval(secs => (floor(extract(epoch from (clock_timestamp()-a.next_due))/a.interval_seconds)*a.interval_seconds)::double precision);
  if not exists(select 1 from public.dua_workflow_executions where owner_id=p_owner and workflow_id=a.workflow_id and status in ('queued','running')) then
   run=public.dua_workflow_enqueue(p_owner,a.workflow_id,a.title,'sch:'||a.id::text||':'||floor(extract(epoch from due_slot))::text,
    'schedule:'||a.id::text||':'||a.revision::text||':'||extract(epoch from due_slot)::text,a.definition,due_slot);
   update public.dua_workflow_automation set last_enqueued_at=now() where id=a.id;
   count_runs=count_runs+1;
  else update public.dua_workflow_automation set last_skipped_at=now() where id=a.id;
  end if;
  update public.dua_workflow_automation set next_due=due_slot+make_interval(secs => a.interval_seconds),updated_at=now() where id=a.id;
 end loop;
 return count_runs;
end $$;

create or replace function public.dua_workflow_deliver(p_owner uuid,p_id uuid,p_event text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.dua_workflow_automation; run public.dua_workflow_executions;
begin
 if (select auth.uid()) is distinct from p_owner then raise exception 'not authorized' using errcode = '42501'; end if;
 select * into a from public.dua_workflow_automation where owner_id=p_owner and id=p_id and kind='webhook';
 if not found then raise exception 'run_missing'; end if;
 perform pg_advisory_xact_lock(hashtextextended(a.owner_id::text,0));
 select * into a from public.dua_workflow_automation where id=p_id for update;
 select e.* into run from public.dua_workflow_deliveries d join public.dua_workflow_executions e on e.id=d.run_id where d.trigger_id=p_id and d.event_id=p_event;
 if found then return jsonb_build_object('id',run.id,'status',run.status); end if;
 if not a.enabled then raise exception 'automation_disabled'; end if;
 run=public.dua_workflow_enqueue(a.owner_id,a.workflow_id,a.title,'evt:'||encode(sha256(convert_to(p_id::text||':'||p_event,'UTF8')),'hex'),
  'trigger:'||p_id::text||':'||a.revision::text,a.definition,clock_timestamp());
 insert into public.dua_workflow_deliveries values(p_id,p_event,run.id);
 update public.dua_workflow_automation set last_enqueued_at=now() where id=p_id;
 return jsonb_build_object('id',run.id,'status',run.status);
end $$;

revoke all on function public.dua_workflow_history(uuid,text) from public,anon,service_role;
revoke all on function public.dua_workflow_enqueue(uuid,text,text,text,text,jsonb,timestamptz) from public,anon,service_role;
revoke all on function public.dua_workflow_claim(uuid,uuid) from public,anon,service_role;
revoke all on function public.dua_workflow_control(uuid,uuid,text,int) from public,anon,service_role;
revoke all on function public.dua_workflow_checkpoint(uuid,uuid,uuid,jsonb,text,text) from public,anon,service_role;
revoke all on function public.dua_workflow_recover(uuid) from public,anon,service_role;
revoke all on function public.dua_workflow_register(uuid,uuid,int,text,text,text,jsonb,int,timestamptz,boolean) from public,anon,service_role;
revoke all on function public.dua_workflow_automation_disable(uuid,uuid,int) from public,anon,service_role;
revoke all on function public.dua_workflow_tick(uuid) from public,anon,service_role;
revoke all on function public.dua_workflow_deliver(uuid,uuid,text) from public,anon,service_role;
grant execute on function public.dua_workflow_history(uuid,text) to authenticated;
grant execute on function public.dua_workflow_enqueue(uuid,text,text,text,text,jsonb,timestamptz) to authenticated;
grant execute on function public.dua_workflow_claim(uuid,uuid) to authenticated;
grant execute on function public.dua_workflow_control(uuid,uuid,text,int) to authenticated;
grant execute on function public.dua_workflow_checkpoint(uuid,uuid,uuid,jsonb,text,text) to authenticated;
grant execute on function public.dua_workflow_recover(uuid) to authenticated;
grant execute on function public.dua_workflow_register(uuid,uuid,int,text,text,text,jsonb,int,timestamptz,boolean) to authenticated;
grant execute on function public.dua_workflow_automation_disable(uuid,uuid,int) to authenticated;
grant execute on function public.dua_workflow_tick(uuid) to authenticated;
grant execute on function public.dua_workflow_deliver(uuid,uuid,text) to authenticated;
commit;
