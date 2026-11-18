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

### PR E: agents and skills

- Tables `dua_agents` and `dua_agent_skills`.
- Agents CRUD. The official `personal-agent` and `dua-agent` cannot be deleted.
- `POST /api/agents/generate-prompt` and `POST /api/skills/generate` in Node, using the existing
  providers and the existing quota guard.
- Skills CRUD for user-created skills and overrides only (decision 2). This PR also removes the Node
  duplicate skill list and the static size cap.

## 4. Out of scope until separately approved

- Running `db push` or any deploy.
- Android client changes.
- Moving or deleting data in `dua_cloud_snapshots`.
