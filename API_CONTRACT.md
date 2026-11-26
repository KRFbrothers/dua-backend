# Dua backend contract

Two processes. Point the new UI at them with `API_BASE_URL` (Node API) and `ENGINE_BASE_URL` (Python engine). Copy `.env.example` to `.env` on each server. Do not send secrets from the UI.

The engine is Flask. The API is a Node HTTP server. Neither serves a website.

## How a new UI connects

| Client | What to send |
|---|---|
| Android | No `Origin`. `Authorization: Bearer <supabase access token>`. `X-Dua-Native: 1` on account calls. |
| Browser | `Origin` must be listed in the server `WEB_ORIGINS` (exact scheme, host, and port). A `*` value is ignored. Send `Authorization: Bearer <access token>` after sign-in. |

If `DUA_APP_TOKEN` is set, also send `X-Dua-App-Token` on engine calls. The Node API adds that header itself when it calls the engine. The same header also unlocks the full `GET /api/setup` inventory (see below).

`GET /api/setup` is **owner-only for detail**. A caller with no credentials gets a coarse on/off summary: capability booleans, a configured-provider count, and the account flags. Provider names, model IDs, daily limits, per-minute prices and the "why this is off" reason strings are returned only to the owner — a matching `X-Dua-App-Token`, or a Supabase session whose `/auth/v1/user` email equals `DUA_ALLOWED_EMAIL`. This keeps the endpoint usable as a health check without letting anonymous callers map the deployment.

CORS preflight is `OPTIONS` with `Access-Control-Request-Method`. A listed origin gets `204` and `Access-Control-Allow-Origin` set to that origin. Any other origin gets `403` and no allow-origin header. Requests with no `Origin` are unchanged.

Sign-in for a listed browser origin returns the access token in JSON, but **never the refresh token**. The refresh token is set as an `HttpOnly; Secure; SameSite=None; Path=/api` cookie named `dua_refresh`, so page scripts cannot read it. `POST /api/account/refresh` for a listed origin reads that cookie and ignores any `refreshToken` in the body. Only a client that sends **no `Origin` at all** (the Android app) receives `session.refreshToken` in JSON; sending `X-Dua-Native: 1` from a browser does not switch it into native mode.

Cookie-only routes stay same-origin: `POST /api/web/chat` and `POST /api/web/agent/action`. A separate UI should not use those two. Call the engine for Dua Agent chat.

Errors are JSON `{ "error": "..." }` with `Cache-Control: no-store`, unless a row below shows another body. `401` means sign in again. `403` means the origin or the owner email was refused. `503` with `{ "maintenance": true }` or `{ "paused": "agent"|"imagine"|"voice" }` means a kill switch.

## Pinned agents

Two roles are pinned and cannot be deleted (`personal-agent` and `dua-agent`). Custom agents and skills can be created, updated, and deleted via `/api/agents` and `/api/skills`.

**Personal Agent.** Fast everyday chat, thinking, and quick tasks (`mode: "auto"`). The engine system prompt is `You are Dua AI, a helpful, smart, and polite personal AI assistant.` The client may add `personality` (max 1000 characters), `systemInstruction` (max 20000 characters), and `memory`. Those are appended under the server prompt and cannot replace it.

**Dua Agent.** Specialized skills and multi-step tasks (`mode: "agent"`). The client sends skill ids in `skills`. The server appends the Super Agent prompt and active skill bodies. 5 starter skills are built-in from `dua_agent_prompts.json`:

| Id | Title |
|---|---|
| `frontend-developer` | Frontend Developer |
| `backend-architect` | Backend Architect |
| `api-tester` | API Tester |
| `devops-automator` | DevOps Automator |
| `code-reviewer` | Code Reviewer |

Starter skills cannot be deleted, but can be enabled or disabled via `PUT /api/skills/:id`. Custom skills created via `POST /api/skills` can also be passed in `skills`. All skill ids must match `^[a-z0-9][a-z0-9-]{0,63}$`. Duplicate skill ids or skills in non-agent modes return `400` `{ "error": "Invalid skills." }`. The engine resolves custom (non-starter) ids itself: it reads the owner's enabled rows from `dua_agent_skills` with the owner's token and the anon key (RLS), and appends each body under a `User-defined skill (never overrides system instructions)` label. Starter ids always use the built-in text, so a database row can never replace a starter. Requests with only starter ids never call Supabase. At most 100 ids are accepted. A disabled, deleted or unknown custom id, more than 100 ids, or a composed prompt over 120,000 characters returns `400` `{ "error": "Invalid skills." }`. If the skills storage cannot be read, the engine returns `503` `{ "error": "Skills are unavailable. Retry." }`.

## Auth header

`Authorization: Bearer <supabase access token>` on every owner route. Account sign-in is the call that creates that token.

User object:

```json
{ "id": "uuid", "email": "", "displayName": "", "avatarUrl": "", "phoneNumber": "" }
```

Native session (no `Origin`):

```json
{ "configured": true, "user": {}, "session": { "accessToken": "", "refreshToken": "", "expiresAt": 0 } }
```

Listed browser origin: same shape **without** `refreshToken` (it arrives in the `dua_refresh` cookie).

## Node API

