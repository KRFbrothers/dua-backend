import test from 'node:test';
import assert from 'node:assert/strict';
import { handleService } from '../src/server/service-handler.mjs';
import { OFFICIAL_AGENTS, getStarterSkills, SLUG_REGEX } from '../src/core/agents-skills.mjs';
import { filesEnv, router, SUPA, UID, OTHER } from './files-helpers.mjs';

const env = { ...filesEnv, GEMINI_API_KEY: 'test-gemini-key', GEMINI_MODEL: 'gemini-3.8-flash' };
const workflowEnv = { ...env, DUA_WORKFLOWS_ENABLED: '1' };

function call(method, path, body, { token = 'user-token', headers = {} } = {}) {
  return new Request('https://dua.test' + path, {
    method,
    headers: {
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}

function database() {
  const agents = [];
  const skills = [];
  const instructions = [];
  const triggers = [];
  const notifications = [];
  const deviceTokens = [];
  const enqueued = [];
  let clock = Date.parse('2026-11-19T00:00:00Z');
  const stamp = () => new Date(clock += 1000).toISOString();
  const ownerOf = init => new Headers(init.headers).get('authorization') === 'Bearer user-token' ? UID : 'nobody';
  const eq = (query, name) => query.get(name)?.replace(/^eq\./, '');

  const filter = (rows, query, owner) => rows.filter(row => {
    if (row.owner_id !== owner) return false;
    for (const name of ['id', 'owner_id', 'agent_id']) {
      if (query.has(name) && row[name] !== eq(query, name)) return false;
    }
    return true;
  });

  const sort = (rows, order) => {
    const keys = (order || '').split(',').filter(Boolean).map(part => part.split('.'));
    return [...rows].sort((a, b) => {
      for (const [key, direction] of keys) {
        const x = a[key] === true ? 1 : a[key] === false ? 0 : a[key];
        const y = b[key] === true ? 1 : b[key] === false ? 0 : b[key];
        if (x < y) return direction === 'desc' ? 1 : -1;
        if (x > y) return direction === 'desc' ? -1 : 1;
      }
      return 0;
    });
  };

  const tables = {
    dua_agents: agents,
    dua_agent_skills: skills,
    dua_agent_instructions: instructions,
    dua_agent_triggers: triggers,
    dua_notifications: notifications,
    dua_device_tokens: deviceTokens,
  };

  const routes = [
    [url => url === `${SUPA}/rest/v1/rpc/dua_workflow_enqueue`, (url, init) => {
      const headers = new Headers(init.headers);
      if (headers.get('authorization') !== 'Bearer user-token' || headers.get('apikey') === env.SUPABASE_SERVICE_ROLE_KEY)
        return Response.json({ message: 'denied' }, { status: 401 });
      const body = JSON.parse(init.body);
      if (body.p_owner !== UID) return Response.json({ message: 'denied' }, { status: 403 });
      if (enqueued.some(run => run.workflow_id === body.p_workflow && run.status === 'queued'))
        return Response.json({ message: 'workflow_active' }, { status: 409 });
      const run = { id: crypto.randomUUID(), owner_id: body.p_owner, workflow_id: body.p_workflow, title: body.p_title, request_key: body.p_key,
        definition: body.p_definition, status: 'queued', attempt: 1, steps: [] };
      enqueued.push(run);
      return Response.json(run);
    }],
    [url => url.startsWith(`${SUPA}/rest/v1/`), (url, init) => {
      const parsed = new URL(url);
      const table = parsed.pathname.split('/').pop();
      const rows = tables[table];
      if (!rows) return Response.json({ error: 'not found' }, { status: 404 });
      const query = parsed.searchParams;
      const owner = ownerOf(init);
      const method = init.method || 'GET';
      const headers = new Headers(init.headers);

      // Verify that database calls use user token + anon key, never service_role key
      if (headers.get('apikey') === env.SUPABASE_SERVICE_ROLE_KEY) {
        return Response.json({ error: 'Service role key not allowed on user tables!' }, { status: 500 });
      }

      if (method === 'GET') {
        return Response.json(sort(filter(rows, query, owner), query.get('order')));
      }

      if (method === 'POST') {
        const body = JSON.parse(init.body);
        if (body.owner_id !== owner) return Response.json({ message: 'row-level security' }, { status: 403 });

        const prefer = headers.get('prefer') || '';
        const isUpsert = prefer.includes('resolution=merge-duplicates');
        const existingIdx = body.id ? rows.findIndex(r => r.id === body.id && r.owner_id === body.owner_id) : -1;

        if (existingIdx >= 0) {
          if (isUpsert) {
            rows[existingIdx] = { ...rows[existingIdx], ...body, updated_at: stamp() };
            return Response.json([rows[existingIdx]], { status: 200 });
          }
          return Response.json({ message: 'duplicate key' }, { status: 409 });
        }

        const row = { id: crypto.randomUUID(), created_at: stamp(), updated_at: stamp(), ...body };
        rows.push(row);
        return Response.json([row], { status: 201 });
      }

      if (method === 'PATCH') {
        const changed = filter(rows, query, owner);
        const patch = JSON.parse(init.body);
        for (const row of changed) Object.assign(row, patch, { updated_at: stamp() });
        return Response.json(changed);
      }

      if (method === 'DELETE') {
        const removed = filter(rows, query, owner);
        for (const row of removed) {
          const idx = rows.indexOf(row);
          if (idx >= 0) rows.splice(idx, 1);
        }
        return Response.json(removed);
      }

      return Response.json({ error: 'unexpected method' }, { status: 500 });
    }],
    [url => url.includes('generativelanguage.googleapis.com'), (url, init) => {
      // The Gemini key travels only in the x-goog-api-key header, never in the URL.
      if (new URL(url).search !== '' || new Headers(init.headers).get('x-goog-api-key') !== env.GEMINI_API_KEY)
        return Response.json({ error: 'Gemini key must be sent only in the x-goog-api-key header' }, { status: 400 });
      const body = JSON.parse(init.body);
      const text = body.contents?.[0]?.parts?.[0]?.text || '';
      if (text.includes('system prompt')) {
        return Response.json({
          candidates: [{ content: { parts: [{ text: 'You are a specialized test agent assistant.' }] } }]
        });
      }
      if (text.includes('specialized skill specification')) {
        return Response.json({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  title: 'Generated Skill',
                  summary: 'A generated skill for testing.',
                  body: '# Generated Skill\n\nInstructions here.'
                })
              }]
            }
          }]
        });
      }
      return Response.json({ candidates: [{ content: { parts: [{ text: 'Generic reply' }] } }] });
    }]
  ];

  return { agents, skills, instructions, triggers, notifications, deviceTokens, enqueued, routes };
}

