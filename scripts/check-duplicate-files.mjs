#!/usr/bin/env node
// Duplicate-file guard for the dua-backend repository.
//
// Why this exists: docs drift in this repo has repeatedly produced a second
// home for the same fact (a ROADMAP.md next to MASTER_PLAN.md, a CLAUDE.md
// next to AGENTS.md, a copied prompt JSON). One fact, one file. This script
// fails CI when a second home appears.
//
// Usage:
//   node scripts/check-duplicate-files.mjs
//   node scripts/check-duplicate-files.mjs --verbose
//   node scripts/check-duplicate-files.mjs --json
//
// Exit codes: 0 = no blocking duplicate, 1 = at least one blocking duplicate,
// 2 = the script itself could not run.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = new Set(process.argv.slice(2));
const VERBOSE = argv.has('--verbose') || argv.has('-v');
const AS_JSON = argv.has('--json');

// Directories that are never part of the source tree we police.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '__pycache__', '.venv', 'venv']);

// ---------------------------------------------------------------------------
// Allowlist. Every entry needs a reason. `severity: 'warn'` means the finding
// is real but already known and tracked elsewhere, so it is printed and does
// not fail the build. `severity: 'ok'` means it is not a duplicate at all
// (per-app config files, re-export shims, third-party licences).
// ---------------------------------------------------------------------------
const ALLOWLIST = [
  // --- per-app / per-package config files: same name, different owner ------
  { check: 'same-name', name: '.gitignore', severity: 'ok', reason: 'one per package root; each ignores that package only' },
  { check: 'same-name', name: '.dockerignore', severity: 'ok', reason: 'one per Docker build context' },
  { check: 'same-name', name: '.gcloudignore', severity: 'ok', reason: 'one per Cloud Run service' },
  { check: 'same-name', name: '.env.example', severity: 'ok', reason: 'one per service; each documents that service env' },
  { check: 'same-name', name: 'Dockerfile', severity: 'ok', reason: 'one per deployable service' },
  { check: 'same-name', name: 'requirements.txt', severity: 'ok', reason: 'api engine and coding-runner have separate dependency sets' },
  { check: 'same-name', name: '__init__.py', severity: 'ok', reason: 'Python package marker, one per package by definition' },
  { check: 'same-name', name: 'routes.py', severity: 'ok', reason: 'one router per engine sub-package (agent, chat, orhan)' },
  { check: 'same-name', name: 'LICENSE', severity: 'ok', reason: 'root project licence plus a vendored third-party licence' },
  { check: 'same-name', name: 'README.md', severity: 'ok', reason: 'root project README plus apps/api/scripts/README.md for the scripts folder' },
  { check: 'same-name', name: 'agent_automation.py', severity: 'ok', reason: 'dua_engine/agent copy is a 230 B re-export shim, not a second implementation' },
  { check: 'same-name', name: 'automation_companion.py', severity: 'ok', reason: 'apps/ai-engine copy is a 347 B re-export shim' },
  { check: 'same-name', name: 'coding_runner_server.py', severity: 'ok', reason: 'apps/ai-engine copy is a 230 B re-export shim' },

  // --- known real duplicates, tracked, removal needs an owner decision -----
  {
    check: 'same-name',
    name: 'dua_agent_prompts.json',
    severity: 'warn',
    reason: 'known duplicate, tracked as P10 in WORK_CHECKLIST.md; deleting one needs an owner decision',
  },
  {
    check: 'same-content',
    paths: ['apps/ai-engine/dua_engine/agent/dua_agent_prompts.json', 'apps/api/src/core/dua_agent_prompts.json'],
    severity: 'warn',
    reason: 'known duplicate (100 KB, byte identical), tracked as P10 in WORK_CHECKLIST.md; deleting one needs an owner decision',
  },
];

