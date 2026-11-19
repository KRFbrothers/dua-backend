import test from 'node:test';
import assert from 'node:assert/strict';
import { handleService } from '../src/server/service-handler.mjs';
import { filesEnv, router, SUPA, UID, OTHER } from './files-helpers.mjs';

const env = filesEnv;

function call(method, path, body, { token = 'user-token', headers = {} } = {}) {
  return new Request('https://dua.test' + path, {
    method,
    headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/**
 * A tiny in-memory stand-in for the two Supabase tables.
 * It honours the owner filter and the on_conflict upsert the handler relies on,
 * so the tests exercise the real request shapes rather than a stub that agrees
 * with whatever the handler happens to send.
 * Phase 3: also handles PATCH (scope toggle) and scope/conversation_id query filters.
 */
const CONV_A = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONV_B = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function store(table, idColumn) {
  const rows = [];
  const routes = [[url => url.startsWith(`${SUPA}/rest/v1/${table}`), (url, init) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    const query = new URL(url).searchParams;
    if (method === 'GET') {
      const owner = query.get('owner_id');
      const scopeParam = query.get('scope');
      const conversationIdParam = query.get('conversation_id');
      let list = rows.filter(row => !owner || row.owner_id === owner.replace('eq.', ''));
      // scope=in.(global,group:<id>) filter
      if (scopeParam && scopeParam.startsWith('in.(')) {
        const values = scopeParam.slice(4, -1).split(',');
        list = list.filter(row => values.includes(row.scope ?? 'global'));
      } else if (scopeParam && scopeParam.startsWith('eq.')) {
        list = list.filter(row => (row.scope ?? 'global') === scopeParam.slice(3));
      }
      // conversation_id filter
      if (conversationIdParam) {
        const convId = conversationIdParam.replace('eq.', '');
        list = list.filter(row => row.source_conversation_id === convId);
      }
      return Response.json(list);
    }
    if (method === 'POST') {
      const existing = rows.findIndex(row => row.owner_id === body.owner_id && row[idColumn] === body[idColumn]);
      if (existing >= 0) rows[existing] = body; else rows.push(body);
      return Response.json([body], { status: 201 });
    }
    if (method === 'PATCH') {
      const id = query.get(idColumn)?.replace('eq.', '');
      const owner = query.get('owner_id')?.replace('eq.', '');
      const idx = rows.findIndex(row => row[idColumn] === id && (!owner || row.owner_id === owner));
      if (idx < 0) return Response.json([]);
      rows[idx] = { ...rows[idx], ...body };
      return Response.json([rows[idx]]);
    }
    if (method === 'DELETE') {
      const id = query.get(`${idColumn}`)?.replace('eq.', '');
      const owner = query.get('owner_id')?.replace('eq.', '');
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i][idColumn] === id && (!owner || rows[i].owner_id === owner)) rows.splice(i, 1);
      }
      return Response.json(rows.length === before ? [] : [{ [idColumn]: id }]);
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  }]];
  return { rows, routes };
}

const artifact = { id: 'art_q3_deck', title: 'Q3 Launch Deck', type: 'Webpage', timestamp: 'Aaj', sizeBytes: 2411724, url: 'https://static.teamily.ai/sites/demo/q3-deck/index.html' };
// Phase 3: memory now includes scope and sourceConversationId.
const memory = { id: 'mem_brand_green', title: 'Brand green is #087C45', summary: 'Never purple or blue.', timestamp: '4 din pehle', category: 'Preference', url: null, scope: 'global', sourceConversationId: null };

test('artifacts: create, list and delete round-trip through the owner-scoped table', async () => {
  const { rows, routes } = store('dua_artifacts', 'artifact_id');
  const fetcher = router(routes);

  const created = await handleService(call('POST', '/api/artifacts', artifact), { env, fetcher });
  assert.equal(created.status, 201);
  assert.deepEqual((await created.json()).artifact, artifact);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner_id, UID);
  assert.equal(rows[0].artifact_id, 'art_q3_deck');
  assert.equal(rows[0].size_bytes, 2411724);

  const listed = await handleService(call('GET', '/api/artifacts'), { env, fetcher });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).artifacts, [artifact]);

  const deleted = await handleService(call('DELETE', '/api/artifacts/art_q3_deck'), { env, fetcher });
  assert.equal(deleted.status, 204);
  assert.equal(rows.length, 0);
});

