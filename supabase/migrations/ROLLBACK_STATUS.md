# Migration rollback status

Inventory of every file in `supabase/migrations/` and whether it can be rolled back.

`AGENTS.md` 4.11 and `CONTRIBUTING.md` section 5 both require a rollback file beside every
migration. `AGENTS.md` 4.11 also records the current fact: 27 migrations exist, two have a
rollback file (`202611280001_dua_function_history.rollback.sql` and
`202611280002_dua_quota_rpc_dispatch.rollback.sql`).
This file is the record of that gap, one row per migration, so the next schema change can be
judged against a known baseline instead of a guess.

## Summary

| Metric | Count |
| --- | --- |
| Total migrations | 27 |
| Rollback possible (YES) | 21 |
| Rollback not possible (NO) | 6 |
| Unknown | 0 |
| Rollback file present | 2 |

Read the counts as: 21 files can be undone with a written down script, 6 cannot be undone
without losing data or without re-applying an earlier migration's function bodies. None is
unknown, because every file was read in full.

## How this was produced

Every file in `supabase/migrations/` was read end to end (1859 lines total). Each row states
what the file does, whether a down script exists in principle, how it would run, and the risk.
No migration file was edited, renamed or deleted to produce this document.

## Naming convention

No rollback file and no down migration pattern exists in this repository today. There is no
`*.rollback.sql`, no `down/` directory and no `supabase migration` down step in any workflow.
So this document does not invent a new mechanism. It records the convention that `AGENTS.md`
4.11 already states, which is a rollback file kept beside the migration:

```
supabase/migrations/202611270001_dua_task_lifecycle_workers.sql
supabase/migrations/202611270001_dua_task_lifecycle_workers.rollback.sql
```

That name is a proposal for the next migration, not something this PR adds. Nothing in the
repo reads it yet, so adding one is a separate decision.

## Inventory

