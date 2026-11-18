-- Additive follow-up to 20261102180726. Generated with the Supabase CLI; not applied.
begin;
create table public.dua_workflow_credentials (
 owner_id uuid primary key references auth.users(id) on delete cascade,
 ciphertext text not null check (length(ciphertext)<40000),
 state text not null check (state in ('ready','refreshing','reauthorize')),
 revision bigint not null default 1,
 holder uuid,
 lease_until timestamptz,
 updated_at timestamptz not null default now(),
 check ((state='refreshing' and holder is not null and lease_until is not null) or (state<>'refreshing' and holder is null and lease_until is null))
);
alter table public.dua_workflow_credentials enable row level security;
revoke all on public.dua_workflow_credentials from public,anon,authenticated;
grant all on public.dua_workflow_credentials to service_role;

-- Serialize refresh-token rotation across workers. A lost refresh result never
-- causes an old single-use refresh token to be replayed after the lease expires.
create function public.dua_workflow_identity(p_owner uuid,p_action text,p_holder uuid,p_revision bigint,p_ciphertext text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r public.dua_workflow_credentials;
begin
 perform pg_advisory_xact_lock(hashtextextended('workflow-identity:'||p_owner::text,0));
 select * into r from public.dua_workflow_credentials where owner_id=p_owner for update;
 if found and r.state='refreshing' and r.lease_until<=clock_timestamp() then
  update public.dua_workflow_credentials set state='reauthorize',holder=null,lease_until=null,updated_at=now() where owner_id=p_owner returning * into r;
 end if;
 if p_action='provision' then
  if r.state='refreshing' then raise exception 'identity_busy'; end if;
  if p_ciphertext is null then raise exception 'identity_missing'; end if;
  insert into public.dua_workflow_credentials(owner_id,ciphertext,state) values(p_owner,p_ciphertext,'ready')
   on conflict(owner_id) do update set ciphertext=excluded.ciphertext,state='ready',revision=dua_workflow_credentials.revision+1,holder=null,lease_until=null,updated_at=now()
   returning * into r;
 elsif p_action='revoke' then
  update public.dua_workflow_credentials set state='reauthorize',revision=revision+1,holder=null,lease_until=null,updated_at=now() where owner_id=p_owner returning * into r;
 elsif p_action='acquire' and r.state='ready' and r.revision=p_revision then
  update public.dua_workflow_credentials set state='refreshing',holder=p_holder,lease_until=clock_timestamp()+interval '90 seconds',updated_at=now() where owner_id=p_owner returning * into r;
 elsif p_action in ('commit','invalidate') then
  if r.state<>'refreshing' or r.holder is distinct from p_holder or r.revision is distinct from p_revision or r.lease_until<=clock_timestamp() then raise exception 'identity_fence_lost'; end if;
  if p_action='commit' and p_ciphertext is null then raise exception 'identity_missing'; end if;
  update public.dua_workflow_credentials set ciphertext=coalesce(p_ciphertext,ciphertext),
   state=case when p_action='commit' then 'ready' else 'reauthorize' end,
   revision=revision+1,holder=null,lease_until=null,updated_at=now() where owner_id=p_owner returning * into r;
 elsif p_action<>'read' and p_action<>'acquire' then raise exception 'identity_action_invalid';
 end if;
 return to_jsonb(r);
end $$;
revoke all on function public.dua_workflow_identity(uuid,text,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.dua_workflow_identity(uuid,text,uuid,bigint,text) to service_role;

-- Recovery is independent of owner JWT availability and feature kill switches.
create function public.dua_workflow_recover(p_owner uuid)
returns int language plpgsql security invoker set search_path='' as $$
declare affected int;
begin
 update public.dua_workflow_executions r set status=case when cancel_requested then 'cancelled' else 'failed' end,
  steps=(select jsonb_agg(case when s->>'status'='succeeded' then s else s||jsonb_build_object('status',case when r.cancel_requested or s->>'status'='queued' then 'cancelled' else 'failed' end,'error','Worker lease expired; review before retry.') end order by n) from jsonb_array_elements(r.steps) with ordinality a(s,n)),
  error='Worker lease expired; provider outcome may be unknown. Review before retry.',finished_at=now(),updated_at=now(),worker_id=null,lease_until=null
 where owner_id=p_owner and status='running' and lease_until<clock_timestamp();
 get diagnostics affected=row_count;
 return affected;
end $$;
revoke all on function public.dua_workflow_recover(uuid) from public,anon,authenticated;
grant execute on function public.dua_workflow_recover(uuid) to service_role;

create or replace function public.dua_workflow_claim(p_worker uuid,p_owner uuid)
returns setof public.dua_workflow_executions language plpgsql security invoker set search_path='' as $$
declare r public.dua_workflow_executions;
begin
 perform public.dua_workflow_recover(p_owner);
 select * into r from public.dua_workflow_executions where owner_id=p_owner and status='queued' and due_at<=clock_timestamp()
 order by due_at for update skip locked limit 1;
 if found then
  update public.dua_workflow_executions set status='running',worker_id=p_worker,lease_until=clock_timestamp()+interval '60 seconds',updated_at=now() where id=r.id returning * into r;
  return next r;
 end if;
end $$;

-- A transaction-start timestamp must not let a worker checkpoint after expiry
-- while waiting for a row lock. Recheck the wall clock after acquiring the lock.
create or replace function public.dua_workflow_checkpoint(p_owner uuid,p_id uuid,p_worker uuid,p_steps jsonb,p_status text,p_error text)
returns public.dua_workflow_executions language plpgsql security invoker set search_path='' as $$
declare r public.dua_workflow_executions; actual_steps jsonb;
begin
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
commit;