test('starter skills load from dua_agent_prompts.json and official agents are defined', () => {
  const starters = getStarterSkills();
  assert.equal(starters.length, 5);
  const starterIds = starters.map(s => s.id);
  assert.deepEqual(starterIds, ['frontend-developer', 'backend-architect', 'api-tester', 'devops-automator', 'code-reviewer']);

  assert.equal(OFFICIAL_AGENTS.length, 1);
  assert.equal(OFFICIAL_AGENTS[0].id, 'dua-work');
  assert.equal(OFFICIAL_AGENTS[0].name, 'Dua Work');
  assert.equal(OFFICIAL_AGENTS[0].description, 'Fast everyday chat, tools, skills, and multi-step execution.');
  assert.equal(OFFICIAL_AGENTS[0].mode, 'agent');
  assert.equal(OFFICIAL_AGENTS[0].pinned, true);
  assert.equal(OFFICIAL_AGENTS[0].isOfficial, true);

  assert.ok(SLUG_REGEX.test('frontend-developer'));
  assert.ok(SLUG_REGEX.test('my-agent-1'));
  assert.ok(!SLUG_REGEX.test('My Agent'));
  assert.ok(!SLUG_REGEX.test('-leading-dash'));
});

test('GET /api/agents returns official agents merged with custom agents', async () => {
  const db = database();
  const fetcher = router(db.routes);

  const res = await handleService(call('GET', '/api/agents'), { env, fetcher });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.agents.length, 1);
  assert.equal(data.agents[0].id, 'dua-work');
  assert.equal(data.agents[0].name, 'Dua Work');
  assert.equal(data.agents[0].isOfficial, true);
  assert.equal(data.agents[0].pinned, true);
});