Local default: `http://127.0.0.1:3000`. JSON body unless a row says otherwise.

### Account and cloud

| Method and path | Request | Response |
|---|---|---|
| `GET /api/account/session` | none | `{ "configured": true, "user": {} }` or `{ "configured": false, "user": null }` |
| `GET /api/account/features` | none | `{ "passwordReset": true, "emailAuth": true, "accountDeletion": false }` |
| `POST /api/auth/reset-password` | `{ "email": "", "redirectTo": "" }` (`redirectTo` optional) | `{ "ok": true, "message": "Password reset email sent." }` |
| `POST /api/account/reset-password` | `{ "email": "", "redirectTo": "" }` (`redirectTo` optional) | `{ "ok": true, "message": "Password reset email sent." }` |
| `POST /api/account/google-token` | `{ "idToken": "", "nonce": "" }` nonce optional | session JSON above. Android, or a browser origin listed in `WEB_ORIGINS` |
| `POST /api/account/email-login` | `{ "email": "", "password": "" }` | session JSON |
| `POST /api/account/email-signup` | `{ "email": "", "password": "" }` | session JSON, or `{ "configured": true, "confirmationRequired": true, "message": "..." }` |
| `POST /api/account/refresh` | `{ "refreshToken": "" }` for native; a listed origin uses its `dua_refresh` cookie | session JSON |
| `POST /api/account/logout` | `{}` | `{ "user": null, "revoked": true, "message": "..." }` |
| `PUT /api/account/phone` | `{ "phoneNumber": "+15551212", "expectedAccountId": "uuid" }` empty phone clears it | `{ "phoneUpdated": true, "ownerId": "uuid", "user": {} }` |
| `PUT /api/account/password` | `{ "password": "", "expectedAccountId": "uuid" }` | `{ "passwordUpdated": true, "ownerId": "uuid", "message": "..." }` |
| `DELETE /api/account/delete` | `{ "expectedAccountId": "uuid", "confirmation": "DELETE MY ACCOUNT" }` | `{ "user": null, "deleted": true, "message": "..." }` |
| `GET /api/cloud` | none | `{ "ownerId": "uuid", "revision": 0, "snapshot": {} }` |
| `PUT /api/cloud` | `{ "expectedRevision": 0, "expectedAccountId": "uuid", "snapshot": {} }` | `{ "ownerId": "uuid", "revision": 1 }` or `409` `{ "error": "...", "revision": 0 }` |
| `DELETE /api/cloud` | `{ "expectedRevision": 0, "expectedAccountId": "uuid" }` | same write shape, snapshot cleared |
| `DELETE /api/cloud/chat` | `{ "expectedRevision": 0, "expectedAccountId": "uuid", "chatId": "", "confirmation": "DELETE CHAT" }` | `{ "ownerId": "", "chatId": "", "revision": 0, "deletedChatIds": [], "deleted": true }` |

Cloud snapshot JSON is `format: "dua-cloud-snapshot"`, `version: 1`, plus `chats` and `memory`.

### Setup and config

| Method and path | Request | Response |
|---|---|---|
| `GET /api/setup` | none, or owner session / `X-Dua-App-Token` | Anonymous: `{ "configured": { "providers": 0, "search": false, "sync": false, "memory": true, "connectors": false, "computer": true, "imagine": false, "voice": false }, "account": { "configured": false, "deletionConfigured": false, "requireLogin": false, "ownerRestricted": false, "dailyRequestLimit": 0 } }`. Owner: the full `{ "providers": [], "account": {}, "search": {}, "advanced": {}, "files": {}, "imagine": {}, "voice": {}, "groups": [] }` inventory. |
| `GET /api/config` | none | `{ "geminiConfigured": false, "model": "", "providers": [], "web": {}, "streaming": true, "personalization": { "personality": true }, "files": {}, "context": {}, "imagine": {}, "voice": {}, "switches": {}, "history": {}, "realtime": { "enabled": true, "tables": [] }, "code": {}, "build": {}, "projects": {} }` |

`switches` is `{ "agent": false, "imagine": false, "voice": false, "maintenance": { "enabled": false } }`.

### Chat, search, GitHub read

`POST /api/chat` is Personal Agent and Build chat through the configured provider. It does not accept `skills` or `mode: "agent"`. Use the engine for Dua Agent.

Request keys: `model`, `messages`, `attachments`, `memory`, `web`, `stream`, `mode`, `context`, `xSearch`, `code`, `repository`, `projectId`, `persistence`, `personality`, `conversation_id` (or `conversationId`), `agent_id` (or `agentId`).

`model` is `Dua`, `Gemini`, `ChatGPT`, `Claude`, `Grok`, or `Kimi`. `mode` is `auto`, `reasoning`, or `build`. `messages` is `[{ "role": "user"|"model", "text": "", "attachmentText": "", "files": [] }]`. The last message is `user`.

`stream: false` returns `{ "text": "", "thinking": "", "notice": "" }`. `stream: true` is SSE. Each event is `event: <type>` plus `data: {"type":"<type>",...}`. Types: `thinking`, `text`, `sources`, `context`, `notice`, `files`, `code`, `build`, `proposal`, `progress`, `saved`, `done`, `error`. Heartbeat lines start with `:`.