| # | File | What it does | Rollback | How | Risk |
| --- | --- | --- | --- | --- | --- |
| 1 | `202610040001_dua_cloud.sql` | Creates `dua_cloud_snapshots` and the `dua_write_cloud_snapshot` RPC | YES | `drop function public.dua_write_cloud_snapshot(bigint,jsonb); drop table public.dua_cloud_snapshots;` | Data loss: every saved cloud snapshot is deleted. The Android app reads this table, so rollback breaks cloud sync until the app is rolled back too. |
| 2 | `202610040002_dua_usage.sql` | Creates `dua_daily_usage` and the `dua_consume_daily_request` RPC | YES | `drop function public.dua_consume_daily_request(uuid,integer); drop table public.dua_daily_usage;` | Data loss: daily request counters reset. The API calls this RPC, so a rollback without a code rollback returns 503 on quota checks. |
| 3 | `202610060001_dua_read_daily_usage.sql` | Adds the read-only `dua_read_daily_usage` RPC | YES | `drop function public.dua_read_daily_usage(uuid);` | No data. The usage screen loses its read path. Depends on table 2, so roll back this file before file 2. |
| 4 | `202610080001_dua_files_storage.sql` | Creates the private `dua-files` bucket and three owner-folder policies on `storage.objects` | YES | Drop the three `dua_files_*` policies, then `delete from storage.buckets where id = 'dua-files';` | High. The bucket delete fails while objects exist, and emptying it deletes every uploaded file. Policies must go first or the bucket row is orphaned. |
| 5 | `202610090001_dua_imagine.sql` | Appends `video/mp4` to the bucket mime list, creates `dua_imagine_usage` and two RPCs | YES | `drop function public.dua_read_imagine_usage(); drop function public.dua_consume_imagine(uuid,text,integer,integer); drop table public.dua_imagine_usage;` then remove `video/mp4` from the bucket list | Data loss: Imagine usage counters reset, so a user can exceed the daily cap once. The function signature is the one from file 15, not the original, so roll back file 15 first. |
| 6 | `202610100001_dua_voice.sql` | Creates `dua_voice_usage`, `dua_voice_sessions` and four RPCs | YES | Drop the four functions, then both tables | Data loss: voice minutes and open sessions are lost. An open session at rollback time is never charged. Signature again comes from file 15. |
| 7 | `202610160001_dua_agent_notes.sql` | Creates `agent_notes`, its prune trigger and function | YES | `drop trigger if exists agent_notes_prune on public.agent_notes; drop function public.agent_notes_prune(); drop table public.agent_notes;` | Data loss: the agent's self-learning notes are deleted. The engine reads this table, so it degrades to no notes rather than failing. |
| 8 | `202611020001_dua_workflow_runs.sql` | Creates `dua_workflow_runs` and three owner policies | YES | `drop table public.dua_workflow_runs;` | Data loss: workflow run history is deleted. The run transcript lives in chat, so only the history list is lost. |
| 9 | `20261102180726_workflow_execution.sql` | Creates `dua_workflow_executions` and five workflow RPCs | YES | Drop the five functions, then the table | Data loss: queued and running workflow runs are lost. Files 10, 11 and 23 build on these functions, so roll them back first. |
| 10 | `20261102183410_workflow_identity_recovery.sql` | Creates `dua_workflow_credentials`, adds `dua_workflow_identity` and `dua_workflow_recover`, and replaces `dua_workflow_claim` and `dua_workflow_checkpoint` | NO | Would need the two replaced function bodies re-applied from file 9, plus a drop of the new table and functions | The file overwrites two functions from file 9. A plain drop leaves the workflow with no claim or checkpoint function at all. The credentials table holds encrypted refresh tokens, so dropping it forces every owner to reauthorize. |
| 11 | `20261102183411_workflow_automation.sql` | Creates `dua_workflow_automation`, `dua_workflow_deliveries` and four RPCs | YES | Drop the four functions, then `dua_workflow_deliveries`, then `dua_workflow_automation` | Data loss: every interval and webhook trigger is deleted. `dua_workflow_deliveries` has a foreign key to `dua_workflow_executions`, so it must be dropped before file 9. |
| 12 | `202611090001_dua_orhan_tasks.sql` | Creates `dua_orhan_tasks`, its prune trigger and function | YES | Drop the trigger and function, then the table | Data loss: every Orhan task is deleted. The phone reads this table, so the task list goes empty. |
| 13 | `202611140001_revoke_quota_authenticated.sql` | Revokes `authenticated` execute on two quota RPCs and grants `service_role` only | YES | Re-grant execute to `authenticated` on both functions | No data. Reverting reopens the F-01 bypass where any signed-in user could pass a huge daily limit. Only revert together with the code that depends on the revoke. |
| 14 | `202611140002_dua_artifacts_memories.sql` | Creates `dua_artifacts`, `dua_memories` and two prune triggers | YES | Drop both triggers and functions, then both tables | Data loss: the artifact and memory lists are deleted. File 18 alters `dua_memories`, so roll that back first. |
| 15 | `202611160001_owner_scoped_quota_rpcs.sql` | Drops the `auth.uid()` versions of two quota RPCs and recreates them with an explicit `owner` argument | NO | Would need the original bodies re-applied from files 5 and 6, and the backend reverted to the old call shape | The file drops the old signatures on purpose so PostgREST has one function per name. A rollback that only drops the new ones leaves Imagine and live voice with no RPC, and the API already calls the new signature. |
| 16 | `202611190001_dua_conversations_messages.sql` | Creates `dua_conversations`, `dua_messages` and the preview trigger | YES | Drop the trigger and function, then `dua_messages`, then `dua_conversations` | Data loss: every chat and message is deleted. This is the largest data loss in the set. Files 18, 19, 20, 21 and 24 depend on these tables. |
| 17 | `202611190002_dua_agents_skills.sql` | Creates `dua_agents` and `dua_agent_skills` | YES | `drop table public.dua_agent_skills; drop table public.dua_agents;` | Data loss: custom agents and user skills are deleted. The two official pinned agents are recreated by the app, so only user data is lost. |
| 18 | `202611190003_dua_memories_scope.sql` | Adds `scope` and `source_conversation_id` columns to `dua_memories` | NO | Would need `drop column` on both | Dropping the columns destroys every scope assignment and every memory to conversation link. There is no way to rebuild which memory belonged to which thread. |
| 19 | `202611190004_dua_conversation_agents.sql` | Creates the `dua_conversation_agents` junction table | YES | `drop table public.dua_conversation_agents;` | Data loss: group chat membership is lost, so multi-agent conversations fall back to a single agent. |
| 20 | `202611190005_dua_studios_triggers.sql` | Creates `dua_artifact_versions`, `dua_agent_instructions` and `dua_agent_triggers` | YES | Drop the three tables in that order | Data loss: artifact version history, agent instructions and proactive triggers are deleted. `dua_artifact_versions` has a foreign key to `dua_artifacts`, so file 14 must stay. |
| 21 | `202611190006_dua_realtime_push.sql` | Adds five tables to the `supabase_realtime` publication, creates `dua_device_tokens` and `dua_notifications` | YES | `alter publication supabase_realtime drop table` for each of the five, then drop both new tables | Data loss: device tokens and notification history are deleted, so push stops until devices re-register. The publication block is wrapped in `exception when duplicate_object`, so a partial rollback is safe to retry. |
| 22 | `202611250001_dua_orhan_tasks_lifecycle.sql` | Adds `end_reason`, `finished_at_ms`, `stopped_at_ms` and three check constraints to `dua_orhan_tasks` | NO | Would need `drop column` on all three | Dropping the columns destroys why each task ended and when. The API maps these to the user-visible stopped and timed out states, so history becomes unreadable. |
| 23 | `202611260001_workflow_rpcs_authenticated.sql` | Replaces ten workflow RPCs with `security definer` versions that require `auth.uid() = p_owner`, and moves execute grants to `authenticated` | NO | Would need the previous bodies re-applied from files 9, 10 and 11, plus the old grants | The file rewrites ten functions across three earlier migrations. A drop leaves the workflow with no RPCs, and the API already calls the owner-scoped shape. Reverting also reopens the service-role-only access the file closed. |
| 24 | `202611260002_dua_messages_preview_guard.sql` | Replaces the preview trigger function and narrows the `dua_messages` insert grant to named columns | YES | Re-apply the trigger function body from file 16, then `revoke insert` and `grant insert on public.dua_messages to authenticated` | No data loss. Reverting lets a client set `created_at` and `id` again, which is the bug the file fixes, so only revert with the matching code. |
| 25 | `202611270001_dua_task_lifecycle_workers.sql` | Adds five columns and four constraints to `dua_orhan_tasks`, creates `dua_task_events` and `dua_workers`, adds six functions and an append-only trigger | NO | Would need `drop column` on five columns plus dropping two tables and six functions | Dropping the columns destroys parent and root task links, the attempt counter and the idempotency key, so retry and continue history is lost. `dua_task_events` is the audit trail and cannot be rebuilt. |
| 26 | `202611280001_dua_function_history.sql` | Creates `dua_function_history`, the `dua_capture_function` helper and two indexes, and captures the current body of eleven workflow functions | YES | `202611280001_dua_function_history.rollback.sql` beside it: drop the helper, the two indexes, then the table | Data loss: every captured function definition is deleted, so a function replaced after this migration loses its restore point. Export the table first if a body is still needed. The table is inert until a migration calls the helper, so the rollback cannot break a running workflow. |
| 27 | `202611280002_dua_quota_rpc_dispatch.sql` | Moves the `dua_consume_imagine` and `dua_start_voice_session` bodies to `_v2` names and leaves the public names as thin dispatchers, so a future signature change is a swap instead of a `drop function` | YES | `202611280002_dua_quota_rpc_dispatch.rollback.sql` beside it, generated from `dua_function_history`: restore both public bodies, then `drop function` the two `_v2` names | Data loss: none. Quota counters and voice sessions are untouched, and the dispatcher passes every argument through unchanged. The rollback drops the `_v2` functions, so a caller that started using `_v2` directly would break; the API calls the public names only. |

