#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';

// Cross-tenant RLS verification. Companion to scripts/verify-rls.mjs.
//
// verify-rls.mjs is an anonymous smoke check: it never signs in, so auth.uid() is never set and
// no owner_id = auth.uid() policy is ever evaluated. This script closes that gap. It creates two
// real users, signs both in, writes rows as A, and then tries to read, update, delete and
// re-own those rows as B. Every attempt must come back empty or denied.
//
// It writes real rows and creates real users, so it is opt-in (DUA_RLS_TEST=1) and refuses to run
// against a project that does not match DUA_RLS_TEST_PROJECT. Cleanup runs in a finally block.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
//   DUA_RLS_TEST=1 DUA_RLS_TEST_PROJECT=<project-ref> \
//   node scripts/verify-rls-cross-tenant.mjs
//
// Exit code 0 = every check passed or the run was skipped. 1 = a leak, a setup failure or an
// unverified table. Leak messages carry the table name and a row count only, never row content.

// Tables that carry owner_id and have at least one policy. S1..S6 run against these.
// Keep in sync with supabase/migrations/; test/verify-rls-cross-tenant.test.mjs fails on drift.
export const OWNED_TABLES = Object.freeze([
  'dua_conversations', 'dua_messages', 'dua_artifacts', 'dua_memories', 'dua_agents',
  'dua_agent_skills', 'dua_agent_instructions', 'dua_agent_triggers', 'dua_conversation_agents',
  'dua_artifact_versions', 'dua_device_tokens', 'dua_notifications', 'dua_task_events',
  'dua_orhan_tasks', 'dua_workflow_runs', 'agent_notes',
]);

// Tables that carry owner_id but have zero policies. Access is meant to go through a
// security definer RPC that reads auth.uid() itself, so a direct table probe proves nothing.
// These get the Z checks instead of S1..S6.
export const RPC_ONLY_TABLES = Object.freeze([
  'dua_daily_usage', 'dua_imagine_usage', 'dua_voice_usage', 'dua_voice_sessions',
  'dua_workflow_credentials',
]);

// Tables that carry owner_id and have a select policy only. The owner cannot insert, update or
// delete through PostgREST: writes go through a security definer RPC. So the row is seeded with the
// service role and only the read isolation (S2) is checked.
export const SELECT_ONLY_TABLES = Object.freeze([
  'dua_cloud_snapshots', 'dua_workflow_executions', 'dua_workflow_automation',
]);

// Tables with no owner_id at all. Listed so the report can say they were considered and skipped.
export const UNOWNED_TABLES = Object.freeze(['dua_workers', 'dua_workflow_deliveries']);

// Tables where the owner cannot delete or update through PostgREST, so S3/S4 are not applicable.
// dua_messages and dua_task_events are append-only by design (select + insert policies only).
const APPEND_ONLY = new Set(['dua_messages', 'dua_task_events']);

// Tables whose insert needs a parent row first. The parent is created as A in the same run.
const NEEDS_PARENT = Object.freeze({
  dua_messages: 'dua_conversations',
  dua_conversation_agents: 'dua_conversations',
  dua_artifact_versions: 'dua_artifacts',
});

const fail = reason => ({ ok: false, reason });
const nowMs = () => Date.now();

