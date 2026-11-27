import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  normalizeType,
  parseParameter,
  parseArgList,
  parseMigrationFunctions,
  planRollback,
  buildRollbackSql,
} from '../scripts/generate-function-rollback.mjs';

const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));

test('normalizeType maps aliases to the names oidvectortypes prints', () => {
  assert.equal(normalizeType('INT'), 'integer');
  assert.equal(normalizeType('int8'), 'bigint');
  assert.equal(normalizeType('bool'), 'boolean');
  assert.equal(normalizeType('varchar'), 'character varying');
  assert.equal(normalizeType('timestamptz'), 'timestamp with time zone');
  assert.equal(normalizeType('  timestamp   with   time zone '), 'timestamp with time zone');
});

test('parseParameter drops the name, the mode and the default', () => {
  assert.equal(parseParameter('p_name text'), 'text');
  assert.equal(parseParameter('text'), 'text');
  assert.equal(parseParameter('p_args text default \'migration\''), 'text');
  assert.equal(parseParameter('inout p_x integer'), 'integer');
  assert.equal(parseParameter('p_at timestamptz'), 'timestamp with time zone');
  assert.equal(parseParameter('p_map jsonb'), 'jsonb');
});

test('parseArgList handles defaults, nested parens and empty lists', () => {
  assert.equal(parseArgList(''), '');
  assert.equal(parseArgList('p_a uuid, p_b text'), 'uuid, text');
  assert.equal(parseArgList("p_a text default 'x, y', p_b integer"), 'text, integer');
  assert.equal(parseArgList('p_a numeric(10, 2), p_b text'), 'numeric(10, 2), text');
});

test('parseMigrationFunctions reads create or replace and drop', () => {
  const sql = `
    create or replace function public.dua_workflow_claim(p_worker uuid, p_owner uuid)
    returns jsonb language plpgsql as $$ begin return '{}'::jsonb; end; $$;

    create function dua_workflow_tick(p_owner uuid) returns void language sql as $$ select; $$;

    drop function if exists public.dua_old_thing(uuid, text);
  `;
  const found = parseMigrationFunctions(sql);
  assert.deepEqual(found, [
    { name: 'dua_workflow_claim', args: 'uuid, uuid', action: 'replace' },
    { name: 'dua_workflow_tick', args: 'uuid', action: 'replace' },
    { name: 'dua_old_thing', args: 'uuid, text', action: 'drop' },
  ]);
});

test('parseMigrationFunctions ignores a function name inside a comment', () => {
  const sql = '-- create or replace function public.ghost(p_a uuid)\nselect 1;';
  assert.deepEqual(parseMigrationFunctions(sql), []);
});

test('parseMigrationFunctions finds all ten functions in the real migration', async () => {
  const sql = await readFile(MIGRATIONS + '202611260001_workflow_rpcs_authenticated.sql', 'utf8');
  const found = parseMigrationFunctions(sql);
  assert.equal(found.length, 10, `expected 10 functions, got ${found.length}`);
  const names = found.map(f => f.name).sort();
  assert.deepEqual(names, [
    'dua_workflow_automation_disable', 'dua_workflow_checkpoint', 'dua_workflow_claim',
    'dua_workflow_control', 'dua_workflow_deliver', 'dua_workflow_enqueue',
    'dua_workflow_history', 'dua_workflow_recover', 'dua_workflow_register',
    'dua_workflow_tick',
  ]);
  // The type list must match what the history table stores, or nothing is found.
  const claim = found.find(f => f.name === 'dua_workflow_claim');
  assert.equal(claim.args, 'uuid, uuid');
  const enqueue = found.find(f => f.name === 'dua_workflow_enqueue');
  assert.equal(enqueue.args, 'uuid, text, text, text, text, jsonb, timestamp with time zone');
});

test('planRollback restores the body that differs from the live one', () => {
  const functions = [{ name: 'f', args: 'uuid', action: 'replace' }];
  const history = { 'f(uuid)': [
    { definition: 'NEW', captured_at: '2026-11-28T00:00:00Z', captured_by: 'migration:a' },
    { definition: 'OLD', captured_at: '2026-11-01T00:00:00Z', captured_by: 'migration:b' },
  ] };
  const plan = planRollback({ functions, history, live: { 'f(uuid)': 'NEW' } });
  assert.equal(plan.restores.length, 1);
  assert.equal(plan.restores[0].row.definition, 'OLD');
  assert.equal(plan.restores[0].reason, 'replaced');
  assert.equal(plan.missing.length, 0);
});

