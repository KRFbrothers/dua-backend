// Artifacts and Memory: the two owner-scoped lists the Android app reads.
//
// Both resources are the same shape of problem — a small, owner-scoped list with
// list / create / delete — so they share ONE handler and differ only in a
// resource descriptor (table, id column, field rules). Two copies of the same
// validation would drift; one table of rules cannot.
//
// AUTH: every request goes through resolveOwner, which verifies the Supabase
// access token and refuses any account other than DUA_ALLOWED_EMAIL. The
// database call then uses the USER's token, never a service key, so row level
// security is the second line of defence rather than the only one.
//
// The JSON shape is the one the app already parses (see ArtifactsRepository.kt /
// MemoryRepository.kt in teamily-android-ui):
//   artifact: { id, title, type, timestamp, sizeBytes, url }
//   memory:   { id, title, summary, timestamp, category, url }
// `id` is the app's field name; the column is artifact_id / memory_id.
import { readJsonLimited } from './limited-json.mjs';
import { resolveOwner, StorageError } from './storage.mjs';

const noStore = (error, status) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
const ok = body => Response.json(body, { headers: { 'Cache-Control': 'no-store' } });

// The app's ids are opaque strings it generates; keep them to a safe path segment
// so an id can never change the URL's structure or reach another row.
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_BODY = 16 * 1024;
const LIST_LIMIT = 200;

const RESOURCES = {
  artifacts: {
    table: 'dua_artifacts',
    idColumn: 'artifact_id',
    // The key the app reads the single saved item from: { artifact: {...} }.
    itemKey: 'artifact',
    feature: 'Artifacts',
    // [field, maxLength, required]
    text: [['title', 200, true], ['type', 40, true], ['timestamp', 60, false]],
    // [field, column, min, max] — the app's camelCase name maps to a snake_case column.
    number: [['sizeBytes', 'size_bytes', 0, Number.MAX_SAFE_INTEGER]],
    url: true,
    present: row => ({
      id: row.artifact_id,
      title: row.title,
      type: row.type,
      timestamp: row.timestamp || '',
      sizeBytes: Number(row.size_bytes) || 0,
      url: row.url || null,
    }),
  },
  memories: {
    table: 'dua_memories',
    idColumn: 'memory_id',
    itemKey: 'memory',
    feature: 'Memory',
    text: [['title', 200, true], ['summary', 2000, false], ['timestamp', 60, false], ['category', 40, false]],
    number: [],
    url: true,
    present: row => ({
      id: row.memory_id,
      title: row.title,
      summary: row.summary || '',
      timestamp: row.timestamp || '',
      category: row.category || '',
      url: row.url || null,
    }),
  },
};

/** Trims a value and enforces its length. Returns null when the value is unusable. */
function text(value, max, required) {
  if (value === undefined || value === null) return required ? null : '';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (required && !trimmed) return null;
  if (trimmed.length > max) return null;
  return trimmed;
}

/** Only http(s) links are stored: the app hands them to UrlOpener, which refuses other schemes. */
function link(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  let parsed;
  try { parsed = new URL(value); } catch { return undefined; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
  return parsed.toString();
}

/** Builds the row to insert from the request body, or returns an error message. */
function rowFrom(resource, data, ownerId, now) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'Invalid request.' };
  const id = typeof data.id === 'string' ? data.id.trim() : '';
  if (!ID.test(id)) return { error: 'Invalid id.' };
  const row = { owner_id: ownerId, [resource.idColumn]: id, created_at_ms: now, updated_at_ms: now };
  for (const [field, max, required] of resource.text) {
    const value = text(data[field], max, required);
    if (value === null) return { error: `Invalid ${field}.` };
    row[field] = value;
  }
  for (const [field, column, min, max] of resource.number) {
    const value = data[field] === undefined || data[field] === null ? 0 : data[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return { error: `Invalid ${field}.` };
    row[column] = Math.trunc(value);
  }
  if (resource.url) {
    const value = link(data.url);
    if (value === undefined) return { error: 'Invalid url.' };
    row.url = value;
  }
  return { row };
}