/** Build the insert body for one table. Every value is a literal, so nothing is guessed at runtime. */
function insertBody(table, ownerId, parentId) {
  const stamp = nowMs();
  switch (table) {
    case 'dua_conversations': return { title: 'rls-cross-tenant' };
    case 'dua_messages': return { conversation_id: parentId, role: 'user', content: 'rls-cross-tenant' };
    case 'dua_artifacts': return { artifact_id: `rls-${randomUUID().slice(0, 8)}`, title: 'rls-cross-tenant', type: 'html', created_at_ms: stamp, updated_at_ms: stamp };
    case 'dua_memories': return { memory_id: `rls-${randomUUID().slice(0, 8)}`, title: 'rls-cross-tenant', created_at_ms: stamp, updated_at_ms: stamp };
    case 'dua_agents': return { id: `rls-${randomUUID().slice(0, 8)}`, name: 'rls-cross-tenant' };
    case 'dua_agent_skills': return { id: `rls-${randomUUID().slice(0, 8)}`, title: 'rls-cross-tenant' };
    case 'dua_agent_instructions': return { agent_id: 'dua-agent', instruction: 'rls-cross-tenant' };
    case 'dua_agent_triggers': return { agent_id: 'dua-agent', trigger_type: 'schedule', prompt: 'rls-cross-tenant' };
    case 'dua_conversation_agents': return { conversation_id: parentId, agent_id: 'dua-agent' };
    case 'dua_artifact_versions': return { artifact_id: parentId, version_num: 1, content: 'rls-cross-tenant' };
    case 'dua_cloud_snapshots': return { revision: 1, payload: { rls: 'cross-tenant' } };
    case 'dua_workflow_executions': return { workflow_id: 'rls', title: 'rls-cross-tenant', request_key: `rls-${randomUUID().slice(0, 8)}`, fingerprint: 'rls', definition: {}, steps: [] };
    case 'dua_workflow_automation': return { id: randomUUID(), kind: 'interval', workflow_id: 'rls', title: 'rls-cross-tenant', definition: {}, interval_seconds: 300, next_due: new Date(stamp).toISOString() };
    case 'dua_device_tokens': return { token: `rls-${randomUUID()}`, platform: 'android' };
    case 'dua_notifications': return { title: 'rls-cross-tenant', body: 'rls-cross-tenant' };
    case 'dua_task_events': return { task_id: `rls-${randomUUID().slice(0, 12)}`, seq: 1, event: 'created' };
    case 'dua_orhan_tasks': return { task_id: `rls-${randomUUID().slice(0, 12)}`, title: 'rls-cross-tenant', prompt: 'rls-cross-tenant', status: 'waiting', plan: {}, steps: [], created_at_ms: stamp, updated_at_ms: stamp };
    case 'dua_workflow_runs': return { run_id: `rls-${randomUUID().slice(0, 12)}`, workflow_id: 'rls', workflow_title: 'rls-cross-tenant', chat_title: 'rls-cross-tenant', agent_name: 'rls', status: 'queued', started_at_ms: stamp };
    case 'agent_notes': return { note: 'rls-cross-tenant' };
    default: return null;
  }
}

/** The column the row is addressed by in S2..S6. Composite-PK tables use their text key. */
function rowFilter(table, row) {
  switch (table) {
    case 'dua_artifacts': return `artifact_id=eq.${encodeURIComponent(row.artifact_id)}`;
    case 'dua_memories': return `memory_id=eq.${encodeURIComponent(row.memory_id)}`;
    case 'dua_agents': return `id=eq.${encodeURIComponent(row.id)}`;
    case 'dua_agent_skills': return `id=eq.${encodeURIComponent(row.id)}`;
    case 'dua_orhan_tasks': return `task_id=eq.${encodeURIComponent(row.task_id)}`;
    case 'dua_workflow_runs': return `run_id=eq.${encodeURIComponent(row.run_id)}`;
    case 'dua_task_events': return `task_id=eq.${encodeURIComponent(row.task_id)}`;
    case 'dua_conversation_agents': return `conversation_id=eq.${encodeURIComponent(row.conversation_id)}`;
    case 'dua_artifact_versions': return `artifact_id=eq.${encodeURIComponent(row.artifact_id)}`;
    case 'dua_cloud_snapshots': return `owner_id=eq.${encodeURIComponent(row.owner_id)}`;
    case 'dua_workflow_executions': return `id=eq.${encodeURIComponent(row.id)}`;
    case 'dua_workflow_automation': return `id=eq.${encodeURIComponent(row.id)}`;
    default: return `id=eq.${encodeURIComponent(row.id)}`;
  }
}