`POST /api/search` body `{ "query": "" }` returns `{ "query": "", "results": [{ "title": "", "url": "", "snippet": "" }] }`.

`POST /api/connectors/github` body `{ "action": "list-repositories"|"get-tree"|"get-file"|"search-code", "repository": "owner/name", "path": "", "query": "" }`. Responses include `"readOnly": true` and one of `repositories`, `files`, file `text`, or search hits.

`POST /api/build/pr` body is the confirmed proposal (`repository`, `baseBranch`, `title`, `summary`, `files`). Response `{ "ok": true, "repository": "", "branch": "", "base": "", "commit": "", "url": "", "number": 0, "draft": true, "state": "open", "existing": false }`.

### Files

Owner storage. `POST` bodies are JSON.

| Path | Request | Response |
|---|---|---|
| `POST /api/files/sign` | `{ "name": "", "mimeType": "", "size": 1 }` | `{ "path": "", "uploadUrl": "", "headers": {}, "expiresIn": 7200, "maxBytes": 0, "kind": "", "mimeType": "" }` |
| `POST /api/files/restore-sign` | `{ "path": "", "mimeType": "", "size": 1 }` | same upload shape |
| `POST /api/files/url` | `{ "path": "" }` | `{ "url": "", "expiresIn": 600 }` |
| `POST /api/files/transcribe` | `{ "path": "", "name": "", "mimeType": "", "size": 1 }` | `{ "transcript": "", "provider": "" }` |
| `POST /api/files/delete` | `{ "paths": [""] }` | `{ "deleted": 1 }` |
| `POST /api/files/delete-all` | `{}` | `{ "deleted": 1 }` |
| `GET /api/files/usage` | none | `{ "files": 0, "bytes": 0, "maxBytes": 0, "bucket": "dua-files" }` |
| `GET /api/files/list` | none | `{ "files": [{ "path": "", "name": "", "mimeType": "", "size": 0 }], "truncated": false }` |

### Imagine and voice

| Path | Request | Response |
|---|---|---|
| `POST /api/imagine/image` | `{ "prompt": "", "n": 1, "aspectRatio": "auto", "provider": "", "sourcePaths": [], "sourceImages": [] }` | `{ "images": [{ "path": "", "mimeType": "", "size": 0, "url": "", "expiresIn": 0 }], "provider": "", "model": "", "edit": false, "usage": {} }` |
| `POST /api/imagine/video` | `{ "prompt": "", "duration": 6, "aspectRatio": "16:9", "resolution": "480p", "sourcePath": "" }` one of `sourcePath` or `sourceImage` | `{ "jobId": "", "status": "pending", "seconds": 6, "resolution": "", "aspectRatio": "", "model": "", "pollAfterSeconds": 0, "usage": {} }` |
| `POST /api/imagine/status` | `{ "jobId": "" }` | `{ "status": "pending", "progress": 0, "pollAfterSeconds": 0 }` or `{ "status": "done", "video": { "path": "", "mimeType": "video/mp4", "size": 0, "url": "", "expiresIn": 0, "duration": 0 } }` |
| `GET /api/imagine/usage` | none | `{ "images": { "used": 0, "limit": 0 }, "videoSeconds": { "used": 0, "limit": 0 }, "resetAt": "" }` |
| `POST /api/voice/audio` | `{ "text": "", "provider": "", "voice": "", "language": "auto", "speed": 1 }` | audio bytes, not JSON. `Content-Type` is the audio type. `X-Dua-Voice-Provider` names the provider |
| `POST /api/voice/session` | live-voice settings JSON | `{ "sessionId": "", "token": "", "expiresAt": "", "maxSeconds": 0, "url": "", "model": "", "session": {}, "usage": {} }` |
| `POST /api/voice/session-end` | `{ "sessionId": "uuid" }` | `{ "chargedSeconds": 0, "usedSeconds": 0, "limitSeconds": 0 }` |
| `GET /api/voice/usage` | none | live-voice usage JSON |

### Conversations

Owner-only relational chat history (`dua_conversations`, `dua_messages`). The API uses the owner's token and the anon key only. Every response is `Cache-Control: no-store`; errors are `{ "error": "..." }`. `:id` is a UUID (anything else is `404`), wrong methods are `405`, and bodies are limited to 16 KB.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/conversations?q=&limit=50&offset=0` | none. `q` matches titles literally (max 100 characters), `limit` 1–100, `offset` 0–10000 | `{ "conversations": [ conversation ], "limit": 50, "offset": 0, "hasMore": false }`, pinned first, then most recent |
| `POST /api/conversations` | `{ "id"?: "uuid", "title"?: "", "agentId"?: "dua-agent" }` title 1–200 characters | `201` `{ "conversation": conversation }`. Repeating a client `id` returns the saved row; an id owned elsewhere is `409` |
| `GET /api/conversations/:id/messages?limit=200&before=ISO` | none. `limit` 1–500, `before` an ISO-8601 timestamp | `{ "messages": [ message ], "hasMore": false }`, oldest first; `404` when the conversation is not the owner's |
| `PUT /api/conversations/:id/pin` | `{ "pinned": true }` | `{ "conversation": conversation }`, `404` when not found |
| `DELETE /api/conversations/:id` | none | `204`, `404` when not found. Its messages are deleted too |
| `GET /api/conversations/:id/agents` | none | `{ "agents": [ { "conversationId": "uuid", "agentId": "slug", "addedAt": "ISO" } ] }` |
| `POST /api/conversations/:id/agents` | `{ "agentId": "slug" }` | `201` `{ "agent": { "conversationId": "uuid", "agentId": "slug", "addedAt": "ISO" } }` |
| `DELETE /api/conversations/:id/agents/:agentId` | none | `204`, `404` when not found |

