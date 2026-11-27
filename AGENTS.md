This repository contains **Dua Gen AI**, consisting of:

- **Dua** — fast chat, planning, intent detection, memory, task creation and task control.
- **Dua Work** — coding, file operations, tests, execution, logs and task artifacts.

The existing `dua-backend` is the source code being upgraded. This is an upgrade of the existing backend, not a clean-slate replacement.

## Project Docs

- [`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md) — approved backend roadmap and owner decisions.

## Core Rules

1. Do not permanently delete any existing file, folder or code without explicit approval.
2. Edit, refactor and improve the existing implementation wherever possible.
3. Do not create duplicate files, folders, routes, services or implementations.
4. Before creating anything new, search the repository for an existing equivalent.
5. If an existing file or folder is no longer active or needed, move it to `archive/` instead of deleting it.
6. Do not move anything to `archive/` until its imports, routes, tests, scripts and deployment references have been checked.
7. Do not change unrelated code or expand the scope of a task.
8. Preserve existing public APIs unless the task explicitly requires a breaking change.
9. Never invent behavior, configuration, credentials, test results or implementation details.

## Change Workflow

1. Inspect the repository structure and relevant files first.
2. Read the applicable documentation and existing code before editing.
3. Identify current routes, services, models, workers, tests and configuration.
4. Make the smallest safe change that satisfies the requirement.
5. Reuse existing utilities, types, services and patterns.
6. Update imports and references when files are moved or renamed.
7. Update documentation when behavior, setup or API contracts change.
8. Run the relevant formatter, linter, type checker, build and tests.
9. Review the final diff for accidental changes, duplicates and secrets.
10. Report exactly what changed, what was tested and what could not be tested.

## Archive Rules

The `archive/` directory is for inactive code that must be preserved for review or possible restoration.

Before moving an item to `archive/`:

- Search for imports and references.
- Check route registration and startup code.
- Check test and build configuration.
- Check deployment and CI/CD configuration.
- Check documentation and scripts.
- Confirm that no active code depends on it.

For every archived item, add or update an archive note containing:

- Original path
- New archive path
- Date of move
- Reason for move
- References checked
- Restoration notes

Archived code must not be imported by active production code.

## Product Naming

Use these names consistently:

- `Dua Gen AI` — complete product/platform
- `Dua` — chat and control-plane experience
- `Dua Work` — execution and coding experience

`Orhan` is the legacy internal name kept in routes, tables and files for compatibility (for example `/api/orhan/*` and `dua_orhan_tasks`); do not use it in new user-facing text.

Do not introduce mixed or obsolete product names in new code or documentation.

## Initial Control-Plane Actions

The first stable actions are:

- `direct_reply`
- `create_task`
- `get_task_status`
- `stop_task`

Each action must have clear validation, authorization, error handling and tests.

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

Recommended statuses:

- `queued`
- `running`
- `completed`
- `failed`
- `stopped`
- `timed_out`

## API and Backend Safety

- Validate all external input.
- Authenticate and authorize protected operations.
- Do not expose secrets in logs or responses.
- Use consistent error responses.
- Make task operations idempotent where practical.
- Prevent unauthorized task access.
- Apply timeouts and resource limits to execution work.
- Keep execution work isolated from the chat/control plane.
- Never give `Dua Work` execution workers `SUPABASE_SERVICE_ROLE_KEY` or unrestricted database/server access; use scoped task tokens only.
- Define every execution tool through a Tool Registry with explicit input/output schema, permission level, timeout, and network policy.
- Use a Context Packer when passing context from `Dua` (control plane) to `Dua Work` (execution plane) instead of dumping full raw conversation history.

## Testing Requirements

At minimum, test:

- Direct replies
- Task creation
- Task status retrieval
- Task stopping
- Invalid input
- Unauthorized access
- Missing task IDs
- Duplicate requests
- Failed tasks
- Timed-out tasks
- Existing behavior that must remain unchanged

Do not claim tests passed unless they were actually run.

## Definition of Done

A change is complete only when:

- The requested behavior is implemented.
- Existing code was reused where appropriate.
- No duplicate implementation was introduced.
- No unrelated files were changed.
- Imports and references are valid.
- Relevant tests, lint, type checks and build were run.
- Documentation is updated when needed.
- The final diff was reviewed.
- Any remaining limitation is clearly reported.