/** The column S5 tries to forge. Composite-PK tables have no single id column to point at. */
function ownerColumn(table) {
  return table === 'dua_conversation_agents' || table === 'dua_artifact_versions' ? null : 'owner_id';
}

function configuration(env) {
  const url = env.SUPABASE_URL?.trim();
  const anon = (env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY)?.trim();
  const service = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !anon) return { skip: 'SKIP: set SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_PUBLISHABLE_KEY).' };
  if (!service) return { skip: 'SKIP: SUPABASE_SERVICE_ROLE_KEY is required to create and delete the two test users.' };
  if (env.DUA_RLS_TEST !== '1') return { skip: 'SKIP: set DUA_RLS_TEST=1 to run cross-tenant checks. This script writes real rows.' };
  let parsed;
  try { parsed = new URL(url); } catch { return { error: 'SUPABASE_URL must be the project root URL.' }; }
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password)
    return { error: 'Use the Supabase project root URL, without /rest/v1, credentials or query parameters.' };
  const ref = env.DUA_RLS_TEST_PROJECT?.trim();
  if (!ref) return { error: 'Refusing to run: set DUA_RLS_TEST_PROJECT to the project ref this run is allowed to touch.' };
  if (!parsed.hostname.startsWith(ref + '.')) return { error: `Refusing to run: SUPABASE_URL host does not match DUA_RLS_TEST_PROJECT (${ref}).` };
  if (env.DUA_ALLOWED_EMAIL?.trim()) return { error: 'Refusing to run: DUA_ALLOWED_EMAIL is set, which marks a single-owner production project.' };
  return { url: parsed.origin, anon, service };
}

