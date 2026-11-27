# Phase 3: task lifecycle, workers, observability

This document covers only what Phase 3 added. `API_CONTRACT.md` remains the full
contract; the sections below are the delta, written so a reviewer does not have to
diff a 47 KB file.

Everything here is additive. No existing route, status value, RLS policy or grant
on `dua_orhan_tasks` changed, and the migration is nullable with no data rewrite.

---

## 1. Health and readiness

Both services now answer two paths.

| Method and path | Response |
|---|---|
| `GET /healthz` | `{ "status": "ok", "service": "dua-api", "version": "", "uptimeSeconds": 0 }` |
| `GET /readyz` | `{ "status": "ready", "checks": {} }` or `503` `{ "status": "not_ready", "failed": [] }` |

- `healthz` does no I/O. It is always `200` while the process runs, so a slow
dependency cannot cause a restart loop.
- `readyz` checks what the service actually needs. dua-api checks Supabase and,
when `DUA_ENGINE_URL` is set, the engine. dua-ai-engine checks Supabase and that
Vertex credentials can mint a token. It never calls a model, so a probe spends no
quota.
- A failing check reports a short reason (`not_configured`, `unreachable`,
`credentials_unavailable`), never a provider error string, a project id or a secret.
- Both are answered before the CORS, origin and kill-switch checks, because a load
balancer probe sends no `Origin` header.
- A non-`GET` method is `405`.

`GET /` on the engine is unchanged, because the app reads its capability flags there.

### Where it is registered

| Service | File |
|---|---|
| dua-api | `apps/api/src/core/health.mjs`, called from `service-handler.mjs` |
| dua-ai-engine | `apps/ai-engine/dua_engine/health.py`, registered in `apps/ai-engine/wsgi.py` |

The engine blueprint is registered in `wsgi.py` and not `app.py` because
`adk_server.py` execs `gunicorn ... wsgi:app`, so `wsgi.py` is the entry point the
container loads.

### Deploy

`deploy-cloudrun.sh` and `deploy-adk.sh` now pass `--startup-probe` and
`--liveness-probe` pointing at `/healthz`, replacing Cloud Run's default TCP check,
which passes even when Supabase is unreachable.

---

## 2. Request ids

Every response from dua-api carries a server-generated `X-Request-Id`.

- Always server-generated. A client-supplied `x-request-id` is never adopted: it
would let a caller forge or collide ids in the log.
- The GitHub stage log (`withRequestLog`) keeps its own schema and still emits
nothing for unrelated routes. `withRequestId` is a separate wrapper that only puts
an id in the async context and echoes it back.

---

## 3. Task lifecycle

### New columns on `dua_orhan_tasks`

| Column | Type | Meaning |
|---|---|---|
| `parent_task_id` | `text` | The task this one continues. Composite FK on `(owner_id, task_id)`, so a cross-owner link is impossible. |
| `root_task_id` | `text` | First task in the chain. A task with no parent is its own root. |
| `continue_thread_id` | `uuid` | Groups tasks into one conversation thread. A child inherits its parent's unless it names its own. |
| `attempt` | `integer` | Retry counter, starts at 1, increments on each retry. Distinct from `run_count`, which counts steps. |
| `idempotency_key` | `text` | Optional client string, max 200 chars, unique per owner. |

### Create

`POST /api/orhan/tasks` now accepts three optional fields:

```json
{ "prompt": "", "parentTaskId": "uuid", "continueThreadId": "uuid", "idempotencyKey": "" }
```

- `parentTaskId` must name a task of the same owner. Unknown is `404`, not a
silently ignored link. A non-UUID is `400`.
- `idempotencyKey` is independent of `requestId`: `requestId` fixes the task id,
`idempotencyKey` fixes the request. Repeating a create with the same key returns
the task that already owns it.

### Task response

Five new fields, all echoed from persisted columns:

```json
{ "parentTaskId": null, "rootTaskId": "uuid", "continueThreadId": null, "attempt": 1, "idempotencyKey": null }
```