test('memories: create, list and delete round-trip, and a null url stays null', async () => {
  const { rows, routes } = store('dua_memories', 'memory_id');
  const fetcher = router(routes);

  const created = await handleService(call('POST', '/api/memories', memory), { env, fetcher });
  assert.equal(created.status, 201);
  const saved = (await created.json()).memory;
  assert.deepEqual(saved, memory);
  assert.equal(saved.url, null);
  assert.equal(rows[0].memory_id, 'mem_brand_green');

  const listed = await handleService(call('GET', '/api/memories'), { env, fetcher });
  assert.deepEqual((await listed.json()).memories, [memory]);

  assert.equal((await handleService(call('DELETE', '/api/memories/mem_brand_green'), { env, fetcher })).status, 204);
  assert.equal(rows.length, 0);
});

test('a repeated POST upserts instead of failing, so the undo path can re-add an item', async () => {
  const { rows, routes } = store('dua_artifacts', 'artifact_id');
  const fetcher = router(routes);
  assert.equal((await handleService(call('POST', '/api/artifacts', artifact), { env, fetcher })).status, 201);
  const again = await handleService(call('POST', '/api/artifacts', { ...artifact, title: 'Q3 Launch Deck (v2)' }), { env, fetcher });
  assert.equal(again.status, 201);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Q3 Launch Deck (v2)');
});

test('the owner is taken from the verified session, never from the request body', async () => {
  const { rows, routes } = store('dua_artifacts', 'artifact_id');
  const fetcher = router(routes);
  await handleService(call('POST', '/api/artifacts', { ...artifact, owner_id: OTHER, ownerId: OTHER }), { env, fetcher });
  assert.equal(rows[0].owner_id, UID);
});

test('a delete only removes the caller\'s own row', async () => {
  const { rows, routes } = store('dua_artifacts', 'artifact_id');
  rows.push({ ...artifact, owner_id: OTHER, artifact_id: 'art_q3_deck', size_bytes: 1, created_at_ms: 1, updated_at_ms: 1 });
  const fetcher = router(routes);
  const response = await handleService(call('DELETE', '/api/artifacts/art_q3_deck'), { env, fetcher });
  assert.equal(response.status, 404);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner_id, OTHER);
});

test('invalid input is refused before any database call', async () => {
  const fetcher = router([]);
  const cases = [
    ['/api/artifacts', { ...artifact, id: '../memories' }, 'Invalid id.'],
    ['/api/artifacts', { ...artifact, id: 'x?admin=1' }, 'Invalid id.'],
    ['/api/artifacts', { ...artifact, title: '   ' }, 'Invalid title.'],
    ['/api/artifacts', { ...artifact, title: 'x'.repeat(201) }, 'Invalid title.'],
    ['/api/artifacts', { ...artifact, sizeBytes: -1 }, 'Invalid sizeBytes.'],
    ['/api/artifacts', { ...artifact, sizeBytes: '12' }, 'Invalid sizeBytes.'],
    ['/api/artifacts', { ...artifact, url: 'javascript:alert(1)' }, 'Invalid url.'],
    ['/api/artifacts', { ...artifact, url: 'file:///etc/passwd' }, 'Invalid url.'],
    ['/api/memories', { ...memory, summary: 'x'.repeat(2001) }, 'Invalid summary.'],
  ];
  for (const [path, body, message] of cases) {
    const response = await handleService(call('POST', path, body), { env, fetcher });
    assert.equal(response.status, 400, `${path} ${JSON.stringify(body).slice(0, 60)}`);
    assert.equal((await response.json()).error, message);
  }
  assert.equal(fetcher.find(SUPA + '/rest/v1/').length, 0);
});

