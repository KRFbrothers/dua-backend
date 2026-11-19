// Device tokens and Push Notifications (Phase 5B):
// Owner-only device registration and notifications list/read (dua_device_tokens, dua_notifications).
//
// AUTH: Every request goes through resolveOwner, which verifies the Supabase access token and refuses
// any account other than DUA_ALLOWED_EMAIL. Database calls use the USER's token with the anon key,
// never a service key, so row level security decides every row.
//
// FCM HTTP v1: Push notifications use FCM HTTP v1 (OAuth2 service account token), never legacy FCM API.
import crypto from 'node:crypto';
import { readJsonLimited } from './limited-json.mjs';
import { resolveOwner, StorageError } from './storage.mjs';

const noStore = (error, status) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
const ok = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_BODY = 16 * 1024;
const PLATFORMS = new Set(['android', 'web']);

export const presentDevice = row => ({
  id: row.id,
  token: row.token,
  platform: row.platform,
  deviceName: row.device_name || '',
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const presentNotification = row => ({
  id: row.id,
  conversationId: row.conversation_id || null,
  agentId: row.agent_id || null,
  title: row.title,
  body: row.body,
  data: row.data || {},
  status: row.status,
  sentAt: row.sent_at || null,
  createdAt: row.created_at,
});

function upstreamFailure(status, feature = 'Notifications') {
  if (status === 401) return noStore('Session expired. Sign in again.', 401);
  if (status === 403) return noStore(`This account cannot use ${feature}.`, 403);
  if (status === 404) return noStore(`${feature} storage is not set up. Apply the realtime-push migration.`, 503);
  if (status === 429) return noStore('Too many requests. Retry shortly.', 429);
  return noStore(`${feature} are temporarily unavailable. Retry.`, 502);
}

async function readBody(request) {
  try { return { data: await readJsonLimited(request, MAX_BODY) }; }
  catch (error) { return { response: noStore(error.status === 413 ? 'This request is too large.' : 'Invalid request.', error.status || 400) }; }
}

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export async function handleNotifications(request, { env = process.env, fetcher = fetch } = {}) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'devices'|'notifications', ...]
  if (parts[0] !== 'api' || !['devices', 'notifications'].includes(parts[1])) {
    return noStore('Not found.', 404);
  }

  const resource = parts[1];

  let owner;
  try {
    owner = await resolveOwner(request, { env, fetcher, feature: resource === 'devices' ? 'Devices' : 'Notifications' });
  } catch (error) {
    return noStore(error instanceof StorageError ? error.message : 'Account verification is unavailable. Retry.', error.status || 503);
  }

  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_ANON_KEY || '');
  if (!base.startsWith('https://') || !key || key.startsWith('sb_secret_')) {
    return noStore(`${resource === 'devices' ? 'Devices' : 'Notifications'} storage is not configured.`, 503);
  }

  const headers = { apikey: key, Authorization: `Bearer ${owner.token}`, Accept: 'application/json' };
  const db = (table, path, init = {}) => fetcher(`${base}/rest/v1/${table}${path}`, {
    redirect: 'error',
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
  });
  const ownerFilter = `owner_id=eq.${encodeURIComponent(owner.user.id)}`;
  const rowsOf = async response => {
    const rows = await response.json().catch(() => null);
    return Array.isArray(rows) ? rows : null;
  };

  try {
    if (resource === 'devices') {
      // POST /api/devices/register
      if (parts.length === 3 && parts[2] === 'register') {
        if (request.method !== 'POST') return noStore('Method not allowed.', 405);
        const { data, response: invalid } = await readBody(request);
        if (invalid) return invalid;
        if (!isObject(data)) return noStore('Invalid request.', 400);

        const token = typeof data.token === 'string' ? data.token.trim() : '';
        if (!token || token.length > 1000) return noStore('Invalid device token.', 400);

        const platform = typeof data.platform === 'string' ? data.platform.trim().toLowerCase() : '';
        if (!PLATFORMS.has(platform)) return noStore('Invalid platform. Must be android or web.', 400);

        const deviceName = typeof data.deviceName === 'string' ? data.deviceName.trim().slice(0, 100)
          : typeof data.device_name === 'string' ? data.device_name.trim().slice(0, 100) : '';

        const now = new Date().toISOString();
        const row = {
          owner_id: owner.user.id,
          token,
          platform,
          device_name: deviceName,
          updated_at: now,
        };

        const response = await db('dua_device_tokens', '?select=*&on_conflict=owner_id,token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify(row),
        });
        if (!response.ok) return upstreamFailure(response.status, 'Devices');
        const stored = (await rowsOf(response))?.[0];
        if (!stored) return noStore('Failed to register device token.', 502);
        return ok({ device: presentDevice(stored) }, 200);
      }

      // DELETE /api/devices/:token
      if (parts.length === 3) {
        if (request.method !== 'DELETE') return noStore('Method not allowed.', 405);
        const token = parts[2];
        if (!token || token.length > 1000) return noStore('Invalid token.', 400);

        const response = await db('dua_device_tokens', `?token=eq.${encodeURIComponent(token)}&${ownerFilter}`, {
          method: 'DELETE',
          headers: { Prefer: 'return=representation' },
        });
        if (!response.ok) return upstreamFailure(response.status, 'Devices');
        return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
      }

      return noStore('Not found.', 404);
    }

    if (resource === 'notifications') {
      // GET /api/notifications
      if (parts.length === 2) {
        if (request.method !== 'GET') return noStore('Method not allowed.', 405);
        const response = await db('dua_notifications', `?select=*&${ownerFilter}&order=created_at.desc&limit=100`, { method: 'GET' });
        if (!response.ok) return upstreamFailure(response.status, 'Notifications');
        const rows = await rowsOf(response);
        if (!rows) return noStore('Notifications returned an invalid list.', 502);
        return ok({ notifications: rows.map(presentNotification) });
      }

      // PUT /api/notifications/:id/read
      if (parts.length === 4 && parts[3] === 'read') {
        if (request.method !== 'PUT') return noStore('Method not allowed.', 405);
        const id = parts[2];
        if (!UUID_REGEX.test(id)) return noStore('Not found.', 404);

        const response = await db('dua_notifications', `?select=*&id=eq.${encodeURIComponent(id)}&${ownerFilter}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify({ status: 'read' }),
        });
        if (!response.ok) return upstreamFailure(response.status, 'Notifications');
        const rows = await rowsOf(response);
        if (!rows || !rows.length) return noStore('That notification was not found.', 404);
        return ok({ notification: presentNotification(rows[0]) });
      }

      return noStore('Not found.', 404);
    }

    return noStore('Not found.', 404);
  } catch (error) {
    if (error instanceof Response) return error;
    return noStore('Operation temporarily unavailable. Retry.', 502);
  }
}

// ─── FCM HTTP v1 Push Dispatcher ─────────────────────────────────────────────

export function buildFcmV1Payload({ token, title, body, data = {} }) {
  const stringData = {};
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      stringData[String(k)] = typeof v === 'string' ? v : JSON.stringify(v);
    }
  }

  return {
    message: {
      token,
      notification: {
        title,
        body,
      },
      data: stringData,
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'dua_proactive_channel',
        },
      },
    },
  };
}

let cachedOAuthToken = null;
let oAuthTokenExpiresAt = 0;

export async function getGoogleOAuth2AccessToken({ env = process.env, fetcher = fetch } = {}) {
  if (env.FCM_ACCESS_TOKEN) return env.FCM_ACCESS_TOKEN;

  if (cachedOAuthToken && Date.now() < oAuthTokenExpiresAt - 60000) {
    return cachedOAuthToken;
  }

  const clientEmail = env.FCM_CLIENT_EMAIL || env.GOOGLE_CLIENT_EMAIL;
  let privateKey = env.FCM_PRIVATE_KEY || env.GOOGLE_PRIVATE_KEY;
  if (clientEmail && privateKey) {
    try {
      privateKey = privateKey.replace(/\\n/g, '\n');
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        iss: clientEmail,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now,
      })).toString('base64url');

      const signer = crypto.createSign('RSA-SHA256');
      signer.update(`${header}.${payload}`);
      const signature = signer.sign(privateKey, 'base64url');
      const jwt = `${header}.${payload}.${signature}`;

      const tokenRes = await fetcher('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: jwt,
        }).toString(),
        signal: AbortSignal.timeout(10000),
      });
      if (tokenRes.ok) {
        const json = await tokenRes.json().catch(() => null);
        if (json?.access_token) {
          cachedOAuthToken = json.access_token;
          oAuthTokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000;
          return cachedOAuthToken;
        }
      }
    } catch {}
  }

  // Cloud Run instance metadata server
  try {
    const metaRes = await fetcher('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(2000),
    });
    if (metaRes.ok) {
      const json = await metaRes.json().catch(() => null);
      if (json?.access_token) {
        cachedOAuthToken = json.access_token;
        oAuthTokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000;
        return cachedOAuthToken;
      }
    }
  } catch {}

  return null;
}

export async function sendFcmV1Message({ projectId, accessToken, messagePayload, fetcher = fetch }) {
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;
  return fetcher(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(messagePayload),
    signal: AbortSignal.timeout(15000),
  });
}

export async function dispatchPushNotification({ ownerId, ownerToken, notification, env = process.env, fetcher = fetch }) {
  const projectId = env.FCM_PROJECT_ID;
  if (!projectId) {
    // Graceful no-op fallback when FCM is not configured in local tests
    return { dispatched: false, reason: 'fcm_not_configured', count: 0 };
  }

  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_ANON_KEY || '');
  if (!base || !key || !ownerId || !ownerToken) {
    return { dispatched: false, reason: 'storage_not_configured', count: 0 };
  }

  try {
    const tokensRes = await fetcher(`${base}/rest/v1/dua_device_tokens?select=token,platform&owner_id=eq.${encodeURIComponent(ownerId)}`, {
      method: 'GET',
      headers: { apikey: key, Authorization: `Bearer ${ownerToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);

    if (!tokensRes || !tokensRes.ok) return { dispatched: false, reason: 'tokens_fetch_failed', count: 0 };
    const tokens = await tokensRes.json().catch(() => []);
    if (!Array.isArray(tokens) || tokens.length === 0) return { dispatched: false, reason: 'no_devices_registered', count: 0 };

    const accessToken = await getGoogleOAuth2AccessToken({ env, fetcher });
    if (!accessToken) return { dispatched: false, reason: 'auth_failed', count: 0 };

    let sentCount = 0;
    for (const item of tokens) {
      const payload = buildFcmV1Payload({
        token: item.token,
        title: notification.title,
        body: notification.body,
        data: notification.data || {},
      });
      try {
        const sendRes = await sendFcmV1Message({ projectId, accessToken, messagePayload: payload, fetcher });
        if (sendRes.ok) sentCount++;
      } catch {}
    }

    return { dispatched: sentCount > 0, count: sentCount };
  } catch {
    return { dispatched: false, reason: 'dispatch_error', count: 0 };
  }
}