test('POST /api/agents creates a custom agent and rejects invalid or official ids', async () => {
  const db = database();
  const fetcher = router(db.routes);

  // Reject official id
  const badOfficial = await handleService(call('POST', '/api/agents', { id: 'dua-work', name: 'Fake' }), { env, fetcher });
  assert.equal(badOfficial.status, 400);

  // Reject invalid mode
  const badMode = await handleService(call('POST', '/api/agents', { name: 'Agent', mode: 'invalid' }), { env, fetcher });
  assert.equal(badMode.status, 400);

  // Create valid agent
  const res = await handleService(call('POST', '/api/agents', {
    name: 'Code Reviewer Pro',
    description: 'Expert reviewer',
    mode: 'auto',
    systemPrompt: 'Review carefully.'
  }), { env, fetcher });
  assert.equal(res.status, 201);
  const created = (await res.json()).agent;
  assert.equal(created.name, 'Code Reviewer Pro');
  assert.equal(created.id, 'code-reviewer-pro');
  assert.equal(created.isOfficial, false);

  // GET /api/agents now has the official agent plus the custom one
  const list = await (await handleService(call('GET', '/api/agents'), { env, fetcher })).json();
  assert.equal(list.agents.length, 2);
});

test('GET /api/agents/:id returns agent details or 404', async () => {
  const db = database();
  const fetcher = router(db.routes);

  // Official agent returns without DB record
  const official = await handleService(call('GET', '/api/agents/dua-work'), { env, fetcher });
  assert.equal(official.status, 200);
  assert.equal((await official.json()).agent.id, 'dua-work');

  // Unknown agent returns 404
  const unknown = await handleService(call('GET', '/api/agents/unknown-agent'), { env, fetcher });
  assert.equal(unknown.status, 404);
});

test('PUT and DELETE /api/agents/:id respects official protection', async () => {
  const db = database();
  const fetcher = router(db.routes);

  // Official agent cannot be deleted
  const delOfficial = await handleService(call('DELETE', '/api/agents/dua-work'), { env, fetcher });
  assert.equal(delOfficial.status, 400);

  // Official agent can be customized via PUT
  const putOfficial = await handleService(call('PUT', '/api/agents/dua-work', {
    description: 'Customized Dua Work',
    systemPrompt: 'Be super helpful.'
  }), { env, fetcher });
  assert.equal(putOfficial.status, 200);
  const updatedOfficial = (await putOfficial.json()).agent;
  assert.equal(updatedOfficial.description, 'Customized Dua Work');
  assert.equal(updatedOfficial.systemPrompt, 'Be super helpful.');

  // Custom agent create, update, delete
  await handleService(call('POST', '/api/agents', { id: 'test-agent', name: 'Test Agent' }), { env, fetcher });
  const putCustom = await handleService(call('PUT', '/api/agents/test-agent', { name: 'Renamed Test' }), { env, fetcher });
  assert.equal(putCustom.status, 200);
  assert.equal((await putCustom.json()).agent.name, 'Renamed Test');

  const delCustom = await handleService(call('DELETE', '/api/agents/test-agent'), { env, fetcher });
  assert.equal(delCustom.status, 204);

  const getDeleted = await handleService(call('GET', '/api/agents/test-agent'), { env, fetcher });
  assert.equal(getDeleted.status, 404);
});

test('GET /api/skills returns starter skills merged with custom skills and overrides', async () => {
  const db = database();
  const fetcher = router(db.routes);

  const res = await handleService(call('GET', '/api/skills'), { env, fetcher });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.skills.length, 5);
  assert.equal(data.skills[0].id, 'frontend-developer');
  assert.equal(data.skills[0].isStarter, true);
  assert.equal(data.skills[0].enabled, true);
});

