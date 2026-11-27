# Dua Gen AI backend: architecture

How the system is built today. This file describes what the code does, not what it should do. The
target and the order of work live in [`MASTER_PLAN.md`](MASTER_PLAN.md); the HTTP shapes live in
[`../API_CONTRACT.md`](../API_CONTRACT.md); the database lives in [`../SUPABASE.md`](../SUPABASE.md)
and `supabase/migrations/`.

Every claim below was read in the repository at commit `43135d80e867dd7660aad84be9de8c7be79fc570`.
Where a number is given it was counted, not estimated. Where something is not in the code it says so.

---

## 1. Shape

Two services, one database, one client.

| Piece | What it is | Where |
|---|---|---|
| `dua-api` | Node 24, bare `node:http`, ESM, no framework | `apps/api/` |
| `dua-ai-engine` | Python, Flask plus Google ADK | `apps/ai-engine/` |
| Database | Supabase Postgres with row level security | `supabase/migrations/` |
| Client | Android app, separate repository | `KRFbrothers/teamily-android-ui` |

Neither service serves a website. There is no build step, no linter, no formatter and no type
checker in this repository. The two test suites are the only automated checks.

Size, counted with `find` and `wc -l`:

| Measure | Count |
|---|---|
| `apps/api` `.mjs` files | 133 |
| `apps/api` `.mjs` lines | 21,196 |
| `apps/ai-engine` `.py` files | 103 |
| `apps/ai-engine` `.py` lines | 19,312 |
| `supabase/migrations` `.sql` lines | 1,859 |
| Migrations | 25 |
| Tables created | 26 |
| `create policy` statements | 61 |
| `apps/api` test files | 60 |
| `apps/ai-engine` test files | 41 |

---

## 2. Control plane and execution plane

The split is by job, not by process.

**Control plane (`dua-api`).** Owns identity, the owner lock, conversations, messages, agents,
skills, artifacts, memories, files, notifications, quota, and the workflow registry. It is the only
process that talks to Supabase with the user's JWT for user tables.

**Execution plane (`dua-ai-engine`).** Owns model calls, the ADK agent graph, tool execution, coding
runs, voice, and Imagine. It is called by `dua-api` over HTTP and never holds the user's session.

`apps/api/src/core/engine-client.mjs` is the only place `dua-api` calls the engine. A new engine
endpoint is added there, not by a second HTTP client.

### Request path for a chat turn

```
Android app
  -> POST /api/chat            (dua-api, apps/api/src/server/service-handler.mjs)
     -> access-policy.mjs      owner lock, 403 for any other account
     -> conversations.mjs      load or create the conversation row
     -> engine-client.mjs      POST to dua-ai-engine
        -> app.py              Flask route
        -> dua_engine/agent/   ADK graph, tools, memory
     -> reply-persistence.mjs  write the assistant message
     -> sse.mjs                stream deltas back to the client
```

`apps/api/src/server/server.mjs` is 86 lines: it parses the request, enforces the body size limit,
and hands off to `service-handler.mjs` (185 lines), which routes on `url.pathname`. There is no
router library and no route table object. A new route is a new branch in `service-handler.mjs`.

---

## 3. `apps/api` layout

`src/core/` holds 62 files. They are grouped by job, not by layer:

| Group | Files |
|---|---|
| Identity and access | `access-policy.mjs`, `account.mjs`, `cors.mjs`, `request-rate-limit.mjs` |
| Chat | `conversations.mjs`, `chat-web.mjs`, `reply-persistence.mjs`, `sse.mjs`, `context.mjs` |
| Agents and skills | `agents-skills.mjs`, `dua_agent_prompts.json` |
| Artifacts and memory | `artifacts-memories.mjs`, `cloud-snapshot.mjs` |
| Files and attachments | `files.mjs`, `attachments.mjs`, `file-context.mjs`, `file-types.mjs`, `storage.mjs` |
| Models and providers | `providers.mjs`, `gemini.mjs`, `gemini-files.mjs`, `adapters.mjs`, `engine-client.mjs` |
| Connectors | `github.mjs`, `github-write.mjs`, `github-validation.mjs`, `advanced-integrations.mjs`, `sheets.mjs` |
| Workflows | `workflow-runs.mjs`, `workflow-execution.mjs`, `workflow-automation.mjs`, `workflow-identity.mjs`, `workflow-runtime.mjs`, `workflow-worker.mjs` |
| Tasks | `orhan-tasks.mjs`, `task-events.mjs`, `task-reaper.mjs`, `worker-health.mjs` |
| Media | `imagine.mjs`, `imagine-jobs.mjs`, `imagine-providers.mjs`, `imagine-usage.mjs`, `voice.mjs`, `voice-live.mjs`, `voice-tts.mjs`, `transcribe.mjs` |
| Build and code | `build-chat.mjs`, `build-pr.mjs`, `code-execution.mjs`, `projects.mjs` |
| Ops | `health.mjs`, `kill-switches.mjs`, `request-logging.mjs`, `setup.mjs`, `limited-json.mjs` |

