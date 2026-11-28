# AGENTS.md

Rules for any agent or human in `dua-backend`. Read before touching a file. A rulebook, not a history.

**Citations.** Name the file plus a function, constant or heading, never a line number. Numbers rot in
one or two commits: `API_CONTRACT.md` gained a section at the top and everything below shifted 15 to 25
lines, so a stale number opened the wrong paragraph. A name survives that. Label each code claim
`FACT` (verified in the file), `ASSUMPTION` (your guess) or `Not found in code`. Never present an
assumption as a fact.

## 1. Shape

`apps/api/` is a bare `node:http` ESM server, Cloud Run `dua-api`, entry `src/server/server.mjs`.
`apps/ai-engine/` is Flask plus Google ADK, Cloud Run `dua-ai-engine`, served by `wsgi.py`.
`supabase/` holds numbered SQL in `supabase/migrations/`. `packages/contracts/` holds one file. Android
is elsewhere (`KRFbrothers/teamily-android-ui`). Neither process serves a website. There is no build
step, no linter, no formatter, no type checker: never claim one passed. `archive/` and `apps/android/`
are named in files but do not exist.

## 2. Commands

In `apps/api`: `npm ci --ignore-scripts --no-audit --no-fund`, `npm test`, `npm run test:ci`,
`npm start`. From the root: `python -m pytest -q apps/ai-engine/tests`. `npm run verify:rls` needs live
Supabase and never runs in CI. Node floor `24` (`.nvmrc`, `engines` in `apps/api/package.json`); deps
are `unpdf` and `cfb` only. CI is `.github/workflows/checks.yml`, workflow `Project checks`, two jobs,
no secret scan, no audit, no lint. `FACT:` `google-adk` is `2.12.0` in `requirements.txt` but `2.14.1`
in `requirements-lock.txt`, and CI installs the lock.

## 3. Secrets

`.gitignore` blocks `.env` and `.env.*`; `.env.example` is tracked on purpose and stays tracked. Before
every push run `git status --short` and `git diff --cached` and read every line. A committed secret is
reported and rotated, never scrubbed locally. The service-role key never leaves the server.

## 4. Rules

**4.1 Read-only by default.** Change nothing until the task asks, then the smallest safe change.
**4.2 Ambiguous task: ask, do not guess.** 4 concrete options plus one marked `(Recommended)`, and one
line on what the wrong pick costs. Never build the wrong thing and report it as done.
**4.3 One phase, then stop.** Report it, stop for review, state what you did not do. If a command
fails, retry with a fix at most 3 times, then stop with the exact command, error and what changed.
**4.4 Never delete, archive instead.** Move to `archive/` with original path, new path, date, reason,
references checked and restoration notes, after checking imports, routes, tests, build and deploy
config and docs. Search for an existing equivalent first: no duplicate route, table, prompt or skill
list.
**4.5 Preserve public APIs and naming.** `/api/orhan/*` and `dua_orhan_tasks` are kept for Android, so
renaming them is breaking. `Dua Gen AI` is the platform, `Dua` chat and control plane, `Dua Work`
execution and coding. `Orhan` is legacy internal only, never user facing.
**4.6 One official pinned agent: `Dua Work`.** `OFFICIAL_AGENTS` in
`apps/api/src/core/agents-skills.mjs` and `loadAvailableAgents` in
`apps/api/src/core/conversations.mjs` list only `dua-work`. Never add a second pinned agent without
an owner decision in `docs/MASTER_PLAN.md`. `FACT:` a conversation row may still store `agent_id`
`dua-agent`. `prepareConversationChat` accepts that stored id so older chats do not return 400.
**4.7 No starter skill catalogue.** No fixed set of 5 skills as a product rule; the owner enables
skills per agent, with no fixed catalogue size. `FACT:` the code lags.
`apps/ai-engine/dua_engine/agent/dua_agent_prompts.json` still ships `frontend-developer`,
`backend-architect`, `api-tester`, `devops-automator`, `code-reviewer`. It is the single source of
truth; `deploy-cloudrun.sh` materializes it into the container at build time, so no committed copy
exists under `apps/api/src/core/`. Do not copy that list into new code.
**4.8 Owner lock fails closed.** Production refuses to start without a valid `DUA_ALLOWED_EMAIL` and
returns 503. Never make that check optional to pass a test.
**4.9 Status values stay in sync:** the mapping, the migration comment, this rule and the
`## Task Requirements` list all change in one PR.
**4.10 Never weaken a test to make it pass,** and never claim a check passed that you did not run. Fix
the code or report the failure. No deleted assertion, loosened matcher, skipped case or edited fixture
to turn a number green. No linter exists here, so never write "lint passed".
**4.11 Never edit an applied migration, and every schema change ships a rollback file.** Migrations in
`supabase/migrations/` are immutable once merged: fix forward with a new numbered file, named rollback
kept beside it. No rollback, not done. `FACT:` 30 migrations exist, five have a rollback file
(`202611280001_dua_function_history.rollback.sql`,
`202611280002_dua_quota_rpc_dispatch.rollback.sql`,
`202611280003_dua_task_links_event_backfill.rollback.sql`,
`202611280004_dua_task_lineage_event_backfill.rollback.sql` and
`202611280005_dua_memories_scope_history.rollback.sql`).
**4.12 Staging only for database work.** Never point a local run, test or script at production.
**4.13 Never push to `main`.** Push a branch, open a PR, wait for `Project checks` green. Merge,
`supabase db push` and Cloud Run deploy each need an explicit owner yes in the PR thread, every time.
Merging does not deploy.
**4.14 Every PR carries a short Hinglish summary:** 3 to 6 lines on what changed, why, what you ran,
what you could not run and the risk, so the owner can decide without the diff.
**4.15 Every claim carries a file path** plus a function or heading. No bare assertion, no invented
behaviour, no invented test result.