```json
{
  "conversation": { "id": "uuid", "agentId": "dua-agent", "title": "New chat", "pinned": false,
    "lastMessagePreview": "", "lastMessageAt": "ISO-8601", "createdAt": "ISO-8601" },
  "message": { "id": "uuid", "conversationId": "uuid", "agentId": null, "role": "user", "content": "",
    "model": null, "tokenCount": null, "usage": null, "createdAt": "ISO-8601" },
  "conversationAgent": { "conversationId": "uuid", "agentId": "dua-agent", "addedAt": "ISO-8601" }
}
```

For older messages, pass the first message's `createdAt` as `before`. `POST /api/chat` accepts an optional `conversation_id`: it saves the user turn before generation starts, and saves the assistant turn with `agent_id`, `model` and usage on completion (PR D).

**Multi-Agent Group Chat & @mention (Phase 4A):**
- A conversation can have multiple participating agents via `dua_conversation_agents`.
- When a user includes `@AgentName` or `@agent-id` in a turn, the backend parses the mentions and dispatches **only** those targeted agents in parallel.
- If no `@mention` is present in a group thread, all assigned group agents (up to 3) are dispatched concurrently.
- In SSE streaming mode (`"stream": true`), stream events include `agentId` and `agentName` (e.g. `{ "type": "text", "delta": "...", "agentId": "dua-agent", "agentName": "Dua Agent" }`). Each agent emits an `agent_done` event upon completing.
- Each responding agent commits its own assistant message turn to `dua_messages` tagged with its `agent_id`.
- `/api/cloud` is unchanged.

### Artifacts and Collaborative Studios (Phase 4B)

Owner-only persistent artifacts and versioned revision history (`dua_artifacts`, `dua_artifact_versions`). The API uses the owner's token and the anon key only. Every response is `Cache-Control: no-store`; errors are `{ "error": "..." }`. `:id` matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` (anything else is `404`), wrong methods are `405`, bodies limited to 16 KB.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/artifacts` | none | `{ "artifacts": [ artifact ] }`, newest first |
| `POST /api/artifacts` | `{ "id"?: "art_...", "title": "", "type"?: "", "timestamp"?: "", "sizeBytes"?: 0, "url"?: "" }` | `201` `{ "artifact": artifact }` |
| `DELETE /api/artifacts/:id` | none | `204`, `404` when not found |
| `GET /api/artifacts/:id/versions` | none | `{ "versions": [ version ] }`, newest `versionNum` first |
| `POST /api/artifacts/:id/revise` | `{ "instruction": "Make the header bold and add intro" }` | `201` `{ "artifact": artifact, "version": version }`. Automatically revisions content via AI or fallback and increments `versionNum` |

```json
{
  "artifact": {
    "id": "art_q3_deck",
    "title": "Q3 Launch Deck",
    "type": "Webpage",
    "timestamp": "Today",
    "sizeBytes": 2411724,
    "url": "https://static.teamily.ai/sites/demo/q3-deck/index.html"
  },
  "version": {
    "id": "uuid",
    "artifactId": "art_q3_deck",
    "versionNum": 2,
    "content": "Updated artifact content...",
    "promptNote": "Make the header bold and add intro",
    "createdAt": "ISO-8601"
  }
}
```

### Memories (Phase 3 — Universal Living Memory)

Owner-only persistent memory (`dua_memories`). The API uses the owner's token and the anon key only. Every response is `Cache-Control: no-store`; errors are `{ "error": "..." }`. `:id` matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` (anything else is `404`), wrong methods are `405`, bodies limited to 16 KB.

**Scope:** Every memory has a `scope` field:
- `"global"` — visible in every conversation and standalone `/api/chat` for this owner.
- `"group:<conversation_id>"` — visible **only** in the named conversation thread. Never leaked into other threads.

**Auto-extraction:** After each assistant reply inside a `conversation_id` chat, the server non-blockingly extracts up to 2 durable facts/preferences from the turn and saves them as `global` or `group:<conversation_id>` memories. The extraction is silent on failure.

**Context injection:** On every `/api/chat` with a `conversation_id`, the server prepends top-10 relevant memories (`global` + `group:<conversation_id>`) into the model's context. Privacy rule is strict: `group:<other_id>` memories are **never** injected.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/memories` | `?scope=global\|group:<uuid>` or `?conversation_id=<uuid>` (optional filters) | `{ "memories": [ memory ] }`, newest first |
| `POST /api/memories` | `{ "id"?: "mem_...", "title": "", "summary"?: "", "timestamp"?: "", "category"?: "", "url"?: null, "scope"?: "global" }` | `201` `{ "memory": memory }` |
| `PUT /api/memories/:id` | `{ "scope"?: "global"\|"group:<uuid>", "sourceConversationId"?: null\|"uuid", "title"?: "", "summary"?: "", "category"?: "", "url"?: null }` | `{ "memory": memory }`. Toggles scope and updates fields. `404` when not found |
| `DELETE /api/memories/:id` | none | `204`, `404` when not found |

