// Conversations and messages: the owner's relational chat history (dua_conversations, dua_messages).
//
// AUTH: every request goes through resolveOwner, which verifies the Supabase access token and
// refuses any account other than DUA_ALLOWED_EMAIL. Database calls use the USER's token with the
// anon key, never a service key, so row level security decides every row (docs/MASTER_PLAN.md,
// owner decision 1). The owner filter is also explicit on every query.
//
// Messages are only read here. PR D saves them from /api/chat; an insert trigger keeps each
// conversation's last_message_at and last_message_preview current.
//
//   GET    /api/conversations?q=&limit=&offset=         -> { conversations, limit, offset, hasMore }
//   POST   /api/conversations  { id?, title?, agentId? } -> 201 { conversation }
//   GET    /api/conversations/:id/messages?limit=&before= -> { messages, hasMore }
//   PUT    /api/conversations/:id/pin  { pinned }        -> { conversation }
//   DELETE /api/conversations/:id                        -> 204
import { readJsonLimited } from './limited-json.mjs';
import { resolveOwner, StorageError } from './storage.mjs';

const noStore = (error, status) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
const ok = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const MAX_BODY = 16 * 1024;
const MAX_QUERY = 100;
const LIST = { default: 50, max: 100, maxOffset: 10000 };
const MESSAGES = { default: 200, max: 500 };
const CONVERSATION_COLUMNS = 'id,agent_id,title,pinned,last_message_preview,last_message_at,created_at';
const MESSAGE_COLUMNS = 'id,conversation_id,agent_id,role,content,model,token_count,usage,created_at';
const FEATURE = 'Conversations';

const presentConversation = row => ({
  id: row.id,
  agentId: row.agent_id,
  title: row.title,
  pinned: row.pinned === true,
  lastMessagePreview: row.last_message_preview || '',
  lastMessageAt: row.last_message_at,
  createdAt: row.created_at,
});
const presentMessage = row => ({
  id: row.id,
  conversationId: row.conversation_id,
  agentId: row.agent_id ?? null,
  role: row.role,
  content: row.content,
  model: row.model ?? null,
  tokenCount: row.token_count ?? null,
  usage: row.usage ?? null,
  createdAt: row.created_at,
});