`src/server/` holds three files: `server.mjs`, `service-handler.mjs`, `static-site.mjs`.

`scripts/` holds `imagine-smoke.mjs` and `verify-rls.mjs`. Both are manual, neither runs in CI.

---

## 4. `apps/ai-engine` layout

`app.py` is the Flask entry, served by `wsgi.py`. `dua_engine/` holds the packages:

| Package | Job |
|---|---|
| `agent/` | 19 Python files: the ADK graph, tools, memory, policy, safety, resilience, observability |
| `chat/` | chat turn handling |
| `coding/` | coding runs |
| `automation/` | automation runs |
| `orhan/` | legacy Orhan task execution |

`agent/agent_adk.py` is the orchestration core. It builds an `adk.SequentialAgent` named `dua_root`
whose stages are a planner, a helpers stage, a merger, and optionally a reviewer and a reviser. The
helpers stage is a `SequentialAgent` by default and a `ParallelAgent` only when
`ADK_HELPERS_SEQUENTIAL=0`. The reviewer and reviser are added only when `DUA_AGENT_REVIEW=1`.

`agent/agent_documents.py` holds the vector store: a `Vector()` column and `cosine_distance` search.
`agent/agent_notes.py` holds the notes store, which uses that vector store for semantic recall when
`agent_documents.enabled()` is true.

---

## 5. Data model

26 tables, all in `public`, all created by numbered files in `supabase/migrations/`. 24 of the 26
carry `owner_id`; `dua_workers` and `dua_workflow_deliveries` do not.

| Table | `owner_id` | Policies |
|---|---|---|
| `agent_notes` | yes | 3 |
| `dua_agent_instructions` | yes | 4 |
| `dua_agent_skills` | yes | 4 |
| `dua_agent_triggers` | yes | 4 |
| `dua_agents` | yes | 4 |
| `dua_artifact_versions` | yes | 3 |
| `dua_artifacts` | yes | 4 |
| `dua_cloud_snapshots` | yes | 1 |
| `dua_conversation_agents` | yes | 3 |
| `dua_conversations` | yes | 4 |
| `dua_daily_usage` | yes | 0 |
| `dua_device_tokens` | yes | 4 |
| `dua_imagine_usage` | yes | 0 |
| `dua_memories` | yes | 4 |
| `dua_messages` | yes | 2 |
| `dua_notifications` | yes | 4 |
| `dua_orhan_tasks` | yes | 3 |
| `dua_task_events` | yes | 2 |
| `dua_voice_sessions` | yes | 0 |
| `dua_voice_usage` | yes | 0 |
| `dua_workers` | no | 0 |
| `dua_workflow_automation` | yes | 1 |
| `dua_workflow_credentials` | yes | 0 |
| `dua_workflow_deliveries` | no | 0 |
| `dua_workflow_executions` | yes | 1 |
| `dua_workflow_runs` | yes | 3 |

The five tables with `owner_id` and zero policies are not unprotected. Access goes through a
`security definer` RPC that reads `auth.uid()` itself, and the table is revoked from `anon` and
`authenticated`. A direct PostgREST read returns nothing for every user, which is why a direct probe
proves nothing about them.

`dua_workers` and `dua_workflow_deliveries` are service-role only: revoked from `public`, `anon` and
`authenticated`, granted to `service_role`.

### RLS rules

- Every table has `enable row level security`.
- Every owner-scoped policy compares `owner_id` to `(select auth.uid())`.
- `dua_messages` and `dua_task_events` are append-only: select and insert policies only, no update
  and no delete.
- `dua_cloud_snapshots` is select-only for the owner; writes go through `dua_write_cloud_snapshot`,
  which checks the expected revision.
