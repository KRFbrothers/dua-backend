import test from 'node:test';
import assert from 'node:assert/strict';
import { handleService } from '../src/server/service-handler.mjs';
import { searchPattern, parseMentions, usageTokenCount } from '../src/core/conversations.mjs';
import { validateChat } from '../src/core/providers.mjs';
import { filesEnv, router, SUPA, UID, OTHER } from './files-helpers.mjs';
import { readEvents, sseResponse, sse } from './helpers.mjs';

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
  const conversationAgents = [];
  const customAgents = [];
  let clock = Date.parse('2026-11-19T00:00:00Z');
  const stamp = () => new Date(clock += 1000).toISOString().replace('Z', '+00:00');
  const ownerOf = init => new Headers(init.headers).get('authorization') === 'Bearer user-token' ? UID : 'nobody';
  const eq = (query, name) => query.get(name)?.replace(/^eq\./, '');
  const filter = (rows, query, owner) => rows.filter(row => {
    if (row.owner_id !== owner) return false;
    for (const name of ['id', 'owner_id', 'conversation_id', 'agent_id']) if (query.has(name) && row[name] !== eq(query, name)) return false;
    if (query.has('title') && !ilike(query.get('title').replace(/^ilike\./, '')).test(row.title)) return false;
    if (query.has('created_at') && !(row.created_at < query.get('created_at').replace(/^lt\./, ''))) return false;
    if (query.has('or')) {
      // Only the messages tie-breaker shape: (created_at.lt."T",and(created_at.eq."T",id.lt.ID))
      const tie = /^\(created_at\.lt\."([^"]+)",and\(created_at\.eq\."\1",id\.lt\.([0-9a-f-]{36})\)\)$/.exec(query.get('or'));
      if (!tie) throw new Error('Unexpected or filter ' + query.get('or'));
      if (!(row.created_at < tie[1] || (row.created_at === tie[1] && row.id < tie[2]))) return false;
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
  const page = (rows, query) => {
    const offset = Number(query.get('offset') || 0);
    return query.has('limit') ? rows.slice(offset, offset + Number(query.get('limit'))) : rows.slice(offset);
  };
  const tables = {
    dua_conversations: conversations,
    dua_messages: messages,
    dua_conversation_agents: conversationAgents,
    dua_agents: customAgents,
  };
  const restControls = new Set(['select', 'order', 'limit', 'offset', 'on_conflict']);
  const conversationAgentColumns = new Set(['conversation_id', 'agent_id', 'owner_id', 'added_at']);
  const routes = [[url => url.startsWith(`${SUPA}/rest/v1/`), (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.split('/').pop();
    const rows = tables[table] || [];
    const query = parsed.searchParams;
    const owner = ownerOf(init);
    const method = init.method || 'GET';
    if (table === 'dua_conversation_agents') {
      for (const name of query.keys()) {
        if (!conversationAgentColumns.has(name) && !restControls.has(name)) {
          return Response.json({ message: `column ${name} does not exist`, code: '42703' }, { status: 400 });
        }
      }
    }
    if (method === 'GET') return Response.json(page(sort(filter(rows, query, owner), query.get('order')), query));
    if (method === 'POST') {
      const body = JSON.parse(init.body);
      if (body.owner_id !== owner) return Response.json({ message: 'row-level security' }, { status: 403 });
      if (table === 'dua_conversation_agents') {
        const existing = conversationAgents.find(r => r.conversation_id === body.conversation_id && r.agent_id === body.agent_id && r.owner_id === body.owner_id);
        if (existing) {
          if (/ignore-duplicates/.test(new Headers(init.headers).get('prefer'))) return Response.json([], { status: 201 });
          return Response.json({ message: 'duplicate' }, { status: 409 });
        }
        const row = { conversation_id: body.conversation_id, agent_id: body.agent_id, owner_id: body.owner_id, added_at: stamp() };
        conversationAgents.push(row);
        return Response.json([row], { status: 201 });
      }
      const row = { id: body.id || crypto.randomUUID(), agent_id: 'dua-agent', title: 'New chat', pinned: false,
        last_message_preview: '', last_message_at: stamp(), created_at: stamp(), ...body };
      if (rows.some(existing => existing.id === row.id)) {
        if (query.get('on_conflict') === 'id' && /ignore-duplicates/.test(new Headers(init.headers).get('prefer'))) return Response.json([], { status: 201 });
        return Response.json({ message: 'duplicate' }, { status: 409 });
      }
      rows.push(row);
      if (table === 'dua_messages') {
        const conv = conversations.find(c => c.id === row.conversation_id && c.owner_id === row.owner_id);
        // Mirrors dua_messages_touch_conversation (202611260002): recency is the max, and the preview
        // only follows a row at least as new as last_message_at.
        if (conv) {
          if (row.created_at >= conv.last_message_at) conv.last_message_preview = (row.content || '').replace(/\s+/g, ' ').slice(0, 200);
          if (row.created_at > conv.last_message_at) conv.last_message_at = row.created_at;
        }
      }
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
        if (table === 'dua_conversations') {
          for (let i = messages.length - 1; i >= 0; i--) if (messages[i].conversation_id === row.id) messages.splice(i, 1);
          for (let i = conversationAgents.length - 1; i >= 0; i--) if (conversationAgents[i].conversation_id === row.id) conversationAgents.splice(i, 1);
        }
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
  const addConversationAgent = (conversationId, agentId) => {
    const row = { conversation_id: conversationId, agent_id: agentId, owner_id: UID, added_at: stamp() };
    conversationAgents.push(row);
    return row;
  };
  return { conversations, messages, conversationAgents, customAgents, routes, addConversation, addMessage, addConversationAgent };
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
  // before-only requests are byte-identical to the pre-beforeId shape.
  assert.equal(fetcher.find(SUPA + '/rest/v1/dua_messages').at(-1).url,
    `${SUPA}/rest/v1/dua_messages?select=id,conversation_id,agent_id,role,content,model,token_count,usage,created_at&conversation_id=eq.${C1}&owner_id=eq.${UID}&created_at=lt.${encodeURIComponent(rows[1].created_at)}&order=created_at.desc,id.desc&limit=3`);

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

test('validateChat validates conversation_id, conversationId, agent_id and conflicts with persistence', () => {
  const base = { model: 'Dua', messages: [{ role: 'user', text: 'Hello' }] };
  assert.equal(validateChat({ ...base, conversation_id: C1 }), null);
  assert.equal(validateChat({ ...base, conversationId: C1.toUpperCase() }), null);
  assert.equal(validateChat({ ...base, conversation_id: 'bad-id' })?.[0], 'Invalid conversation_id.');
  assert.equal(validateChat({ ...base, conversationId: '123' })?.[0], 'Invalid conversation_id.');
  assert.equal(validateChat({ ...base, agent_id: 'personal-agent' }), null);
  assert.equal(validateChat({ ...base, agentId: 'dua-agent' }), null);
  assert.equal(validateChat({ ...base, agent_id: 'Invalid Agent!' })?.[0], 'Invalid agent_id.');
  assert.equal(validateChat({ ...base, conversation_id: C1, persistence: {} })?.[0], 'Choose conversation_id or persistence, not both.');
});

test('POST /api/chat with conversation_id persists user turn before stream and assistant turn on done', async () => {
  const db = database();
  const conv = db.addConversation({ id: C1, title: 'Trip Planning', agent_id: 'dua-agent' });
  const geminiRoutes = [
    [url => url.includes(':streamGenerateContent'), () => sseResponse([
      sse({ candidates: [{ content: { parts: [{ text: 'Paris is ' }] } }] }),
      sse({ candidates: [{ content: { parts: [{ text: 'wonderful!' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6 } }),
    ])],
  ];
  const fetcher = router([...db.routes, ...geminiRoutes]);

  const reqBody = {
    model: 'Dua',
    messages: [{ role: 'user', text: 'Where should we go?' }],
    conversation_id: conv.id,
    stream: true,
  };

  const response = await handleService(call('POST', '/api/chat', reqBody), { env, fetcher });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const events = await readEvents(response);
  assert.deepEqual(events, [
    { type: 'text', delta: 'Paris is ' },
    { type: 'text', delta: 'wonderful!' },
    { type: 'done', truncated: false, usage: { inputTokens: 12, outputTokens: 6 } },
  ]);

  // Verify both user message and assistant message are saved in dua_messages
  assert.equal(db.messages.length, 2);
  const [userMsg, assistantMsg] = db.messages;
  assert.equal(userMsg.conversation_id, conv.id);
  assert.equal(userMsg.owner_id, UID);
  assert.equal(userMsg.role, 'user');
  assert.equal(userMsg.content, 'Where should we go?');
  assert.equal(userMsg.agent_id, null);

  assert.equal(assistantMsg.conversation_id, conv.id);
  assert.equal(assistantMsg.owner_id, UID);
  assert.equal(assistantMsg.role, 'assistant');
  assert.equal(assistantMsg.content, 'Paris is wonderful!');
  assert.equal(assistantMsg.agent_id, 'dua-agent');
  assert.equal(assistantMsg.model, env.GEMINI_MODEL, 'the real provider model id is stored, not the picker label');
  assert.equal(assistantMsg.token_count, 18);
  assert.deepEqual(assistantMsg.usage, { inputTokens: 12, outputTokens: 6 });

  // Conversation preview and last_message_at were touched by trigger emulation
  assert.equal(conv.last_message_preview, 'Paris is wonderful!');

  // The user turn is written after every preflight check but before generation starts.
  const userSave = fetcher.calls.findIndex(c => c.method === 'POST' && c.url.includes('/rest/v1/dua_messages') && c.json?.role === 'user');
  const generation = fetcher.calls.findIndex(c => c.url.includes(':streamGenerateContent'));
  assert.ok(userSave >= 0 && generation > userSave, 'user turn saved before generation');

  // Verify GET /api/conversations/:id/messages returns both in order
  const listRes = await handleService(call('GET', `/api/conversations/${conv.id}/messages`), { env, fetcher });
  assert.equal(listRes.status, 200);
  const { messages } = await listRes.json();
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'Where should we go?');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].content, 'Paris is wonderful!');
  assert.equal(messages[1].tokenCount, 18);
});

test('POST /api/chat with conversation_id persists both turns in non-streaming mode', async () => {
  const db = database();
  const conv = db.addConversation({ id: C2, title: 'Quick Q', agent_id: 'personal-agent' });
  const geminiRoutes = [
    [url => url.includes(':generateContent'), () => Response.json({
      candidates: [{ content: { parts: [{ text: 'Direct answer.' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 }
    })],
  ];
  const fetcher = router([...db.routes, ...geminiRoutes]);

  const reqBody = {
    model: 'Dua',
    messages: [{ role: 'user', text: 'Quick question?' }],
    conversation_id: conv.id,
    stream: false,
  };

  const response = await handleService(call('POST', '/api/chat', reqBody), { env, fetcher });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.text, 'Direct answer.');

  assert.equal(db.messages.length, 2);
  assert.equal(db.messages[0].role, 'user');
  assert.equal(db.messages[0].content, 'Quick question?');
  assert.equal(db.messages[1].role, 'assistant');
  assert.equal(db.messages[1].content, 'Direct answer.');
  assert.equal(db.messages[1].agent_id, 'personal-agent');
  assert.equal(conv.last_message_preview, 'Direct answer.');
});

test('POST /api/chat fails fast with 404 when conversation_id does not exist or belongs to another owner', async () => {
  const db = database();
  db.addConversation({ id: C1, owner_id: OTHER });
  const fetcher = router(db.routes);

  const missing = await handleService(call('POST', '/api/chat', {
    model: 'Dua',
    messages: [{ role: 'user', text: 'Hello' }],
    conversation_id: C2,
  }), { env, fetcher });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'That conversation was not found.');

  const foreign = await handleService(call('POST', '/api/chat', {
    model: 'Dua',
    messages: [{ role: 'user', text: 'Hello' }],
    conversation_id: C1,
  }), { env, fetcher });
  assert.equal(foreign.status, 404);
  assert.equal(db.messages.length, 0, 'no messages written on 404');
});

test('POST /api/chat stream failure keeps user message but skips assistant message', async () => {
  const db = database();
  const conv = db.addConversation({ id: C1 });
  const geminiRoutes = [
    [url => url.includes(':streamGenerateContent'), () => new Response('invalid sse', { status: 500 })],
  ];
  const fetcher = router([...db.routes, ...geminiRoutes]);

  const response = await handleService(call('POST', '/api/chat', {
    model: 'Dua',
    messages: [{ role: 'user', text: 'Will this fail?' }],
    conversation_id: conv.id,
    stream: true,
  }), { env, fetcher });
  assert.equal(response.status, 200);
  const events = await readEvents(response);
  assert.equal(events[0].type, 'error');

  // User message was saved before the stream failed, but no assistant message
  assert.equal(db.messages.length, 1);
  assert.equal(db.messages[0].role, 'user');
  assert.equal(db.messages[0].content, 'Will this fail?');
});

// ─── Phase 4A: Multi-Agent Group Chat & @mention Tests ───────────────────────

test('Phase 4A: parseMentions correctly extracts agent IDs and names', () => {
  const candidates = [
    { id: 'personal-agent', name: 'Personal Agent' },
    { id: 'dua-agent', name: 'Dua Agent' },
    { id: 'code-assistant', name: 'Code Assistant' },
    { id: 'frontend-dev', name: 'Frontend Developer' },
  ];

  // Matches @slug and @Name case-insensitively
  const r1 = parseMentions('Hello @personal-agent and @CodeAssistant please review', candidates);
  assert.equal(r1.length, 2);
  assert.equal(r1[0].id, 'personal-agent');
  assert.equal(r1[1].id, 'code-assistant');

  // Matches @Name without hyphens/spaces
  const r2 = parseMentions('Can @FrontendDeveloper build this UI?', candidates);
  assert.equal(r2.length, 1);
  assert.equal(r2[0].id, 'frontend-dev');

  // Ignores email addresses (preceded by alphanumeric chars)
  const r3 = parseMentions('Send feedback to test@example.com or ping @dua-agent', candidates);
  assert.equal(r3.length, 1);
  assert.equal(r3[0].id, 'dua-agent');

  // Deduplicates repeated mentions
  const r4 = parseMentions('@dua-agent hello @dua-agent are you there?', candidates);
  assert.equal(r4.length, 1);
  assert.equal(r4[0].id, 'dua-agent');

  // Unmatched mention returns empty
  const r5 = parseMentions('Hello @unknown-agent', candidates);
  assert.equal(r5.length, 0);

  // No @mention returns empty
  assert.deepEqual(parseMentions('Plain message without tags', candidates), []);
});

test('Phase 4A: /api/conversations/:id/agents CRUD round-trip', async () => {
  const db = database();
  const conv = db.addConversation({ id: C1 });
  const fetcher = router(db.routes);

  // 1. Initial list is empty
  const emptyRes = await handleService(call('GET', `/api/conversations/${conv.id}/agents`), { env, fetcher });
  assert.equal(emptyRes.status, 200);
  assert.deepEqual((await emptyRes.json()).agents, []);

  // 2. Add an official agent
  const addRes1 = await handleService(call('POST', `/api/conversations/${conv.id}/agents`, { agentId: 'personal-agent' }), { env, fetcher });
  assert.equal(addRes1.status, 201);
  const { agent: agent1 } = await addRes1.json();
  assert.equal(agent1.agentId, 'personal-agent');
  assert.equal(agent1.conversationId, conv.id);

  // 3. Add a custom agent that exists in dua_agents
  db.customAgents.push({ id: 'code-helper', owner_id: UID, name: 'Code Helper', mode: 'auto', system_prompt: '' });
  const addRes2 = await handleService(call('POST', `/api/conversations/${conv.id}/agents`, { agentId: 'code-helper' }), { env, fetcher });
  assert.equal(addRes2.status, 201);

  // 4. Reject nonexistent agent
  const badAgentRes = await handleService(call('POST', `/api/conversations/${conv.id}/agents`, { agentId: 'nonexistent-agent' }), { env, fetcher });
  assert.equal(badAgentRes.status, 404);

  // 5. List now has both agents
  const listRes = await handleService(call('GET', `/api/conversations/${conv.id}/agents`), { env, fetcher });
  assert.equal(listRes.status, 200);
  const { agents } = await listRes.json();
  assert.equal(agents.length, 2);
  assert.deepEqual(agents.map(a => a.agentId), ['personal-agent', 'code-helper']);

  // 6. Delete agent from conversation
  const delRes = await handleService(call('DELETE', `/api/conversations/${conv.id}/agents/code-helper`), { env, fetcher });
  assert.equal(delRes.status, 204);

  // 7. Verify deletion
  const listResAfter = await handleService(call('GET', `/api/conversations/${conv.id}/agents`), { env, fetcher });
  assert.equal((await listResAfter.json()).agents.length, 1);

  // 8. Delete nonexistent agent returns 404
  const delMissingRes = await handleService(call('DELETE', `/api/conversations/${conv.id}/agents/code-helper`), { env, fetcher });
  assert.equal(delMissingRes.status, 404);
});

test('Phase 4A: Multi-Agent streaming chat tags events with agentId and saves turns', async () => {
  const db = database();
  const conv = db.addConversation({ id: C1, agent_id: 'personal-agent' });
  // Add a second agent to the conversation
  db.addConversationAgent(conv.id, 'personal-agent');
  db.addConversationAgent(conv.id, 'dua-agent');

  const geminiRoutes = [
    [url => url.includes(':streamGenerateContent'), () => sseResponse([
      sse({ candidates: [{ content: { parts: [{ text: 'Answer chunk' }] } }] }),
      sse({ usageMetadata: { totalTokenCount: 15 } }),
    ])],
  ];
  const fetcher = router([...db.routes, ...geminiRoutes]);

  // User mentions both agents in the prompt
  const response = await handleService(call('POST', '/api/chat', {
    model: 'Dua',
    messages: [{ role: 'user', text: '@PersonalAgent and @DuaAgent please give your views' }],
    conversation_id: conv.id,
    stream: true,
  }), { env, fetcher });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');

  const events = await readEvents(response);
  // Verify tagged events
  const textEvents = events.filter(e => e.type === 'text');
  assert.ok(textEvents.length >= 2, 'Expected text events from multiple agents');
  assert.ok(textEvents.some(e => e.agentId === 'personal-agent'));
  assert.ok(textEvents.some(e => e.agentId === 'dua-agent'));

  const agentDoneEvents = events.filter(e => e.type === 'agent_done');
  assert.equal(agentDoneEvents.length, 2);
  assert.ok(agentDoneEvents.some(e => e.agentId === 'personal-agent'));
  assert.ok(agentDoneEvents.some(e => e.agentId === 'dua-agent'));

  // Final stream done
  assert.ok(events.some(e => e.type === 'done'));

  // Verify that dua_messages contains 1 user turn + 2 separate assistant turns (one for each agent)
  assert.equal(db.messages.length, 3);
  assert.equal(db.messages[0].role, 'user');
  assert.equal(db.messages[1].role, 'assistant');
  assert.equal(db.messages[2].role, 'assistant');
  const agentIds = [db.messages[1].agent_id, db.messages[2].agent_id].sort();
  assert.deepEqual(agentIds, ['dua-agent', 'personal-agent']);
});

test('Phase 4A: group chat without a mention dispatches every assigned agent', async () => {
  const db = database();
  const conv = db.addConversation({ id: C1, agent_id: 'personal-agent' });
  db.addConversationAgent(conv.id, 'personal-agent');
  db.addConversationAgent(conv.id, 'dua-agent');

  let callCount = 0;
  const geminiRoutes = [
    [url => url.includes(':generateContent'), () => {
      callCount++;
      return Response.json({
        candidates: [{ content: { parts: [{ text: `Answer from agent ${callCount}` }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 }
      });
    }],
  ];
  const fetcher = router([...db.routes, ...geminiRoutes]);

  const response = await handleService(call('POST', '/api/chat', {
    model: 'Dua',
    messages: [{ role: 'user', text: 'Please both weigh in on this plan' }],
    conversation_id: conv.id,
    stream: false,
  }), { env, fetcher });

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.replies.length, 2);
  assert.deepEqual(data.replies.map(reply => reply.agentId), ['personal-agent', 'dua-agent']);
  assert.equal(db.messages.length, 3);
  assert.deepEqual([db.messages[1].agent_id, db.messages[2].agent_id], ['personal-agent', 'dua-agent']);

  const membershipRead = fetcher.calls.find(call => call.method === 'GET' && call.url.includes('/rest/v1/dua_conversation_agents'));
  assert.ok(membershipRead, 'group chat must read dua_conversation_agents');
  assert.ok(membershipRead.url.includes(`conversation_id=eq.${conv.id}`));
  assert.equal(/[?&]id=/.test(membershipRead.url), false);

  const rejected = await fetcher(`${SUPA}/rest/v1/dua_conversation_agents?select=agent_id&id=eq.${conv.id}&owner_id=eq.${UID}`, {
    method: 'GET',
    headers: { authorization: 'Bearer user-token' },
  });
  assert.equal(rejected.status, 400);
});

test('Phase 4A: Multi-Agent non-streaming chat returns replies and saves turns', async () => {
  const db = database();
  const conv = db.addConversation({ id: C2, title: 'Group Chat', agent_id: 'personal-agent' });
  db.addConversationAgent(conv.id, 'personal-agent');
  db.addConversationAgent(conv.id, 'dua-agent');

  let callCount = 0;
  const geminiRoutes = [
    [url => url.includes(':generateContent'), () => {
      callCount++;
      return Response.json({
        candidates: [{ content: { parts: [{ text: `Answer from agent ${callCount}` }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 }
      });
    }],
  ];
  const fetcher = router([...db.routes, ...geminiRoutes]);

  const reqBody = {
    model: 'Dua',
    messages: [{ role: 'user', text: '@PersonalAgent and @DuaAgent answer together' }],
    conversation_id: conv.id,
    stream: false,
  };

  const response = await handleService(call('POST', '/api/chat', reqBody), { env, fetcher });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(Array.isArray(data.replies));
  assert.equal(data.replies.length, 2);
  assert.equal(data.replies[0].agentId, 'personal-agent');
  assert.equal(data.replies[1].agentId, 'dua-agent');

  // Verify that dua_messages saved both assistant turns
  assert.equal(db.messages.length, 3);
  assert.equal(db.messages[0].role, 'user');
  assert.equal(db.messages[1].role, 'assistant');
  assert.equal(db.messages[2].role, 'assistant');
  assert.deepEqual([db.messages[1].agent_id, db.messages[2].agent_id].sort(), ['dua-agent', 'personal-agent']);
  assert.equal(db.messages[1].model, env.GEMINI_MODEL);
  assert.equal(data.notice, undefined);
});

// ─── PR D fixes: orphans, save failures, model id, agent_id, token usage ─────

/** Fails POSTs of assistant rows to dua_messages; everything else goes to the in-memory database. */
const failAssistantSaves = [(url, init) => init.method === 'POST' && url.startsWith(`${SUPA}/rest/v1/dua_messages`) && JSON.parse(init.body).role === 'assistant',
  () => Response.json({ message: 'boom' }, { status: 500 })];
const SAVE_NOTICE = 'This reply could not be saved to the conversation. Copy it if you need it, then retry.';

test('PR D: a chat refused by a preflight check writes no orphan user message', async () => {
  const db = database();
  const conv = db.addConversation({ id: C1 });
  const fetcher = router(db.routes);
  const body = { model: 'Dua', messages: [{ role: 'user', text: 'Hello?' }], conversation_id: conv.id };

  const unconfigured = await handleService(call('POST', '/api/chat', body), { env: { ...env, GEMINI_API_KEY: '' }, fetcher });
  assert.equal(unconfigured.status, 503);
  assert.equal(db.messages.length, 0, 'no user row when the provider is not configured');

  const streamed = await handleService(call('POST', '/api/chat', { ...body, stream: true }), { env: { ...env, GEMINI_MODEL: '' }, fetcher });
  assert.equal(streamed.status, 503);
  assert.equal(db.messages.length, 0, 'no user row before a stream that never starts');
});

test('PR D: unknown agent_id is refused with 400; official and owner agents are accepted', async () => {
  const db = database();
  const conv = db.addConversation({ id: C1, agent_id: 'dua-agent' });
  db.customAgents.push({ id: 'code-helper', owner_id: UID, name: 'Code Helper', mode: 'auto', system_prompt: '' });
  const gemini = [url => url.includes(':generateContent'), () => Response.json({ candidates: [{ content: { parts: [{ text: 'Hi.' }] }, finishReason: 'STOP' }] })];
  const fetcher = router([...db.routes, gemini]);
  const body = { model: 'Dua', messages: [{ role: 'user', text: 'Hello' }], conversation_id: conv.id };

  const unknown = await handleService(call('POST', '/api/chat', { ...body, agent_id: 'ghost-agent' }), { env, fetcher });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error, 'Unknown agent_id.');
  assert.equal(db.messages.length, 0);

  const custom = await handleService(call('POST', '/api/chat', { ...body, agentId: 'code-helper' }), { env, fetcher });
  assert.equal(custom.status, 200);
  assert.equal(db.messages.at(-1).agent_id, 'code-helper');

  const official = await handleService(call('POST', '/api/chat', { ...body, agent_id: 'personal-agent' }), { env, fetcher });
  assert.equal(official.status, 200);
  assert.equal(db.messages.at(-1).agent_id, 'personal-agent');
});

test('PR D: a custom agent_id is not called unknown while dua_agents is unreadable (503, nothing written)', async () => {
  const db = database();
  const conv = db.addConversation({ id: C1 });
  const fetcher = router([[url => url.startsWith(`${SUPA}/rest/v1/dua_agents`), () => new Response(null, { status: 500 })], ...db.routes]);
  const res = await handleService(call('POST', '/api/chat', { model: 'Dua', messages: [{ role: 'user', text: 'Hello' }], conversation_id: conv.id, agent_id: 'code-helper' }), { env, fetcher });
  assert.equal(res.status, 503);
  assert.equal(db.messages.length, 0);
});

test('PR D: a streamed reply whose save fails still ends with notice then done', async () => {
  const db = database();
  const conv = db.addConversation({ id: C1 });
  const gemini = [url => url.includes(':streamGenerateContent'), () => sseResponse([
    sse({ candidates: [{ content: { parts: [{ text: 'Kept reply.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2 } }),
  ])];
  const fetcher = router([failAssistantSaves, ...db.routes, gemini]);
  const response = await handleService(call('POST', '/api/chat', { model: 'Dua', messages: [{ role: 'user', text: 'Hi' }], conversation_id: conv.id, stream: true }), { env, fetcher });
  assert.equal(response.status, 200);
  const events = await readEvents(response);
  assert.deepEqual(events, [
    { type: 'text', delta: 'Kept reply.' },
    { type: 'notice', message: SAVE_NOTICE },
    { type: 'done', truncated: false, usage: { inputTokens: 2, outputTokens: 2 } },
  ]);
  assert.equal(events.some(e => e.type === 'error'), false);
  assert.deepEqual(db.messages.map(m => m.role), ['user']);
});

test('PR D: a JSON reply whose save fails returns 200 with the text and a notice', async () => {
  const db = database();
  const conv = db.addConversation({ id: C1 });
  const gemini = [url => url.includes(':generateContent'), () => Response.json({ candidates: [{ content: { parts: [{ text: 'Still here.' }] }, finishReason: 'STOP' }] })];
  const fetcher = router([failAssistantSaves, ...db.routes, gemini]);
  const response = await handleService(call('POST', '/api/chat', { model: 'Dua', messages: [{ role: 'user', text: 'Hi' }], conversation_id: conv.id }), { env, fetcher });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.text, 'Still here.');
  assert.equal(body.notice, SAVE_NOTICE);
  assert.deepEqual(db.messages.map(m => m.role), ['user']);
});

test('PR D: multi-agent JSON keeps every reply when the first agent save fails', async () => {
  const db = database();
  const conv = db.addConversation({ id: C2 });
  db.addConversationAgent(conv.id, 'personal-agent');
  db.addConversationAgent(conv.id, 'dua-agent');
  let n = 0;
  const gemini = [url => url.includes(':generateContent'), () => Response.json({ candidates: [{ content: { parts: [{ text: `Reply ${++n}` }] }, finishReason: 'STOP' }] })];
  const fetcher = router([failAssistantSaves, ...db.routes, gemini]);
  const response = await handleService(call('POST', '/api/chat', { model: 'Dua', messages: [{ role: 'user', text: 'Both of you?' }], conversation_id: conv.id }), { env, fetcher });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.replies.length, 2);
  assert.ok(body.replies.every(reply => reply.text && reply.notice === SAVE_NOTICE));
  assert.equal(body.notice, SAVE_NOTICE);
});

test('PR D: usageTokenCount is the single token_count rule', () => {
  assert.equal(usageTokenCount({ totalTokens: 30, inputTokens: 1, outputTokens: 1 }), 30);
  assert.equal(usageTokenCount({ inputTokens: 12, outputTokens: 6 }), 18);
  assert.equal(usageTokenCount({ outputTokens: 4 }), 4);
  assert.equal(usageTokenCount({ inputTokens: 0, outputTokens: 0 }), null);
  assert.equal(usageTokenCount({ totalTokens: -1, inputTokens: 'x' }), null);
  assert.equal(usageTokenCount(null), null);
  assert.equal(usageTokenCount(undefined), null);
});

// ─── PR D-fix-2: beforeId tie-breaker and the preview guard migration ────────

test('PR D-fix-2: before + beforeId pages through messages that share one created_at', async () => {
  const db = database();
  const conv = db.addConversation({ id: C1 });
  const same = '2026-11-20T10:00:00.123456+00:00';
  const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004'];
  ids.forEach((id, n) => db.addMessage(conv, { id, content: 't' + (n + 1), created_at: same }));
  const fetcher = router(db.routes);
  const get = path => handleService(call('GET', `/api/conversations/${C1}/messages?` + path), { env, fetcher }).then(r => r.json());

  const first = await get('limit=2');
  assert.deepEqual(first.messages.map(m => m.content), ['t3', 't4']);
  const cursor = first.messages[0];
  const tieOnly = await get(`limit=2&before=${encodeURIComponent(cursor.createdAt)}`);
  assert.deepEqual(tieOnly.messages, [], 'before alone skips same-time rows (the old caveat)');
  const next = await get(`limit=2&before=${encodeURIComponent(cursor.createdAt)}&beforeId=${cursor.id.toUpperCase()}`);
  assert.deepEqual(next.messages.map(m => m.content), ['t1', 't2']);
  assert.equal(next.hasMore, false);

  const query = new URL(fetcher.find(SUPA + '/rest/v1/dua_messages').at(-1).url).searchParams;
  assert.equal(query.get('or'), `(created_at.lt."${same}",and(created_at.eq."${same}",id.lt.${ids[2]}))`);
  assert.equal(query.has('created_at'), false);
  assert.equal(query.get('order'), 'created_at.desc,id.desc');
});

test('PR D-fix-2: beforeId needs before and must be a UUID, refused before any database call', async () => {
  const fetcher = router([]);
  const cases = [
    ['beforeId=10000000-0000-4000-8000-000000000001', 'beforeId needs before.'],
    [`before=${encodeURIComponent('2026-11-20T10:00:00Z')}&beforeId=nope`, 'Invalid beforeId.'],
    [`before=${encodeURIComponent('2026-11-20T10:00:00Z')}&beforeId=`, 'Invalid beforeId.'],
  ];
  for (const [path, error] of cases) {
    const res = await handleService(call('GET', `/api/conversations/${C1}/messages?` + path), { env, fetcher });
    assert.equal(res.status, 400, path);
    assert.equal((await res.json()).error, error);
  }
  assert.equal(fetcher.find(SUPA + '/rest/v1/').length, 0);
});

test('PR D-fix-2: an older message does not replace the newer preview', async () => {
  const db = database();
  const conv = db.addConversation({ id: C1 });
  const fetcher = router(db.routes);
  const post = row => fetcher(`${SUPA}/rest/v1/dua_messages`, { method: 'POST', headers: { authorization: 'Bearer user-token' },
    body: JSON.stringify({ conversation_id: C1, owner_id: UID, ...row }) });
  assert.equal((await post({ role: 'user', content: 'newest' })).status, 201);
  assert.equal(conv.last_message_preview, 'newest');
  // Simulates an out-of-order commit: the row is older than last_message_at.
  const at = conv.last_message_at;
  const res = await post({ role: 'assistant', content: 'older', created_at: '2026-01-01T00:00:00+00:00' });
  assert.equal(res.status, 201);
  assert.equal(conv.last_message_preview, 'newest');
  assert.equal(conv.last_message_at, at);
});

test('PR D-fix-2: preview guard migration is additive, guarded and narrows the insert grant', async () => {
  const { readFile } = await import('node:fs/promises');
  const sql = await readFile(new URL('../../../supabase/migrations/202611260002_dua_messages_preview_guard.sql', import.meta.url), 'utf8');
  const code = sql.replace(/--.*$/gm, '');
  assert.match(code, /create or replace function public\.dua_messages_touch_conversation\(\)/);
  assert.match(code, /security definer set search_path = ''/);
  assert.match(code, /last_message_at = greatest\(c\.last_message_at, new\.created_at\)/);
  assert.match(code, /when new\.created_at >= c\.last_message_at/);
  assert.match(code, /else c\.last_message_preview/);
  assert.match(code, /revoke all on function public\.dua_messages_touch_conversation\(\) from public, anon, authenticated;/);
  assert.match(code, /revoke insert on public\.dua_messages from authenticated;/);
  const grant = /grant insert \(([^)]*)\)\s+on public\.dua_messages to authenticated;/.exec(code);
  assert.ok(grant, 'column-level insert grant');
  assert.deepEqual(grant[1].split(',').map(c => c.trim()).sort(), ['agent_id', 'content', 'conversation_id', 'model', 'owner_id', 'role', 'token_count', 'usage']);
  for (const forbidden of [/create\s+table/i, /alter\s+table/i, /\bdrop\s+(table|trigger|function)\b/i, /\bupdate\s+public\.dua_conversations\s+set[\s\S]*\bwhere\b[\s\S]*;\s*$/i, /\bdelete\s+from\b/i, /service_role/i]) {
    assert.doesNotMatch(code.replace(/\$\$[\s\S]*?\$\$/g, ''), forbidden, String(forbidden));
  }
});