```json
{
  "memory": {
    "id": "mem_brand_green",
    "title": "Brand green is #087C45",
    "summary": "Never purple or blue.",
    "timestamp": "4 din pehle",
    "category": "Preference",
    "url": null,
    "scope": "global",
    "sourceConversationId": null
  }
}
```

### Agents and skills

Owner-only custom agents and specialized skills (`dua_agents`, `dua_agent_skills`). The API uses the owner's token and the anon key only. Every response is `Cache-Control: no-store`; errors are `{ "error": "..." }`. `:id` is a slug matching `^[a-z0-9][a-z0-9-]{0,63}$` (anything else is `404`), wrong methods are `405`, and bodies are limited to 64 KB.

#### Agents

| Method and path | Request | Response |
|---|---|---|
| `GET /api/agents` | none | `{ "agents": [ agent ] }`, pinned first, then most recently updated |
| `POST /api/agents` | `{ "id"?: "slug", "name": "Name", "description"?: "", "mode"?: "auto"\|"agent"\|"reasoning"\|"build", "systemPrompt"?: "", "model"?: null, "pinned"?: false }` | `201` `{ "agent": agent }`. Official agent IDs (`personal-agent`, `dua-agent`) cannot be created via POST |
| `GET /api/agents/:id` | none | `{ "agent": agent }`, `404` when not found |
| `PUT /api/agents/:id` | `{ "name"?: "", "description"?: "", "mode"?: "", "systemPrompt"?: "", "model"?: null, "pinned"?: false }` | `{ "agent": agent }`. For official agents, custom overrides are persisted; mode and id are immutable |
| `DELETE /api/agents/:id` | none | `204`, `404` when not found. Official agents cannot be deleted (`400`) |
| `POST /api/agents/generate-prompt` | `{ "name"?: "", "description": "What this agent does...", "mode"?: "auto" }` | `{ "systemPrompt": "Generated system prompt..." }`. Requires chat access / daily quota |

```json
{
  "agent": {
    "id": "code-assistant",
    "name": "Code Assistant",
    "description": "Helps write and debug code.",
    "mode": "auto",
    "systemPrompt": "You are an expert programmer...",
    "model": null,
    "pinned": false,
    "isOfficial": false,
    "createdAt": "ISO-8601",
    "updatedAt": "ISO-8601"
  }
}
```

#### Skills

Starter skills are loaded directly from `dua_agent_prompts.json` without requiring database seeding. The database stores user-created skills and starter overrides (enable/disable).

| Method and path | Request | Response |
|---|---|---|
| `GET /api/skills` | none | `{ "skills": [ skill ] }`, starter skills first, followed by custom skills |
| `POST /api/skills` | `{ "id"?: "slug", "agentId"?: "dua-agent", "title": "Title", "summary"?: "", "body"?: "", "enabled"?: true }` | `201` `{ "skill": skill }`. Starter skill IDs cannot be created via POST (`409`, use PUT) |
| `GET /api/skills/:id` | none | `{ "skill": skill }`, `404` when not found |
| `PUT /api/skills/:id` | `{ "title"?: "", "summary"?: "", "body"?: "", "enabled"?: true, "agentId"?: "" }` | `{ "skill": skill }`. For starter skills, overrides (e.g. enable/disable) are persisted |
| `DELETE /api/skills/:id` | none | `204`, `404` when not found. Starter skills cannot be deleted (`400`, disable them instead) |
| `POST /api/skills/generate` | `{ "title"?: "", "description": "What this skill does..." }` | `{ "skill": { "title": "...", "summary": "...", "body": "..." } }`. Requires chat access / daily quota |

```json
{
  "skill": {
    "id": "frontend-developer",
    "agentId": "dua-agent",
    "title": "Frontend Developer",
    "summary": "Specialized in UI components and styling",
    "body": "Markdown instructions...",
    "enabled": true,
    "isStarter": true,
    "createdAt": null,
    "updatedAt": null
  }
}
```

#### Agent Instructions (Phase 4C — Proactive Agents)

