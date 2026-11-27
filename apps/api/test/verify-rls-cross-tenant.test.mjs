import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  verifyCrossTenant, main,
  OWNED_TABLES, SELECT_ONLY_TABLES, RPC_ONLY_TABLES, UNOWNED_TABLES,
} from '../scripts/verify-rls-cross-tenant.mjs';

const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));

async function migrationSql() {
  const files = (await readdir(MIGRATIONS)).filter(f => f.endsWith('.sql'));
  assert.ok(files.length > 0, 'no migrations found');
  const parts = [];
  for (const file of files) parts.push(await readFile(MIGRATIONS + file, 'utf8'));
  return parts.join('\n');
}

test('every table in the migrations is classified exactly once', async () => {
  const sql = await migrationSql();
  const created = new Set();
  for (const match of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi))
    created.add(match[1].toLowerCase());

  const classified = [...OWNED_TABLES, ...SELECT_ONLY_TABLES, ...RPC_ONLY_TABLES, ...UNOWNED_TABLES];
  assert.equal(new Set(classified).size, classified.length, 'a table is listed in two groups');

  const missing = [...created].filter(t => !classified.includes(t)).sort();
  const extra = classified.filter(t => !created.has(t)).sort();
  assert.deepEqual(missing, [], `tables in the migrations but not in the script: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `tables in the script but not in the migrations: ${extra.join(', ')}`);
});

test('the zero-policy group really has zero policies', async () => {
  const sql = await migrationSql();
  for (const table of RPC_ONLY_TABLES) {
    const pattern = new RegExp(`create\\s+policy\\s+[a-z0-9_]+\\s+on\\s+(?:public\\.)?${table}\\b`, 'gi');
    const found = [...sql.matchAll(pattern)];
    assert.equal(found.length, 0, `${table} is in RPC_ONLY_TABLES but has ${found.length} policy statement(s)`);
  }
});

test('the select-only group has a select policy and no insert policy', async () => {
  const sql = await migrationSql();
  for (const table of SELECT_ONLY_TABLES) {
    const base = `create\\s+policy\\s+[a-z0-9_]+\\s+on\\s+(?:public\\.)?${table}\\s+for\\s+`;
    assert.match(sql, new RegExp(base + 'select', 'i'), `${table} has no select policy`);
    assert.doesNotMatch(sql, new RegExp(base + 'insert', 'i'), `${table} has an insert policy, so it belongs in OWNED_TABLES`);
  }
});

test('the unowned group has no owner_id column', async () => {
  const sql = await migrationSql();
  for (const table of UNOWNED_TABLES) {
    const block = sql.match(new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:public\\.)?${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i'));
    assert.ok(block, `${table} not found in the migrations`);
    assert.doesNotMatch(block[1], /owner_id/, `${table} has an owner_id column, so it is not unowned`);
  }
});

test('missing configuration skips cleanly without any network request', async () => {
  const result = await verifyCrossTenant({ env: {}, fetcher: () => assert.fail('must not fetch') });
  assert.equal(result.skipped, true);
  assert.equal(result.ok, true);
  assert.match(result.reason, /SKIP.*SUPABASE_URL/);
  assert.equal(await main([], { env: {}, log: () => {} }), 0);
});

test('a project ref mismatch refuses to run', async () => {
  const env = {
    SUPABASE_URL: 'https://other.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_mock',
    SUPABASE_SERVICE_ROLE_KEY: 'mock',
    DUA_RLS_TEST: '1',
    DUA_RLS_TEST_PROJECT: 'expected',
  };
  const result = await verifyCrossTenant({ env, fetcher: () => assert.fail('must not fetch') });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not match DUA_RLS_TEST_PROJECT/);
});

test('a single-owner production project refuses to run', async () => {
  const env = {
    SUPABASE_URL: 'https://proj.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_mock',
    SUPABASE_SERVICE_ROLE_KEY: 'mock',
    DUA_RLS_TEST: '1',
    DUA_RLS_TEST_PROJECT: 'proj',
    DUA_ALLOWED_EMAIL: 'owner@example.com',
  };
  const result = await verifyCrossTenant({ env, fetcher: () => assert.fail('must not fetch') });
  assert.equal(result.ok, false);
  assert.match(result.reason, /single-owner production project/);
});

test('arguments are rejected, so a typo cannot silently run the wrong thing', async () => {
  assert.equal(await main(['--tables=x'], { env: {}, log: () => {} }), 1);
});
