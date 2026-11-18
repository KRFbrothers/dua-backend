import test from 'node:test';
import assert from 'node:assert/strict';
import { handleService } from '../src/server/service-handler.mjs';
import { searchPattern } from '../src/core/conversations.mjs';
import { filesEnv, router, SUPA, UID, OTHER } from './files-helpers.mjs';

const env = filesEnv;
const C1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const C2 = 'aaaaaaaa-0000-4000-8000-000000000002';

function call(method, path, body, { token = 'user-token', headers = {} } = {}) {
  return new Request('https://dua.test' + path, {
    method,
    headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}

/** PostgREST `ilike` pattern (`*` wildcard, LIKE escapes) as a case-insensitive RegExp. */
function ilike(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) source += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (ch === '*' || ch === '%') source += '.*';
    else if (ch === '_') source += '.';
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + source + '$', 'is');
}

/**
 * In-memory stand-in for the two tables. It applies the filters, order, limit/offset, the
 * ignore-duplicates insert and the column defaults the handler relies on, plus RLS: a row is only
 * visible to the token's owner (the router's /auth/v1/user answers UID for 'user-token').
 */
function database() {
  const conversations = [];
  const messages = [];
  let clock = Date.parse('2026-11-19T00:00:00Z');
  const stamp = () => new Date(clock += 1000).toISOString().replace('Z', '+00:00');
  const ownerOf = init => new Headers(init.headers).get('authorization') === 'Bearer user-token' ? UID : 'nobody';
  const eq = (query, name) => query.get(name)?.replace(/^eq\./, '');
  const filter = (rows, query, owner) => rows.filter(row => {
    if (row.owner_id !== owner) return false;
    for (const name of ['id', 'owner_id', 'conversation_id']) if (query.has(name) && row[name] !== eq(query, name)) return false;
    if (query.has('title') && !ilike(query.get('title').replace(/^ilike\./, '')).test(row.title)) return false;
    if (query.has('created_at') && !(row.created_at < query.get('created_at').replace(/^lt\./, ''))) return false;
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
  const page = (rows, query) => {
    const offset = Number(query.get('offset') || 0);
    return query.has('limit') ? rows.slice(offset, offset + Number(query.get('limit'))) : rows.slice(offset);
  };
  const tables = { dua_conversations: conversations, dua_messages: messages };
  const routes = [[url => url.startsWith(`${SUPA}/rest/v1/`), (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.split('/').pop();
    const rows = tables[table];
    const query = parsed.searchParams;
    const owner = ownerOf(init);
    const method = init.method || 'GET';
    if (method === 'GET') return Response.json(page(sort(filter(rows, query, owner), query.get('order')), query));
    if (method === 'POST') {
      const body = JSON.parse(init.body);
      if (body.owner_id !== owner) return Response.json({ message: 'row-level security' }, { status: 403 });
      const row = { id: body.id || crypto.randomUUID(), agent_id: 'dua-agent', title: 'New chat', pinned: false,
        last_message_preview: '', last_message_at: stamp(), created_at: stamp(), ...body };
      if (rows.some(existing => existing.id === row.id)) {
        if (query.get('on_conflict') === 'id' && /ignore-duplicates/.test(new Headers(init.headers).get('prefer'))) return Response.json([], { status: 201 });
        return Response.json({ message: 'duplicate' }, { status: 409 });
      }
      rows.push(row);
      return Response.json([row], { status: 201 });
    }
    if (method === 'PATCH') {
      const changed = filter(rows, query, owner);
      for (const row of changed) Object.assign(row, JSON.parse(init.body));
      return Response.json(changed);
    }
    if (method === 'DELETE') {
      const removed = filter(rows, query, owner);
      for (const row of removed) {
        rows.splice(rows.indexOf(row), 1);
        for (let i = messages.length - 1; i >= 0; i--) if (messages[i].conversation_id === row.id) messages.splice(i, 1);
      }
      return Response.json(removed);
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  }]];
  const addConversation = (fields = {}) => {
    const row = { id: crypto.randomUUID(), owner_id: UID, agent_id: 'dua-agent', title: 'New chat', pinned: false,
      last_message_preview: '', last_message_at: stamp(), created_at: stamp(), ...fields };
    conversations.push(row);
    return row;
  };
  const addMessage = (conversation, fields = {}) => {
    const row = { id: crypto.randomUUID(), owner_id: conversation.owner_id, conversation_id: conversation.id, agent_id: null,
      role: 'user', content: 'hello', model: null, token_count: null, usage: null, created_at: stamp(), ...fields };
    messages.push(row);
    return row;
  };
  return { conversations, messages, routes, addConversation, addMessage };
}

test('conversations: create, list, pin and delete round-trip with the documented shapes', async () => {
  const db = database();
  const fetcher = router(db.routes);

  const created = await handleService(call('POST', '/api/conversations', { title: '  Trip plan  ', agentId: 'personal-agent' }), { env, fetcher });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const { conversation } = await created.json();
  assert.deepEqual(Object.keys(conversation).sort(), ['agentId', 'createdAt', 'id', 'lastMessageAt', 'lastMessagePreview', 'pinned', 'title']);
  assert.equal(conversation.title, 'Trip plan');
  assert.equal(conversation.agentId, 'personal-agent');
  assert.equal(conversation.pinned, false);
  assert.equal(db.conversations[0].owner_id, UID);

  const defaults = await (await handleService(call('POST', '/api/conversations', {}), { env, fetcher })).json();
  assert.equal(defaults.conversation.title, 'New chat');
  assert.equal(defaults.conversation.agentId, 'dua-agent');

  const pinned = await handleService(call('PUT', `/api/conversations/${conversation.id}/pin`, { pinned: true }), { env, fetcher });
  assert.equal(pinned.status, 200);
  assert.equal((await pinned.json()).conversation.pinned, true);

  const listed = await (await handleService(call('GET', '/api/conversations'), { env, fetcher })).json();
  assert.deepEqual(listed.conversations.map(item => item.id), [conversation.id, defaults.conversation.id], 'pinned first, then most recent');
  assert.equal(listed.limit, 50);
  assert.equal(listed.offset, 0);
  assert.equal(listed.hasMore, false);

  const deleted = await handleService(call('DELETE', `/api/conversations/${conversation.id}`), { env, fetcher });
  assert.equal(deleted.status, 204);
  assert.equal(db.conversations.length, 1);
  const missing = await handleService(call('DELETE', `/api/conversations/${conversation.id}`), { env, fetcher });
  assert.equal(missing.status, 404);
});

test('the list query is owner-filtered, ordered pinned then recent, and pages with hasMore', async () => {
  const db = database();
  for (let i = 0; i < 5; i++) db.addConversation({ title: `Chat ${i}` });
  db.addConversation({ title: 'Other owner', owner_id: OTHER });
  const fetcher = router(db.routes);

  const first = await (await handleService(call('GET', '/api/conversations?limit=2'), { env, fetcher })).json();
  assert.deepEqual(first.conversations.map(item => item.title), ['Chat 4', 'Chat 3']);
  assert.equal(first.hasMore, true);
  const last = await (await handleService(call('GET', '/api/conversations?limit=2&offset=4'), { env, fetcher })).json();
  assert.deepEqual(last.conversations.map(item => item.title), ['Chat 0']);
  assert.equal(last.hasMore, false);

  const query = new URL(fetcher.find(SUPA + '/rest/v1/dua_conversations').at(-1).url).searchParams;
  assert.equal(query.get('owner_id'), 'eq.' + UID);
  assert.equal(query.get('order'), 'pinned.desc,last_message_at.desc,id.desc');
  assert.equal(query.get('limit'), '3', 'one extra row decides hasMore');
  assert.equal(query.get('offset'), '4');

  for (const bad of ['limit=0', 'limit=101', 'limit=abc', 'offset=-1', 'offset=10001', 'limit=1.5']) {
    const response = await handleService(call('GET', '/api/conversations?' + bad), { env, fetcher });
    assert.equal(response.status, 400, bad);
  }
});

test('q searches titles literally: %, _ and \\ are escaped and * is dropped', async () => {
  assert.equal(searchPattern(null), '');
  assert.equal(searchPattern('   '), '');
  assert.equal(searchPattern('***'), '');
  assert.equal(searchPattern(' Trip '), '*Trip*');
  assert.equal(searchPattern('100%_a\\b*'), '*100\\%\\_a\\\\b*');
  assert.equal(searchPattern('x'.repeat(101)), null);

  const db = database();
  db.addConversation({ title: 'Budget 100% done' });
  db.addConversation({ title: 'Budget 1000 items' });
  db.addConversation({ title: 'snake_case notes' });
  db.addConversation({ title: 'snakeXcase notes' });
  const fetcher = router(db.routes);
  const titles = async q => (await (await handleService(call('GET', '/api/conversations?q=' + encodeURIComponent(q)), { env, fetcher })).json())
    .conversations.map(item => item.title).sort();
  assert.deepEqual(await titles('100%'), ['Budget 100% done']);
  assert.deepEqual(await titles('snake_case'), ['snake_case notes']);
  assert.deepEqual(await titles('BUDGET'), ['Budget 100% done', 'Budget 1000 items']);
  assert.equal(new URL(fetcher.find(SUPA + '/rest/v1/dua_conversations').at(-1).url).searchParams.get('title'), 'ilike.*BUDGET*');
  assert.equal((await handleService(call('GET', '/api/conversations?q=' + 'x'.repeat(101)), { env, fetcher })).status, 400);
});

test('POST with a client id is idempotent and never returns another owner\'s row', async () => {
  const db = database();
  const fetcher = router(db.routes);
  const first = await handleService(call('POST', '/api/conversations', { id: C1.toUpperCase(), title: 'First' }), { env, fetcher });
  assert.equal(first.status, 201);
  assert.equal((await first.json()).conversation.id, C1);
  const retry = await handleService(call('POST', '/api/conversations', { id: C1, title: 'Retry' }), { env, fetcher });
  assert.equal(retry.status, 201);
  assert.equal((await retry.json()).conversation.title, 'First', 'the saved row is returned unchanged');
  assert.equal(db.conversations.length, 1);
  const insert = fetcher.find(SUPA + '/rest/v1/dua_conversations').find(c => c.method === 'POST');
  assert.equal(new URL(insert.url).searchParams.get('on_conflict'), 'id');
  assert.match(insert.headers.get('prefer'), /resolution=ignore-duplicates/);

  db.addConversation({ id: C2, owner_id: OTHER, title: 'Not yours' });
  const taken = await handleService(call('POST', '/api/conversations', { id: C2 }), { env, fetcher });
  assert.equal(taken.status, 409);
  assert.doesNotMatch(await taken.text(), /Not yours/);
});

test('the owner comes from the verified session, never from the request body', async () => {
  const db = database();
  const fetcher = router(db.routes);
  await handleService(call('POST', '/api/conversations', { owner_id: OTHER, ownerId: OTHER, title: 'Mine' }), { env, fetcher });
  assert.equal(db.conversations[0].owner_id, UID);
  assert.deepEqual(Object.keys(fetcher.find(SUPA + '/rest/v1/').at(-1).json).sort(), ['owner_id', 'title']);
});

test('invalid create and pin bodies are refused before any database call', async () => {
  const fetcher = router([]);
  const cases = [
    ['POST', '/api/conversations', { id: 'not-a-uuid' }, 'Invalid id.'],
    ['POST', '/api/conversations', { title: '   ' }, 'Invalid title.'],
    ['POST', '/api/conversations', { title: 'x'.repeat(201) }, 'Invalid title.'],
    ['POST', '/api/conversations', { title: 7 }, 'Invalid title.'],
    ['POST', '/api/conversations', { agentId: 'Dua Agent' }, 'Invalid agentId.'],
    ['POST', '/api/conversations', [], 'Invalid request.'],
    ['POST', '/api/conversations', '{oops', 'Invalid request.'],
    ['PUT', `/api/conversations/${C1}/pin`, { pinned: 'yes' }, 'Invalid pinned.'],
    ['PUT', `/api/conversations/${C1}/pin`, {}, 'Invalid pinned.'],
    ['PUT', `/api/conversations/${C1}/pin`, null, 'Invalid pinned.'],
  ];
  for (const [method, path, body, message] of cases) {
    const response = await handleService(call(method, path, body), { env, fetcher });
    assert.equal(response.status, 400, `${method} ${path} ${JSON.stringify(body)}`);
    assert.equal((await response.json()).error, message);
  }
  const large = await handleService(call('POST', '/api/conversations', { title: 'x'.repeat(17 * 1024) }), { env, fetcher });
  assert.equal(large.status, 413);
  assert.equal(fetcher.find(SUPA + '/rest/v1/').length, 0);
});

test('pin and delete only touch the caller\'s own conversation', async () => {
  const db = database();
  db.addConversation({ id: C1, owner_id: OTHER, title: 'Other' });
  const fetcher = router(db.routes);
  assert.equal((await handleService(call('PUT', `/api/conversations/${C1}/pin`, { pinned: true }), { env, fetcher })).status, 404);
  assert.equal((await handleService(call('DELETE', `/api/conversations/${C1}`), { env, fetcher })).status, 404);
  assert.equal(db.conversations[0].pinned, false);
  assert.equal(db.conversations.length, 1);
  for (const request of fetcher.find(SUPA + '/rest/v1/')) assert.equal(new URL(request.url).searchParams.get('owner_id'), 'eq.' + UID);
});

test('messages: owner-checked, oldest-first pages with a before cursor and hasMore', async () => {
  const db = database();
  const mine = db.addConversation({ id: C1 });
  const theirs = db.addConversation({ id: C2, owner_id: OTHER });
  const rows = [1, 2, 3, 4, 5].map(n => db.addMessage(mine, { content: 'm' + n, role: n % 2 ? 'user' : 'assistant' }));
  db.addMessage(theirs, { content: 'secret' });
  const fetcher = router(db.routes);

  const page = await handleService(call('GET', `/api/conversations/${C1}/messages?limit=2`), { env, fetcher });
  assert.equal(page.status, 200);
  const body = await page.json();
  assert.deepEqual(body.messages.map(m => m.content), ['m4', 'm5']);
  assert.equal(body.hasMore, true);
  assert.deepEqual(Object.keys(body.messages[0]).sort(), ['agentId', 'content', 'conversationId', 'createdAt', 'id', 'model', 'role', 'tokenCount', 'usage']);
  assert.equal(body.messages[0].tokenCount, null);

  const older = await (await handleService(call('GET', `/api/conversations/${C1}/messages?limit=2&before=${encodeURIComponent(body.messages[0].createdAt)}`), { env, fetcher })).json();
  assert.deepEqual(older.messages.map(m => m.content), ['m2', 'm3']);
  const oldest = await (await handleService(call('GET', `/api/conversations/${C1}/messages?limit=2&before=${encodeURIComponent(rows[1].created_at)}`), { env, fetcher })).json();
  assert.deepEqual(oldest.messages.map(m => m.content), ['m1']);
  assert.equal(oldest.hasMore, false);

  const query = new URL(fetcher.find(SUPA + '/rest/v1/dua_messages').at(-1).url).searchParams;
  assert.equal(query.get('owner_id'), 'eq.' + UID);
  assert.equal(query.get('order'), 'created_at.desc,id.desc');

  const other = await handleService(call('GET', `/api/conversations/${C2}/messages`), { env, fetcher });
  assert.equal(other.status, 404);
  assert.doesNotMatch(await other.text(), /secret/);

  for (const bad of ['limit=0', 'limit=501', 'before=yesterday', 'before=2026-11-19', 'before=2026-13-45T99:00:00Z']) {
    assert.equal((await handleService(call('GET', `/api/conversations/${C1}/messages?` + bad), { env, fetcher })).status, 400, bad);
  }
});

test('non-UUID ids and unknown paths are 404; wrong methods are 405', async () => {
  const fetcher = router([]);
  for (const path of ['/api/conversations/abc', '/api/conversations/%2e%2e', `/api/conversations/${C1}/title`, `/api/conversations/${C1}/pin/x`, '/api/conversations/x/messages']) {
    const method = path.endsWith('/messages') ? 'GET' : 'DELETE';
    assert.equal((await handleService(call(method, path), { env, fetcher })).status, 404, path);
  }
  const wrong = [['PUT', '/api/conversations'], ['DELETE', '/api/conversations'], ['GET', `/api/conversations/${C1}`],
    ['POST', `/api/conversations/${C1}/messages`], ['GET', `/api/conversations/${C1}/pin`], ['POST', `/api/conversations/${C1}/pin`]];
  for (const [method, path] of wrong) {
    const response = await handleService(call(method, path, method === 'GET' ? undefined : {}), { env, fetcher });
    assert.equal(response.status, 405, `${method} ${path}`);
  }
  assert.equal(fetcher.calls.length, 0, 'routing errors never verify the session or reach the database');
});

test('every database call uses the anon key and the user token, never the service-role key', async () => {
  const db = database();
  const fetcher = router(db.routes);
  const created = await (await handleService(call('POST', '/api/conversations', { id: C1 }), { env, fetcher })).json();
  await handleService(call('GET', '/api/conversations?q=a'), { env, fetcher });
  await handleService(call('GET', `/api/conversations/${created.conversation.id}/messages`), { env, fetcher });
  await handleService(call('PUT', `/api/conversations/${C1}/pin`, { pinned: true }), { env, fetcher });
  await handleService(call('DELETE', `/api/conversations/${C1}`), { env, fetcher });
  const rest = fetcher.find(SUPA + '/rest/v1/');
  assert.ok(rest.length >= 5);
  for (const request of rest) {
    assert.equal(request.headers.get('apikey'), env.SUPABASE_ANON_KEY);
    assert.equal(request.headers.get('authorization'), 'Bearer user-token');
    assert.doesNotMatch(JSON.stringify([...request.headers]), /sb_secret_/);
  }
  assert.equal(fetcher.find(SUPA + '/rest/v1/rpc').length, 0);

  const secretOnly = await handleService(call('GET', '/api/conversations'), { env: { ...env, SUPABASE_ANON_KEY: env.SUPABASE_SERVICE_ROLE_KEY }, fetcher: router([]) });
  assert.equal(secretOnly.status, 503);
});

test('Android Bearer + X-Dua-Native requests work; missing, foreign or expired sessions are refused', async () => {
  const db = database();
  db.addConversation({ title: 'Phone chat' });
  const fetcher = router(db.routes);
  const native = await handleService(call('GET', '/api/conversations', undefined, { headers: { 'x-dua-native': '1' } }), { env, fetcher });
  assert.equal(native.status, 200);
  assert.deepEqual((await native.json()).conversations.map(item => item.title), ['Phone chat']);

  assert.equal((await handleService(call('GET', '/api/conversations', undefined, { token: '' }), { env, fetcher })).status, 401);
  const foreign = router(db.routes, { email: 'someone@else.com' });
  assert.equal((await handleService(call('GET', '/api/conversations'), { env, fetcher: foreign })).status, 403);
  assert.equal(foreign.find(SUPA + '/rest/v1/').length, 0);
  assert.equal((await handleService(call('GET', '/api/conversations'), { env: { ...env, DUA_ALLOWED_EMAIL: '' }, fetcher })).status, 503);
});

test('upstream failures map to safe messages without leaking upstream text', async () => {
  for (const [status, expected] of [[401, 401], [403, 403], [404, 503], [429, 429], [500, 502]]) {
    const fetcher = router([[SUPA + '/rest/v1/', () => Response.json({ message: 'internal detail xyz' }, { status })]]);
    const response = await handleService(call('GET', '/api/conversations'), { env, fetcher });
    assert.equal(response.status, expected, String(status));
    assert.doesNotMatch(await response.text(), /internal detail/);
  }
});
