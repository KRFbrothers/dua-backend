#!/usr/bin/env node
// Generate a `.rollback.sql` for a migration from `public.dua_function_history`.
//
// Why this exists: `AGENTS.md` 4.11 says every schema change ships a rollback file.
// For a migration that only does `create or replace function`, the previous body
// used to live in git and nowhere else, so a rollback could not re-apply it.
// `202611280001_dua_function_history.sql` fixed the recording half. This script is
// the reading half: it takes a migration file, works out which functions that file
// replaced or dropped, pulls the body each one had before, and writes the matching
// rollback beside it.
//
// Usage
//   node scripts/generate-function-rollback.mjs <migration.sql> [options]
//
//   --database-url <url>   Postgres connection string. Defaults to $DATABASE_URL.
//   --out <path>           Where to write. Defaults to <migration>.rollback.sql.
//   --before <timestamp>   Only use history captured before this instant. Optional;
//                          without it the newest body that differs from the live one
//                          is used, which is the body the migration replaced.
//   --dry-run              Print the SQL instead of writing a file.
//   --force                Overwrite an existing rollback file.
//   --allow-remote         Permit a non-local database host. Refused by default,
//                          because AGENTS.md 4.12 says database work is staging only.
//
// Exit codes
//   0  rollback written (or printed)
//   1  a function has no recorded previous body, or was dropped after the migration
//   2  bad arguments, unreadable migration, or the database call failed
//
// Example
//   cd apps/api
//   DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
//     node scripts/generate-function-rollback.mjs \
//     ../../supabase/migrations/202611260001_workflow_rpcs_authenticated.sql --dry-run
//
// This script never runs in CI: it needs a live database, like the other scripts in
// this directory. The pure parts (parsing, planning, rendering) are unit tested in
// test/generate-function-rollback.test.mjs.

import { spawnSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Type handling
// ---------------------------------------------------------------------------
// `oidvectortypes()` is what the history table stores, and it prints canonical
// names: `integer`, `bigint`, `boolean`, `timestamp with time zone`,
// `character varying`, `double precision`. A migration writes whatever the author
// typed, so both sides are normalised to that canonical spelling before matching.
const TYPE_WORDS = new Set([
  'text', 'uuid', 'jsonb', 'json', 'integer', 'int', 'int2', 'int4', 'int8',
  'bigint', 'smallint', 'boolean', 'bool', 'timestamptz', 'timestamp', 'date',
  'time', 'timetz', 'numeric', 'decimal', 'real', 'float4', 'float8', 'double',
  'bytea', 'varchar', 'character', 'char', 'inet', 'cidr', 'macaddr', 'interval',
  'money', 'serial', 'bigserial', 'smallserial', 'tsvector', 'tsquery', 'vector',
  'regclass', 'oid', 'name', 'record', 'void', 'anyelement', 'anyarray',
]);

const TYPE_ALIASES = new Map([
  ['int', 'integer'], ['int4', 'integer'], ['int2', 'smallint'], ['int8', 'bigint'],
  ['bool', 'boolean'], ['float4', 'real'], ['float8', 'double precision'],
  ['decimal', 'numeric'], ['varchar', 'character varying'], ['char', 'character'],
  ['timetz', 'time with time zone'], ['timestamptz', 'timestamp with time zone'],
  ['timestamp', 'timestamp without time zone'], ['serial', 'integer'],
  ['bigserial', 'bigint'], ['smallserial', 'smallint'],
]);

/** Collapse whitespace and map an alias to the name `oidvectortypes()` prints. */
export function normalizeType(raw) {
  const collapsed = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  return TYPE_ALIASES.get(collapsed) ?? collapsed;
}

/** Split on a separator that is not inside parentheses, brackets or quotes. */
export function splitTopLevel(text, separator = ',') {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === separator && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim() !== '' || parts.length) parts.push(current);
  return parts.map(p => p.trim()).filter(p => p !== '');
}

/** Turn one parameter declaration into the bare type, as `oidvectortypes()` would. */
export function parseParameter(raw) {
  let text = String(raw).trim();
  // `in`, `out`, `inout` and `variadic` are mode markers, not part of the type.
  text = text.replace(/^(?:inout|variadic|in|out)\s+/i, '');
  // A default value is not part of the identity.
  const defaultAt = text.search(/\s+default\s+/i);
  if (defaultAt !== -1) text = text.slice(0, defaultAt);
  text = text.trim();
  if (text === '') return null;
  // `p_name text` -> `text`, but `text` alone stays `text`.
  const named = /^([a-z_][a-z0-9_]*)\s+(.+)$/i.exec(text);
  if (named && TYPE_WORDS.has(named[1].toLowerCase())) return normalizeType(text);
  if (named) return normalizeType(named[2]);
  return normalizeType(text);
}

