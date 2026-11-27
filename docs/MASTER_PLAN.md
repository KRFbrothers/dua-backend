# Dua Gen AI backend: master plan

This is the roadmap for the single-user, multi-agent Dua Gen AI backend (`dua-api` in `apps/api`,
`dua-ai-engine` in `apps/ai-engine`, Supabase in `supabase/`). It records owner-approved decisions so
later PRs do not re-open them. `API_CONTRACT.md` and `SUPABASE.md` stay the source of truth for
shipped behaviour; this file describes the target and the order of work.

## 1. Product principles

- **Single user, owner lock.** Exactly one owner, set by `DUA_ALLOWED_EMAIL`. In production
  (`NODE_ENV=production`) `dua-api` refuses to start without one valid owner email, and the access
  policy fails closed (503) instead of allowing open access. Every other account gets 403.
- **Two official pinned agents only:**
  - `personal-agent`: "Personal Agent", mode `auto` (fast everyday chat).
  - `dua-agent`: "Dua Agent", mode `agent` (tools, skills, multi-step work).

  Both are always pinned and protected from deletion. They can be configured, not removed.
- **Skills are not agents.** The 5 reference skills (`frontend-developer`, `backend-architect`,
  `api-tester`, `devops-automator`, `code-reviewer`) are skills that Dua Agent can use. They are not
  separate agents.
- **Unlimited skills for Dua Agent.** There is no fixed catalogue size. The only limit is a guard
  on the total composed prompt size.
- **Unlimited custom agents.** The owner can create any number of custom agents alongside the two
  official ones.
- **Relational chats.** Conversations and messages live in proper tables (`dua_conversations`,
  `dua_messages`) with search, pinning and recent ordering.
- **Global memory with privacy boundaries.** Memory is shared across agents by default. Agents and
  chats can opt out, and nothing is shared across accounts.
- **Studios.** Focused workspaces (for example Imagine, Build and Voice) reuse the same agents,
  memory and quota policy. They do not get parallel copies.
- **Proactive triggers.** Scheduled and event-driven agent runs build on the existing workflow
  worker and its owner identity. They stay opt-in.
- **Realtime and push.** Supabase Realtime for live chat and task updates, and FCM HTTP v1 for
  Android push notifications. The legacy FCM API is never used.

## 2. Owner decisions (approved)

