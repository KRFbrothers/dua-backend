import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const agents = read('../../../AGENTS.md');
const readme = read('../../../README.md');
const contract = read('../../../API_CONTRACT.md');
const checks = read('../../../.github/workflows/checks.yml');
const pkg = JSON.parse(read('../package.json'));

const ROUTES = [
  ['direct_reply', 'POST /api/chat'],
  ['create_task', 'POST /api/orhan/tasks'],
  ['get_task_status', 'GET /api/orhan/tasks/:id'],
  ['stop_task', 'POST /api/orhan/tasks/:id/cancel']
];
const STATUSES = ['queued', 'running', 'completed', 'failed', 'stopped', 'timed_out'];

const routeRow = (action, route) => new RegExp(`\\| \`${action}\` \\| \`${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\` \\|`);

test('AGENTS.md keeps the four control-plane actions, task statuses, and the master plan link', () => {
  assert.match(agents, /\[`docs\/MASTER_PLAN\.md`\]\(docs\/MASTER_PLAN\.md\)/);
  assert.match(agents, /## Initial Control-Plane Actions/);
  for (const [action] of ROUTES) assert.match(agents, new RegExp(`- \`${action}\``));
  assert.match(agents, /## Task Requirements/);
  for (const status of STATUSES) assert.match(agents, new RegExp(`- \`${status}\``));
});

test('README and the API contract keep the control-plane route table', () => {
  for (const [action, route] of ROUTES) {
    assert.match(readme, routeRow(action, route), action);
    assert.match(contract, routeRow(action, route), action);
  }
});

test('backend CI runs this suite, so an AGENTS.md drift fails the pull request', () => {
  assert.match(checks, /working-directory: apps\/api/);
  assert.match(checks, /npm run test:ci/);
  assert.match(pkg.scripts['test:ci'], /test\/\*\*\/\*\.test\.mjs/);
});