/** `p_name text, p_args text default 'x'` -> `text, text`. */
export function parseArgList(raw) {
  const inner = String(raw).trim();
  if (inner === '') return '';
  return splitTopLevel(inner).map(parseParameter).filter(Boolean).join(', ');
}

// ---------------------------------------------------------------------------
// Migration parsing
// ---------------------------------------------------------------------------
/** Read the parenthesised argument list that starts at `openIndex`. */
function readParenGroup(sql, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(openIndex + 1, i);
    }
  }
  return null;
}

/**
 * Every function a migration creates, replaces or drops.
 * Returns `[{ name, args, action }]` where action is `replace` or `drop`.
 * A `create function` (no `or replace`) is reported as `replace` too: from the
 * rollback's point of view the function must be put back either way.
 */
/**
 * Remove `--` line comments and `/* *\/` block comments, leaving string literals
 * and dollar quoted bodies alone. A commented out `create function` must not be
 * mistaken for a real one.
 */
export function stripComments(sql) {
  let out = '';
  let i = 0;
  let quote = null;
  let dollarTag = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) { out += dollarTag; i += dollarTag.length; dollarTag = null; continue; }
      out += ch; i += 1; continue;
    }
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) { out += sql[i + 1]; i += 2; continue; }
        quote = null;
      }
      i += 1; continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (tag) { dollarTag = tag[0]; out += dollarTag; i += dollarTag.length; continue; }
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch; i += 1;
  }
  return out;
}

export function parseMigrationFunctions(rawSql) {
  const sql = stripComments(rawSql);
  const found = [];
  const seen = new Set();
  const push = (name, args, action) => {
    const key = `${name}(${args})`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ name: name.toLowerCase(), args, action });
  };

  const createRe = /create\s+(or\s+replace\s+)?function\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi;
  for (const match of sql.matchAll(createRe)) {
    const openIndex = match.index + match[0].length - 1;
    const group = readParenGroup(sql, openIndex);
    if (group === null) continue;
    // A plain `create function` cannot overwrite an existing function: Postgres
    // raises 42723. So if the migration applied, that function did not exist
    // before it, and the rollback drops it instead of restoring a body.
    push(match[2], parseArgList(group), match[1] ? 'replace' : 'create');
  }

  const dropRe = /drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi;
  for (const match of sql.matchAll(dropRe)) {
    const openIndex = match.index + match[0].length - 1;
    const group = readParenGroup(sql, openIndex);
    if (group === null) continue;
    push(match[1], parseArgList(group), 'drop');
  }

  return found;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------
/**
 * Decide, per function, which recorded body to restore.
 *
 * `history` is `{ 'name(args)': [{ definition, captured_at, captured_by }, ...] }`
 * newest first. `live` is `{ 'name(args)': definition | null }`.
 *
 * A function is `restore` when a recorded body differs from the live one: that is
 * the body the migration replaced. It is `missing-history` when the function still
 * exists but nothing older than the live body was ever recorded, and `dropped` when
 * the function is gone from the database entirely.
 */
