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

There is no agent-create endpoint. Two roles are fixed.

**Personal Agent.** Normal chat. The engine system prompt is `You are Dua AI, a helpful, smart, and polite personal AI assistant.` The client may add `personality` (max 1000 characters), `systemInstruction` (max 20000 characters), and `memory`. Those are appended under the server prompt and cannot replace it.

**Dua Agent.** Engine `POST /api/chat` with `"mode": "agent"` and `"stream": true`. The client sends skill ids only. The server appends the Super Agent prompt and the skill bodies, in this order:

| Id | Title |
|---|---|
| `frontend-developer` | Frontend Developer |
| `backend-architect` | Backend Architect |
| `api-tester` | API Tester |
| `devops-automator` | DevOps Automator |
| `code-reviewer` | Code Reviewer |

Unknown, duplicate, or non-agent `skills` return `400` `{ "error": "Invalid skills." }`.

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
| `GET /api/account/features` | none | `{ "passwordReset": false, "emailAuth": true, "accountDeletion": false }` |
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
| `GET /api/config` | none | `{ "geminiConfigured": false, "model": "", "providers": [], "web": {}, "streaming": true, "personalization": { "personality": true }, "files": {}, "context": {}, "imagine": {}, "voice": {}, "switches": {}, "history": {}, "code": {}, "build": {}, "projects": {} }` |

`switches` is `{ "agent": false, "imagine": false, "voice": false, "maintenance": { "enabled": false } }`.

### Chat, search, GitHub read

`POST /api/chat` is Personal Agent and Build chat through the configured provider. It does not accept `skills` or `mode: "agent"`. Use the engine for Dua Agent.

Request keys: `model`, `messages`, `attachments`, `memory`, `web`, `stream`, `mode`, `context`, `xSearch`, `code`, `repository`, `projectId`, `persistence`, `personality`.

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

```json
{
  "conversation": { "id": "uuid", "agentId": "dua-agent", "title": "New chat", "pinned": false,
    "lastMessagePreview": "", "lastMessageAt": "ISO-8601", "createdAt": "ISO-8601" },
  "message": { "id": "uuid", "conversationId": "uuid", "agentId": null, "role": "user", "content": "",
    "model": null, "tokenCount": null, "usage": null, "createdAt": "ISO-8601" }
}
```

For older messages, pass the first message's `createdAt` as `before`. Messages are saved by `/api/chat` in a later release (PR D). `/api/cloud` is unchanged.

### Orhan tasks

One running task. Research, then Checker, then Writer. Max 12 steps and 10 minutes.

| Path | Request | Response |
|---|---|---|
| `GET /api/orhan/tasks` | none | `{ "tasks": [ task ] }` |
| `POST /api/orhan/tasks` | `{ "prompt": "", "team": null }` prompt max 4000 characters | `{ "task": task }` |
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
  "plan": { "title": "", "agents": [], "steps": [] },
  "steps": [],
  "artifact": null,
  "error": null,
  "runCount": 0,
  "startedAtMs": 0,
  "createdAtMs": 0,
  "updatedAtMs": 0,
  "limits": { "maxSteps": 12, "maxMinutes": 10 }
}
```

`status` is `waiting`, `running`, `done`, `failed`, or `cancelled`.

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