test('POST, PUT, and DELETE /api/skills handles starter and custom skills correctly', async () => {
  const db = database();
  const fetcher = router(db.routes);

  // POST with starter id is rejected
  const badPost = await handleService(call('POST', '/api/skills', { id: 'frontend-developer', title: 'New Frontend' }), { env, fetcher });
  assert.equal(badPost.status, 409);

  // POST custom skill
  const postCustom = await handleService(call('POST', '/api/skills', {
    title: 'Database Tuner',
    summary: 'Optimizes SQL queries',
    body: 'Tune Postgres queries and indexes.'
  }), { env, fetcher });
  assert.equal(postCustom.status, 201);
  const skill = (await postCustom.json()).skill;
  assert.equal(skill.id, 'database-tuner');
  assert.equal(skill.isStarter, false);

  // PUT starter skill to disable it
  const putStarter = await handleService(call('PUT', '/api/skills/frontend-developer', { enabled: false }), { env, fetcher });
  assert.equal(putStarter.status, 200);
  assert.equal((await putStarter.json()).skill.enabled, false);

  // DELETE starter skill is rejected
  const delStarter = await handleService(call('DELETE', '/api/skills/frontend-developer'), { env, fetcher });
  assert.equal(delStarter.status, 400);

  // DELETE custom skill succeeds
  const delCustom = await handleService(call('DELETE', '/api/skills/database-tuner'), { env, fetcher });
  assert.equal(delCustom.status, 204);
});

test('POST /api/agents/generate-prompt generates system prompt using AI', async () => {
  const db = database();
  const fetcher = router(db.routes);

  const res = await handleService(call('POST', '/api/agents/generate-prompt', {
    name: 'Python Pro',
    description: 'Expert Python software engineer'
  }), { env, fetcher });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.systemPrompt);
  assert.match(data.systemPrompt, /specialized test agent assistant/);
});

test('POST /api/skills/generate generates skill specification using AI', async () => {
  const db = database();
  const fetcher = router(db.routes);

  const res = await handleService(call('POST', '/api/skills/generate', {
    title: 'Android Architect',
    description: 'Specialist in Android Architecture Components and Jetpack Compose'
  }), { env, fetcher });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.skill);
  assert.equal(data.skill.title, 'Generated Skill');
  assert.equal(data.skill.summary, 'A generated skill for testing.');
  assert.match(data.skill.body, /# Generated Skill/);
});

test('Security & owner lock: non-owner and unauthenticated access are blocked', async () => {
  const db = database();
  const fetcher = router(db.routes);

  // Unauthenticated -> 401
  const noAuth = await handleService(call('GET', '/api/agents', undefined, { token: '' }), { env, fetcher });
  assert.equal(noAuth.status, 401);

  // Non-owner email -> 403
  const badOwnerFetcher = router(db.routes, { email: 'stranger@example.com' });
  const forbidden = await handleService(call('GET', '/api/agents'), { env, fetcher: badOwnerFetcher });
  assert.equal(forbidden.status, 403);
});

// ─── Phase 4C: Proactive Agents (Instructions & Triggers) ─────────────────────

test('Phase 4C: Proactive Agents — Instructions CRUD (GET, POST, PUT, DELETE)', async () => {
  const db = database();
  const fetcher = router(db.routes);

  // 1. POST instruction
  const postRes = await handleService(call('POST', '/api/agents/dua-work/instructions', {
    instruction: 'Always format Kotlin code with official style guidelines',
    isActive: true,
  }), { env, fetcher });
  assert.equal(postRes.status, 201);
  const { instruction } = await postRes.json();
  assert.ok(instruction.id);
  assert.equal(instruction.agentId, 'dua-work');
  assert.equal(instruction.instruction, 'Always format Kotlin code with official style guidelines');
  assert.equal(instruction.isActive, true);

  // 2. GET instructions list
  const listRes = await handleService(call('GET', '/api/agents/dua-work/instructions'), { env, fetcher });
  assert.equal(listRes.status, 200);
  const listJson = await listRes.json();
  assert.equal(listJson.instructions.length, 1);
  assert.equal(listJson.instructions[0].id, instruction.id);

  // 3. GET single instruction
  const getSingle = await handleService(call('GET', `/api/agents/dua-work/instructions/${instruction.id}`), { env, fetcher });
  assert.equal(getSingle.status, 200);
  assert.equal((await getSingle.json()).instruction.id, instruction.id);

  // 4. PUT instruction (deactivate)
  const putRes = await handleService(call('PUT', `/api/agents/dua-work/instructions/${instruction.id}`, {
    isActive: false,
  }), { env, fetcher });
  assert.equal(putRes.status, 200);
  assert.equal((await putRes.json()).instruction.isActive, false);

  // 5. DELETE instruction
  const delRes = await handleService(call('DELETE', `/api/agents/dua-work/instructions/${instruction.id}`), { env, fetcher });
  assert.equal(delRes.status, 204);

  // 6. Verify empty list
  const emptyList = await handleService(call('GET', '/api/agents/dua-work/instructions'), { env, fetcher });
  assert.equal(emptyList.status, 200);
  assert.equal((await emptyList.json()).instructions.length, 0);
});