## Initial Control-Plane Actions

The first stable actions are:

- `direct_reply`
- `create_task`
- `get_task_status`
- `stop_task`

`FACT:` each maps to an existing route, asserted in `apps/api/test/agents-md.test.mjs`:
`direct_reply` is `POST /api/chat`; `create_task` is `POST /api/orhan/tasks`; `get_task_status` is
`GET /api/orhan/tasks/:id`; `stop_task` is `POST /api/orhan/tasks/:id/cancel`. `handleOrhanTasks` in
`apps/api/src/core/orhan-tasks.mjs` accepts only `start`, `continue`, `cancel`, `retry` and `events` as
the fifth segment, locks one running task per owner, caps at `MAX_STEPS` 12 and `MAX_MINUTES` 10, and
runs research then checker then writer.

## Task Requirements

Every task has a unique ID, a status, created and updated times, request metadata, a result or artifact
reference, error detail on failure, stop detail, and timeout handling.

Recommended statuses:

- `queued`
- `running`
- `completed`
- `failed`
- `stopped`
- `timed_out`

`FACT:` all six exist. The stored row also carries `idempotency_key`, `parent_task_id`, `root_task_id`,
`attempt` and `end_reason` (task record builder in `orhan-tasks.mjs`).

## 5. This file is tested by CI

`FACT:` `apps/api/test/agents-md.test.mjs` reads this file and asserts it keeps the
[`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md) link, both headings above, the four action bullets and the
six status bullets. `npm run test:ci` runs it, so dropping any of those strings fails the PR.

## 6. Cross-repo and done

`API_CONTRACT.md` is the source of truth for every shape the Android client depends on: update it in
the same PR. Do not change `X-Dua-Native`, the `Origin` check or the `dua_refresh` cookie without a
coordinated Android change. A change to `POST /api/chat` on either process, or to status values, is
cross-repo. Done means behaviour implemented, no duplicate added, no unrelated file touched, imports
resolve, relevant tests ran, contract updated, diff read for secrets, every limitation named with the
check you could not run.

## 7. Open items

A 5 skill starter set is still in the code against 4.7. `google-adk`
drift unresolved. No migration has a rollback. `apps/android/` and `archive/` are referenced but absent.
No linter, formatter or type checker exists.