# `apps/api/scripts`

Manual verification scripts. None of these run in CI, because each needs a live Supabase project.

| Script | npm script | Writes rows? | What it proves |
|---|---|---|---|
| `verify-rls.mjs` | `npm run verify:rls` | No | Anonymous access is denied or empty on every table |
| `verify-rls-cross-tenant.mjs` | `npm run verify:rls:cross` | Yes, then deletes them | One owner cannot read, update, delete or re-own another owner's row |
| `imagine-smoke.mjs` | none | No | The Imagine provider answers |

## `verify-rls.mjs`

An anonymous smoke check. It never signs in, so `auth.uid()` is never set and no
`owner_id = auth.uid()` policy is ever evaluated. It proves that an unauthenticated caller cannot
read or insert. It does not prove that one signed-in owner is isolated from another.

```bash
cd apps/api
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<publishable key> npm run verify:rls
```

Exit code 0 means every table denied or returned empty. Exit code 1 means a table answered.

## `verify-rls-cross-tenant.mjs`

The companion that closes the gap above. It creates two real users, signs both in, writes rows as A,
then tries to read, update, delete and re-own those rows as B. Every attempt must come back empty or
denied.

It writes real rows and creates real users, so it is opt-in and it refuses to run against a project
it was not told to touch.

### Environment

| Variable | Required | What it is |
|---|---|---|
| `SUPABASE_URL` | yes | Project root URL, no `/rest/v1`, no query string |
| `SUPABASE_ANON_KEY` | yes | Publishable or legacy anon key. Never a service-role key |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Used only to create and delete the two test users |
| `DUA_RLS_TEST` | yes | Must be exactly `1`. Without it the script skips |
| `DUA_RLS_TEST_PROJECT` | yes | The project ref this run is allowed to touch |

The script refuses to run when:

- `SUPABASE_URL` host does not start with `DUA_RLS_TEST_PROJECT`.
- `DUA_ALLOWED_EMAIL` is set, which marks a single-owner production project.
- `SUPABASE_URL` is not a bare project root.

### Run

```bash
cd apps/api
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_ANON_KEY=<publishable key> \
SUPABASE_SERVICE_ROLE_KEY=<service role key> \
DUA_RLS_TEST=1 \
DUA_RLS_TEST_PROJECT=<ref> \
npm run verify:rls:cross
```

### What it checks

| Check | Meaning |
|---|---|
| `C0 anon read` | No row is readable without a token. Indirect proof that RLS is on |
| `S1 A inserts own row` | The owner can write their own row |
| `S2 B reads A row` | B gets 0 rows |
| `S3 B updates A row` | B affects 0 rows |
| `S4 B deletes A row` | B affects 0 rows |
| `S5 B forges owner_id` | B's insert claiming A as owner is denied with 401 or 403 |
| `S6 B re-owns A row` | B cannot move A's row to itself |
| `Z1 A direct read` | A zero-policy table returns nothing on a direct read |
| `Z2 RPC returns own usage` | The usage RPC returns only the caller's numbers |
| `Z3 bucket is private` | The `dua-files` bucket has `public = false` |

Tables fall into four groups:

| Group | Tables | Checks |
|---|---|---|
| Owner-writable | 16 | S1 to S6 |
| Select-only (writes go through an RPC) | 3 | S2, seeded with the service role |
| Zero policies (RPC only) | 5 | Z1 |
| No `owner_id` | 2 | Listed, skipped |

`dua_messages` and `dua_task_events` are append-only, so S3, S4 and S6 report "not applicable"
instead of a pass.

### Output and exit code

One line per check:

```
PASS dua_conversations S2 B reads A row: expected 0 rows, got 0 row(s)
FAIL dua_conversations S2 B reads A row: expected 0 rows, got 1 row(s) (LEAK: B can read A data.)
```

Exit code 0 when every check passed or the run was skipped. Exit code 1 on a leak, a setup failure
or an unverified table.

A leak message carries the table name and a row count only, never row content.

### Cleanup

Cleanup runs in a `finally` block, so it runs on failure too. It deletes both test users through the
admin API, which cascades to every `owner_id` row they wrote. If a delete fails, the script prints a
warning with the email so the user can be removed by hand.

### What it cannot prove

`pg_class.relrowsecurity` is not readable through PostgREST, so "RLS is enabled" is inferred from
C0, not read directly. To confirm it directly, run this in the Supabase SQL editor:

```sql
select c.relname, c.relrowsecurity
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;
```

Every row must show `relrowsecurity = true`.