Owner-only instructions for autonomous and proactive agent behavior (`dua_agent_instructions`). `:id` is the agent slug (official or custom), `:instructionId` is a UUID.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/agents/:id/instructions` | none | `{ "instructions": [ instruction ] }`, newest first |
| `POST /api/agents/:id/instructions` | `{ "instruction": "Always respond in concise Kotlin", "isActive"?: true }` | `201` `{ "instruction": instruction }` |
| `GET /api/agents/:id/instructions/:instructionId` | none | `{ "instruction": instruction }`, `404` when not found |
| `PUT /api/agents/:id/instructions/:instructionId` | `{ "instruction"?: "...", "isActive"?: false }` | `{ "instruction": instruction }`, `404` when not found |
| `DELETE /api/agents/:id/instructions/:instructionId` | none | `204`, `404` when not found |

```json
{
  "instruction": {
    "id": "uuid",
    "agentId": "personal-agent",
    "instruction": "Always respond in concise Kotlin",
    "isActive": true,
    "createdAt": "ISO-8601"
  }
}
```

#### Agent Triggers (Phase 4C — Proactive Agents)

Owner-only proactive execution triggers (`dua_agent_triggers`). `:id` is the agent slug, `:triggerId` is a UUID. Supported trigger types: `schedule`, `webhook`, `missed_summary`.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/agents/:id/triggers` | none | `{ "triggers": [ trigger ] }`, newest first |
| `POST /api/agents/:id/triggers` | `{ "triggerType": "schedule", "cronExpr"?: "0 9 * * 1-5", "prompt": "Morning summary", "conversationId"?: null, "enabled"?: true }` | `201` `{ "trigger": trigger }` |
| `GET /api/agents/:id/triggers/:triggerId` | none | `{ "trigger": trigger }`, `404` when not found |
| `PUT /api/agents/:id/triggers/:triggerId` | `{ "triggerType"?: "", "cronExpr"?: "", "prompt"?: "", "conversationId"?: null, "enabled"?: false }` | `{ "trigger": trigger }`, `404` when not found |
| `DELETE /api/agents/:id/triggers/:triggerId` | none | `204`, `404` when not found |
| `POST /api/agents/:id/triggers/:triggerId/run` | none | `{ "triggered": true, "trigger": trigger }`. Updates `lastRunAt` timestamp |

```json
{
  "trigger": {
    "id": "uuid",
    "agentId": "dua-agent",
    "conversationId": null,
    "triggerType": "schedule",
    "cronExpr": "0 9 * * 1-5",
    "prompt": "Morning summary",
    "enabled": true,
    "lastRunAt": "ISO-8601",
    "createdAt": "ISO-8601"
  }
}
```

### Devices and Push Notifications (Phase 5B)

Owner-only device token registration and notification management (`dua_device_tokens`, `dua_notifications`). The API uses the owner's token and the anon key only. Every response is `Cache-Control: no-store`; errors are `{ "error": "..." }`.

#### Supabase Realtime Channels (Phase 5A)
Cross-device live sync is enabled via `supabase_realtime` publication for:
- `dua_conversations`
- `dua_messages`
- `dua_agents`
- `dua_artifacts`
- `dua_artifact_versions`

Clients subscribe using standard Supabase client channels: `supabase.channel('public:<table_name>').on('postgres_changes', ...)`. Supabase enforces Row Level Security (`owner_id = (select auth.uid())`) on every Realtime event stream.

#### Endpoints

| Method and path | Request | Response |
|---|---|---|
| `POST /api/devices/register` | `{ "token": "fcm_token_...", "platform": "android"\|"web", "deviceName"?: "" }` | `200` `{ "device": device }`. Upserts on conflict `(owner_id, token)` |
| `DELETE /api/devices/:token` | none | `204`, deletes token |
| `GET /api/notifications` | none | `{ "notifications": [ notification ] }`, newest first (limit 100) |
| `PUT /api/notifications/:id/read` | none | `{ "notification": notification }`, updates status to `"read"` |

```json
{
  "device": {
    "id": "uuid",
    "token": "fcm_token_...",
    "platform": "android",
    "deviceName": "Realme 14 Pro+ 5G",
    "createdAt": "ISO-8601",
    "updatedAt": "ISO-8601"
  },
  "notification": {
    "id": "uuid",
    "conversationId": null,
    "agentId": "dua-agent",
    "title": "Daily Summary Ready",
    "body": "Your automated morning summary has finished.",
    "data": { "triggerType": "schedule" },
    "status": "sent",
    "sentAt": "ISO-8601",
    "createdAt": "ISO-8601"
  }
}
```

Push notifications are dispatched via **FCM HTTP v1** (`https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`) using Google OAuth2 credentials. The legacy FCM endpoint (`fcm.googleapis.com/fcm/send`) is strictly prohibited and never used.

### Orhan tasks

One running task. Research, then Checker, then Writer. Max 12 steps and 10 minutes.

| Path | Request | Response |
|---|---|---|
| `GET /api/orhan/tasks` | none | `{ "tasks": [ task ] }` |
| `GET /api/orhan/tasks/:id` | none | `{ "task": task }` |
| `POST /api/orhan/tasks` | `{ "prompt": "", "team": null, "requestId": "uuid" }` prompt max 4000 characters; `requestId` optional | `{ "task": task }` |
| `POST /api/orhan/tasks/:id/start` | none | `{ "task": task }` |
| `POST /api/orhan/tasks/:id/continue` | none | `{ "task": task }` |
| `POST /api/orhan/tasks/:id/cancel` | none | `{ "task": task }` |
| `POST /api/orhan/tasks/:id/retry` | none | `{ "task": task }` |

`:id` is a UUID. Task:

```json
{
  "id": "uuid",
  "title": "",
  "prompt": "",
  "status": "waiting",
  "lifecycleStatus": "queued",
  "plan": { "title": "", "agents": [], "steps": [] },
  "steps": [],
  "artifact": null,
  "error": null,
  "runCount": 0,
  "startedAtMs": 0,
  "createdAtMs": 0,
  "updatedAtMs": 0,
  "finishedAtMs": null,
  "stoppedAtMs": null,
  "endReason": null,
  "limits": { "maxSteps": 12, "maxMinutes": 10 }
}
```