- Migrations are immutable. A change is a new numbered file with a rollback.

---

## 6. Multi-tenancy

One owner per deployment, set by `DUA_ALLOWED_EMAIL`. In production `dua-api` refuses to start
without a valid owner email, and `access-policy.mjs` fails closed with 503 rather than allowing open
access. Every other account gets 403.

This is a single-owner lock, not a workspace model. There is no organisation, no team, no shared
resource and no cross-account sharing. RLS is still enforced per row, so a second account in the same
project sees nothing, but the product does not offer a second account.

---

## 7. Connectors

Two different files, two different access levels. Do not read one and assume the other.

| Path | Access | File |
|---|---|---|
| Chat connector | read-only: tree, file, search | `core/advanced-integrations.mjs` |
| Build mode | write, but only pull requests | `core/github-write.mjs` |

`github-write.mjs` is 81 lines. Its allowlist is GET and POST only: no PATCH, no PUT, no DELETE. The
only POST targets are `git/blobs`, `git/trees`, `git/commits`, `git/refs` and `pulls`. A new ref must
be under `refs/heads/dua/*`, and a pull request can only come from a `dua/*` branch. There is no
force-push, no merge and no branch deletion.

---

## 8. Memory

Two stores, two retrieval modes.

| Store | Retrieval | File |
|---|---|---|
| Chat memory (artifacts and memories) | keyword, `ilike` | `core/artifacts-memories.mjs` |
| Agent notes | semantic, cosine distance | `agent/agent_notes.py` via `agent/agent_documents.py` |

The vector store is a `Vector()` column with `cosine_distance` search. It is used only when
`agent_documents.enabled()` is true, which needs a Vertex embedding client. When it is off, notes
fall back to keyword matching.

So "memory is keyword-only" is wrong, and "memory is fully semantic" is also wrong. It depends on
which store and whether the vector path is enabled.

---

## 9. Workflows and tasks

`dua_workflow_runs` stores lifecycle metadata for a run; the transcript stays in the owner's chat.
`dua_workflow_executions` is the durable execution record with a lease, an attempt count and a due
time. `dua_workflow_automation` holds interval and webhook triggers. `dua_workflow_deliveries` is the
idempotency table for webhook events, keyed on `(trigger_id, event_id)`.

`dua_orhan_tasks` is the legacy task table, kept because the Android app calls `/api/orhan/*`. It is
not renamed and not removed. `dua_task_events` is the append-only event log for a task, and
`dua_workers` is the worker registry with heartbeat and drain.

`workflow-runtime.mjs` and `workflow-worker.mjs` are separate processes started by their own npm
scripts, not by the API server.

---

## 10. Checks

`.github/workflows/checks.yml` runs two jobs on every pull request and on push to `main`:

| Job | What it runs |
|---|---|
| `google-cloud` | `pytest` on `apps/ai-engine/tests`, twice: once with mocked Vertex, once with the real ADK SDK against a disposable pgvector Postgres |
| `backend` | `npm run test:ci` in `apps/api` |

`npm run verify:rls` needs a live Supabase project and never runs in CI. `npm run verify:rls:cross`
is the same: manual, opt-in, and it writes real rows.

`apps/api/test/agents-md.test.mjs` reads `AGENTS.md` and fails the pull request if the control-plane
action table, the task statuses or the master plan link drift. That is why an `AGENTS.md` edit and a
code edit belong in the same pull request.

---

## 11. What is not here

Named in files but not present: `archive/`, `apps/android/`. There is no linter, no formatter, no
type checker, no build step, no secret scan and no dependency audit in CI. There is no `docs/` file
other than `MASTER_PLAN.md` and this one. There is no `CONTRIBUTING.md` before this change.

---

## 12. Where to look next

| Question | File |
|---|---|
| What should this become, and in what order | [`MASTER_PLAN.md`](MASTER_PLAN.md) |
| What does the HTTP API look like | [`../API_CONTRACT.md`](../API_CONTRACT.md) |
| How is the database set up | [`../SUPABASE.md`](../SUPABASE.md) |
| What are the rules for an agent working here | [`../AGENTS.md`](../AGENTS.md) |
| What did the last audit find | [`audits/2026-11-27-rls-and-roadmap-audit.md`](audits/2026-11-27-rls-and-roadmap-audit.md) |