/** One REST call. Returns { status, rows, error } and never throws on a non-2xx. */
async function rest(fetcher, config, path, { token, method = 'GET', body, prefer } = {}) {
  const headers = { apikey: config.anon, Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  try {
    const response = await fetcher(config.url + path, {
      method, headers, redirect: 'error',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    let rows = null;
    try { rows = text ? JSON.parse(text) : null; } catch { rows = null; }
    return { status: response.status, rows, error: null };
  } catch (error) {
    return { status: 0, rows: null, error: error?.name === 'TimeoutError' ? 'request timed out after 15s' : 'request failed' };
  }
}

async function admin(fetcher, config, path, init = {}) {
  const response = await fetcher(config.url + path, {
    ...init,
    headers: { apikey: config.service, Authorization: `Bearer ${config.service}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: response.ok, status: response.status, data };
}

/** Create one confirmed user and return { id, email, token }. */
async function makeUser(fetcher, config, label, runId) {
  const email = `dua-rls-${label}-${runId}@example.test`;
  const password = randomBytes(24).toString('base64url');
  const created = await admin(fetcher, config, '/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok || !created.data?.id) return { error: `could not create test user ${label} (HTTP ${created.status})` };
  const signed = await fetcher(config.url + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: config.anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  const session = await signed.json().catch(() => null);
  if (!signed.ok || typeof session?.access_token !== 'string')
    return { error: `sign-in for ${label} failed (HTTP ${signed.status}). Check email confirmation settings on the test project.` };
  return { id: created.data.id, email, token: session.access_token };
}

/**
 * Run the cross-tenant checks. Returns { ok, skipped, reason, checks }.
 * checks entries are { table, scenario, expected, actual, ok, note }.
 */
export async function verifyCrossTenant({ env = process.env, fetcher = fetch } = {}) {
  const config = configuration(env);
  if (config.skip) return { ok: true, skipped: true, reason: config.skip, checks: [] };
  if (config.error) return { ok: false, skipped: false, reason: config.error, checks: [] };

  const checks = [];
  const add = (table, scenario, expected, actual, ok, note) => checks.push({ table, scenario, expected, actual, ok, ...(note ? { note } : {}) });
  const runId = randomUUID().slice(0, 8);
  let userA = null;
  let userB = null;

  try {
    userA = await makeUser(fetcher, config, 'a', runId);
    if (userA.error) return { ok: false, skipped: false, reason: `Setup failed: ${userA.error}. No table was verified.`, checks: [] };
    userB = await makeUser(fetcher, config, 'b', runId);
    if (userB.error) return { ok: false, skipped: false, reason: `Setup failed: ${userB.error}. No table was verified.`, checks: [] };

    // C0: RLS must be on. A table with policies but RLS disabled exposes every row to everyone.
    // PostgREST cannot read pg_class, so this is inferred: an anon read that returns rows means
    // the table is readable without a token, which is a leak regardless of the policy text.
    for (const table of [...OWNED_TABLES, ...SELECT_ONLY_TABLES, ...RPC_ONLY_TABLES]) {
      const anon = await rest(fetcher, config, `/rest/v1/${table}?select=*&limit=1`);
      if (anon.status === 200 && Array.isArray(anon.rows) && anon.rows.length > 0)
        add(table, 'C0 anon read', 'no rows without a token', `${anon.rows.length} row(s)`, false, 'RLS may be disabled or a policy allows anon.');
      else if (anon.status === 0)
        add(table, 'C0 anon read', 'no rows without a token', anon.error, false, 'Could not reach the table.');
      else
        add(table, 'C0 anon read', 'no rows without a token', `HTTP ${anon.status}`, true);
    }

    // S1..S6 per owned table.
    for (const table of OWNED_TABLES) {
      const parentTable = NEEDS_PARENT[table];
      let parentId = null;
      if (parentTable) {
        const parentBody = insertBody(parentTable, userA.id, null);
        const parent = await rest(fetcher, config, `/rest/v1/${parentTable}`, {
          token: userA.token, method: 'POST', body: parentBody, prefer: 'return=representation',
        });
        if (parent.status !== 201 || !Array.isArray(parent.rows) || !parent.rows[0]) {
          add(table, 'S1 A inserts own row', '201', `parent ${parentTable} insert returned HTTP ${parent.status}`, false, 'Parent row could not be created, so this table was not verified.');
          continue;
        }
        // dua_artifacts is keyed on (owner_id, artifact_id), so the child needs artifact_id, not id.
        parentId = parentTable === 'dua_artifacts' ? parent.rows[0].artifact_id : parent.rows[0].id;
      }

      const body = insertBody(table, userA.id, parentId);
      const s1 = await rest(fetcher, config, `/rest/v1/${table}`, {
        token: userA.token, method: 'POST', body, prefer: 'return=representation',
      });
      if (s1.status !== 201 || !Array.isArray(s1.rows) || !s1.rows[0]) {
        add(table, 'S1 A inserts own row', '201', `HTTP ${s1.status}`, false, 'Row could not be created, so the isolation checks for this table were skipped.');
        continue;
      }
      const row = s1.rows[0];
      add(table, 'S1 A inserts own row', '201', 'HTTP 201', true);

      const filter = rowFilter(table, row);

      // S2: B must not see A's row.
      const s2 = await rest(fetcher, config, `/rest/v1/${table}?select=*&${filter}`, { token: userB.token });
      const s2Rows = Array.isArray(s2.rows) ? s2.rows.length : null;
      add(table, 'S2 B reads A row', '0 rows', s2.status === 200 ? `${s2Rows} row(s)` : `HTTP ${s2.status}`, s2.status === 200 && s2Rows === 0,
        s2.status === 200 && s2Rows > 0 ? 'LEAK: B can read A data.' : undefined);

      // S3: B must not update A's row.
      if (APPEND_ONLY.has(table)) {
        add(table, 'S3 B updates A row', 'not applicable', 'append-only table', true, 'No update policy exists by design.');
      } else {
        const s3 = await rest(fetcher, config, `/rest/v1/${table}?${filter}`, {
          token: userB.token, method: 'PATCH', body: { ...body, ...(ownerColumn(table) ? { [ownerColumn(table)]: userB.id } : {}) }, prefer: 'return=representation',
        });
        const s3Rows = Array.isArray(s3.rows) ? s3.rows.length : 0;
        add(table, 'S3 B updates A row', '0 rows', `HTTP ${s3.status}, ${s3Rows} row(s)`, s3Rows === 0,
          s3Rows > 0 ? 'LEAK: B can update A data.' : undefined);
      }

      // S4: B must not delete A's row.
      if (APPEND_ONLY.has(table)) {
        add(table, 'S4 B deletes A row', 'not applicable', 'append-only table', true, 'No delete policy exists by design.');
      } else {
        const s4 = await rest(fetcher, config, `/rest/v1/${table}?${filter}`, {
          token: userB.token, method: 'DELETE', prefer: 'return=representation',
        });
        const s4Rows = Array.isArray(s4.rows) ? s4.rows.length : 0;
        add(table, 'S4 B deletes A row', '0 rows', `HTTP ${s4.status}, ${s4Rows} row(s)`, s4Rows === 0,
          s4Rows > 0 ? 'LEAK: B can delete A data.' : undefined);
      }

      // S5: B must not insert a row that claims A as owner. This is the WITH CHECK test.
      const column = ownerColumn(table);
      if (!column) {
        add(table, 'S5 B forges owner_id', 'not applicable', 'no single owner column', true, 'Composite primary key, owner is implied by the parent row.');
      } else {
        const forged = { ...insertBody(table, userA.id, parentId), [column]: userA.id };
        const s5 = await rest(fetcher, config, `/rest/v1/${table}`, {
          token: userB.token, method: 'POST', body: forged, prefer: 'return=minimal',
        });
        const denied = s5.status === 401 || s5.status === 403;
        add(table, 'S5 B forges owner_id', '401 or 403', `HTTP ${s5.status}`, denied,
          !denied && s5.status >= 200 && s5.status < 300 ? 'LEAK: WITH CHECK is missing, B inserted a row owned by A.' : undefined);
      }

      // S6: B must not re-own A's row.
      if (APPEND_ONLY.has(table) || !column) {
        add(table, 'S6 B re-owns A row', 'not applicable', 'no update path', true);
      } else {
        const s6 = await rest(fetcher, config, `/rest/v1/${table}?${filter}`, {
          token: userB.token, method: 'PATCH', body: { [column]: userB.id }, prefer: 'return=representation',
        });
        const s6Rows = Array.isArray(s6.rows) ? s6.rows.length : 0;
        add(table, 'S6 B re-owns A row', '0 rows', `HTTP ${s6.status}, ${s6Rows} row(s)`, s6Rows === 0,
          s6Rows > 0 ? 'LEAK: B can take ownership of A data.' : undefined);
      }
    }

    // S2 only, for tables the owner can read but not write through PostgREST. The row is seeded
    // with the service role, so the insert itself proves nothing about the owner's policies.
    for (const table of SELECT_ONLY_TABLES) {
      const body = insertBody(table, userA.id, null);
      const seeded = await admin(fetcher, config, `/rest/v1/${table}`, {
        method: 'POST', body: JSON.stringify({ ...body, owner_id: userA.id }), prefer: 'return=representation',
      });
      if (!seeded.ok || !Array.isArray(seeded.data) || !seeded.data[0]) {
        add(table, 'S2 B reads A row', '0 rows', `service-role seed returned HTTP ${seeded.status}`, false, 'Row could not be seeded, so read isolation for this table was not verified.');
        continue;
      }
      const row = seeded.data[0];
      const filter = rowFilter(table, row);
      const s2 = await rest(fetcher, config, `/rest/v1/${table}?select=*&${filter}`, { token: userB.token });
      const s2Rows = Array.isArray(s2.rows) ? s2.rows.length : null;
      add(table, 'S2 B reads A row', '0 rows', s2.status === 200 ? `${s2Rows} row(s)` : `HTTP ${s2.status}`, s2.status === 200 && s2Rows === 0,
        s2.status === 200 && s2Rows > 0 ? 'LEAK: B can read A data.' : undefined);
    }

    // Z checks for the five owner_id tables that have no policies. Access is meant to go through
    // a security definer RPC, so a direct read must return nothing for either user.
    for (const table of RPC_ONLY_TABLES) {
      const z1 = await rest(fetcher, config, `/rest/v1/${table}?select=*&limit=5`, { token: userA.token });
      const z1Rows = Array.isArray(z1.rows) ? z1.rows.length : 0;
      const denied = z1.status === 401 || z1.status === 403 || (z1.status === 200 && z1Rows === 0);
      add(table, 'Z1 A direct read', 'no rows or denied', `HTTP ${z1.status}, ${z1Rows} row(s)`, denied,
        z1Rows > 0 ? 'LEAK: a table with zero policies is readable directly.' : undefined);
    }

    // Z2: the two usage RPCs must return only the caller's own numbers.
    for (const rpc of ['dua_read_imagine_usage', 'dua_read_voice_usage']) {
      const call = await rest(fetcher, config, `/rest/v1/rpc/${rpc}`, { token: userA.token, method: 'POST', body: {} });
      const ok = call.status === 200 && call.rows && typeof call.rows === 'object';
      add(rpc, 'Z2 RPC returns own usage', '200 with an object', `HTTP ${call.status}`, ok,
        !ok ? 'RPC did not return the caller own usage. Check the security definer body.' : undefined);
    }

    // Z3: the storage bucket must be private and folder-scoped.
    const bucket = await rest(fetcher, config, '/storage/v1/bucket/dua-files', { token: userA.token });
    const isPrivate = bucket.status === 200 && bucket.rows && bucket.rows.public === false;
    add('storage.objects', 'Z3 bucket is private', 'public = false', bucket.status === 200 ? `public = ${bucket.rows?.public}` : `HTTP ${bucket.status}`, isPrivate,
      bucket.status === 200 && bucket.rows?.public === true ? 'LEAK: the dua-files bucket is public.' : undefined);

    return { ok: checks.every(c => c.ok), skipped: false, checks };
  } catch (error) {
    return { ok: false, skipped: false, reason: `Run failed: ${error?.message || 'unexpected error'}.`, checks };
  } finally {
    // Cleanup always runs. Deleting the auth user cascades to every owner_id row.
    for (const user of [userA, userB]) {
      if (!user?.id) continue;
      try {
        const removed = await admin(fetcher, config, `/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
          method: 'DELETE', body: JSON.stringify({ should_soft_delete: false }),
        });
        if (!removed.ok) console.warn(`WARN: cleanup of test user ${user.email} failed (HTTP ${removed.status}), manual delete needed.`);
      } catch {
        console.warn(`WARN: cleanup of test user ${user.email} failed, manual delete needed.`);
      }
    }
  }
}

export async function main(args = process.argv.slice(2), options = {}) {
  const log = options.log || console.log;
  if (args.length) { log('Usage: npm run verify:rls:cross'); return 1; }
  const result = await verifyCrossTenant(options);
  if (result.reason) log(result.reason);
  for (const check of result.checks)
    log(`${check.ok ? 'PASS' : 'FAIL'} ${check.table} ${check.scenario}: expected ${check.expected}, got ${check.actual}${check.note ? ` (${check.note})` : ''}`);
  const failed = result.checks.filter(c => !c.ok).length;
  if (!result.skipped) log(result.ok
    ? `Cross-tenant checks passed (${result.checks.length} checks). Test users and their rows were deleted.`
    : `Cross-tenant checks FAILED: ${failed} of ${result.checks.length} checks did not pass.`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