test('Phase 4C: Proactive Agents — Triggers CRUD & Run (GET, POST, PUT, DELETE, POST /run)', async () => {
  const db = database();
  const fetcher = router(db.routes);

  // 1. POST trigger
  const postRes = await handleService(call('POST', '/api/agents/dua-work/triggers', {
    triggerType: 'schedule',
    cronExpr: '0 9 * * 1-5',
    prompt: 'Summarize unread GitHub PRs and morning tasks',
    enabled: true,
  }), { env, fetcher });
  assert.equal(postRes.status, 201);
  const { trigger } = await postRes.json();
  assert.ok(trigger.id);
  assert.equal(trigger.agentId, 'dua-work');
  assert.equal(trigger.triggerType, 'schedule');
  assert.equal(trigger.cronExpr, '0 9 * * 1-5');
  assert.equal(trigger.prompt, 'Summarize unread GitHub PRs and morning tasks');
  assert.equal(trigger.enabled, true);
  assert.equal(trigger.lastRunAt, null);

  // 2. GET triggers list
  const listRes = await handleService(call('GET', '/api/agents/dua-work/triggers'), { env, fetcher });
  assert.equal(listRes.status, 200);
  const listJson = await listRes.json();
  assert.equal(listJson.triggers.length, 1);
  assert.equal(listJson.triggers[0].id, trigger.id);

  // 3. GET single trigger
  const getSingle = await handleService(call('GET', `/api/agents/dua-work/triggers/${trigger.id}`), { env, fetcher });
  assert.equal(getSingle.status, 200);
  assert.equal((await getSingle.json()).trigger.id, trigger.id);

  // 4. PUT trigger (update cron and prompt)
  const putRes = await handleService(call('PUT', `/api/agents/dua-work/triggers/${trigger.id}`, {
    cronExpr: '0 10 * * 1-5',
    prompt: 'Updated morning summary',
  }), { env, fetcher });
  assert.equal(putRes.status, 200);
  const updatedTrigger = (await putRes.json()).trigger;
  assert.equal(updatedTrigger.cronExpr, '0 10 * * 1-5');
  assert.equal(updatedTrigger.prompt, 'Updated morning summary');

  // 5. POST run trigger manually
  const runRes = await handleService(call('POST', `/api/agents/dua-work/triggers/${trigger.id}/run`), { env: workflowEnv, fetcher });
  assert.equal(runRes.status, 200);
  const runJson = await runRes.json();
  assert.equal(runJson.triggered, true);
  assert.ok(runJson.trigger.lastRunAt);
  assert.deepEqual(runJson.push, { dispatched: false, reason: 'queued', count: 0 });
  assert.equal(runJson.status, 'queued');
  assert.ok(runJson.runId);

  // 6. DELETE trigger
  const delRes = await handleService(call('DELETE', `/api/agents/dua-work/triggers/${trigger.id}`), { env, fetcher });
  assert.equal(delRes.status, 204);

  // 7. Verify empty list
  const emptyList = await handleService(call('GET', '/api/agents/dua-work/triggers'), { env, fetcher });
  assert.equal(emptyList.status, 200);
  assert.equal((await emptyList.json()).triggers.length, 0);
});

