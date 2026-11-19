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

- This file, linked from `AGENTS.md`.
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

### PR D: chat persistence via `conversation_id` (this PR)

- Node `/api/chat` accepts an optional `conversation_id` (or `conversationId`) and optional `agent_id`.
- It saves the user message to `dua_messages` before the stream or generation starts. When the stream
  or reply completes cleanly, it saves the assistant message with `agent_id`, `model` and nullable
  token or usage. The database trigger updates `last_message_at` and `last_message_preview`.
- Requests without `conversation_id` and the engine path are unchanged.

### PR E: agents and skills (completed)

- Tables `dua_agents` and `dua_agent_skills` with owner-only RLS and delete protection on official agents.
- Agents CRUD: official `personal-agent` and `dua-agent` pinned and protected from deletion.
- AI generators: `POST /api/agents/generate-prompt` and `POST /api/skills/generate` in Node using Gemini with quota guard.
- Skills CRUD: starter skills loaded without DB seed, overrides persisted, custom skills created/deleted.
- Unlimited skills: removed static skill cap in Python engine (`MAX_COMPOSED_PROMPT_CHARS = 120_000` guard) and Node web chat (`SKILL_ID` regex).

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

## 4. Out of scope until separately approved

- Running `db push` or any deploy.
- Android client changes.
- Moving or deleting data in `dua_cloud_snapshots`.