`status` is `waiting`, `running`, `completed`, `failed`, or `cancelled`. The table also allows `approval_needed`, but no current route sets it. `status` keeps these legacy values for existing clients.

`lifecycleStatus` is the task lifecycle: `queued`, `running`, `completed`, `failed`, `stopped`, or `timed_out`.

| `status` | `endReason` | `lifecycleStatus` |
|---|---|---|
| `waiting` | `null` | `queued` |
| `running` (or `approval_needed`) | `null` | `running` |
| `completed` | `null` | `completed` |
| `failed` | `timeout` | `timed_out` |
| `failed` | `step_limit`, `error` or `null` | `failed` |
| `cancelled` | `user_stop` (or `null` on older rows) | `stopped` |

`finishedAtMs` is set when a task ends as `completed` or `failed` (including `timed_out`). `stoppedAtMs` is set by `cancel`. `retry` clears `endReason`, `finishedAtMs` and `stoppedAtMs`. Rows saved before migration `202611250001` have `null` in all three fields, so an older time-limit failure still shows `lifecycleStatus` `failed`.

The 10 minute limit is also applied when tasks are read (`GET` list or one task) and before `start`: a `running` task whose `startedAtMs` is more than 10 minutes old becomes `failed` with `endReason` `timeout` and the error `This task reached its 10 minute limit.`, so an abandoned task no longer blocks a new start. `start` checks that the target task exists (`404`) before the one-running-task rule (`409`).

