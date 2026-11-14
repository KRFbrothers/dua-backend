-- Generated with the Supabase CLI. Apply after identity/recovery; source only.
begin;
create table public.dua_workflow_automation (
 id uuid primary key,
 owner_id uuid not null references auth.users(id) on delete cascade,
 kind text not null check(kind in ('interval','webhook')),
 workflow_id text not null check(length(workflow_id) between 1 and 100),
 title text not null check(length(title) between 1 and 120),
 definition jsonb not null,
 interval_seconds int check(interval_seconds between 300 and 2678400),
 start_at timestamptz,
 next_due timestamptz,
 enabled boolean not null default true,
 revision int not null default 1,
 updated_at timestamptz not null default now(),
 last_enqueued_at timestamptz,
 last_skipped_at timestamptz,
 check((kind='interval' and interval_seconds is not null and next_due is not null) or (kind='webhook' and interval_seconds is null and next_due is null))
);
create index dua_workflow_automation_due on public.dua_workflow_automation(next_due) where enabled and kind='interval';
create table public.dua_workflow_deliveries (
 trigger_id uuid not null references public.dua_workflow_automation(id),
 event_id text not null check(length(event_id) between 1 and 100),
 run_id uuid not null references public.dua_workflow_executions(id),
 primary key(trigger_id,event_id)
);
alter table public.dua_workflow_automation enable row level security;
alter table public.dua_workflow_deliveries enable row level security;
revoke all on public.dua_workflow_automation,public.dua_workflow_deliveries from public,anon,authenticated;
grant select on public.dua_workflow_automation to authenticated;
grant all on public.dua_workflow_automation,public.dua_workflow_deliveries to service_role;
create policy workflow_automation_owner on public.dua_workflow_automation for select to authenticated using(owner_id=(select auth.uid()));

create function public.dua_workflow_register(p_owner uuid,p_id uuid,p_revision int,p_kind text,p_workflow text,p_title text,p_definition jsonb,p_interval int,p_due timestamptz,p_enabled boolean)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r public.dua_workflow_automation;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 select * into r from public.dua_workflow_automation where owner_id=p_owner and id=p_id for update;
 if found then
  if r.kind<>p_kind then raise exception 'automation_kind_conflict'; end if;
  -- Recover a lost create response without creating another registration.
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

create function public.dua_workflow_automation_disable(p_owner uuid,p_id uuid,p_revision int)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r public.dua_workflow_automation;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 select * into r from public.dua_workflow_automation where id=p_id and owner_id=p_owner for update;
 if not found then raise exception 'run_missing'; end if;
 if r.revision<>p_revision then raise exception 'automation_revision_conflict'; end if;
 update public.dua_workflow_automation set enabled=false,revision=revision+1,updated_at=now() where id=p_id returning * into r;
 return to_jsonb(r);
end $$;

create function public.dua_workflow_tick(p_owner uuid)
returns int language plpgsql security invoker set search_path='' as $$
declare a public.dua_workflow_automation; run public.dua_workflow_executions; count_runs int=0; due_slot timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 for a in select * from public.dua_workflow_automation where owner_id=p_owner and kind='interval' and enabled and next_due<=clock_timestamp()
  order by next_due for update skip locked limit 20 loop
  -- Coalesce missed periods to the most recent slot; never burst historical work.
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

create function public.dua_workflow_deliver(p_owner uuid,p_id uuid,p_event text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare a public.dua_workflow_automation; run public.dua_workflow_executions;
begin
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
revoke all on function public.dua_workflow_register(uuid,uuid,int,text,text,text,jsonb,int,timestamptz,boolean) from public,anon,authenticated;
revoke all on function public.dua_workflow_automation_disable(uuid,uuid,int) from public,anon,authenticated;
revoke all on function public.dua_workflow_tick(uuid) from public,anon,authenticated;
revoke all on function public.dua_workflow_deliver(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.dua_workflow_register(uuid,uuid,int,text,text,text,jsonb,int,timestamptz,boolean) to service_role;
grant execute on function public.dua_workflow_automation_disable(uuid,uuid,int) to service_role;
grant execute on function public.dua_workflow_tick(uuid) to service_role;
grant execute on function public.dua_workflow_deliver(uuid,uuid,text) to service_role;
commit;