## The six that cannot be rolled back

| File | Why not |
| --- | --- |
| `20261102183410_workflow_identity_recovery.sql` | Replaces two functions from an earlier file and holds encrypted refresh tokens |
| `202611160001_owner_scoped_quota_rpcs.sql` | Drops the old function signatures on purpose, so a drop leaves no RPC |
| `202611190003_dua_memories_scope.sql` | Column drop destroys scope and thread links that cannot be rebuilt |
| `202611250001_dua_orhan_tasks_lifecycle.sql` | Column drop destroys why and when each task ended |
| `202611260001_workflow_rpcs_authenticated.sql` | Rewrites ten functions across three earlier files |
| `202611270001_dua_task_lifecycle_workers.sql` | Column drop destroys task lineage and the append-only audit trail |

## Highest risk cases

1. `202611190001_dua_conversations_messages.sql` deletes every chat and message. It is the
   single largest data loss and five later files depend on it.
2. `202610080001_dua_files_storage.sql` deletes the storage bucket, which means every uploaded
   file. The bucket cannot be dropped while objects exist, so a careless rollback either fails
   or destroys user files.
3. `202611160001_owner_scoped_quota_rpcs.sql` and `202611260001_workflow_rpcs_authenticated.sql`
   both replace functions in place. A rollback that only drops the new version leaves the
   feature with no function at all, which is worse than the migration never having run.
4. `202611140001_revoke_quota_authenticated.sql` is trivially reversible, but reverting it
   reopens a known security bypass (F-01). It should never be reverted alone.

## Ordering rule

Rollback must run newest first. Several files depend on tables and functions from earlier
files, and a few replace functions in place. The safe order is the reverse of the file name
order, with these extra constraints:

- File 24 before file 16, because it replaces file 16's trigger function.
- File 15 before files 5 and 6, because it replaced their function signatures.
- File 23 before files 9, 10 and 11, because it replaced their function bodies.
- File 11 before file 9, because `dua_workflow_deliveries` references `dua_workflow_executions`.
- File 18 before file 14, because it alters `dua_memories`.
- File 4 last among the storage files, and only after the bucket is empty.

## What this document does not do

- It does not add rollback files. It records that none exist.
- It does not change any migration. Every file is untouched.
- It does not claim any rollback was tested. No rollback script was run against a database,
  because no rollback script exists yet and no staging database was available in this run.