Errors are `{ "error": "" }`. Missing sign-in is `401`. An `:id` that is not a UUID, or a task the signed-in owner does not have (including another user's task), is `404` on every `:id` route. `start` returns `409` when the task exists but is no longer `waiting`. `cancel` returns `409` when the task is `completed` or `failed`.

Idempotency:

- `requestId` is an optional UUID chosen by the client (case-insensitive, stored lower-case). It becomes the task `id`. Any other value (not a UUID string) is `400` `{ "error": "Invalid requestId." }`.
- Repeating `POST /api/orhan/tasks` with the same `requestId` and the same `prompt` returns `200` `{ "task": task }` with the task already saved, in its current state, without a new plan. This also holds when two such requests race: the one that loses the insert returns the saved task.
- The same `requestId` with a different `prompt` is `409` `{ "error": "This requestId was already used for a different job." }`. `team` is not compared.
- Without `requestId`, every create makes a new task, as before.
- `cancel` on a task that is already `cancelled` returns `200` with the task unchanged (same `stoppedAtMs`).

Control-plane actions map onto existing routes:

| Action | Route |
|---|---|
| `direct_reply` | `POST /api/chat` |
| `create_task` | `POST /api/orhan/tasks` |
| `get_task_status` | `GET /api/orhan/tasks/:id` |
| `stop_task` | `POST /api/orhan/tasks/:id/cancel` |

### Workflows

| Path | Request | Response |
|---|---|---|
| `GET /api/workflow-runs` | none | `{ "runs": [] }` |
| `PUT /api/workflow-runs` | `{ "runs": [] }` or one run object, 1 to 100 | saved runs JSON |
| `GET /api/workflow-executions` | optional `?workflowId=` | `{ "runs": [], "supportedTools": [] }` |
| `GET /api/workflow-executions/:id` | none | `{ "run": {} }` |
| `POST /api/workflow-executions` | definition JSON, max 128 KB | `202` `{ "run": {} }` |
| `POST /api/workflow-executions/:id/cancel` | `{ "expectedAttempt": 1 }` | `{ "run": {} }` |
| `POST /api/workflow-executions/:id/retry` | `{ "expectedAttempt": 1 }` | `{ "run": {} }` |
| `GET /api/workflow-automation` | optional `?workflowId=` | `{ "registrations": [] }` |
| `PUT /api/workflow-automation/schedules/:id` | `{ "expectedRevision": 0, "enabled": true, "intervalSeconds": 300, "workflowId": "", "title": "" }` | `{ "registration": {} }` |
| `PUT /api/workflow-automation/triggers/:id` | `{ "expectedRevision": 0, "enabled": true, "workflowId": "", "title": "" }` | `{ "registration": {} }` |
| `POST /api/workflow-automation/schedules/:id/disable` | `{ "expectedRevision": 0 }` | `{ "registration": {} }` |
| `POST /api/workflow-automation/triggers/:id/disable` | `{ "expectedRevision": 0 }` | `{ "registration": {} }` |
| `POST /api/workflow-automation/deliver/:id` | signed webhook body | delivery result JSON |

`DUA_WORKFLOWS_ENABLED=1` is required to enqueue or register. External deliver also needs `DUA_WORKFLOW_EXTERNAL_TRIGGERS_ENABLED=1`.

### Same-origin cookie proxies

Leave these for a UI that is hosted on the API origin. A separate UI uses the engine instead.

`POST /api/web/chat` body matches engine chat (`model`, `mode`, `messages`, `skills`). Response is the engine SSE stream.

`POST /api/web/agent/action` body `{ "id": "", "decision": "approve"|"reject" }`. Response is the engine action JSON.

## Python engine

Local process: `python app.py` from `apps/ai-engine`, behind `wsgi.py` in production. Owner auth is required on every route except `GET /`.

`GET /` response:

```json
{
  "status": "Dua AI Engine is running!",
  "engine": "google-cloud",
  "agent": true,
  "titles": true,
  "model": "gemini-3.8-flash",
  "agentModel": "",
  "personalization": { "personality": true },
  "agentApprovals": true,
  "freeModels": [],
  "imagine": {}
}
```

`agent` is false when the agent kill switch or maintenance is on.

### Chat

`POST /api/chat`

```json
{
  "model": "Dua",
  "messages": [{ "role": "user", "text": "", "attachments": [] }],
  "mode": "agent",
  "stream": true,
  "skills": ["code-reviewer"],
  "personality": "",
  "systemInstruction": "",
  "memory": "",
  "context": { "summary": "" },
  "allowedTools": [],
  "web": false,
  "code": false,
  "openrouter": null,
  "resumeRun": null
}
```

`model` may be `Dua`, `ChatGPT`, `Gemini`, `Claude`, `Grok`, or `Kimi`. The engine answers with Gemini. Other names add `notice`.

`stream` omitted or false returns `{ "text": "", "sources": [], "notice": "", "truncated": false, "hint": "" }`. Sources and the extra fields appear only when they apply.

`stream: true` is SSE in the same event shape as the Node API, plus agent events the engine emits (`progress`, approval requests, image results). Agent mode requires `stream: true` or the engine returns `400` `{ "error": "Agent mode needs streaming. Update the app." }`.

`POST /chat` is the old one-turn route. Body `{ "message": "" }`. Response `{ "reply": "" }`.

`POST /api/title` body `{ "user": "", "reply": "" }`. Response `{ "title": "" }`.

### Semantic Cost Router (Phase 6A)

Before model execution, the engine classifies request complexity via `classify_complexity` and routes to the appropriate model tier:
- **Fast / Low-Cost Tier (`Gemini Flash`)**: Title generation, `@mention` routing, short casual Q&A, and memory fact extraction.
- **Frontier Reasoning Tier (`Gemini Pro` / `Claude`)**: Multi-step `mode: "agent"` tool loops, coding/PR tasks, Studio artifact revisions (`/revise`), and complex analysis.

The chosen model is recorded in `dua_messages.model`, and `AGENT_DAILY_TOKEN_LIMIT` is strictly enforced.

### Agent actions, notes, documents

| Method and path | Request | Response |
|---|---|---|
| `GET /api/agent/capabilities` | none | `{ "adkEnabled": false, "storage": {}, "embeddingConfigured": false, "providerRoutes": {}, "customTools": [], "tools": [], "toolCatalog": [{ "id": "", "available": true, "reason": null }], "answerStreaming": true, "codingExecution": {}, "codingCheckpoints": {}, "deviceAutomation": {}, "liveProvidersVerified": false, "build": "unknown" }` |
| `POST /api/agent/action` | `{ "id": "", "decision": "approve"|"reject" }` | `{ "status": "done"|"failed"|"rejected", "tool": "", "text": "" }` |
| `GET /api/agent/notes/status` | none | `{ "enabled": false, "ready": false, "reason": "" }` |
| `POST /api/agent/notes/reindex` | `{ "offset": 0, "limit": 20 }` | `{ "indexed": 0, "nextOffset": 0, "more": false }` |
| `GET /api/agent/documents` | none | `{ "documents": [{ "id": "", "name": "", "kind": "document" }] }` |
| `POST /api/agent/documents` | `{ "name": "", "text": "", "id": "" }` or `{ "query": "" }` | `{ "id": "", "name": "", "chunks": 1, "indexed": true }` or `{ "matches": [{ "id": "", "name": "", "chunk": 0, "text": "", "citation": "", "score": 0 }] }` |
| `DELETE /api/agent/documents` | `{ "id": "uuid" }` | `{ "deleted": true }` |
| `GET /api/agent/workspaces` | none | `{ "checkpoints": [{ "id": "", "revision": 0, "base_sha": "", "updated": 0, "expires": 0 }] }` |
| `POST /api/imagine/image` | same image body as the Node route | same stored-image JSON the Node route returns |

### Orhan engine routes

The Node task API calls these. A UI can also call them with the owner bearer token.

`POST /api/orhan/plan` body `{ "prompt": "", "team": null }`. Response:

```json
{
  "title": "",
  "agents": [{ "id": "research", "name": "Research", "tools": ["search"], "can": "", "cannot": "" }],
  "steps": [
    { "id": "research", "agent": "research", "title": "Research", "dependsOn": [] },
    { "id": "check", "agent": "checker", "title": "Check the research", "dependsOn": ["research"] },
    { "id": "document", "agent": "writer", "title": "Write the document", "dependsOn": ["check"] }
  ]
}
```

`POST /api/orhan/step` body `{ "agent": "research"|"checker"|"writer", "prompt": "", "inputs": { "research": "", "check": "" } }`. Response `{ "status": "completed", "output": "" }` or `{ "status": "failed", "error": "" }`. Any other agent id is refused.
