# Dua Gen AI

Dua Gen AI is an AI platform with two connected experiences:

- **Dua** — fast chat, planning and task control.
- **Dua Work** — coding, file operations, tests and execution.

This repository contains the existing `dua-backend`, which is being upgraded in place. The project does not use a clean-slate replacement backend.

## Product Structure

```text
Dua Gen AI
├── Dua
│   ├── chat
│   ├── intent detection
│   ├── memory
│   ├── task creation
│   ├── task status
│   └── task control
│
├── Dua Work
│   ├── coding tasks
│   ├── file operations
│   ├── test execution
│   ├── logs
│   └── artifacts and results
│
└── Shared Backend
    ├── authentication
    ├── authorization
    ├── task storage
    ├── queue or worker system
    ├── event handling
    └── artifact storage
```

## Upgrade Strategy

The existing backend is upgraded directly:

- Existing files and folders are edited or refactored.
- Existing services and utilities are reused.
- Duplicate files, folders, routes and implementations are not created.
- Unused code is moved to `archive/` instead of being permanently deleted.
- Imports, routes, tests, scripts and deployment references are updated after changes.
- Changes should be made on a separate branch or pull request before merging.

## Initial Scope

The first stable control-plane actions are:

1. `direct_reply`
2. `create_task`
3. `get_task_status`
4. `stop_task`

After these actions are reliable, the project can expand into execution workers, tools, files, browser operations, memory improvements and advanced agent workflows.

In this repository the actions map onto existing `dua-api` routes. Tasks are the existing Orhan tasks (`apps/api/src/core/orhan-tasks.mjs`, table `dua_orhan_tasks`). Request and response details are in [API_CONTRACT.md](API_CONTRACT.md#orhan-tasks).

| Action | Route | Notes |
|---|---|---|
| `direct_reply` | `POST /api/chat` | Dua chat reply; no task is created. |
| `create_task` | `POST /api/orhan/tasks` | Optional `requestId` (UUID) makes a repeated create return the same task. |
| `get_task_status` | `GET /api/orhan/tasks/:id` | Returns `lifecycleStatus`; the legacy `status` field is unchanged. |
| `stop_task` | `POST /api/orhan/tasks/:id/cancel` | Stopping an already stopped task returns it unchanged. |

All task routes need the signed-in owner's Bearer token, and a task that belongs to someone else is `404`.

## Task Lifecycle

A task should move through a predictable lifecycle:

```text
queued → running → completed
                 ├── failed
                 ├── stopped
                 └── timed_out
```

Every task should expose a unique ID, current status, timestamps, result or artifact information, and error details when applicable.

## Repository Rules

Before changing code:

1. Inspect the repository structure.
2. Read the relevant source files and documentation.
3. Search for existing implementations.
4. Identify all imports and references.
5. Define the smallest safe change.

After changing code:

1. Run formatting and lint checks.
2. Run type checks if available.
3. Run relevant unit and integration tests.
4. Run the build.
5. Review the final diff.
6. Document any limitation or untested area.

## Archive Policy

Nothing is permanently deleted without explicit approval.

When code is no longer active:

- Move it to `archive/`.
- Record its original path and reason for moving it.
- Check imports, routes, tests, scripts and deployment references.
- Ensure active production code does not import it.

The archive is preserved for review and possible restoration. It is not part of the active runtime.

## Security

- Validate external input.
- Protect private routes with authentication and authorization.
- Do not expose secrets in logs or API responses.
- Apply timeouts and resource limits to execution tasks.
- Prevent users from accessing tasks they do not own or control.
- Use consistent error responses.

## Development Principles

- Prefer small, reviewable changes.
- Preserve backward compatibility unless a breaking change is explicitly approved.
- Keep Dua and Dua Work responsibilities clear.
- Keep the control plane separate from execution work.
- Do not claim a feature or test is complete without evidence.
- Avoid scope creep.

## Definition of Done

A change is ready for review when:

- The requested behavior works.
- Existing code was reused where possible.
- No duplicate implementation was added.
- No unrelated behavior changed.
- Tests and checks were run.
- Documentation was updated where necessary.
- The diff was reviewed.
- Known limitations are clearly stated.

## Stack and Commands

| Path | What it is | Checks (same as CI, `.github/workflows/checks.yml`) |
|---|---|---|
| `apps/api/` | Node.js 24 HTTP API (`dua-api` on Cloud Run) | `cd apps/api && npm ci && npm test` |
| `apps/ai-engine/` | Python Flask/ADK engine (`dua-ai-engine` on Cloud Run) | `python -m pytest -q apps/ai-engine/tests` (from the repository root) |
| `supabase/` | Supabase CLI workspace and SQL migrations | see `SUPABASE.md`; never `db push` without owner approval |
| `packages/contracts/` | Shared kill-switch contract read by both services' tests | covered by the two test suites above |

No formatter, linter, type checker or separate build step is configured in this repository yet; the test suites above are the checks CI runs. Deploys are manual and need owner approval.

## Project Docs

- [`AGENTS.md`](AGENTS.md) — rules for agents working in this repository.
- [`API_CONTRACT.md`](API_CONTRACT.md) — public HTTP API of `dua-api` and `dua-ai-engine`.
- [`SUPABASE.md`](SUPABASE.md) — Supabase setup, migrations and data rules.
- [`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md) — approved backend roadmap and owner decisions.
- [`packages/contracts/KILL_SWITCHES.md`](packages/contracts/KILL_SWITCHES.md) — kill-switch contract.
- [`SECURITY.md`](SECURITY.md) — security policy.

## License

GPL-3.0-or-later. See [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