export function planRollback({ functions, history = {}, live = {}, before = null }) {
  const restores = [];
  const missing = [];
  const dropped = [];
  const creates = [];

  for (const fn of functions) {
    const key = `${fn.name}(${fn.args})`;
    const rows = (history[key] ?? []).filter(row => !before || new Date(row.captured_at) < new Date(before));
    const liveDefinition = live[key] ?? null;

    // A function this migration created from nothing. No history is expected, and
    // the rollback removes it. Only when a body was recorded does it become a
    // restore, which covers a `create function` that replaced a dropped name.
    if (fn.action === 'create' && !rows.length) {
      creates.push({ ...fn, key });
      continue;
    }

    if (liveDefinition === null) {
      // Gone from the database. The newest recorded body is the only candidate.
      if (rows.length) restores.push({ ...fn, key, row: rows[0], reason: 'dropped' });
      else dropped.push({ ...fn, key });
      continue;
    }

    const previous = rows.find(row => row.definition !== liveDefinition);
    if (previous) restores.push({ ...fn, key, row: previous, reason: 'replaced' });
    else missing.push({ ...fn, key, recorded: rows.length });
  }

  return { restores, missing, dropped, creates };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function header({ migrationName, generatedAt, restores, missing, dropped, creates = [] }) {
  const lines = [
    `-- Rollback for ${migrationName}`,
    '--',
    '-- Generated by apps/api/scripts/generate-function-rollback.mjs from',
    '-- public.dua_function_history. Do not hand edit: regenerate instead.',
    `-- Generated at: ${generatedAt}`,
    '--',
    `-- Restores ${restores.length} function definition(s) to the body each one had`,
    '-- before that migration replaced it.',
    `-- Drops ${creates.length} function(s) the migration created from nothing.`,
    '--',
    '-- Data loss: none. Function definitions are copied, never moved, and',
    '-- `create or replace` keeps the existing grants on each function.',
    '--',
    '-- Apply with:',
    `--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ${migrationName.replace(/\.sql$/, '.rollback.sql')}`,
    '--',
    '-- Safe to run again: every statement is `create or replace` or `drop if exists`.',
  ];
  if (creates.length) {
    lines.push('--', '-- Dropped by this rollback, because the migration created them:');
    for (const fn of creates) lines.push(`--   ${fn.key}`);
  }
  if (missing.length) {
    lines.push('--', '-- WARNING: no previous body was recorded for:');
    for (const fn of missing) lines.push(`--   ${fn.key}`);
  }
  if (dropped.length) {
    lines.push('--', '-- WARNING: dropped after the migration and never recorded:');
    for (const fn of dropped) lines.push(`--   ${fn.key}`);
  }
  return lines.join('\n');
}

/** Render the rollback SQL. `restores` comes from `planRollback`. */
export function buildRollbackSql({ migrationName, restores, missing = [], dropped = [], creates = [], generatedAt = new Date().toISOString() }) {
  const blocks = restores.map(({ key, row, reason }) => {
    const body = String(row.definition).trim().replace(/;\s*$/, '');
    const note = reason === 'dropped'
      ? '-- was dropped by the migration, recreated from the newest recorded body'
      : '-- body replaced by the migration, restored from history';
    return [
      `-- public.${key}`,
      `-- captured ${row.captured_at} by ${row.captured_by}`,
      note,
      `${body};`,
    ].join('\n');
  });

  // A function the migration created did not exist before it, so undoing the
  // migration means removing it. `if exists` keeps the file safe to run twice.
  const dropBlocks = creates.map(({ key }) => [
    `-- public.${key}`,
    '-- created by the migration, so the rollback removes it',
    `drop function if exists public.${key};`,
  ].join('\n'));

  return [
    header({ migrationName, generatedAt, restores, missing, dropped, creates }),
    '',
    'begin;',
    '',
    [...blocks, ...dropBlocks].join('\n\n'),
    '',
    'commit;',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Database access
// ---------------------------------------------------------------------------
function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPsql(databaseUrl, sql) {
  // `-q` suppresses the `SET` command tag, so stdout is only the JSON row.
  const result = spawnSync('psql', [databaseUrl, '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (result.error) throw new Error(`psql could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`psql failed: ${(result.stderr || '').trim()}`);
  return (result.stdout || '').trim();
}

/** Read every recorded body for the given functions, newest first. */
export function readHistory(databaseUrl, functions) {
  if (!functions.length) return {};
  const pairs = functions.map(fn => `(${sqlLiteral(fn.name)}, ${sqlLiteral(fn.args)})`).join(', ');
  const sql = `
    select coalesce(json_object_agg(k, v), '{}'::json)::text from (
      select h.function_name || '(' || h.identity_args || ')' as k,
             json_agg(json_build_object(
               'definition', h.definition,
               'captured_at', h.captured_at,
               'captured_by', h.captured_by
             ) order by h.captured_at desc) as v
        from public.dua_function_history h
       where h.schema_name = 'public'
         and (h.function_name, h.identity_args) in (${pairs})
       group by h.function_name, h.identity_args
    ) s`;
  return JSON.parse(runPsql(databaseUrl, sql) || '{}');
}

/** Read the live definition of each function, or null when it does not exist. */
export function readLive(databaseUrl, functions) {
  if (!functions.length) return {};
  const pairs = functions.map(fn => `(${sqlLiteral(fn.name)}, ${sqlLiteral(fn.args)})`).join(', ');
  // `set search_path = ''` matters: pg_get_functiondef qualifies a type name only
  // when the type is not on the search path. The capture helper runs with an empty
  // search_path, so it stores `public.dua_workflow_executions`. Reading the live
  // body with the default search_path would print `dua_workflow_executions`, and
  // the two would never compare equal. Same setting on both sides, same text.
  const sql = `
    set search_path = '';
    select coalesce(json_object_agg(k, v), '{}'::json)::text from (
      select t.name || '(' || t.args || ')' as k,
             (select pg_get_functiondef(p.oid)
                from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public'
                 and p.proname = t.name
                 and oidvectortypes(p.proargtypes) = t.args
               limit 1) as v
        from (values ${pairs}) as t(name, args)
    ) s`;
  return JSON.parse(runPsql(databaseUrl, sql) || '{}');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const options = { migration: null, databaseUrl: process.env.DATABASE_URL ?? null, out: null, before: null, dryRun: false, force: false, allowRemote: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--allow-remote') options.allowRemote = true;
    else if (arg === '--database-url') options.databaseUrl = argv[++i] ?? null;
    else if (arg === '--out') options.out = argv[++i] ?? null;
    else if (arg === '--before') options.before = argv[++i] ?? null;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else if (!options.migration) options.migration = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return options;
}

function isLocalHost(databaseUrl) {
  try {
    const host = new URL(databaseUrl).hostname;
    return ['localhost', '127.0.0.1', '::1', '[::1]', ''].includes(host);
  } catch {
    return false;
  }
}

const USAGE = `Usage: node scripts/generate-function-rollback.mjs <migration.sql> [options]

  --database-url <url>   Postgres connection string (default: $DATABASE_URL)
  --out <path>           Output path (default: <migration>.rollback.sql)
  --before <timestamp>   Only use history captured before this instant
  --dry-run              Print the SQL instead of writing a file
  --force                Overwrite an existing rollback file
  --allow-remote         Permit a non-local database host
`;

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`error: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) { console.log(USAGE); return 0; }
  if (!options.migration) { console.error(`error: no migration file given\n\n${USAGE}`); return 2; }
  if (!options.databaseUrl) { console.error('error: no database. Pass --database-url or set DATABASE_URL.'); return 2; }
  if (!isLocalHost(options.databaseUrl) && !options.allowRemote) {
    console.error('error: refusing a non-local database host. AGENTS.md 4.12 says database work is staging only. Pass --allow-remote if this really is staging.');
    return 2;
  }

  const migrationPath = resolve(options.migration);
  let sql;
  try {
    sql = await readFile(migrationPath, 'utf8');
  } catch (error) {
    console.error(`error: cannot read ${migrationPath}: ${error.message}`);
    return 2;
  }

  const functions = parseMigrationFunctions(sql);
  if (!functions.length) {
    console.error(`error: ${migrationPath} creates, replaces or drops no function. Nothing to generate.`);
    return 2;
  }

  let history;
  let live;
  try {
    history = readHistory(options.databaseUrl, functions);
    live = readLive(options.databaseUrl, functions);
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }

  const plan = planRollback({ functions, history, live, before: options.before });
  const migrationName = migrationPath.split('/').pop();
  const output = buildRollbackSql({ migrationName, ...plan });

  if (plan.missing.length || plan.dropped.length) {
    console.error(`error: cannot write a complete rollback for ${migrationName}`);
    for (const fn of plan.missing) {
      console.error(`  missing history: public.${fn.key} still exists but no older body was recorded (${fn.recorded} row(s) found, all equal to the live body)`);
    }
    for (const fn of plan.dropped) {
      console.error(`  dropped: public.${fn.key} does not exist and was never recorded`);
    }
    console.error('  Nothing was written. Record the body with public.dua_capture_function() before the change, then regenerate.');
    return 1;
  }

  if (options.dryRun) {
    process.stdout.write(output);
    return 0;
  }

  const outPath = options.out ? resolve(options.out) : join(dirname(migrationPath), migrationName.replace(/\.sql$/, '.rollback.sql'));
  if (!options.force) {
    try {
      await access(outPath);
      console.error(`error: ${outPath} already exists. Pass --force to overwrite.`);
      return 2;
    } catch { /* absent, which is what we want */ }
  }
  await writeFile(outPath, output, 'utf8');
  console.log(`wrote ${outPath} (${plan.restores.length} function(s) restored)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`error: ${error.message}`);
    process.exitCode = 2;
  });
}