/** Whole-number query parameter within [min, max]; the fallback when absent; null when invalid. */
function integerParam(params, name, fallback, min, max) {
  const raw = params.get(name);
  if (raw === null || raw === '') return fallback;
  if (!/^\d{1,6}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

/**
 * Title search text for PostgREST `ilike`. `*` is PostgREST's wildcard and is removed; `\`, `%` and
 * `_` are escaped so the owner's text is matched literally. Returns '' for no filter, null when invalid.
 */
export function searchPattern(raw) {
  if (raw === null) return '';
  const text = raw.trim();
  if (text.length > MAX_QUERY) return null;
  const literal = text.replace(/\*/g, '').replace(/[\\%_]/g, match => '\\' + match);
  return literal ? `*${literal}*` : '';
}

/** Maps an upstream Supabase failure to a safe message; raw upstream text is never returned. */
export function upstreamFailure(status) {
  if (status === 401) return noStore('Session expired. Sign in again.', 401);
  if (status === 403) return noStore('This account cannot use conversations.', 403);
  if (status === 409) return noStore('That conversation id is already used.', 409);
  if (status === 404) return noStore('Conversations are not set up. Apply the dua-conversations-messages migration (see SUPABASE.md).', 503);
  if (status === 429) return noStore('Too many requests. Retry shortly.', 429);
  return noStore('Conversations are temporarily unavailable. Retry.', 502);
}

async function readBody(request) {
  try { return { data: await readJsonLimited(request, MAX_BODY) }; }
  catch (error) { return { response: noStore(error.status === 413 ? 'This request is too large.' : 'Invalid request.', error.status || 400) }; }
}

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Builds the conversation row to insert from the request body, or returns an error message. */
function conversationRow(data, ownerId) {
  if (!isObject(data)) return { error: 'Invalid request.' };
  const row = { owner_id: ownerId };
  if (data.id !== undefined && data.id !== null) {
    if (typeof data.id !== 'string' || !UUID.test(data.id)) return { error: 'Invalid id.' };
    row.id = data.id.toLowerCase();
  }
  if (data.title !== undefined && data.title !== null) {
    const title = typeof data.title === 'string' ? data.title.trim() : '';
    if (!title || title.length > 200) return { error: 'Invalid title.' };
    row.title = title;
  }
  if (data.agentId !== undefined && data.agentId !== null) {
    if (typeof data.agentId !== 'string' || !AGENT_ID.test(data.agentId)) return { error: 'Invalid agentId.' };
    row.agent_id = data.agentId;
  }
  return { row };
}

export async function handleConversations(request, { env = process.env, fetcher = fetch } = {}) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'conversations' || parts.length > 4) return noStore('Not found.', 404);
  const id = parts[2] || '';
  const action = parts[3] || '';
  if (parts.length >= 3 && !UUID.test(id)) return noStore('Not found.', 404);
  if (parts.length === 4 && !['messages', 'pin'].includes(action)) return noStore('Not found.', 404);
  const allowed = parts.length === 2 ? ['GET', 'POST'] : parts.length === 3 ? ['DELETE'] : action === 'messages' ? ['GET'] : ['PUT'];
  if (!allowed.includes(request.method)) return noStore('Method not allowed.', 405);

  let owner;
  try {
    owner = await resolveOwner(request, { env, fetcher, feature: FEATURE });
  } catch (error) {
    return noStore(error instanceof StorageError ? error.message : 'Account verification is unavailable. Retry.', error.status || 503);
  }

  // The anon (publishable) key only: a secret or service-role key is refused, never used.
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_ANON_KEY || '');
  if (!base.startsWith('https://') || !key || key.startsWith('sb_secret_')) return noStore(`${FEATURE} storage is not configured.`, 503);
  const headers = { apikey: key, Authorization: `Bearer ${owner.token}`, Accept: 'application/json' };
  const db = (table, path, init = {}) => fetcher(`${base}/rest/v1/${table}${path}`, {
    redirect: 'error',
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
  });
  const ownerFilter = `owner_id=eq.${encodeURIComponent(owner.user.id)}`;
  const conversationFilter = `id=eq.${encodeURIComponent(id.toLowerCase())}&${ownerFilter}`;
  const rowsOf = async response => {
    const rows = await response.json().catch(() => null);
    return Array.isArray(rows) ? rows : null;
  };

  try {
    if (parts.length === 2 && request.method === 'GET') {
      const params = url.searchParams;
      const pattern = searchPattern(params.get('q'));
      if (pattern === null) return noStore('Invalid q.', 400);
      const limit = integerParam(params, 'limit', LIST.default, 1, LIST.max);
      if (limit === null) return noStore('Invalid limit.', 400);
      const offset = integerParam(params, 'offset', 0, 0, LIST.maxOffset);
      if (offset === null) return noStore('Invalid offset.', 400);
      const search = pattern ? `&title=ilike.${encodeURIComponent(pattern)}` : '';
      const response = await db('dua_conversations',
        `?select=${CONVERSATION_COLUMNS}&${ownerFilter}${search}&order=pinned.desc,last_message_at.desc,id.desc&limit=${limit + 1}&offset=${offset}`,
        { method: 'GET' });
      if (!response.ok) return upstreamFailure(response.status);
      const rows = await rowsOf(response);
      if (!rows) return noStore(`${FEATURE} returned an invalid list.`, 502);
      return ok({ conversations: rows.slice(0, limit).map(presentConversation), limit, offset, hasMore: rows.length > limit });
    }

    if (parts.length === 2) {
      const { data, response: invalid } = await readBody(request);
      if (invalid) return invalid;
      const { row, error } = conversationRow(data, owner.user.id);
      if (error) return noStore(error, 400);
      // A client id makes a retried create safe: a duplicate id is ignored and the saved row returned.
      const response = await db('dua_conversations', `?select=${CONVERSATION_COLUMNS}${row.id ? '&on_conflict=id' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: (row.id ? 'resolution=ignore-duplicates,' : '') + 'return=representation' },
        body: JSON.stringify(row),
      });
      if (!response.ok) return upstreamFailure(response.status);
      let stored = (await rowsOf(response))?.[0];
      if (!stored && row.id) {
        const existing = await db('dua_conversations', `?select=${CONVERSATION_COLUMNS}&id=eq.${encodeURIComponent(row.id)}&${ownerFilter}&limit=1`, { method: 'GET' });
        if (!existing.ok) return upstreamFailure(existing.status);
        stored = (await rowsOf(existing))?.[0];
        // The id exists but is not visible to this owner.
        if (!stored) return upstreamFailure(409);
      }
      if (!stored) return noStore(`${FEATURE} did not confirm the save.`, 502);
      return ok({ conversation: presentConversation(stored) }, 201);
    }

    if (action === 'messages') {
      const params = url.searchParams;
      const limit = integerParam(params, 'limit', MESSAGES.default, 1, MESSAGES.max);
      if (limit === null) return noStore('Invalid limit.', 400);
      const before = params.get('before');
      if (before !== null && (!ISO_TIME.test(before) || Number.isNaN(Date.parse(before)))) return noStore('Invalid before.', 400);
      const found = await db('dua_conversations', `?select=id&${conversationFilter}&limit=1`, { method: 'GET' });
      if (!found.ok) return upstreamFailure(found.status);
      const conversation = await rowsOf(found);
      if (!conversation) return noStore(`${FEATURE} returned an invalid list.`, 502);
      if (!conversation.length) return noStore('That conversation was not found.', 404);
      const cursor = before === null ? '' : `&created_at=lt.${encodeURIComponent(before)}`;
      const response = await db('dua_messages',
        `?select=${MESSAGE_COLUMNS}&conversation_id=eq.${encodeURIComponent(id.toLowerCase())}&${ownerFilter}${cursor}&order=created_at.desc,id.desc&limit=${limit + 1}`,
        { method: 'GET' });
      if (!response.ok) return upstreamFailure(response.status);
      const rows = await rowsOf(response);
      if (!rows) return noStore(`${FEATURE} returned an invalid list.`, 502);
      // Newest page first from the database, returned oldest-first for display.
      return ok({ messages: rows.slice(0, limit).reverse().map(presentMessage), hasMore: rows.length > limit });
    }

    if (action === 'pin') {
      const { data, response: invalid } = await readBody(request);
      if (invalid) return invalid;
      if (!isObject(data) || typeof data.pinned !== 'boolean') return noStore('Invalid pinned.', 400);
      const response = await db('dua_conversations', `?select=${CONVERSATION_COLUMNS}&${conversationFilter}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ pinned: data.pinned }),
      });
      if (!response.ok) return upstreamFailure(response.status);
      const rows = await rowsOf(response);
      if (!rows || !rows.length) return noStore('That conversation was not found.', 404);
      return ok({ conversation: presentConversation(rows[0]) });
    }

    // DELETE: messages are removed by the database cascade.
    const response = await db('dua_conversations', `?${conversationFilter}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' },
    });
    if (!response.ok) return upstreamFailure(response.status);
    const removed = await rowsOf(response);
    if (!removed || removed.length === 0) return noStore('That conversation was not found.', 404);
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Response) return error;
    return noStore(`${FEATURE} are temporarily unavailable. Retry.`, 502);
  }
}

/**
 * PR D: Chat persistence for relational conversations (dua_conversations + dua_messages).
 * Verifies the owner session and conversation ownership, then writes the user's turn to dua_messages
 * before the stream starts. Returns a commit helper that writes the assistant's turn once generation
 * finishes cleanly. Database triggers keep last_message_at and last_message_preview up to date.
 */
export async function prepareConversationChat(request, data, { env = process.env, fetcher = fetch } = {}) {
  const conversationId = (data.conversation_id || data.conversationId)?.toLowerCase();
  if (!conversationId || !UUID.test(conversationId)) {
    throw Object.assign(new Error('Invalid conversation_id.'), { status: 400 });
  }

  let owner;
  try {
    owner = await resolveOwner(request, { env, fetcher, feature: FEATURE });
  } catch (error) {
    throw Object.assign(
      new Error(error instanceof StorageError ? error.message : 'Account verification is unavailable. Retry.'),
      { status: error.status || 503 }
    );
  }

  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_ANON_KEY || '');
  if (!base.startsWith('https://') || !key || key.startsWith('sb_secret_')) {
    throw Object.assign(new Error(`${FEATURE} storage is not configured.`), { status: 503 });
  }

  const headers = { apikey: key, Authorization: `Bearer ${owner.token}`, Accept: 'application/json' };
  const ownerFilter = `owner_id=eq.${encodeURIComponent(owner.user.id)}`;
  const conversationFilter = `id=eq.${encodeURIComponent(conversationId)}&${ownerFilter}`;

  const found = await fetcher(`${base}/rest/v1/dua_conversations?select=id,agent_id&${conversationFilter}&limit=1`, {
    method: 'GET',
    headers,
    redirect: 'error',
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
  });
  if (!found.ok) {
    const failure = upstreamFailure(found.status);
    const body = await failure.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `${FEATURE} are temporarily unavailable. Retry.`), { status: failure.status });
  }
  const convRows = await found.json().catch(() => null);
  if (!Array.isArray(convRows) || convRows.length === 0) {
    throw Object.assign(new Error('That conversation was not found.'), { status: 404 });
  }
  const conv = convRows[0];
  const agentId = data.agent_id || data.agentId || conv.agent_id || 'personal-agent';

  const lastUserTurn = data.messages?.at(-1);
  const userContent = lastUserTurn?.text || '';
  const userRow = {
    conversation_id: conversationId,
    owner_id: owner.user.id,
    agent_id: null,
    role: 'user',
    content: userContent,
  };
  const saveUserRes = await fetcher(`${base}/rest/v1/dua_messages`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(userRow),
    redirect: 'error',
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
  });
  if (!saveUserRes.ok) {
    const failure = upstreamFailure(saveUserRes.status);
    const body = await failure.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `${FEATURE} are temporarily unavailable. Retry.`), { status: failure.status });
  }

  return {
    owner,
    conversationId,
    agentId,
    async commitAssistantMessage({ text, model, tokenCount = null, usage = null }, signal) {
      const assistantRow = {
        conversation_id: conversationId,
        owner_id: owner.user.id,
        agent_id: agentId,
        role: 'assistant',
        content: text,
        model: model ? String(model).slice(0, 120) : null,
        token_count: Number.isInteger(tokenCount) && tokenCount >= 0 ? tokenCount : null,
        usage: usage && typeof usage === 'object' ? usage : null,
      };
      const saveRes = await fetcher(`${base}/rest/v1/dua_messages`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(assistantRow),
        redirect: 'error',
        signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)]),
      });
      if (!saveRes.ok) {
        const failure = upstreamFailure(saveRes.status);
        const body = await failure.json().catch(() => ({}));
        throw Object.assign(new Error(body.error || `${FEATURE} are temporarily unavailable. Retry.`), { status: failure.status });
      }
      const saved = await saveRes.json().catch(() => null);
      return Array.isArray(saved) ? saved[0] : null;
    },
  };
}