test('K6: trigger run queues a real agent run for the worker and sends no push at request time', async () => {
  const db = database();
  db.agents.push({ id: 'research-bot', owner_id: UID, name: 'Research Bot', system_prompt: 'You are Research Bot.' });
  const fetcher = router([
    ...db.routes,
    [url => url.includes('fcm.googleapis.com') || url.includes('generativelanguage.googleapis.com'), () => { throw new Error('no provider or push at request time'); }],
  ]);
  const conversationId = '11111111-2222-4333-8444-555555555555';
  db.triggers.push({ id: '22222222-3333-4444-8555-666666666666', owner_id: UID, agent_id: 'research-bot', conversation_id: conversationId,
    trigger_type: 'schedule', cron_expr: '0 9 * * *', prompt: 'Morning research digest', enabled: true, last_run_at: null, created_at: '2026-11-19T00:00:00Z' });
  db.deviceTokens.push({ owner_id: UID, token: 'device-fcm-token', platform: 'android' });

  const runRes = await handleService(call('POST', '/api/agents/research-bot/triggers/22222222-3333-4444-8555-666666666666/run', { source: { type: 'agent_trigger', triggerId: 'forged' } }),
    { env: { ...workflowEnv, FCM_PROJECT_ID: 'dua-project', FCM_ACCESS_TOKEN: 'ya29.test' }, fetcher });
  assert.equal(runRes.status, 200);
  const runJson = await runRes.json();
  assert.deepEqual(runJson.push, { dispatched: false, reason: 'queued', count: 0 });
  assert.equal(runJson.status, 'queued');
  assert.equal(runJson.runId, db.enqueued[0].id);
  assert.equal(db.notifications.length, 0);
  assert.ok(db.triggers[0].last_run_at);

  const run = db.enqueued[0];
  assert.equal(run.workflow_id, 'agent-trigger:22222222-3333-4444-8555-666666666666');
  assert.match(run.request_key, /^run:22222222-3333-4444-8555-666666666666:\d+$/);
  assert.equal(run.title, 'Trigger: Research Bot');
  assert.deepEqual(run.definition.source, { type: 'agent_trigger', triggerId: '22222222-3333-4444-8555-666666666666', triggerType: 'schedule', agentId: 'research-bot', conversationId });
  assert.equal(run.definition.steps.length, 1);
  assert.equal(run.definition.steps[0].prompt, 'Morning research digest');
  assert.equal(run.definition.steps[0].agentId, 'research-bot');
  assert.deepEqual(run.definition.steps[0].allowedTools, ['fetch_url', 'google_search', 'search_documents', 'search_notes']);

  // A second run while the first is still active is refused, not duplicated.
  const again = await handleService(call('POST', '/api/agents/research-bot/triggers/22222222-3333-4444-8555-666666666666/run'), { env: workflowEnv, fetcher });
  assert.equal(again.status, 409);
  assert.equal(db.enqueued.length, 1);
});

test('K6: trigger run needs the workflow worker flag and never enqueues without it', async () => {
  const db = database();
  const fetcher = router(db.routes);
  const created = await handleService(call('POST', '/api/agents/dua-work/triggers', { triggerType: 'webhook', prompt: 'Pending summary' }), { env, fetcher });
  const { trigger } = await created.json();
  const res = await handleService(call('POST', `/api/agents/dua-work/triggers/${trigger.id}/run`), { env, fetcher });
  assert.equal(res.status, 503);
  assert.equal(db.enqueued.length, 0);
  assert.equal(db.notifications.length, 0);
  assert.equal(db.triggers[0].last_run_at ?? null, null);
});

test('Phase 4C: Proactive Agents — Validation & 404s for nonexistent agents or invalid triggers', async () => {
  const db = database();
  const fetcher = router(db.routes);

  // Nonexistent agent -> 404
  const noAgent = await handleService(call('GET', '/api/agents/non-existent-agent-slug/instructions'), { env, fetcher });
  assert.equal(noAgent.status, 404);

  // Empty instruction -> 400
  const emptyInst = await handleService(call('POST', '/api/agents/dua-work/instructions', { instruction: '   ' }), { env, fetcher });
  assert.equal(emptyInst.status, 400);

  // Invalid triggerType -> 400
  const badTriggerType = await handleService(call('POST', '/api/agents/dua-work/triggers', {
    triggerType: 'invalid_type',
    prompt: 'Do something',
  }), { env, fetcher });
  assert.equal(badTriggerType.status, 400);

  // Schedule trigger without cronExpr -> 400
  const noCron = await handleService(call('POST', '/api/agents/dua-work/triggers', {
    triggerType: 'schedule',
    prompt: 'Do something',
  }), { env, fetcher });
  assert.equal(noCron.status, 400);

  // Nonexistent trigger run -> 404
  const fakeId = '00000000-0000-0000-0000-000000000000';
  const badRun = await handleService(call('POST', `/api/agents/dua-work/triggers/${fakeId}/run`), { env, fetcher });
  assert.equal(badRun.status, 404);
});
