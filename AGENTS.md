# AGENTS.md

Rules for any agent or human working in the `dua-backend` repository.

This file is rewritten so that every statement about the code carries a
`file:line` citation. Anything that could not be confirmed is marked
`ASSUMPTION` or `Not found in code`.

Read this before touching a single file.

---

## 1. Repo purpose and scope

**FACT:** This repository is the Dua Gen AI backend, upgraded in place. It is
not a clean-slate replacement. Source: `README.md:8`.

**FACT:** The product has two experiences. `Dua` covers chat, planning, intent
detection, memory, task creation and task control. `Dua Work` covers coding,
file operations, tests, execution, logs and artifacts. Source:
`AGENTS.md` (pre-rewrite) lines 1-4, `README.md:3-6`,
`docs/MASTER_PLAN.md:1-5`.

**FACT:** The repository is a monorepo with two deployable services, one
database workspace and one contract directory.

| Area | Path | What it is |
|---|---|---|
| Node API | `apps/api/` | Node HTTP API, ESM, Cloud Run service `dua-api` |
| Python engine | `apps/ai-engine/` | Flask plus Google ADK, Cloud Run service `dua-ai-engine` |
| Database | `supabase/` | Supabase CLI workspace and 25 SQL migrations |
| Contracts | `packages/contracts/` | One file, `KILL_SWITCHES.md` |

Sources: `README.md:149-153` (the stack table), `apps/api/package.json:1-21`,
`apps/ai-engine/requirements.txt:1-6`, `docs/MASTER_PLAN.md:3-4`,
`ls supabase/migrations` returns 25 files, `ls packages/contracts` returns
1 file.

**FACT:** The Node API is a bare `node:http` server, not Express and not
Fastify. Source: `apps/api/src/server/server.mjs:1` imports `createServer`
from `node:http`, and `:5` imports `handleService` from
`./service-handler.mjs`.

**FACT:** The Python engine is Flask. Source:
`apps/ai-engine/requirements.txt:1` pins `Flask==3.1.3`, and
`API_CONTRACT.md:5` states "The engine is Flask".

**FACT:** Neither process serves a website. Source: `API_CONTRACT.md:5`
("Neither serves a website").

**FACT:** The engine is served by `gunicorn` behind `apps/ai-engine/wsgi.py`
in production. Source: `apps/ai-engine/wsgi.py` exists (578 bytes),
`apps/ai-engine/requirements.txt:2` pins `gunicorn==22.0.0`,
`API_CONTRACT.md:522` states "behind `wsgi.py` in production".

**What is NOT in this repository:**