### Event trail

`GET /api/orhan/tasks/:id/events` returns the append-only trail, oldest first, up
to 200 rows:

```json
{ "events": [ { "seq": 1, "event": "created", "stepId": null, "detail": { "status": "waiting" }, "at": "2026-11-27T00:00:00Z" } ] }
```

`event` is one of `created`, `started`, `step_started`, `step_completed`,
`step_failed`, `heartbeat`, `retry`, `cancelled`, `completed`, `failed`,
`timed_out`, `reaped`.

`detail` carries only ids, counts and short machine-readable values. Prompt text,
step output and provider payloads are never stored: the writer filters to an
allowlist and drops anything else rather than truncating it.

Append-only is enforced in the database, not only by the missing grant: a trigger
raises on any `UPDATE` or `DELETE`.

### Background reaper

Before this, a task's time limit was lazy: `expireOverdue()` only ran when someone
read or started a task. A task the user closed the app on stayed `running` forever,
and the one-running-task-per-owner rule then blocked every new task.

`task-reaper.mjs` sweeps on a timer, independent of any request. The conditional
`UPDATE` lives in the database function `dua_orhan_tasks_reap()`, so a task is
reaped once even if two processes sweep.

**Opt in per deployment:** `DUA_TASK_REAPER=1` on exactly one process. Never on a
Cloud Run service that scales to zero.

The lazy `expireOverdue` sweep is kept. It is not replaced.

---

## 4. Worker registry

`dua_workers` is infrastructure, not user data: no `authenticated` grant, only
`service_role`.

| Function | Purpose |
|---|---|
| `dua_worker_heartbeat(worker, kind, version, capacity, active)` | Upsert. A worker that restarts with the same id keeps its row. |
| `dua_workers_stale(seconds)` | Workers whose last heartbeat is older than the threshold. |
| `dua_worker_drain(worker, draining)` | Marks a worker draining so a deploy stops new claims without killing in-flight work. |

`workflow-runtime.mjs` registers a stable worker id per process (`DUA_WORKER_ID`,
or a generated one), heartbeats every 15 s, and drains on shutdown.

Before this, the worker id was a random UUID per run, so nothing could answer
"how many workers are alive" or "which worker is stuck".

---

## 5. Migration

`supabase/migrations/202611270001_dua_task_lifecycle_workers.sql`

- Adds the five columns, two composite FKs, two check constraints, three indexes.
- Creates `dua_task_events` and `dua_workers`.
- Creates four functions: `dua_task_events_next_seq`, `dua_task_events_immutable`,
`dua_worker_heartbeat`, `dua_workers_stale`, `dua_worker_drain`,
`dua_orhan_tasks_reap`.
- Every statement is `if not exists` or `drop ... if exists` first, so it is safe
to run again.

**Not run in CI.** Apply it on staging before merging.

---

## 6. Configuration

| Variable | Default | Where |
|---|---|---|
| `DUA_TASK_REAPER` | `0` | One worker process only |
| `DUA_WORKER_ID` | generated per process | Worker host |
| `DUA_BUILD_VERSION` | empty | Reported by `/healthz` |

---

## 7. Not in this change

Listed so nothing is silently dropped. Each needs a decision before code.

| Area | Why it waits |
|---|---|
| Multi-tenancy (`org_id` on 24 tables) | Needs its own migration series and a backfill. Folding it in would make this PR unreviewable. |
| Artifact retention | A product decision: how long, which tier. |
| Context and memory layer | `pgvector` is declared but its runtime use is unconfirmed. Decide the base table first. |
| Tool registry and permissions | Overlaps the existing approval flow in `agent_safety.py`. Settle that design first. |
| Streaming changes | SSE already exists in `sse.mjs`. The requirement is unclear. |
| OpenTelemetry | Needs a collector endpoint, which cannot be verified from the sandbox. |
| Per-task cost | Needs a provider pricing table, which is not in the repo. |
| Per-task timeout override | `MAX_MINUTES` is a constant. An override changes the API contract. |