// ---------------------------------------------------------------------------
// Topic map: one fact, one home. A second file whose basename or H1 claims the
// same topic is a duplicate home even when the text differs.
// ---------------------------------------------------------------------------
const TOPICS = [
  { topic: 'roadmap', canonical: 'docs/MASTER_PLAN.md', namePattern: /^(roadmap|master[_-]?plan|plan)\.md$/i, h1Pattern: /roadmap|master plan/i },
  { topic: 'architecture', canonical: 'docs/ARCHITECTURE.md', namePattern: /^architecture\.md$/i, h1Pattern: /architecture/i },
  { topic: 'contributing', canonical: 'CONTRIBUTING.md', namePattern: /^contributing\.md$/i, h1Pattern: /^contributing/i },
  { topic: 'agent instructions', canonical: 'AGENTS.md', namePattern: /^(agents|claude|gemini|copilot)\.md$/i, h1Pattern: /^(agents|claude|gemini|copilot)/i },
  { topic: 'security policy', canonical: 'SECURITY.md', namePattern: /^security\.md$/i, h1Pattern: /^security/i },
  { topic: 'api contract', canonical: 'API_CONTRACT.md', namePattern: /^(api[_-]?contract|api)\.md$/i, h1Pattern: /api contract/i },
];

// Dated audit records are evidence, not a second home for a topic. A file under
// docs/audits/ whose name starts with a date is a point-in-time record and is
// excluded from the same-topic check (it may quote a roadmap, it does not own it).
const DATED_RECORD = /^docs\/audits\/\d{4}-\d{2}-\d{2}-/;

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