test('planRollback reports missing history instead of guessing', () => {
  const functions = [{ name: 'f', args: 'uuid', action: 'replace' }];
  const history = { 'f(uuid)': [
    { definition: 'NEW', captured_at: '2026-11-28T00:00:00Z', captured_by: 'migration:a' },
  ] };
  const plan = planRollback({ functions, history, live: { 'f(uuid)': 'NEW' } });
  assert.equal(plan.restores.length, 0);
  assert.equal(plan.missing.length, 1);
  assert.equal(plan.missing[0].key, 'f(uuid)');
  assert.equal(plan.missing[0].recorded, 1);
});

test('planRollback reports a function with no history at all', () => {
  const functions = [{ name: 'f', args: 'uuid', action: 'replace' }];
  const plan = planRollback({ functions, history: {}, live: { 'f(uuid)': 'LIVE' } });
  assert.equal(plan.missing.length, 1);
  assert.equal(plan.missing[0].recorded, 0);
});

test('planRollback recreates a dropped function from the newest body', () => {
  const functions = [{ name: 'f', args: 'uuid', action: 'drop' }];
  const history = { 'f(uuid)': [
    { definition: 'LAST', captured_at: '2026-11-20T00:00:00Z', captured_by: 'migration:a' },
  ] };
  const plan = planRollback({ functions, history, live: { 'f(uuid)': null } });
  assert.equal(plan.restores.length, 1);
  assert.equal(plan.restores[0].reason, 'dropped');
  assert.equal(plan.dropped.length, 0);
});

test('planRollback reports a dropped function that was never recorded', () => {
  const functions = [{ name: 'f', args: 'uuid', action: 'drop' }];
  const plan = planRollback({ functions, history: {}, live: { 'f(uuid)': null } });
  assert.equal(plan.restores.length, 0);
  assert.equal(plan.dropped.length, 1);
});

test('planRollback honours --before', () => {
  const functions = [{ name: 'f', args: 'uuid', action: 'replace' }];
  const history = { 'f(uuid)': [
    { definition: 'MID', captured_at: '2026-11-20T00:00:00Z', captured_by: 'migration:a' },
    { definition: 'OLD', captured_at: '2026-11-01T00:00:00Z', captured_by: 'migration:b' },
  ] };
  const plan = planRollback({ functions, history, live: { 'f(uuid)': 'LIVE' }, before: '2026-11-10T00:00:00Z' });
  assert.equal(plan.restores.length, 1);
  assert.equal(plan.restores[0].row.definition, 'OLD');
});

test('buildRollbackSql wraps the bodies in one transaction', () => {
  const sql = buildRollbackSql({
    migrationName: '202611260001_workflow_rpcs_authenticated.sql',
    restores: [{
      key: 'f(uuid)',
      reason: 'replaced',
      row: { definition: 'create or replace function public.f(p_a uuid) returns void language sql as $$ select; $$;', captured_at: '2026-11-01T00:00:00Z', captured_by: 'migration:b' },
    }],
    generatedAt: '2026-11-28T00:00:00.000Z',
  });
  assert.match(sql, /^-- Rollback for 202611260001_workflow_rpcs_authenticated\.sql/);
  assert.match(sql, /\nbegin;\n/);
  assert.match(sql, /\ncommit;\n/);
  assert.match(sql, /create or replace function public\.f\(p_a uuid\)/);
  // The trailing semicolon of the stored body must not double up.
  assert.doesNotMatch(sql, /;\s*;;/);
});

test('buildRollbackSql names every function it could not restore', () => {
  const sql = buildRollbackSql({
    migrationName: 'x.sql',
    restores: [],
    missing: [{ key: 'g(uuid)' }],
    dropped: [{ key: 'h(text)' }],
    generatedAt: '2026-11-28T00:00:00.000Z',
  });
  assert.match(sql, /WARNING: no previous body was recorded for:/);
  assert.match(sql, /-- {3}g\(uuid\)/);
  assert.match(sql, /WARNING: dropped after the migration and never recorded:/);
  assert.match(sql, /-- {3}h\(text\)/);
});