1. **Service-role rule.** User tables (conversations, messages, agents, skills) are read and
   written only with the user's JWT plus the anon key, so RLS decides every access. `service_role` is
   allowed only server-side, for the quota and Imagine RPCs, and only after the backend has verified
   the configured owner (PR #15, `SUPABASE.md`). It is never sent to a client, and user tables never
   use it.
2. **Skills: zero duplicates.**
   - The starter 5 skills keep a single source of truth:
     `apps/ai-engine/dua_engine/agent/dua_agent_prompts.json`.
   - The Node duplicate list (`DUA_AGENT_SKILL_IDS` in `apps/api/src/server/service-handler.mjs`) is
     removed in PR E.
   - The starter skills are not seeded into the database.
   - `dua_agent_skills` stores only user-created skills plus enable or disable overrides for
     starter skills.
   - The static catalogue-size cap (Node `DUA_AGENT_SKILL_IDS.length`, engine `len(SKILL_ORDER)`)
     is removed, so Dua Agent gets unlimited skills, guarded by total prompt size.
3. **No snapshot migration.** `dua_cloud_snapshots` holds only dummy test data, so there is no
   migration script from it. The new tables start clean, and the existing `/api/cloud` endpoints
   stay intact for backward compatibility.
4. **Defaults.**
   - New tables use the `dua_` prefix.
   - Migration names use 12 digits, for example `202611190001_<name>.sql`, in `supabase/migrations/`.
   - The prompt and skill generate endpoints live in Node.
   - Token, usage and model columns are nullable.
5. **Process.** Every PR follows Step A (audit and plan), Step B (owner OK) and Step C (implement,
   test, PR). `npx supabase db push` and every Cloud Run deploy need separate, explicit owner approval.

## 3. Roadmap: 5 small PRs (A → B → C → D → E)

### PR A: plan, owner fail-fast, shared engine client (done: PR #18)

- This file, linked from `AGENTS.md` (Project docs section).
- `dua-api` refuses to start in production when `DUA_ALLOWED_EMAIL` is missing, empty or invalid
  (clear error, exit code 1). The access policy fails closed in production. Request-time 503
  behaviour is unchanged.
- `apps/api/src/core/engine-client.mjs` is the single source for the engine default URL, URL
  validation and headers (`Authorization: Bearer <user token>`, optional `X-Dua-App-Token`,
  `x-dua-native: 1` where the call site used it). It replaces the copies in `service-handler.mjs`,
  `orhan-tasks.mjs`, `web-agent-action.mjs` and `workflow-worker.mjs`.
- Follow-ups, not in this PR:
  - an engine (Python) startup owner check;
  - reusing `engineEndpoint` in `workflow-runtime.mjs`, which has its own startup URL check.

### PR B: engine handler modularization (no behaviour change; B1 done: PR #19)

- Split `apps/ai-engine/app.py` (about 1,600 lines) into modules under `apps/ai-engine/dua_engine/`,
  using the existing `register_*_routes(app)` pattern (see `dua_engine/orhan/routes.py`).
- Same routes, payloads, status codes and tests. No new features.

### PR C: relational conversations (done: PR #20)

- Migration `supabase/migrations/202611190001_<name>.sql` creates the clean tables `dua_conversations`
  and `dua_messages`, with RLS `owner_id = (select auth.uid())` on every policy.
- Endpoints (user JWT + anon key only):
  - `GET /api/conversations`: `q` (ILIKE title search), pinned first then most recent, with
    `last_message_preview`.
  - `POST /api/conversations`
  - `GET /api/conversations/:id/messages`
  - `PUT /api/conversations/:id/pin`
  - `DELETE /api/conversations/:id`
- `/api/cloud` and `dua_cloud_snapshots` stay as they are.
- Shipped as `202611190001_dua_conversations_messages.sql` and `apps/api/src/core/conversations.mjs`:
  uuid ids (an optional client id makes a retried create safe), `timestamptz`, `agent_id` slug
  (no foreign key until PR E), a composite `(conversation_id, owner_id)` foreign key, a trigger-kept
  `last_message_preview`, literal title search, limit/offset and `before` paging, hard delete with
  cascade, nullable `model`, `token_count` and `usage`. Messages are read-only until PR D.

### PR D: chat persistence via `conversation_id` (done: PR #21)

- Node `/api/chat` accepts an optional `conversation_id` (or `conversationId`) and optional `agent_id`.
- It saves the user message to `dua_messages` before the stream or generation starts. When the stream
  or reply completes cleanly, it saves the assistant message with `agent_id`, `model` and nullable
  token or usage. The database trigger updates `last_message_at` and `last_message_preview`.
- Requests without `conversation_id` and the engine path are unchanged.
- D-fix-1: user turn saved only after all checks (no orphans), unknown `agent_id` is `400`, `model` stores the provider id, one token-count helper, a failed save returns the reply with a `notice`, and `GET /api/memories?q=`. D-fix-2: migration `202611260002_dua_messages_preview_guard` (preview only follows a message at least as new as `last_message_at`; `authenticated` can no longer insert `dua_messages.id`/`created_at`) and the optional `beforeId` tie-breaker for `before`.

### PR E: agents and skills (completed)

- Tables `dua_agents` and `dua_agent_skills` with owner-only RLS and delete protection on official agents.
- Agents CRUD: official `personal-agent` and `dua-agent` pinned and protected from deletion.
- AI generators: `POST /api/agents/generate-prompt` and `POST /api/skills/generate` in Node using Gemini with quota guard.
- Skills CRUD: starter skills loaded without DB seed, overrides persisted, custom skills created/deleted.
- Unlimited skills: removed static skill cap in Python engine (`MAX_COMPOSED_PROMPT_CHARS = 120_000` guard) and Node web chat (`SKILL_ID` regex).
- Custom skills in chat (BB-5): the engine loads the owner's enabled custom skills from `dua_agent_skills` (owner token + anon key, RLS; only non-starter ids; at most 100 ids; read capped at 1 MB) in `dua_engine/agent/dua_agent_skills.py` (`load_custom_skills`). Custom bodies are labelled as user-defined, fake `# Enabled skill:` headers are escaped, and starter ids can never be shadowed. Disabled, deleted or unknown ids return `400` "Invalid skills."; a storage failure returns `503` "Skills are unavailable. Retry.". Node and the Android request shape are unchanged (skill ids only).

### PR F: Universal Living Memory + Privacy Boundaries (completed)

- **Migration** `202611190003_dua_memories_scope.sql`: added `scope text not null default 'global'` (check: `'global'` or `'group:<uuid>'`) and `source_conversation_id uuid` columns to `dua_memories`, plus `dua_memories_owner_scope_idx` on `(owner_id, scope, updated_at_ms desc)`.
- **Scope boundary**: memories are tagged `global` (all conversations) or `group:<conversation_id>` (single thread only). The PostgREST filter `scope=in.(global,group:<id>)` is the strict privacy boundary — `group:<other_id>` memories can never leak cross-thread.
- **PUT /api/memories/:id**: new endpoint to toggle `scope`, `sourceConversationId`, `title`, `summary`, `category`, `url`.
- **Privacy-safe context injection** (`loadPrivacySafeMemories`): on every `/api/chat` with `conversation_id`, top-10 memories are prepended to the model context. Exported from `artifacts-memories.mjs`, called in `prepareConversationChat`.
- **Background auto-extraction** (`triggerMemoryAutoExtraction`): non-blocking `queueMicrotask` after each assistant reply. Calls Gemini to extract 0–2 durable facts, filters secrets with `SECRET_PATTERNS`, saves as `global` or `group:<conversation_id>`. Skipped silently if `DISABLE_MEMORY_EXTRACTION=1` or Gemini key missing.
- **Tests**: 6 new Phase 3 tests in `artifacts-memories.test.mjs` covering scope defaults, PUT toggle, invalid scope rejection, `?scope=global` filter, and cross-thread privacy boundary.

### PR G: Multi-Agent Group Chat & @mention (completed)

- **Migration** `202611190004_dua_conversation_agents.sql`: created `dua_conversation_agents` table `(conversation_id uuid, agent_id text, owner_id uuid, added_at timestamptz)` with primary key `(conversation_id, agent_id)`, owner RLS policies and index.
- **Group membership endpoints**:
  - `GET /api/conversations/:id/agents`: lists agents assigned to a conversation.
  - `POST /api/conversations/:id/agents`: assigns an official or verified custom agent to a conversation.
  - `DELETE /api/conversations/:id/agents/:agentId`: removes an agent from a conversation.
- **@mention parser** (`parseMentions`): extracts `@agent-id` and `@AgentName` from user turn, matching case-insensitively and ignoring punctuation/emails.
- **Parallel multi-agent execution**:
  - When specific agents are `@mention`ed (or a group thread has multiple assigned agents), all targeted agents execute concurrently in parallel via `Promise.allSettled`.
  - Each agent's custom system prompt / personality is injected into its generation.
  - SSE stream events are tagged with `agentId` and `agentName` (`type: 'text'`, `type: 'agent_done'`).
  - Each responding agent commits its own assistant message turn to `dua_messages` tagged with its `agent_id`.
- **Tests**: comprehensive unit tests in `conversations.test.mjs` for `@mention` parsing, `/api/conversations/:id/agents` CRUD, tagged streaming execution, and multi-agent reply persistence.

### PR H: Collaborative Studios & Proactive Agent Triggers (completed)

- **Migration** `202611190005_dua_studios_triggers.sql`: created 3 tables with strict owner RLS (`owner_id = (select auth.uid())`):
  - `dua_artifact_versions`: `(id uuid, owner_id uuid, artifact_id text, version_num int, content text, prompt_note text, created_at timestamptz)`, unique `(owner_id, artifact_id, version_num)`, foreign key referencing `dua_artifacts`.
  - `dua_agent_instructions`: `(id uuid, owner_id uuid, agent_id text, instruction text, is_active bool, created_at timestamptz)`.
  - `dua_agent_triggers`: `(id uuid, owner_id uuid, agent_id text, conversation_id uuid fk, trigger_type text, cron_expr text, prompt text, enabled bool, last_run_at timestamptz, created_at timestamptz)`.
- **Collaborative Studios endpoints**:
  - `GET /api/artifacts/:id/versions`: lists artifact version history ordered by `version_num desc`.
  - `POST /api/artifacts/:id/revise`: accepts `{ instruction }`, uses Gemini or fallback to revise artifact content, creates incremental version record in `dua_artifact_versions`, and updates artifact timestamp and byte size.
- **Proactive Agents endpoints**:
  - `GET /api/agents/:id/instructions`: lists instructions for an agent.
  - `POST /api/agents/:id/instructions`: creates an instruction (`{ instruction, isActive }`).
  - `GET /api/agents/:id/instructions/:instructionId`: returns a single instruction.
  - `PUT /api/agents/:id/instructions/:instructionId`: updates instruction text or active status.
  - `DELETE /api/agents/:id/instructions/:instructionId`: deletes an instruction.
  - `GET /api/agents/:id/triggers`: lists triggers for an agent.
  - `POST /api/agents/:id/triggers`: creates a trigger (`schedule`, `webhook`, `missed_summary`).
  - `GET /api/agents/:id/triggers/:triggerId`: returns a single trigger.
  - `PUT /api/agents/:id/triggers/:triggerId`: updates trigger fields.
  - `DELETE /api/agents/:id/triggers/:triggerId`: deletes a trigger.
  - `POST /api/agents/:id/triggers/:triggerId/run`: triggers manual execution, updating `last_run_at`.
- **Tests**: comprehensive unit tests in `artifacts-memories.test.mjs` and `agents-skills.test.mjs`, all passing.

### PR I: Cross-Device Supabase Realtime Sync & FCM HTTP v1 Push Notifications (completed)

- **Migration** `202611190006_dua_realtime_push.sql`:
  - Added `dua_conversations`, `dua_messages`, `dua_agents`, `dua_artifacts`, and `dua_artifact_versions` to `supabase_realtime` publication for cross-device live sync.
  - Created `dua_device_tokens` table `(id uuid, owner_id uuid, token text, platform text, device_name text, created_at, updated_at)` with unique `(owner_id, token)` and strict owner RLS.
  - Created `dua_notifications` table `(id uuid, owner_id uuid, conversation_id uuid fk, agent_id text, title text, body text, data jsonb, status text, sent_at, created_at)` with strict owner RLS.
- **Config & Sync**:
  - `GET /api/config` exposes `realtime: { enabled: true, tables: [...] }`.
- **Device & Notification endpoints**:
  - `POST /api/devices/register`: upserts device token and platform.
  - `DELETE /api/devices/:token`: deletes device token.
  - `GET /api/notifications`: lists notifications for owner.
  - `PUT /api/notifications/:id/read`: marks notification as read.
- **FCM HTTP v1 Dispatcher**:
  - Implemented `buildFcmV1Payload`, `sendFcmV1Message`, and `dispatchPushNotification` targeting `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send` via OAuth2.
  - Integrated with proactive triggers (`POST /api/agents/:id/triggers/:triggerId/run`) to record notifications and trigger push.
  - Graceful fallback when FCM is not configured in local testing.
- **Tests**: comprehensive unit tests in `notifications.test.mjs` (8/8 passing) and verify-rls (24 tables).

### PR J: Context-Aware Semantic Cost Router & Password Reset (completed)

- **Phase 6A: Context-Aware Semantic Cost Router** (`apps/ai-engine/dua_engine/agent/agent_models.py`):
  - Added `classify_complexity(data, mode, text, task)` classifying tasks into `fast` and `frontier` tiers:
    - **Fast/Low-Cost Tier (`Gemini Flash`)**: Title generation, `@mention` routing, short casual Q&A, memory fact extraction.
    - **Frontier Reasoning Tier (`Gemini Pro` / `Claude`)**: Multi-step `mode: "agent"` tool loops, coding/PR tasks, Studio artifact revisions (`/revise`), complex analysis.
  - Added `select_semantic_model(data, mode, text, task, default_model)` returning `(model_name, tier)`.
  - Preserved `AGENT_DAILY_TOKEN_LIMIT` enforcement and recording `model` in `dua_messages`.
- **Phase 6B: Password Reset & Feature Polish** (`apps/api`):
  - Added `POST /api/auth/reset-password` and alias `POST /api/account/reset-password` invoking Supabase GoTrue Auth `POST /auth/v1/recover`.
  - Enforced single-user `DUA_ALLOWED_EMAIL` owner lock (rejects non-owner emails with 403).
  - Enforced redirect URL origin check against `WEB_ORIGINS` allowlist and server origin to strictly prevent open-redirect phishing.
  - Flipped `passwordReset: true` in `GET /api/config` and `GET /api/account/features`.
- **Tests**: 11 new tests in `test_semantic_router.py` (all passing) and comprehensive password reset tests in `account.test.mjs` (all 452 Node tests passing).
- **K6 trigger worker**: PR H triggers now run through the one server workflow worker (`workflow-worker.mjs` / `workflow-runtime.mjs`), no second runner. `POST /api/agents/:id/triggers/:triggerId/run` queues a one-step execution (`agent-trigger:<triggerId>`) via the shared `enqueueExecution` helper and returns `runId` + `status` (the `push` field stays as `{ dispatched: false, reason: 'queued', count: 0 }`). The worker applies the agent persona (`dua_agents.system_prompt`, owner token), allows only read tools (`google_search`, `fetch_url`, `search_notes`, `search_documents`, intersected with the engine catalog), then on success saves the reply into the trigger conversation (if set) and writes + pushes a notification; on failure it writes + pushes a failure notification. `schedule` triggers use IST cron (latest due slot only, request key `trg:<id>:<slotEpoch>`), evaluated by the worker tick only with `DUA_WORKFLOW_AUTOMATION_ENABLED=1`; unreadable cron is skipped and logged. `webhook` / `missed_summary` stay manual-only. No new tables or migrations; `dua_workflow_credentials`, `dua_workflow_identity` and `dua_workflow_runs` untouched. Rollout: merge → owner session provision → VM worker → dua-api deploy → automation flag → smoke.
- **K7 wiring**: `classify_complexity` now picks the plain (non-agent) engine chat model behind `CHAT_MODEL_ROUTER` (default `0`): complex requests use `AGENT_MODEL` with `VERTEX_MODEL` fallback, the client `task` field is ignored, and the tier is logged on the server only. Agent intent stays in `route_agent`. `API_CONTRACT.md` (Semantic Cost Router) was corrected: no Claude route, no `dua_messages` write on the engine path, and the title/`@mention`/`/revise` paths are Node work.

## 4. Out of scope until separately approved

- Running `db push` or any deploy.
- Android client changes.
- Moving or deleting data in `dua_cloud_snapshots`.

## 5. Phase plan (7 phases)

Source of truth for phase scope is this file. The HTML roadmap page is a rendered view of it, and
where the two disagree this file wins. The phase list, the week estimates and the reuse estimate
come from that page. The audit in
[`audits/2026-11-27-rls-and-roadmap-audit.md`](audits/2026-11-27-rls-and-roadmap-audit.md)
checked that page against the code and corrected several numbers; the corrections are applied
below. Week estimates are planning estimates, not measurements: the audit found no code evidence
for them.

Shipped work that these phases build on is recorded in section 3 (PR A to PR J). This section does
not repeat it.

### Corrections applied from the audit

| Roadmap said | Code says | Where |
|---|---|---|
| `owner_id` in 18 tables | 24 of 26 tables | audit 2.3, section 5 |
| 4 RLS policies per table | 0 to 4, 61 `create policy` total | audit section 1, 5 |
| 27 migration files | 25 | audit section 5 |
| 30,140 total lines | 42,367 | audit section 5 |
| 22 tables | 22 by `if not exists public`, 26 by `create table` | audit 2.10 |
| no delegation, same prompt only | ADK planner, per-subtask helpers, merger, reviewer | audit 2.4 |
| connectors read-only | `advanced-integrations.mjs` read-only, `github-write.mjs` writes | audit 2.5 |
| memory keyword only | notes semantic, artifacts and memories keyword | audit 2.6 |

### Phase 0: Foundation (2 weeks)

Goal: tenancy ki neev, do users do workspaces me, ek doosre ka data nahi dekh sakte.

- 0.1 `workspaces` + `members` + `invites` tables with RLS.
- 0.2 Personal workspace backfill script.
- 0.3 `workspace_ids` claim in the JWT.
- 0.4 Tenant resolve middleware in the gateway.

Exit condition: two test users in two workspaces, and a cross-workspace read returns zero rows.

Starting point: `workspace_id` has 0 hits in `supabase/migrations/`, `apps/api/src` and
`apps/ai-engine`, and there is no member, invite, workspace or tenant table (audit 2.3).

### Phase 1: Tenancy cutover (3 weeks)

Goal: `owner_id` se `workspace_id` pe switch, bina data loss.

- 1.1 `workspace_id` in the 24 owner tables plus backfill (24 of 26, not 18).
- 1.2 Dual RLS policies, old and new, side by side.
- 1.3 Code shifts to `workspace_id` behind a feature flag.
- 1.4 `owner_id` drop after a 2 week soak.

Exit condition: `grep -c owner_id apps/api/src` is 0 (audit columns excluded), all 26 tables are on
workspace RLS, and the cross-tenant test is green.

Risk: highest phase. 25 migrations, 61 `create policy` statements and every RPC signature are in
scope.

### Phase 2: Orchestration (4 weeks, scope reduced)

Goal: ek task me 3 agents chain me, har hop ka trace, budget exhaust pe clean stop.

- 2.1 `agent_edges` + `task_delegations` tables.
- 2.2 Delegation protocol (payload, budget, deadline).
- 2.3 Router agent (intent classify).
- 2.4 Depth limit + cycle detection.
- 2.5 Trace UI (delegation tree).

Exit condition: a 3 hop delegation runs end to end, stores its trace, and stops cleanly at budget.

Scope note: `apps/ai-engine/dua_engine/agent/agent_adk.py` already has a real ADK graph (planner at
758-767, one helper per subtask at 773-800, merger at 821, optional reviewer and reviser at 822-866,
root `SequentialAgent` at 866). That is in-engine decomposition with static roles, not peer
agent-to-agent handoff, so this phase is about the DB layer, the budget and the trace, not about
building orchestration from zero. The roadmap's "no handoff at all" claim was wrong and is corrected
here.

### Phase 3: Memory (2 weeks, partially exists)

Goal: "kal jo baat hui" query pe relevant memory aaye, keyword match ke bina bhi.

- 3.1 `memory_vectors` + HNSW index.
- 3.2 Embedding job (backfill + on-write).
- 3.3 Hybrid retrieval (vector + keyword + RRF).
- 3.4 `user:` and `agent:` scope.

Exit condition: a paraphrase query with no keyword overlap returns the right memory, and the scope
filters hold.

Scope note: notes already have semantic search (`agent_notes.py:158-162`, `app.py:1077-1078`), with
exact cosine bounded at 6000 rows (`agent_documents.py:5-6, 176`). Artifacts and memories are
keyword only (`artifacts-memories.mjs:361`). This phase extends an existing path, it does not start
one.

### Phase 4: Connectors (4 weeks, 4.4 partially exists)

Goal: user GitHub connect kare, agent file likh sake, token DB me encrypted ho.

- 4.1 `connectors` + `connector_tokens` + KMS.
- 4.2 OAuth flow (state HMAC, callback).
- 4.3 Token refresh job.
- 4.4 GitHub write actions.
- 4.5 Second provider (Slack or Google).
- 4.6 DB backed rate limiter.

Exit condition: a connected GitHub account lets an agent open a PR from a `dua/*` branch, and the
token is unreadable at rest.

Scope note: `github-write.mjs` already creates blobs, trees, commits, refs and pull requests, fenced
to `refs/heads/dua/*` with no PATCH, PUT or DELETE (lines 5-7, 22-26, 54, 56). What is missing is
per-user OAuth and encrypted storage, not the write path itself. `advanced-integrations.mjs` stays
read-only (lines 9, 15).

### Phase 5: Quota + billing (3 weeks)

Goal: free plan limit hit pe clean 402, upgrade pe instant unlock.

- 5.1 `usage_events` append-only.
- 5.2 Meter: LLM token, sandbox second, storage byte.
- 5.3 Plan limits + enforcement.
- 5.4 Stripe subscription + webhook.
- 5.5 Invoice + dunning.

Exit condition: a free account gets 402 at the limit, a paid account unlocks immediately, and every
charge traces to a usage event.

Starting point: a durable request counter with an advisory lock already exists
(`202610040002_dua_usage.sql:18`, 17 sites in 7 files), and there is zero billing code (audit 2.8).

### Phase 6: Scale (4 weeks)

Goal: 1000 concurrent chat, p99 under 2s, ek tenant ka spike doosre ko na mare.

- 6.1 Sandbox pool (warm containers).
- 6.2 Redis event bus.
- 6.3 Read replicas for chat history.
- 6.4 Per-tenant rate limit + fair queue.
- 6.5 Observability: trace, metric and log per tenant.

Exit condition: a load test at 1000 concurrent chats holds p99 under 2s, and one tenant's spike
leaves other tenants' latency flat.

### Estimate

22 weeks for a 3 to 4 engineer team, 12 to 18 months solo, per the roadmap page. The 55% reuse
figure is a file level judgement, not a line level measurement. Both are estimates, not
measurements.