const rel = (p) => relative(REPO_ROOT, p).split(sep).join('/');

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function firstH1(text) {
  for (const line of text.split('\n')) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------
const findings = []; // { check, severity, title, detail, paths }

function allowFor(check, key) {
  return ALLOWLIST.find((a) => {
    if (a.check !== check) return false;
    if (a.name) return a.name === key;
    if (a.paths) return a.paths.slice().sort().join('|') === key;
    return false;
  });
}

function addFinding(check, severity, title, detail, paths) {
  findings.push({ check, severity, title, detail, paths });
}

// --- Check 1: same basename in more than one place -------------------------
function checkSameName(files) {
  const byName = new Map();
  for (const f of files) {
    const n = basename(f);
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(f);
  }
  for (const [name, group] of [...byName.entries()].sort()) {
    if (group.length < 2) continue;
    const allow = allowFor('same-name', name);
    const paths = group.map(rel).sort();
    if (allow) {
      if (allow.severity === 'warn') {
        addFinding('same-name', 'warn', `same file name: ${name}`, allow.reason, paths);
      } else if (VERBOSE) {
        addFinding('same-name', 'ok', `same file name: ${name}`, allow.reason, paths);
      }
      continue;
    }
    addFinding(
      'same-name',
      'fail',
      `same file name in ${group.length} places: ${name}`,
      'one file name should have one home; rename or move the second copy, or add an allowlist entry with a reason',
      paths,
    );
  }
}

// --- Check 2: byte-identical content --------------------------------------
function checkSameContent(files) {
  const byHash = new Map();
  for (const f of files) {
    let st;
    try {
      st = statSync(f);
    } catch {
      continue;
    }
    if (st.size === 0) continue; // empty files are not interesting
    const buf = readFileSync(f);
    const h = sha256(buf);
    if (!byHash.has(h)) byHash.set(h, { size: st.size, files: [] });
    byHash.get(h).files.push(f);
  }
  for (const [hash, group] of byHash) {
    if (group.files.length < 2) continue;
    const paths = group.files.map(rel).sort();
    const key = paths.join('|');
    const allow = allowFor('same-content', key);
    if (allow) {
      if (allow.severity === 'warn') {
        addFinding('same-content', 'warn', `byte-identical files (${group.size} B)`, allow.reason, paths);
      } else if (VERBOSE) {
        addFinding('same-content', 'ok', `byte-identical files (${group.size} B)`, allow.reason, paths);
      }
      continue;
    }
    addFinding(
      'same-content',
      'fail',
      `byte-identical files (${group.size} B, sha256 ${hash.slice(0, 12)})`,
      'two files with the same bytes are one file with two homes; keep one and import or link the other',
      paths,
    );
  }
}

// --- Check 3: two docs claiming the same topic ----------------------------
function checkSameTopic(files) {
  const mdFiles = files.filter((f) => f.toLowerCase().endsWith('.md'));
  for (const t of TOPICS) {
    const claimants = [];
    for (const f of mdFiles) {
      const r = rel(f);
      if (DATED_RECORD.test(r)) continue; // point-in-time record, not a topic home
      const name = basename(f);
      let text = '';
      try {
        text = readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      const h1 = firstH1(text);
      const nameHit = t.namePattern.test(name);
      const h1Hit = h1 ? t.h1Pattern.test(h1) : false;
      if (nameHit || h1Hit) claimants.push({ path: r, name, h1, nameHit, h1Hit });
    }
    if (claimants.length < 2) continue;
    const canonical = claimants.find((c) => c.path === t.canonical);
    const others = claimants.filter((c) => c.path !== t.canonical);
    if (!canonical) {
      addFinding(
        'same-topic',
        'fail',
        `topic "${t.topic}" has ${claimants.length} homes and none is the canonical ${t.canonical}`,
        'the canonical file is missing or renamed; restore it or update TOPICS in this script',
        claimants.map((c) => c.path).sort(),
      );
      continue;
    }
    for (const o of others) {
      const why = o.nameHit ? `file name "${o.name}"` : `H1 "${o.h1}"`;
      addFinding(
        'same-topic',
        'fail',
        `topic "${t.topic}" has a second home: ${o.path}`,
        `${why} claims the same topic as ${t.canonical}; put the content in ${t.canonical} and delete the second file`,
        [t.canonical, o.path].sort(),
      );
    }
  }
}

// --- Check 4: near-identical .md files (copy with small edits) ------------
function normaliseLines(text) {
  return new Set(
    text
      .split('\n')
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l.length > 0),
  );
}

function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function checkNearDuplicateMd(files) {
  const mdFiles = files.filter((f) => f.toLowerCase().endsWith('.md'));
  const docs = [];
  for (const f of mdFiles) {
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const lines = normaliseLines(text);
    if (lines.size < 25) continue; // too short to judge
    docs.push({ path: rel(f), lines });
  }
  const THRESHOLD = 0.8;
  for (let i = 0; i < docs.length; i += 1) {
    for (let j = i + 1; j < docs.length; j += 1) {
      const score = jaccard(docs[i].lines, docs[j].lines);
      if (score < THRESHOLD) continue;
      addFinding(
        'near-duplicate-md',
        'fail',
        `two .md files are ${(score * 100).toFixed(0)}% the same lines`,
        `above the ${THRESHOLD * 100}% copy threshold; one of them should link to the other instead of repeating it`,
        [docs[i].path, docs[j].path].sort(),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
let files;
try {
  files = walk(REPO_ROOT);
} catch (err) {
  console.error(`check-duplicate-files: cannot read the repository: ${err.message}`);
  process.exit(2);
}

checkSameName(files);
checkSameContent(files);
checkSameTopic(files);
checkNearDuplicateMd(files);

const failing = findings.filter((f) => f.severity === 'fail');
const warning = findings.filter((f) => f.severity === 'warn');
const ok = findings.filter((f) => f.severity === 'ok');

if (AS_JSON) {
  console.log(JSON.stringify({ filesScanned: files.length, failing, warning, ok }, null, 2));
} else {
  console.log(`check-duplicate-files: scanned ${files.length} files under ${rel(REPO_ROOT) || '.'}`);
  console.log(`checks: same-name, same-content, same-topic, near-duplicate-md`);
  console.log('');

  if (failing.length === 0) {
    console.log('PASS: no blocking duplicate found.');
  } else {
    console.log(`FAIL: ${failing.length} blocking duplicate(s).`);
    console.log('');
    failing.forEach((f, i) => {
      console.log(`${i + 1}. [${f.check}] ${f.title}`);
      console.log(`   why: ${f.detail}`);
      f.paths.forEach((p) => console.log(`   - ${p}`));
      console.log('');
    });
  }

  if (warning.length > 0) {
    console.log(`WARN: ${warning.length} known duplicate(s), allowed but still real.`);
    warning.forEach((f) => {
      console.log(`  [${f.check}] ${f.title}`);
      console.log(`   reason: ${f.detail}`);
      f.paths.forEach((p) => console.log(`   - ${p}`));
    });
    console.log('');
  }

  if (VERBOSE && ok.length > 0) {
    console.log(`OK: ${ok.length} allowlisted non-duplicate(s).`);
    ok.forEach((f) => {
      console.log(`  [${f.check}] ${f.title}`);
      console.log(`   reason: ${f.detail}`);
      f.paths.forEach((p) => console.log(`   - ${p}`));
    });
    console.log('');
  }

  console.log(`summary: ${failing.length} fail, ${warning.length} warn, ${ok.length} allowlisted`);
}

process.exit(failing.length > 0 ? 1 : 0);