test('a signed-out request is refused with 401 and never reaches the database', async () => {
  const fetcher = router([]);
  const response = await handleService(call('GET', '/api/artifacts', null, { token: '' }), { env, fetcher });
  assert.equal(response.status, 401);
  assert.equal(fetcher.find(SUPA + '/rest/v1/').length, 0);
});

test('a different account is refused with 403', async () => {
  const fetcher = router([], { email: 'someone-else@example.com' });
  const response = await handleService(call('GET', '/api/memories'), { env, fetcher });
  assert.equal(response.status, 403);
  assert.equal(fetcher.find(SUPA + '/rest/v1/').length, 0);
});

test('unknown paths, bad ids and wrong methods are 404/405, not a database call', async () => {
  const fetcher = router([]);
  assert.equal((await handleService(call('GET', '/api/artifact'), { env, fetcher })).status, 404);
  assert.equal((await handleService(call('GET', '/api/artifacts/a/b'), { env, fetcher })).status, 404);
  assert.equal((await handleService(call('GET', '/api/artifacts/..%2Fmemories'), { env, fetcher })).status, 404);
  assert.equal((await handleService(call('PUT', '/api/artifacts'), { env, fetcher })).status, 405);
  assert.equal((await handleService(call('POST', '/api/memories/mem_brand_green', memory), { env, fetcher })).status, 405);
  assert.equal(fetcher.find(SUPA + '/rest/v1/').length, 0);
});

test('an upstream failure is reported as a safe message, never as raw upstream text', async () => {
  const fetcher = router([[(url, init) => url.startsWith(SUPA + '/rest/v1/dua_artifacts'), () => Response.json({ message: 'relation "dua_artifacts" does not exist', code: '42P01' }, { status: 404 })]]);
  const response = await handleService(call('GET', '/api/artifacts'), { env, fetcher });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.match(body.error, /not set up/);
  assert.doesNotMatch(JSON.stringify(body), /42P01|relation/);
});

test('a missing table is not silently reported as an empty list', async () => {
  const fetcher = router([[(url, init) => url.startsWith(SUPA + '/rest/v1/dua_memories'), () => new Response(null, { status: 404 })]]);
  const response = await handleService(call('GET', '/api/memories'), { env, fetcher });
  assert.equal(response.status, 503);
});

test('the list is capped and ordered newest first', async () => {
  const { routes } = store('dua_artifacts', 'artifact_id');
  const fetcher = router(routes);
  await handleService(call('GET', '/api/artifacts'), { env, fetcher });
  const request = fetcher.find(SUPA + '/rest/v1/dua_artifacts')[0];
  assert.match(request.url, /order=updated_at_ms\.desc/);
  assert.match(request.url, /limit=200/);
});

test('the database call carries the user token, never a service key', async () => {
  const { routes } = store('dua_artifacts', 'artifact_id');
  const fetcher = router(routes);
  await handleService(call('GET', '/api/artifacts'), { env, fetcher });
  const request = fetcher.find(SUPA + '/rest/v1/dua_artifacts')[0];
  assert.equal(request.headers.get('authorization'), 'Bearer user-token');
  assert.equal(request.headers.get('apikey'), env.SUPABASE_ANON_KEY);
});

// ─── Phase 3: Scope, Privacy Boundaries & PUT /api/memories/:id ──────────────

test('Phase 3: memory is created with default scope=global and sourceConversationId=null', async () => {
  const { rows, routes } = store('dua_memories', 'memory_id');
  const fetcher = router(routes);
  const created = await handleService(call('POST', '/api/memories', memory), { env, fetcher });
  assert.equal(created.status, 201);
  const saved = (await created.json()).memory;
  assert.equal(saved.scope, 'global');
  assert.equal(saved.sourceConversationId, null);
});

