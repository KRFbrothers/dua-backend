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
// Phase 3 Memory upgrades:
// - Scope boundary: 'global' (cross-chat) vs 'group:<conversation_id>' (thread-specific).
// - Privacy-safe retrieval: loads memories for 'global' OR current 'group:<conversation_id>' only.
// - Scope toggle: PUT /api/memories/:id to modify scope or properties.
// - Background auto-extraction: extracts durable facts from chat turns non-blockingly.
import { readJsonLimited } from './limited-json.mjs';
import { resolveOwner, StorageError } from './storage.mjs';
import { searchPattern } from './conversations.mjs';

const noStore = (error, status) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
const ok = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

// The app's ids are opaque strings it generates; keep them to a safe path segment
// so an id can never change the URL's structure or reach another row.
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const SCOPE_REGEX = /^(global|group:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
export const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_BODY = 16 * 1024;
const LIST_LIMIT = 200;

const SECRET_PATTERNS = [
  /[^\s@]+@[^\s@]+\.[^\s@]+/i,                         // email
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/i,        // JWT
  /\b(sk|pk|rk|xai|sb|ghp|gho|ghs|ghu|github_pat|glpat|AIza|AKIA|ya29)[-_]?[A-Za-z0-9_\-]{10,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY/i,
  /\bbearer\s+\S{8,}/i,
  /\b(password|passwd|secret|api[_ -]?key|token|private[_ -]?key)\b\s*[:=]\s*\S+/i,
  /\b[A-Fa-f0-9]{32,}\b/,                             // long hex
  /\b[A-Za-z0-9+/_-]{40,}={0,2}/,                     // base64 blob
];

function isUnsafeMemory(text) {
  if (!text || typeof text !== 'string') return true;
  return SECRET_PATTERNS.some(p => p.test(text));
}

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
      scope: row.scope || 'global',
      sourceConversationId: row.source_conversation_id || null,
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
  if (resource.table === 'dua_memories') {
    if (data.scope !== undefined && data.scope !== null) {
      if (typeof data.scope !== 'string' || !SCOPE_REGEX.test(data.scope)) return { error: 'Invalid scope.' };
      row.scope = data.scope;
    } else {
      row.scope = 'global';
    }
    if (data.sourceConversationId !== undefined && data.sourceConversationId !== null && data.sourceConversationId !== '') {
      if (typeof data.sourceConversationId !== 'string' || !UUID_REGEX.test(data.sourceConversationId)) return { error: 'Invalid sourceConversationId.' };
      row.source_conversation_id = data.sourceConversationId;
    } else if (row.scope.startsWith('group:')) {
      row.source_conversation_id = row.scope.slice('group:'.length);
    } else {
      row.source_conversation_id = null;
    }
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
 *   GET    /api/memories             -> { memories: [...] }   (supports ?scope= and ?conversation_id=)
 *   POST   /api/memories             -> { memory: {...} }     (201)
 *   PUT    /api/memories/:id         -> { memory: {...} }     (200, scope toggle / edit)
 *   DELETE /api/memories/:id         -> 204
 */
export async function handleArtifactsMemories(request, { env = process.env, fetcher = fetch } = {}) {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean);
  const resource = RESOURCES[parts[1]];
  if (parts[0] !== 'api' || !resource || parts.length > 4) return noStore('Not found.', 404);
  const id = parts[2] || '';
  const action = parts[3] || '';
  if (parts.length >= 3 && !ID.test(id)) return noStore('Not found.', 404);
  if (parts.length === 4 && (parts[1] !== 'artifacts' || !['versions', 'revise'].includes(action))) return noStore('Not found.', 404);

  const allowed = parts.length === 2 ? ['GET', 'POST'] :
    parts.length === 3 ? (resource.table === 'dua_memories' ? ['DELETE', 'PUT'] : ['DELETE']) :
    (action === 'versions' ? ['GET'] : ['POST']);
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
    if (parts.length === 4 && parts[1] === 'artifacts') {
      // 1. Verify artifact exists
      const artRes = await db(`?artifact_id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(owner.user.id)}&limit=1`, { method: 'GET' });
      if (!artRes.ok) return upstreamFailure(artRes.status);
      const artRows = await artRes.json().catch(() => []);
      if (!Array.isArray(artRows) || artRows.length === 0) return noStore('That item was not found.', 404);
      const currentArtifact = artRows[0];

      if (action === 'versions' && request.method === 'GET') {
        const vRes = await fetcher(`${base}/rest/v1/dua_artifact_versions?select=id,artifact_id,version_num,content,prompt_note,created_at&artifact_id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(owner.user.id)}&order=version_num.desc`, {
          method: 'GET',
          headers,
          redirect: 'error',
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
        });
        if (!vRes.ok) return upstreamFailure(vRes.status);
        const vRows = await vRes.json().catch(() => []);
        if (!Array.isArray(vRows)) return noStore('Artifact versions returned an invalid list.', 502);
        return ok({
          versions: vRows.map(r => ({
            id: r.id,
            artifactId: r.artifact_id,
            versionNum: r.version_num,
            content: r.content,
            promptNote: r.prompt_note,
            createdAt: r.created_at,
          })),
        });
      }

      if (action === 'revise' && request.method === 'POST') {
        let data;
        try { data = await readJsonLimited(request, MAX_BODY); }
        catch (error) { return noStore(error.status === 413 ? 'This request is too large.' : 'Invalid request.', error.status || 400); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) return noStore('Invalid request.', 400);
        const instruction = typeof data.instruction === 'string' ? data.instruction.trim() : '';
        if (!instruction || instruction.length > 5000) return noStore('Invalid instruction.', 400);

        // Fetch latest version
        const latestRes = await fetcher(`${base}/rest/v1/dua_artifact_versions?select=version_num,content&artifact_id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(owner.user.id)}&order=version_num.desc&limit=1`, {
          method: 'GET',
          headers,
          redirect: 'error',
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
        });
        const latestRows = latestRes.ok ? await latestRes.json().catch(() => []) : [];
        const latestRow = Array.isArray(latestRows) && latestRows.length > 0 ? latestRows[0] : null;
        const currentContent = latestRow ? latestRow.content : `${currentArtifact.title}\n${currentArtifact.url || ''}`;

        // A missing key is a server configuration error, not an empty revision.
        if (!env.GEMINI_API_KEY) return noStore('AI revision is not configured on this server.', 503);

        let revisedContent = '';
        const model = env.GEMINI_MODEL || 'gemini-3.8-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
        const prompt = `You are an AI artifact editor in a collaborative studio.\n\nCurrent Content:\n${currentContent}\n\nRevision Instruction: ${instruction}\n\nGenerate the complete revised content for this artifact. Return ONLY the revised content without any introductory or conversational remarks.`;
        try {
          const geminiRes = await fetcher(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: 8192, temperature: 0.3 },
            }),
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(30000)]),
          });
          if (geminiRes.ok) {
            const gJson = await geminiRes.json().catch(() => null);
            revisedContent = gJson?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          }
        } catch {}
        if (!revisedContent.trim()) return noStore('Artifact revision failed. Retry.', 502);

        // Save new version. A 409 means another revise took that number: re-read once and retry once.
        const versionUrl = `${base}/rest/v1/dua_artifact_versions?select=version_num&artifact_id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(owner.user.id)}&order=version_num.desc&limit=1`;
        const insertNextVersion = async () => {
          const freshRes = await fetcher(versionUrl, {
            method: 'GET',
            headers,
            redirect: 'error',
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
          });
          const freshRows = freshRes.ok ? await freshRes.json().catch(() => []) : [];
          const freshVersion = Array.isArray(freshRows) && freshRows.length > 0 ? Number(freshRows[0].version_num) || 0 : 0;
          return fetcher(`${base}/rest/v1/dua_artifact_versions`, {
            method: 'POST',
            headers: {
              ...headers,
              'Content-Type': 'application/json',
              Prefer: 'return=representation',
            },
            body: JSON.stringify({
              artifact_id: id,
              owner_id: owner.user.id,
              version_num: freshVersion + 1,
              content: revisedContent,
              prompt_note: instruction,
            }),
            redirect: 'error',
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
          });
        };
        let saveVRes = await insertNextVersion();
        if (saveVRes.status === 409) saveVRes = await insertNextVersion();
        if (saveVRes.status === 409) return noStore('Failed to save artifact version.', 409);
        if (!saveVRes.ok) return upstreamFailure(saveVRes.status);
        const savedV = (await saveVRes.json().catch(() => []))?.[0] || null;
        if (!savedV) return noStore('Failed to save artifact version.', 502);

        // Update artifact updated_at_ms and size_bytes
        const patchArtRes = await db(`?artifact_id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(owner.user.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify({
            updated_at_ms: Date.now(),
            size_bytes: Buffer.byteLength(revisedContent, 'utf8'),
          }),
        });
        const updatedArt = (await patchArtRes.json().catch(() => []))?.[0] || currentArtifact;

        return ok({
          artifact: resource.present(updatedArt),
          version: {
            id: savedV.id,
            artifactId: savedV.artifact_id,
            versionNum: savedV.version_num,
            content: savedV.content,
            promptNote: savedV.prompt_note,
            createdAt: savedV.created_at,
          },
        }, 201);
      }
    }

    if (request.method === 'GET') {
      const url = new URL(request.url);
      let filter = `order=updated_at_ms.desc&limit=${LIST_LIMIT}`;
      if (resource.table === 'dua_memories') {
        const scopeParam = url.searchParams.get('scope');
        const convParam = url.searchParams.get('conversation_id') || url.searchParams.get('conversationId');
        const pattern = searchPattern(url.searchParams.get('q'));
        if (pattern === null) return noStore('Invalid q.', 400);
        if (convParam) {
          if (!UUID_REGEX.test(convParam)) return noStore('Invalid conversation_id.', 400);
          // Privacy boundary: retrieve global + current thread memories only
          filter += `&scope=in.(global,group:${convParam})`;
        } else if (scopeParam) {
          if (!SCOPE_REGEX.test(scopeParam)) return noStore('Invalid scope.', 400);
          filter += `&scope=eq.${encodeURIComponent(scopeParam)}`;
        }
        if (pattern) {
          // Title or summary, matched literally. The value is double-quoted for PostgREST's or=(),
          // so commas and parentheses are safe; `\` and `"` are escaped for the quoted form.
          const quoted = `"${pattern.replace(/[\\"]/g, match => '\\' + match)}"`;
          filter += `&or=${encodeURIComponent(`(title.ilike.${quoted},summary.ilike.${quoted})`)}`;
        }
      }

      const response = await db(`?select=*&${filter}`, { method: 'GET' });
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

    if (request.method === 'PUT') {
      let data;
      try { data = await readJsonLimited(request, MAX_BODY); }
      catch (error) { return noStore(error.status === 413 ? 'This item is too large.' : 'Invalid request.', error.status || 400); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return noStore('Invalid request.', 400);

      const patch = { updated_at_ms: Date.now() };
      if (data.scope !== undefined) {
        if (typeof data.scope !== 'string' || !SCOPE_REGEX.test(data.scope)) return noStore('Invalid scope.', 400);
        patch.scope = data.scope;
        if (data.scope.startsWith('group:')) {
          patch.source_conversation_id = data.scope.slice('group:'.length);
        } else if (data.scope === 'global' && data.sourceConversationId === null) {
          patch.source_conversation_id = null;
        }
      }
      if (data.sourceConversationId !== undefined) {
        if (data.sourceConversationId !== null && (typeof data.sourceConversationId !== 'string' || !UUID_REGEX.test(data.sourceConversationId))) {
          return noStore('Invalid sourceConversationId.', 400);
        }
        patch.source_conversation_id = data.sourceConversationId;
      }
      if (data.title !== undefined) {
        const titleVal = text(data.title, 200, true);
        if (titleVal === null) return noStore('Invalid title.', 400);
        patch.title = titleVal;
      }
      if (data.summary !== undefined) {
        const summaryVal = text(data.summary, 2000, false);
        if (summaryVal === null) return noStore('Invalid summary.', 400);
        patch.summary = summaryVal;
      }
      if (data.category !== undefined) {
        const catVal = text(data.category, 40, false);
        if (catVal === null) return noStore('Invalid category.', 400);
        patch.category = catVal;
      }
      if (data.url !== undefined) {
        const linkVal = link(data.url);
        if (linkVal === undefined) return noStore('Invalid url.', 400);
        patch.url = linkVal;
      }

      const response = await db(`?memory_id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(owner.user.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      if (!response.ok) return upstreamFailure(response.status);
      const updated = await response.json().catch(() => []);
      if (!Array.isArray(updated) || updated.length === 0) return noStore('That item was not found.', 404);
      return ok({ memory: resource.present(updated[0]) });
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

/**
 * Loads privacy-safe memories for the owner:
 * - If conversationId is given: loads where scope is 'global' OR 'group:<conversationId>'.
 * - If no conversationId: loads where scope is 'global' only.
 * - Never returns memories tagged with other group:<id> scopes.
 */
export async function loadPrivacySafeMemories({ base, headers, ownerId, conversationId = null, fetcher = fetch, signal = null, limit = 10 }) {
  if (!base || !headers || !ownerId) return [];
  const scopeFilter = conversationId && UUID_REGEX.test(conversationId)
    ? `scope=in.(global,group:${conversationId})`
    : 'scope=eq.global';
  const ownerFilter = `owner_id=eq.${encodeURIComponent(ownerId)}`;
  try {
    const res = await fetcher(`${base}/rest/v1/dua_memories?select=memory_id,title,summary,category,scope,source_conversation_id&${ownerFilter}&${scopeFilter}&order=updated_at_ms.desc&limit=${limit}`, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** Formats memory rows into a structured notes block for context injection. */
export function formatMemories(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  return rows.map(r => {
    const scopeLabel = r.scope === 'global' ? 'global' : 'thread';
    const cat = r.category ? ` (${r.category})` : '';
    const body = r.summary ? `${r.title}: ${r.summary}` : r.title;
    return `- [${scopeLabel}${cat}] ${body}`.trim();
  }).join('\n');
}

/**
 * Background auto-extraction: extracts durable facts/preferences from a chat turn.
 * Runs non-blockingly via queueMicrotask, never affects the ongoing chat stream/response.
 */
export function triggerMemoryAutoExtraction({ userText, assistantText, conversationId = null, owner, env = process.env, fetcher = fetch }) {
  if (env.DISABLE_MEMORY_EXTRACTION === '1' || !owner?.user?.id || !owner?.token) return;
  if (!userText || typeof userText !== 'string' || userText.length < 5) return;
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_ANON_KEY || '');
  const geminiKey = env.GEMINI_API_KEY;
  if (!base || !key || !geminiKey) return;

  const model = env.GEMINI_MODEL || 'gemini-3.8-flash';
  const extractUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`;

  queueMicrotask(async () => {
    try {
      const prompt = `You are a memory extractor for an AI assistant. Analyze this single conversation turn and extract 0 to 2 durable facts or user preferences worth remembering for future sessions.\n\nClassification rules:\n- "global": General preferences (e.g. coding style, preferred framework, tone, language, domain) that apply to ANY future conversation.\n- "thread": Project-specific, architecture, or sensitive thread facts (e.g. project setup, current repo name, local ports) that apply ONLY to this specific thread.\n\nSkip transient Q&A, greetings, one-off bugs, and sensitive data (passwords, tokens, keys, emails, secrets).\n\nUser: ${userText.slice(0, 1500)}\nAssistant: ${(assistantText || '').slice(0, 1500)}\n\nReply with JSON ONLY:\n{"memories": [{"title": "short title max 50 chars", "summary": "brief summary max 200 chars", "category": "preference|fact|project", "scope": "global|thread"}]}`;

      const res = await fetcher(extractUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 512, temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return;
      const json = await res.json().catch(() => null);
      const textVal = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const cleanJson = textVal.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(cleanJson);
      const items = Array.isArray(parsed?.memories) ? parsed.memories : [];

      for (const item of items.slice(0, 2)) {
        if (!item || typeof item !== 'object') continue;
        const title = (typeof item.title === 'string' ? item.title.trim() : '').slice(0, 200);
        const summary = (typeof item.summary === 'string' ? item.summary.trim() : '').slice(0, 2000);
        if (!title || isUnsafeMemory(title) || isUnsafeMemory(summary)) continue;

        const isThread = item.scope === 'thread' && conversationId;
        const scope = isThread ? `group:${conversationId}` : 'global';
        const now = Date.now();
        const memId = 'mem_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);

        const row = {
          owner_id: owner.user.id,
          memory_id: memId,
          title,
          summary,
          timestamp: 'Just now',
          category: (typeof item.category === 'string' ? item.category.trim() : 'fact').slice(0, 40),
          url: null,
          scope,
          source_conversation_id: isThread ? conversationId : null,
          created_at_ms: now,
          updated_at_ms: now,
        };

        await fetcher(`${base}/rest/v1/dua_memories`, {
          method: 'POST',
          headers: {
            apikey: key,
            Authorization: `Bearer ${owner.token}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify(row),
          signal: AbortSignal.timeout(10000),
        }).catch(() => {});
      }
    } catch {
      // Non-blocking background extraction never throws
    }
  });
}
