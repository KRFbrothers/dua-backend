# Contributing to dua-backend

How a human works in this repository. The rules for an AI agent are in [`AGENTS.md`](AGENTS.md);
this file is the human workflow around them. Where the two overlap, `AGENTS.md` wins.

Read [`AGENTS.md`](AGENTS.md) first. It is short and it is enforced by a test.

---

## 1. Before you start

| You want to | Read |
|---|---|
| Understand the system | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Know what is planned and in what order | [`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md) |
| Change an HTTP shape | [`API_CONTRACT.md`](API_CONTRACT.md) |
| Change the database | [`SUPABASE.md`](SUPABASE.md) |
| Know what the last audit found | [`docs/audits/`](docs/audits/) |

If your change is not in `MASTER_PLAN.md` and it is not a bug fix, get an owner decision recorded
there before you write code. A decision in chat is not a decision.

---

## 2. Setup

```bash
cd apps/api
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

```bash
# from the repository root
python -m pytest -q apps/ai-engine/tests
```

Node floor is 24 (`.nvmrc`, `engines` in `apps/api/package.json`). The only runtime dependencies are
`unpdf` and `cfb`.

There is no build step, no linter, no formatter and no type checker. Do not write "lint passed" in a
pull request, because there is nothing to pass.

---

## 3. Branch and commit

- Branch off `main`. Never commit to `main`.
- One branch, one job. A doc fix and a behaviour change are two branches.
- Commit message: a short imperative subject, then a body that says why. One commit, one change.
- Before every push run `git status --short` and `git diff --cached` and read every line. A committed
  secret is reported and rotated, never scrubbed locally.

---

## 4. What CI runs

`.github/workflows/checks.yml` runs on every pull request and on push to `main`:

| Job | Command |
|---|---|
| `google-cloud` | `pytest` on `apps/ai-engine/tests`, mocked and then with the real ADK SDK |
| `backend` | `npm run test:ci` in `apps/api` |

`.github/workflows/duplicate-files.yml` runs on the same triggers and fails when the same fact gets a
second home: a file name that appears twice, two byte-identical files, a second doc claiming a topic
that already has a canonical file, or two `.md` files that are mostly the same lines. Run it locally
with `node scripts/check-duplicate-files.mjs` (`--verbose` shows the allowlisted cases and why each
one is allowed).

Two checks are manual and never run in CI, because both need a live Supabase project:

```bash
cd apps/api
npm run verify:rls          # anonymous smoke check, never writes a row
npm run verify:rls:cross    # cross-tenant check, writes real rows, opt-in
```

`verify:rls:cross` needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`DUA_RLS_TEST=1` and `DUA_RLS_TEST_PROJECT`. It refuses to run against a project whose host does not
match, and it refuses to run when `DUA_ALLOWED_EMAIL` is set. It deletes its two test users in a
`finally` block, which cascades to every row they wrote.

---

## 5. Database changes

- Migrations are immutable. Never edit a file in `supabase/migrations/` that is already merged.
- A change is a new numbered file in `supabase/migrations/`, plus a rollback file in `supabase/rollbacks/`.
  `supabase db push` applies every `.sql` file in `supabase/migrations/`, so a rollback must not sit there.
- `supabase db push` needs an explicit owner yes, every time.
- A new table needs `enable row level security`, an owner-scoped policy for each verb it allows, and
  a line in `SUPABASE.md`.
- If you add a table, add it to `DEFAULT_TABLES` in `apps/api/scripts/verify-rls.mjs`. A test fails
  if that list drifts from the migrations.

---

## 6. Pull request

A pull request carries:

1. What changed and why, in 3 to 6 lines.
2. What you ran, and the result.
3. What you could not run, and why.
4. The risk, in one line.

Review looks for:

- The smallest change that does the job. No drive-by refactor.
- An existing file edited, not a second file with the same job.
- A doc updated in the same pull request as the code it describes.
- No weakened test, no deleted assertion, no `@Ignore`.
- No secret, no `.env`, no service-role key.
- `AGENTS.md` and `apps/api/test/agents-md.test.mjs` updated together if either changed.

---

## 7. Merging and deploying

Three actions need an explicit owner yes, every time, in the pull request thread:

1. Merge to `main`.
2. `supabase db push`.
3. A Cloud Run deploy of `dua-api` or `dua-ai-engine`.

Deploys are manual. There is no deploy workflow.

---

## 8. Where a fact lives

One home per fact. If you need it elsewhere, link it.

| Fact | Home |
|---|---|
| HTTP shapes | `API_CONTRACT.md` |
| Database schema | `supabase/migrations/` |
| Approved roadmap | `docs/MASTER_PLAN.md` |
| Architecture | `docs/ARCHITECTURE.md` |
| AI and human rules | `AGENTS.md` |
| Audit findings | `docs/audits/<date>-<topic>.md` |
| Kill switches | `packages/contracts/KILL_SWITCHES.md` |

Do not add a second roadmap file, a second architecture file, or a second copy of a prompt JSON.
Versioning is git, not filenames: no `roadmap_v2.md`, no `*New.mjs`. Use `git log` and `git tag`.

---

## 9. License

GPL-3.0-or-later. See [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