- **FACT:** No Android code. Source: `.github/dependabot.yml:2` ("Android and
  website ecosystems stay in their own repositories"). Confirm with
  `ls -d apps/android` returning "No such file or directory".
- **FACT:** No website frontend. Same source.
- **FACT:** No `CONTRIBUTING.md`. Source: `ls CONTRIBUTING.md` returns
  "No such file or directory".
- **FACT:** No lint, format or typecheck configuration of any kind. Source:
  `README.md:156` ("No formatter, linter, type checker or separate build step
  is configured in this repository yet"), and `ls` finds no `eslint.config.*`,
  `.eslintrc*`, `.prettierrc*`, `pyproject.toml`, `setup.cfg`, `.flake8`,
  `ruff.toml` or `.editorconfig` at the root.

**FACT:** `apps/android/` is referenced by `.gitattributes:21-22` but the
directory does not exist. This is a stale reference, documented here so the
next reader does not go looking for it.

---

## 2. Tech stack and exact versions

### Node API

| Item | Value | Source |
|---|---|---|
| Node version file | `24` | `.nvmrc:1` |
| Node engine floor | `>=24.0.0` | `apps/api/package.json:14-16` |
| CI Node version | `'24'` | `.github/workflows/checks.yml:72` |
| Module system | ESM (`"type": "module"`) | `apps/api/package.json:4` |
| Package name | `dua-chat` | `apps/api/package.json:2` |
| Runtime dependencies | `unpdf@2.1.0`, `cfb@1.2.2` | `apps/api/package.json:17-20` |
| Test runner | `node --test` | `apps/api/package.json:10` |

**FACT:** The Node API has exactly two runtime dependencies. Everything else
comes from Node built-ins. Source: `apps/api/package.json:17-20`.

**FACT:** There is no `devDependencies` block. Source:
`apps/api/package.json:1-21` ends after `dependencies`.

### Python engine

Two requirement files disagree on the ADK version. Read both before trusting
either.

| Item | Declared range | Locked value | Source |
|---|---|---|---|
| Flask | `3.1.3` | `3.1.3` | `apps/ai-engine/requirements.txt:1`, `apps/ai-engine/requirements-lock.txt:18` |
| gunicorn | `22.0.0` | `22.0.0` | `apps/ai-engine/requirements.txt:2`, `apps/ai-engine/requirements-lock.txt:24` |
| google-genai | `>=2.30.1,<3` | `2.31.0` | `apps/ai-engine/requirements.txt:3`, `apps/ai-engine/requirements-lock.txt:21` |
| google-adk | `2.12.0` | `2.14.1` | `apps/ai-engine/requirements.txt:4`, `apps/ai-engine/requirements-lock.txt:19` |
| sqlalchemy | `>=2.0.40,<2.1` | `2.0.55` | `apps/ai-engine/requirements.txt:5`, `apps/ai-engine/requirements-lock.txt:54` |
| pgvector | `>=0.4,<1` | `0.5.1` | `apps/ai-engine/requirements.txt:6`, `apps/ai-engine/requirements-lock.txt:39` |

**FACT:** `apps/ai-engine/requirements.txt:4` pins `google-adk==2.12.0` while
`apps/ai-engine/requirements-lock.txt:19` pins `google-adk==2.14.1`. These are different
versions and neither file is a subset of the other.

**FACT:** CI does not install `apps/ai-engine/requirements.txt` for the second engine run. It
installs `apps/ai-engine/requirements-adapters-lock.txt`, whose header at
`apps/ai-engine/requirements-adapters-lock.txt:1-2` reads "Verified Python 3.12/Linux
dependency closure, 2026-11-18" and "Official ADK 2.14.1". Source:
`.github/workflows/checks.yml:42`.

**FACT:** Therefore CI tests ADK `2.14.1`, not the `2.12.0` declared in
`requirements.txt`. This is a real drift, not a formatting difference.

**FACT:** Python is not version-pinned in any repo file. `.nvmrc` pins Node
only. `ASSUMPTION:` CI uses whatever `python3` Ubuntu `ubuntu-latest` ships,
because `.github/workflows/checks.yml:35` and `:41` call `python3 -m venv`
with no version selector. The lock file header claims 3.12 but no workflow
line enforces it.

### Database

**FACT:** Supabase Postgres with `pgvector`. Source:
`.github/workflows/checks.yml:23` pins the CI service image to
`pgvector/pgvector:pg17@sha256:ac08538c...`.

**FACT:** Migrations are 25 timestamp-prefixed SQL files in
`supabase/migrations/`. Source: `find supabase -name "*.sql" | wc -l`
returns 25. Naming follows a 12-digit prefix, for example
`202610040001_dua_cloud.sql` and `202611270001_dua_task_lifecycle_workers.sql`.
`docs/MASTER_PLAN.md:58` states the convention as
`202611190001_<name>.sql` in `supabase/migrations/`.

**FACT:** The newest migration is `202611270001_dua_task_lifecycle_workers.sql`.
Source: `ls supabase/migrations | tail -1`.

### CI

| Job | Runner | Timeout | What it runs | Source |
|---|---|---|---|---|
| `google-cloud` | `ubuntu-latest` | 15 min | pytest on `apps/ai-engine/tests` twice | `.github/workflows/checks.yml:17-59` |
| `backend` | `ubuntu-latest` | 10 min | `npm ci` then `npm run test:ci` in `apps/api` | `.github/workflows/checks.yml:61-87` |

**FACT:** The workflow is named `Project checks`. Source:
`.github/workflows/checks.yml:1`.

**FACT:** CI triggers on `pull_request`, on `push` to `main`, and on
`workflow_dispatch`. Source: `.github/workflows/checks.yml:3-7`.

**FACT:** CI holds `permissions: contents: read` only. Source:
`.github/workflows/checks.yml:9-10`.

**FACT:** CI cancels in-progress runs for the same ref. Source:
`.github/workflows/checks.yml:12-14`.

**FACT:** The first engine run installs `Flask==3.1.3` and `pytest==8.3.5`
explicitly, with mocked Vertex. Source: `.github/workflows/checks.yml:36-38`.

**FACT:** The second engine run installs `apps/ai-engine/requirements-adapters-lock.txt`
plus `pytest==8.3.5`, with the real ADK SDK and `ADK_TEST_POSTGRES_URL`
pointing at the CI Postgres service. Source:
`.github/workflows/checks.yml:42-48`.

**FACT:** On failure, both jobs upload JUnit XML as an artifact retained
3 days. Source: `.github/workflows/checks.yml:49-59` and `:79-87`.

**FACT:** Actions are pinned by commit SHA, not by tag. Source:
`.github/workflows/checks.yml:32` (`actions/checkout@3d3c42e5...`), `:52`
(`actions/upload-artifact@cf430e03...`).

---

## 3. Build and test commands

Run from the repository root unless a step says otherwise.

### Node API

```bash
cd apps/api
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run test:ci
npm start
```

Sources: `apps/api/package.json:5-13`, and CI uses the same forms at
`.github/workflows/checks.yml:76-78`.

**FACT:** There is no build step. The API runs straight from source. Source:
`apps/api/package.json:5-13` has no `build` script, and `README.md:156` says
"no separate build step".

**FACT:** `npm test` runs `node --test "test/**/*.test.mjs"`. Source:
`apps/api/package.json:10`.

**FACT:** `npm run test:ci` runs the same glob but adds a `junit` reporter
writing `backend-test-results.xml`. Source: `apps/api/package.json:11`.

**FACT:** `npm start` runs
`node --env-file-if-exists=.env src/server/server.mjs`. Source:
`apps/api/package.json:6`.

**FACT:** Four worker scripts exist: `worker:workflows`, `worker:provision`,
`worker:revoke`, and they run `src/core/workflow-runtime.mjs`,
`src/core/workflow-identity.mjs provision`, `src/core/workflow-identity.mjs
revoke` respectively. Source: `apps/api/package.json:7-9`.

### Python engine

```bash
python -m pytest -q apps/ai-engine/tests
```

Source: `README.md:152` gives this exact form from the repository root.

**FACT:** 60 Node test files and 41 Python test files exist. Source:
`ls apps/api/test/*.test.mjs | wc -l` returns 60,
`ls apps/ai-engine/tests/test_*.py | wc -l` returns 41.

**FACT:** A local engine run needs a venv with `requirements.txt` installed.
`ASSUMPTION:` installing `requirements.txt` and running the suite locally will
behave like CI, but CI never installs that file, so this is not proven by CI.

### Database

```bash
cd apps/api && npm run verify:rls
```

**FACT:** This runs `node scripts/verify-rls.mjs`. Source:
`apps/api/package.json:12`.

**FACT:** Running this needs live Supabase credentials, so it does not run in
CI. Source: `.github/workflows/checks.yml` has no step invoking `verify:rls`.

### What CI does not check

**FACT:** No workflow runs a formatter, linter, type checker, secret scanner
or dependency audit. Source: `.github/workflows/checks.yml:31-87` contains
only checkout, venv setup, pip install, pytest, npm ci, npm run test:ci and
artifact upload.

**FACT:** Dependabot covers npm in `/apps/api` and GitHub Actions only. Python
requirements are not covered. Source: `.github/dependabot.yml:7-38`,
`SECURITY.md:27`.

---

## 4. What must never be committed

**FACT:** `.gitignore` already blocks these paths. Source: `.gitignore:1-12`.

| Pattern | Why | Source |
|---|---|---|
| `node_modules/` | dependency tree | `.gitignore:1` |
| `__pycache__/`, `*.pyc`, `.pytest_cache/` | Python bytecode and cache | `.gitignore:2`, `:8`, `:9` |
| `.venv/`, `venv/` | local virtualenv | `.gitignore:3-4` |
| `.env`, `.env.*` | real secrets | `.gitignore:5-6` |
| `.idea/` | IDE state | `.gitignore:10` |
| `supabase/.temp`, `supabase/.branches` | local Supabase CLI state | `.gitignore:11-12` |

**FACT:** `.env.example` is explicitly re-included by `.gitignore:7`
(`!.env.example`), so the example file is tracked on purpose and must stay
tracked.

**FACT:** The example file declares 41 keys. Source:
`grep -c "^[A-Z_]*=" .env.example` returns 41. Six of them carry a
non-secret default value (`PORT`, `DUA_CHAT_DEADLINE_SECONDS`,
`DUA_FILES_BUCKET`, `VERTEX_LOCATION`, `VERTEX_MODEL`,
`VERTEX_THINKING_LEVEL`); the other 35 are empty. Source:
`grep "^[A-Z_]*=" .env.example | grep -vc "=$"` returns 6.

**FACT:** Those keys include credentials for
`SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GROK_API_KEY`, `KIMI_API_KEY`,
`BRAVE_SEARCH_API_KEY`, `ELEVENLABS_API_KEY`, `GITHUB_TOKEN`,
`GITHUB_BUILD_WRITE_TOKEN` and `OPENROUTER_API_KEY`. Source:
`.env.example:25-53`.

**FACT:** `.env.example:44` declares `GITHUB_TOKEN`. Any change that prints
this variable in a log or an error message is a leak.

**FACT:** Per-app examples also exist at `apps/api/.env.example` and
`apps/ai-engine/.env.example`. Source: `ls` confirms both files.

**FACT:** Production secrets belong in GitHub Actions Secrets, Google Cloud
Secret Manager or Supabase Vault, never in the repo. Source:
`SECURITY.md:19-24`.

**FACT:** The service-role key is never sent to a client, and user tables are
reached with the user JWT plus the anon key so RLS decides access. Source:
`docs/MASTER_PLAN.md:38-42`.

**FACT:** `verify-rls.mjs` lists the tables expected to be RLS-protected,
including `dua_orhan_tasks`, `dua_artifacts`, `dua_memories`. Source:
`apps/api/scripts/verify-rls.mjs:9`.

**Rule:** Before any commit, run both commands and read every line:

```bash
git status --short
git diff --cached
```

Confirm no `.env`, no key, no token, no service-role key and no customer data
appears. This is the precondition for section 6.5.

---

## 5. Branch naming and PR rules

**FACT:** Changes are made on a separate branch or pull request before
merging. Source: `README.md:47` ("Changes should be made on a separate branch
or pull request before merging").

**FACT:** The merge commit at the tip of `main` follows a `feat/<topic>`
branch convention. Source: `git log -1` shows
"Merge pull request #48 from KRFbrothers/feat/phase3-task-lifecycle-observability".

**FACT:** Branch protection, required reviews and required status checks are
GitHub-hosted settings, not files in this repo. Source: `SECURITY.md:30-32`
("Branch protection, required reviews/checks and force-push rules are
GitHub-hosted settings and must be verified by a repository administrator").

**FACT:** The status check to wait for is named `Project checks`. Source:
`SECURITY.md:31`, `.github/workflows/checks.yml:1`.

**FACT:** Both CI jobs must pass. The job names are `Google Cloud engine
tests` and `Backend tests`. Source: `.github/workflows/checks.yml:18`, `:62`.

**Rule:** branch as `feat/<kebab-topic>`, `fix/<kebab-topic>` or
`docs/<kebab-topic>`, opened as a PR against `main`, with `Project checks`
green before merge. The branch prefixes `feat/` and `fix/` are observed in
history. The `docs/` prefix is `ASSUMPTION:` a reasonable extension, not
observed in this repo's history.

**Rule:** Keep the PR to one concern. This repo archives instead of deleting
(section 6.7), so a PR that moves files is reviewed differently from a PR
that changes behaviour, and mixing both hides the move.

**FACT:** Dependabot opens weekly PRs for npm in `/apps/api` and for GitHub
Actions, with commit prefixes `chore(deps)` and `chore(ci)`. Source:
`.github/dependabot.yml:7-38`.

**FACT:** Merging to `main` does not deploy. Deploys are manual and need
owner approval. Source: `README.md:156` ("Deploys are manual and need owner
approval").

---

## 6. Rules for an agent working in this repo

### 6.1 Read-only by default

Start read-only. Do not write, move, rename or delete anything until the task
explicitly asks for a change. When it does ask, make the smallest safe change
that satisfies it. Source: `AGENTS.md` Change Workflow, preserved from the
pre-rewrite file at its lines 26-35.

### 6.2 Every claim needs a file and line

Every factual statement about the code states the path and the line. If a
thing is not in the code, write `Not found in code` instead of inferring it
from a filename. Example of the standard this file holds itself to:
`apps/api/package.json:14-16` for the Node floor, not "package.json probably
requires Node 24".

### 6.3 FACT and ASSUMPTION are separate lines

Label each statement. Never present an assumption as a fact. Source:
`AGENTS.md` (pre-rewrite) line 22 ("Never invent behavior, configuration,
credentials, test results or implementation details").

### 6.4 One phase, then stop

Do one phase of work, report it, and stop for review. Do not chain phases
without being asked. State what you did not do.

### 6.5 Secret scan before any push

Run the two commands in section 4 and read the output before every push. If a
secret is already committed, do not try to remove it locally: report it,
because the secret must be rotated.

### 6.6 Maximum 3 self-heal attempts

If a command fails, retry with a fix at most 3 times. After the third failure,
stop and report the exact command, the exact error text, and what you changed
between attempts. Do not loop and do not reword the failure.

### 6.7 Do not delete, archive instead

**FACT:** Never permanently delete a file, folder or code without explicit
approval. Move inactive code to `archive/` instead. Source: `AGENTS.md`
(pre-rewrite) lines 14 and 18.

**FACT:** Before archiving, check imports, route registration, tests, build
config, deployment config and documentation. Source: `AGENTS.md` (pre-rewrite)
lines 41-48.

**FACT:** Every archived item needs a note recording original path, new path,
date, reason, references checked and restoration notes. Source: `AGENTS.md`
(pre-rewrite) lines 50-57.

**FACT:** The `archive/` directory does not exist yet. Source: `ls -d archive`
returns "No such file or directory". The rule stands, but the first move into
`archive/` also creates the directory and its first note.

### 6.8 No duplicate implementations

**FACT:** Search for an existing equivalent before creating anything new. Do
not create duplicate files, folders, routes, services or implementations.
Source: `AGENTS.md` (pre-rewrite) lines 16-17.

**FACT:** This has a live example. `docs/MASTER_PLAN.md:43-47` records that
the Node skill list duplicate in `apps/api/src/server/service-handler.mjs` is
scheduled for removal because
`apps/ai-engine/dua_engine/agent/dua_agent_prompts.json` is the single source
of truth for the five starter skills.

### 6.9 Preserve public APIs

**FACT:** Do not change an existing public API unless the task explicitly
requires a breaking change. Source: `AGENTS.md` (pre-rewrite) line 21.

**FACT:** `API_CONTRACT.md:420` states the legacy `/api/orhan/*` route names
and the `dua_orhan_tasks` table are kept for Android compatibility. Renaming
them is a breaking change.

### 6.10 Product naming

**FACT:** Use `Dua Gen AI` for the platform, `Dua` for chat and the control
plane, `Dua Work` for execution and coding. Source: `AGENTS.md` (pre-rewrite)
lines 65-67.

**FACT:** `Orhan` is a legacy internal name kept in routes, tables and files
for compatibility, for example `/api/orhan/*` and `dua_orhan_tasks`. Do not
use it in new user-facing text. Source: `AGENTS.md` (pre-rewrite) line 69,
`README.md:60`, `API_CONTRACT.md:418-420`, `apps/api/src/core/orhan-tasks.mjs:1`,
`supabase/migrations/202611090001_dua_orhan_tasks.sql`.

### 6.11 Two agents are pinned and protected

**FACT:** Exactly two agents are official and pinned: `personal-agent`
("Personal Agent", mode `auto`) and `dua-agent` ("Dua Agent", mode `agent`).
Both are protected from deletion. Source: `docs/MASTER_PLAN.md:13-17`.

**FACT:** Skills are not agents. The five starter skills are
`frontend-developer`, `backend-architect`, `api-tester`, `devops-automator`,
`code-reviewer`. Source: `docs/MASTER_PLAN.md:18-20`.

**Rule:** Never treat a skill as an agent or add a third pinned agent without
an owner decision recorded in `docs/MASTER_PLAN.md`.

### 6.12 Owner lock fails closed

**FACT:** In production the API refuses to start without one valid owner
email in `DUA_ALLOWED_EMAIL`, and access fails closed with 503 rather than
allowing open access. Source: `docs/MASTER_PLAN.md:10-12`.

**Rule:** Never make the owner check optional to get a test passing.

### 6.13 Status values must stay in sync with the migration

**FACT:** The stored `status` keeps the legacy values for existing clients.
`LIFECYCLE` maps `waiting` to `queued`, `approval_needed` to `running` and
`cancelled` to `stopped`. Source:
`apps/api/src/core/orhan-tasks.mjs:14`.

**FACT:** The API maps status plus `end_reason` into
`queued`/`running`/`completed`/`failed`/`stopped`/`timed_out`. Source:
`supabase/migrations/202611250001_dua_orhan_tasks_lifecycle.sql:3`.

**Rule:** Adding a status means changing the mapping, the migration comment,
this section and the `## Task Requirements` list below. All four in one PR.

### 6.14 Do not run a check you cannot run

**FACT:** This repo has no linter, formatter or type checker. Source:
`README.md:156`. Do not write "lint passed" in a report.

**Rule:** If a tool is missing in your environment, say so and name what you
could not run, instead of implying it passed.

---

## Initial Control-Plane Actions

The first stable actions are:

- `direct_reply`
- `create_task`
- `get_task_status`
- `stop_task`

**FACT:** Each action maps to an existing route. Source:
`apps/api/test/agents-md.test.mjs:12-17` asserts this exact mapping, and
`README.md:60` states the actions map onto existing `dua-api` routes.

| Action | Route | Handler source |
|---|---|---|
| `direct_reply` | `POST /api/chat` | `apps/api/src/server/service-handler.mjs` |
| `create_task` | `POST /api/orhan/tasks` | `apps/api/src/server/service-handler.mjs:76` |
| `get_task_status` | `GET /api/orhan/tasks/:id` | `apps/api/src/server/service-handler.mjs:76` |
| `stop_task` | `POST /api/orhan/tasks/:id/cancel` | `apps/api/src/server/service-handler.mjs:76` |

**FACT:** `apps/api/src/server/service-handler.mjs:76` routes every
`/api/orhan/tasks*` request to `handleOrhanTasks`. Source:
`apps/api/src/server/service-handler.mjs:76`.

**FACT:** `handleOrhanTasks` accepts only `start`, `continue`, `cancel`,
`retry` and `events` as the fifth path segment, and validates the task id
against a UUID pattern. Source: `apps/api/src/core/orhan-tasks.mjs:31-33`.

**FACT:** One running task per owner. Source: `API_CONTRACT.md:420`
("One running task"), and the in-flight lock at
`apps/api/src/core/orhan-tasks.mjs:57-58`.

**FACT:** Tasks are capped at 12 steps and 10 minutes. Source:
`apps/api/src/core/orhan-tasks.mjs:8-11` (`MAX_STEPS = 12`,
`MAX_MINUTES = 10`), `API_CONTRACT.md:420`.

**FACT:** The plan order is research, then checker, then writer. Source:
`apps/api/src/core/orhan-tasks.mjs:22-27` (`AGENTS` and `EXPECTED`).

Each action must have clear validation, authorization, error handling and
tests.

---

## Task Requirements

Every task should have:

- A unique task ID
- A clear status
- Creation time and update time
- Input or request metadata
- Result or artifact reference when completed
- Error information when failed
- Cancellation or stop information when stopped
- Timeout handling where applicable

**FACT:** The stored task row carries these columns: `task_id`, `title`,
`prompt`, `status`, `plan`, `steps`, `artifact`, `error`, `run_count`,
`started_at_ms`, `created_at_ms`, `updated_at_ms`, `end_reason`,
`finished_at_ms`, `stopped_at_ms`, `parent_task_id`, `root_task_id`,
`continue_thread_id`, `attempt`, `idempotency_key`. Source:
`apps/api/src/core/orhan-tasks.mjs:12`.

**FACT:** `idempotency_key` exists, so duplicate requests can be deduplicated.
Source: `apps/api/src/core/orhan-tasks.mjs:12`, and the `DUPLICATE` symbol at
`:17`.

Recommended statuses:

- `queued`
- `running`
- `completed`
- `failed`
- `stopped`
- `timed_out`

**FACT:** All six are real, not aspirational. Source:
`apps/api/test/agents-md.test.mjs:18` asserts this list,
`apps/api/src/core/orhan-tasks.mjs:14` maps the stored values, and
`supabase/migrations/202611250001_dua_orhan_tasks_lifecycle.sql:3` names the
API-facing set including `timed_out`.

---

## 7. Cross-repo rules

**FACT:** The Android client is `KRFbrothers/teamily-android-ui`. It is not in
this repo. Source: `.github/dependabot.yml:2`.

**FACT:** `API_CONTRACT.md` at this repo's root is the single source of truth
for every request and response shape the Android app depends on. Source:
`API_CONTRACT.md:1-5`, `README.md:161`
("public HTTP API of `dua-api` and `dua-ai-engine`"), and
`docs/MASTER_PLAN.md:5-6` ("API_CONTRACT.md and SUPABASE.md stay the source of
truth for shipped behaviour").

**FACT:** `API_CONTRACT.md` is 43 KB and is the largest document in the repo
after `LICENSE`. Source: `ls -l API_CONTRACT.md` returns 43768 bytes.

**FACT:** Both processes are reached separately by the client, through
`API_BASE_URL` for the Node API and `ENGINE_BASE_URL` for the Python engine.
Source: `API_CONTRACT.md:3`, `.env.example:4-8`.

**FACT:** `POST /api/chat` exists on both processes and they are different
handlers. Source: `API_CONTRACT.md` section "Chat" under "Python engine" at
line 543, and the Node section at line 100.

**FACT:** The Android client sends no `Origin` header and uses
`X-Dua-Native` to signal a native client, and `DUA_APP_TOKEN` is an optional
extra gate requiring `X-Dua-App-Token`. Source: `API_CONTRACT.md:11` and
`:20`, `.env.example:11-15`.

**Rules:**

1. **Contract first.** Any endpoint change updates `API_CONTRACT.md` in the
   same PR, before or with the code. Never change a shape and leave the
   contract stale. This is enforced in spirit by
   `apps/api/test/agents-md.test.mjs:30-35`, which asserts `README.md` and
   `API_CONTRACT.md` both keep the control-plane route table.
2. **Never silently rename a legacy path.** `/api/orhan/*` and
   `dua_orhan_tasks` are kept for Android compatibility. Source:
   `API_CONTRACT.md:420`.
3. **Do not change the meaning of `X-Dua-Native`, the `Origin` check or the
   `dua_refresh` cookie** without a coordinated change to the contract and the
   Android repo.
4. **A change to `POST /api/chat` on either process is a cross-repo change.**
   Check both, and update the contract.
5. **A change to task status values or the route table is a cross-repo
   change.** The Android client renders those values.

---

## 8. This file is tested by CI

**FACT:** `apps/api/test/agents-md.test.mjs` reads `AGENTS.md` and asserts it
still contains the `docs/MASTER_PLAN.md` link, the
`## Initial Control-Plane Actions` heading, all four action bullets, the
`## Task Requirements` heading and all six status bullets. Source:
`apps/api/test/agents-md.test.mjs:22-28`.

**FACT:** Because `npm run test:ci` runs that file in the `backend` CI job, an
`AGENTS.md` edit that drops one of those strings fails the pull request.
Source: `apps/api/test/agents-md.test.mjs:37-41`,
`apps/api/package.json:11`, `.github/workflows/checks.yml:78`.

**Rule:** When editing this file, keep these exact strings intact:

- the markdown link [`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md)
- the heading `## Initial Control-Plane Actions`
- the bullets `- \`direct_reply\``, `- \`create_task\``,
  `- \`get_task_status\``, `- \`stop_task\``
- the heading `## Task Requirements`
- the bullets `- \`queued\``, `- \`running\``, `- \`completed\``,
  `- \`failed\``, `- \`stopped\``, `- \`timed_out\``

---

## 9. Definition of done

A change is complete only when:

- The requested behavior is implemented.
- Existing code was reused where appropriate.
- No duplicate implementation was introduced.
- No unrelated files were changed.
- Imports and references are valid.
- Relevant tests were run, and no lint or typecheck is claimed because none
  exists (`README.md:156`).
- Documentation is updated when needed, including `API_CONTRACT.md` for any
  shape change.
- The final diff was reviewed for secrets and for accidental changes.
- Any remaining limitation is clearly reported, naming what could not be run.

Source for the original list: `AGENTS.md` (pre-rewrite) lines 137-147.

---

## 10. Open items

These are recorded so the next agent does not re-derive them.

1. **FACT:** `google-adk` is `2.12.0` in `apps/ai-engine/requirements.txt:4` and `2.14.1` in
   `apps/ai-engine/requirements-lock.txt:19`. CI tests the lock. One of the two files is
   stale.
2. **FACT:** `apps/android/` is referenced by `.gitattributes:21-22` but does
   not exist.
3. **FACT:** `archive/` is described by three rules but does not exist.
4. **FACT:** `packages/contracts/` contains one file, `KILL_SWITCHES.md`, so
   the directory name overstates its contents. Source:
   `ls packages/contracts`.
5. **FACT:** No formatter, linter or type checker exists for either language.
   Source: `README.md:156`.
6. **ASSUMPTION:** `python3` on the CI runner is 3.12, based on the lock file
   header at `apps/ai-engine/requirements-adapters-lock.txt:1`. No workflow line pins it.
