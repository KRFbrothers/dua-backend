-- Generated with `supabase migration new workflow_execution`; source prepared only.
-- Located in this repository's canonical migration directory. Never changes legacy history.
begin;
create table public.dua_workflow_executions (
 owner_id uuid not null references auth.users(id) on delete cascade,
 id uuid primary key default gen_random_uuid(),
 workflow_id text not null check (length(workflow_id) between 1 and 100),
 title text not null check (length(title) between 1 and 120),
 request_key text not null check (length(request_key) between 1 and 100),
 fingerprint text not null,
 definition jsonb not null,
 steps jsonb not null,
 status text not null default 'queued' check (status in ('queued','running','succeeded','failed','cancelled')),
 cancel_requested boolean not null default false,
 attempt int not null default 1,
 due_at timestamptz not null default now(),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 finished_at timestamptz,
 error text,
 worker_id uuid,
 lease_until timestamptz,
 unique(owner_id,request_key)
);
create unique index dua_workflow_one_active on public.dua_workflow_executions(owner_id,workflow_id)
 where status in ('queued','running');
create index dua_workflow_due on public.dua_workflow_executions(due_at) where status='queued';
alter table public.dua_workflow_executions enable row level security;
revoke all on public.dua_workflow_executions from public,anon,authenticated;
grant select on public.dua_workflow_executions to authenticated;
grant all on public.dua_workflow_executions to service_role;
create policy workflow_execution_read_own on public.dua_workflow_executions for select to authenticated
 using (owner_id=(select auth.uid()));

-- Bounded history excludes instructions/prompts/output. Fetch one run for output.
create function public.dua_workflow_history(p_owner uuid,p_workflow text)
returns setof jsonb language sql security invoker set search_path='' as $$
 select jsonb_build_object('id',r.id,'workflow_id',r.workflow_id,'title',r.title,'status',r.status,
  'attempt',r.attempt,'cancel_requested',r.cancel_requested,'created_at',r.created_at,
  'updated_at',r.updated_at,'due_at',r.due_at,'finished_at',r.finished_at,'error',r.error,
  'steps',(select jsonb_agg(s-'output' order by n) from jsonb_array_elements(r.steps) with ordinality a(s,n)))
 from public.dua_workflow_executions r where r.owner_id=p_owner and (p_workflow is null or r.workflow_id=p_workflow)
 order by (r.status in ('queued','running')) desc,r.updated_at desc limit 100;
$$;

-- All mutations use server credentials AFTER API owner verification. No JWTs stored.
create function public.dua_workflow_enqueue(p_owner uuid,p_workflow text,p_title text,p_key text,p_fingerprint text,p_definition jsonb,p_due timestamptz)
returns public.dua_workflow_executions language plpgsql security invoker set search_path='' as $$
declare r public.dua_workflow_executions;
begin
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

create function public.dua_workflow_claim(p_worker uuid,p_owner uuid)
returns setof public.dua_workflow_executions language plpgsql security invoker set search_path='' as $$
declare r public.dua_workflow_executions;
begin
 -- Never automatically replay a step whose provider outcome is unknown after worker loss.
 update public.dua_workflow_executions set status=case when cancel_requested then 'cancelled' else 'failed' end,
  steps=(select jsonb_agg(case when s->>'status' in ('queued','running') then s||jsonb_build_object('status',case when cancel_requested then 'cancelled' else 'failed' end,'error','Worker lease expired; review before retry.') else s end order by n) from jsonb_array_elements(steps) with ordinality a(s,n)),
  error='Worker lease expired; provider outcome may be unknown. Review before retry.',finished_at=now(),updated_at=now(),worker_id=null,lease_until=null
 where owner_id=p_owner and status='running' and lease_until<now();
 select * into r from public.dua_workflow_executions where owner_id=p_owner and status='queued' and due_at<=now()
 order by due_at for update skip locked limit 1;
 if found then
  update public.dua_workflow_executions set status='running',worker_id=p_worker,lease_until=now()+interval '60 seconds',updated_at=now()
   where id=r.id returning * into r;
  return next r;
 end if;
end $$;

create function public.dua_workflow_control(p_owner uuid,p_id uuid,p_action text,p_expected_attempt int)
returns public.dua_workflow_executions language plpgsql security invoker set search_path='' as $$
declare r public.dua_workflow_executions;
begin
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

-- Fenced heartbeat/checkpoint. Cancellation always wins over provider completion.
create function public.dua_workflow_checkpoint(p_owner uuid,p_id uuid,p_worker uuid,p_steps jsonb,p_status text,p_error text)
returns public.dua_workflow_executions language plpgsql security invoker set search_path='' as $$
declare r public.dua_workflow_executions;
begin
 select * into r from public.dua_workflow_executions where owner_id=p_owner and id=p_id and worker_id=p_worker and status='running' and lease_until>now() for update;
 if not found then raise exception 'lease_lost'; end if;
 if p_status not in ('running','succeeded','failed','cancelled') then raise exception 'invalid_status'; end if;
 update public.dua_workflow_executions set
  steps=case when r.cancel_requested then (select jsonb_agg(case when s->>'status'<>'succeeded' then s||jsonb_build_object('status','cancelled') else s end order by n) from jsonb_array_elements(coalesce(p_steps,r.steps)) with ordinality a(s,n)) else coalesce(p_steps,r.steps) end,
  status=case when r.cancel_requested then 'cancelled' else p_status end,
  error=case when r.cancel_requested then 'Cancelled by owner.' else p_error end,
  lease_until=now()+interval '60 seconds',updated_at=now(),
  finished_at=case when r.cancel_requested or p_status<>'running' then now() else null end
 where id=p_id returning * into r;
 return r;
end $$;
revoke all on function public.dua_workflow_enqueue(uuid,text,text,text,text,jsonb,timestamptz) from public,anon,authenticated;
revoke all on function public.dua_workflow_history(uuid,text) from public,anon,authenticated;
revoke all on function public.dua_workflow_claim(uuid,uuid) from public,anon,authenticated;
revoke all on function public.dua_workflow_control(uuid,uuid,text,int) from public,anon,authenticated;
revoke all on function public.dua_workflow_checkpoint(uuid,uuid,uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.dua_workflow_enqueue(uuid,text,text,text,text,jsonb,timestamptz) to service_role;
grant execute on function public.dua_workflow_history(uuid,text) to service_role;
grant execute on function public.dua_workflow_claim(uuid,uuid) to service_role;
grant execute on function public.dua_workflow_control(uuid,uuid,text,int) to service_role;
grant execute on function public.dua_workflow_checkpoint(uuid,uuid,uuid,jsonb,text,text) to service_role;
commit;