/** Maps an upstream Supabase failure to a safe message; raw upstream text is never returned. */
function upstreamFailure(status) {
  if (status === 401) return noStore('Session expired. Sign in again.', 401);
  if (status === 403) return noStore('This account cannot use this list.', 403);
  if (status === 409) return noStore('That item already exists.', 409);
  if (status === 404) return noStore('This list is not set up. Apply the dua-artifacts-memories migration (see SUPABASE.md).', 503);
  if (status === 429) return noStore('Too many requests. Retry shortly.', 429);
  return noStore('The list is temporarily unavailable. Retry.', 502);
}

/**
 * Handles /api/artifacts and /api/memories.
 *
 *   GET    /api/artifacts            -> { artifacts: [...] }
 *   POST   /api/artifacts            -> { artifact: {...} }   (201)
 *   DELETE /api/artifacts/:id        -> 204
 *   GET    /api/memories             -> { memories: [...] }
 *   POST   /api/memories             -> { memory: {...} }     (201)
 *   DELETE /api/memories/:id         -> 204
 */
export async function handleArtifactsMemories(request, { env = process.env, fetcher = fetch } = {}) {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean);
  const resource = RESOURCES[parts[1]];
  if (parts[0] !== 'api' || !resource || parts.length > 3) return noStore('Not found.', 404);
  const id = parts[2] || '';
  if (parts.length === 3 && !ID.test(id)) return noStore('Not found.', 404);
  const allowed = parts.length === 2 ? ['GET', 'POST'] : ['DELETE'];
  if (!allowed.includes(request.method)) return noStore('Method not allowed.', 405);

  let owner;
  try {
    owner = await resolveOwner(request, { env, fetcher, feature: resource.feature });
  } catch (error) {
    return noStore(error instanceof StorageError ? error.message : 'Account verification is unavailable. Retry.', error.status || 503);
  }

  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_ANON_KEY || '');
  if (!base.startsWith('https://') || !key || key.startsWith('sb_secret_')) return noStore(`${resource.feature} storage is not configured.`, 503);
  const endpoint = `${base}/rest/v1/${resource.table}`;
  const headers = { apikey: key, Authorization: `Bearer ${owner.token}`, Accept: 'application/json' };
  const db = (path, init = {}) => fetcher(endpoint + path, {
    redirect: 'error',
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
  });

  try {
    if (request.method === 'GET') {
      const response = await db(`?select=*&order=updated_at_ms.desc&limit=${LIST_LIMIT}`, { method: 'GET' });
      if (!response.ok) return upstreamFailure(response.status);
      const rows = await response.json();
      if (!Array.isArray(rows)) return noStore(`${resource.feature} returned an invalid list.`, 502);
      return ok({ [parts[1]]: rows.map(resource.present) });
    }

    if (request.method === 'POST') {
      let data;
      try { data = await readJsonLimited(request, MAX_BODY); }
      catch (error) { return noStore(error.status === 413 ? 'This item is too large.' : 'Invalid request.', error.status || 400); }
      const { row, error } = rowFrom(resource, data, owner.user.id, Date.now());
      if (error) return noStore(error, 400);
      // Upsert on the owner+id key: the app's undo path re-adds a deleted item,
      // and a retried POST must not fail with a duplicate-key error.
      const response = await db('?on_conflict=owner_id,' + resource.idColumn, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(row),
      });
      if (!response.ok) return upstreamFailure(response.status);
      const saved = await response.json().catch(() => null);
      const stored = Array.isArray(saved) ? saved[0] : saved;
      if (!stored) return noStore(`${resource.feature} did not confirm the save.`, 502);
      return Response.json({ [resource.itemKey]: resource.present(stored) }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
    }

    // DELETE: the owner filter is explicit as well as enforced by RLS, so a
    // missing policy can never turn this into a cross-account delete.
    const response = await db(`?${resource.idColumn}=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(owner.user.id)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' },
    });
    if (!response.ok) return upstreamFailure(response.status);
    const removed = await response.json().catch(() => []);
    if (!Array.isArray(removed) || removed.length === 0) return noStore('That item was not found.', 404);
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Response) return error;
    return noStore(`${resource.feature} is temporarily unavailable. Retry.`, 502);
  }
}