test('Phase 3: PUT /api/memories/:id toggles scope from global to group:<convId>', async () => {
  const { rows, routes } = store('dua_memories', 'memory_id');
  const fetcher = router(routes);
  // Seed a row
  rows.push({ memory_id: 'mem_brand_green', owner_id: UID, title: 'Brand green', summary: 'Never purple.', scope: 'global', source_conversation_id: null, timestamp: 'now', category: 'Preference', url: null, created_at_ms: 1, updated_at_ms: 1 });
  const res = await handleService(call('PUT', `/api/memories/mem_brand_green`, { scope: `group:${CONV_A}` }), { env, fetcher });
  assert.equal(res.status, 200);
  const updated = (await res.json()).memory;
  assert.equal(updated.scope, `group:${CONV_A}`);
  assert.equal(updated.sourceConversationId, CONV_A);
});

test('Phase 3: PUT /api/memories/:id toggles scope back to global', async () => {
  const { rows, routes } = store('dua_memories', 'memory_id');
  const fetcher = router(routes);
  rows.push({ memory_id: 'mem_x', owner_id: UID, title: 'X', summary: 'Y', scope: `group:${CONV_A}`, source_conversation_id: CONV_A, timestamp: 'now', category: 'fact', url: null, created_at_ms: 1, updated_at_ms: 1 });
  const res = await handleService(call('PUT', '/api/memories/mem_x', { scope: 'global', sourceConversationId: null }), { env, fetcher });
  assert.equal(res.status, 200);
  const updated = (await res.json()).memory;
  assert.equal(updated.scope, 'global');
});

test('Phase 3: PUT /api/memories/:id rejects invalid scope', async () => {
  const { rows, routes } = store('dua_memories', 'memory_id');
  const fetcher = router(routes);
  rows.push({ memory_id: 'mem_x', owner_id: UID, title: 'X', summary: '', scope: 'global', source_conversation_id: null, timestamp: 'now', category: 'fact', url: null, created_at_ms: 1, updated_at_ms: 1 });
  const res = await handleService(call('PUT', '/api/memories/mem_x', { scope: 'group:not-a-uuid' }), { env, fetcher });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /scope/i);
});

test('Phase 3: GET /api/memories?scope=global returns only global memories', async () => {
  const { rows, routes } = store('dua_memories', 'memory_id');
  const fetcher = router(routes);
  rows.push({ memory_id: 'mem_a', owner_id: UID, title: 'A', summary: '', scope: 'global', source_conversation_id: null, timestamp: 'now', category: 'fact', url: null, created_at_ms: 1, updated_at_ms: 1 });
  rows.push({ memory_id: 'mem_b', owner_id: UID, title: 'B', summary: '', scope: `group:${CONV_A}`, source_conversation_id: CONV_A, timestamp: 'now', category: 'fact', url: null, created_at_ms: 2, updated_at_ms: 2 });
  const res = await handleService(call('GET', '/api/memories?scope=global'), { env, fetcher });
  assert.equal(res.status, 200);
  const list = (await res.json()).memories;
  assert.equal(list.every(m => m.scope === 'global'), true, 'Only global memories should be returned');
});

test('Phase 3: privacy boundary — group:<CONV_B> memory never leaks into CONV_A scope query', async () => {
  const { rows, routes } = store('dua_memories', 'memory_id');
  const fetcher = router(routes);
  // Thread B memory
  rows.push({ memory_id: 'mem_b_secret', owner_id: UID, title: 'Secret B', summary: 'Only for thread B', scope: `group:${CONV_B}`, source_conversation_id: CONV_B, timestamp: 'now', category: 'project', url: null, created_at_ms: 1, updated_at_ms: 1 });
  // Query for CONV_A scope: should only return global + group:CONV_A
  const res = await handleService(call('GET', `/api/memories?conversation_id=${CONV_A}`), { env, fetcher });
  assert.equal(res.status, 200);
  const list = (await res.json()).memories;
  assert.equal(list.some(m => m.id === 'mem_b_secret'), false, 'Thread B memory must not appear in Thread A query');
});
