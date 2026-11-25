import test from 'node:test';
import assert from 'node:assert/strict';
import { handleService } from '../src/server/service-handler.mjs';
import { buildFcmV1Payload, sendFcmV1Message, dispatchPushNotification } from '../src/core/notifications.mjs';
import { filesEnv, router, SUPA, UID, OTHER } from './files-helpers.mjs';

const env = { ...filesEnv, FCM_PROJECT_ID: 'test-dua-firebase' };

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
  const deviceTokens = [];
  const notifications = [];
  let clock = Date.parse('2026-11-19T00:00:00Z');
  const stamp = () => new Date(clock += 1000).toISOString();
  const ownerOf = init => new Headers(init.headers).get('authorization') === 'Bearer user-token' ? UID : 'nobody';
  const eq = (query, name) => query.get(name)?.replace(/^eq\./, '');

  const filter = (rows, query, owner) => rows.filter(row => {
    if (row.owner_id !== owner) return false;
    for (const name of ['id', 'owner_id', 'token']) {
      if (query.has(name) && row[name] !== eq(query, name)) return false;
    }
    return true;
  });

  const tables = {
    dua_device_tokens: deviceTokens,
    dua_notifications: notifications,
  };

  const routes = [
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
        const list = filter(rows, query, owner);
        return Response.json(list);
      }

      if (method === 'POST') {
        const body = JSON.parse(init.body);
        if (body.owner_id !== owner) return Response.json({ message: 'row-level security' }, { status: 403 });

        const prefer = headers.get('prefer') || '';
        const isUpsert = prefer.includes('resolution=merge-duplicates');
        const existingIdx = rows.findIndex(r => r.owner_id === body.owner_id && r.token === body.token);

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
    [url => url.startsWith('https://fcm.googleapis.com/v1/projects/'), (url, init) => {
      const headers = new Headers(init.headers);
      if (!headers.get('authorization')?.startsWith('Bearer ')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      return Response.json({ name: 'projects/test-dua-firebase/messages/msg_12345' });
    }]
  ];

  return { deviceTokens, notifications, routes };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('Phase 5A: GET /api/config exposes realtime enabled flag and 5 synced tables', async () => {
  const db = database();
  const fetcher = router(db.routes);

  const res = await handleService(call('GET', '/api/config'), { env, fetcher });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.realtime);
  assert.equal(data.realtime.enabled, true);
  assert.deepEqual(data.realtime.tables, [
    'dua_conversations',
    'dua_messages',
    'dua_agents',
    'dua_artifacts',
    'dua_artifact_versions',
  ]);
});

test('Phase 5B: POST /api/devices/register registers and upserts device token cleanly', async () => {
  const db = database();
  const fetcher = router(db.routes);

  // 1. Initial register
  const res1 = await handleService(call('POST', '/api/devices/register', {
    token: 'fcm-device-token-111',
    platform: 'android',
    deviceName: 'Realme 14 Pro+ 5G',
  }), { env, fetcher });
  assert.equal(res1.status, 200);
  const json1 = await res1.json();
  assert.ok(json1.device.id);
  assert.equal(json1.device.token, 'fcm-device-token-111');
  assert.equal(json1.device.platform, 'android');
  assert.equal(json1.device.deviceName, 'Realme 14 Pro+ 5G');
  assert.equal(db.deviceTokens.length, 1);

  // 2. Upsert same token with updated device name
  const res2 = await handleService(call('POST', '/api/devices/register', {
    token: 'fcm-device-token-111',
    platform: 'android',
    deviceName: 'Realme 14 Pro+ Renamed',
  }), { env, fetcher });
  assert.equal(res2.status, 200);
  const json2 = await res2.json();
  assert.equal(json2.device.deviceName, 'Realme 14 Pro+ Renamed');
  assert.equal(db.deviceTokens.length, 1); // No duplicate row

  // 3. Validation: reject invalid platform
  const badPlatform = await handleService(call('POST', '/api/devices/register', {
    token: 'fcm-token-2',
    platform: 'ios_unsupported',
  }), { env, fetcher });
  assert.equal(badPlatform.status, 400);

  // 4. Validation: reject empty token
  const emptyToken = await handleService(call('POST', '/api/devices/register', {
    token: '',
    platform: 'android',
  }), { env, fetcher });
  assert.equal(emptyToken.status, 400);
});

test('Phase 5B: DELETE /api/devices/:token removes registered device token', async () => {
  const db = database();
  const fetcher = router(db.routes);

  // Seed token
  db.deviceTokens.push({
    id: crypto.randomUUID(),
    owner_id: UID,
    token: 'token-to-delete',
    platform: 'web',
    device_name: 'Chrome Windows',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  assert.equal(db.deviceTokens.length, 1);

  const delRes = await handleService(call('DELETE', '/api/devices/token-to-delete'), { env, fetcher });
  assert.equal(delRes.status, 204);
  assert.equal(db.deviceTokens.length, 0);

  const missing = await handleService(call('DELETE', '/api/devices/token-to-delete'), { env, fetcher });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'That device token was not found.');
});

test('Phase 5B: DELETE /api/devices/:token decodes an encoded FCM token once', async () => {
  const db = database();
  const fetcher = router(db.routes);
  const token = 'abc/def+ghi:APA91b';
  db.deviceTokens.push({
    id: crypto.randomUUID(),
    owner_id: UID,
    token,
    platform: 'android',
    device_name: 'Phone',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const delRes = await handleService(call('DELETE', '/api/devices/' + encodeURIComponent(token)), { env, fetcher });
  assert.equal(delRes.status, 204);
  assert.equal(db.deviceTokens.length, 0);

  const sent = fetcher.calls.find(callItem => callItem.method === 'DELETE' && callItem.url.includes('/dua_device_tokens'));
  assert.ok(sent);
  assert.ok(sent.url.includes('token=eq.' + encodeURIComponent(token)));
  assert.ok(sent.url.includes('token=eq.abc%2Fdef%2Bghi%3AAPA91b'));
  assert.equal(sent.url.includes('%253A'), false);
  assert.equal(sent.url.includes('%252F'), false);
  assert.equal(sent.url.includes('%252B'), false);

  const malformed = await handleService(call('DELETE', '/api/devices/%ZZ'), { env, fetcher });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'Invalid token.');
});

test('Phase 5B: DELETE /api/devices/:token deletes a realistic FCM token encoded with %3A', async () => {
  const db = database();
  const fetcher = router(db.routes);
  const token = 'cX9abc123:APA91bFakeToken';
  db.deviceTokens.push({
    id: crypto.randomUUID(),
    owner_id: UID,
    token,
    platform: 'android',
    device_name: 'Realme 14 Pro+ 5G',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const delRes = await handleService(call('DELETE', '/api/devices/cX9abc123%3AAPA91bFakeToken'), { env, fetcher });
  assert.equal(delRes.status, 204);
  assert.equal(db.deviceTokens.some(row => row.token === token), false);
  assert.equal(db.deviceTokens.length, 0);

  const sent = fetcher.calls.find(callItem => callItem.method === 'DELETE' && callItem.url.includes('/dua_device_tokens'));
  assert.ok(sent.url.includes('token=eq.cX9abc123%3AAPA91bFakeToken'));
  assert.equal(sent.url.includes('%253A'), false);

  const second = await handleService(call('DELETE', '/api/devices/cX9abc123%3AAPA91bFakeToken'), { env, fetcher });
  assert.equal(second.status, 404);
  assert.equal((await second.json()).error, 'That device token was not found.');
});

test('Phase 5B: Notifications — list notifications and mark as read', async () => {
  const db = database();
  const fetcher = router(db.routes);

  const notifId = '33333333-3333-4333-8333-333333333333';
  db.notifications.push({
    id: notifId,
    owner_id: UID,
    conversation_id: null,
    agent_id: 'dua-agent',
    title: 'Daily Summary Ready',
    body: 'Your automated morning summary has finished.',
    data: { triggerType: 'schedule' },
    status: 'sent',
    sent_at: '2026-11-19T09:00:00Z',
    created_at: '2026-11-19T09:00:00Z',
  });

  // 1. GET /api/notifications
  const listRes = await handleService(call('GET', '/api/notifications'), { env, fetcher });
  assert.equal(listRes.status, 200);
  const listJson = await listRes.json();
  assert.equal(listJson.notifications.length, 1);
  assert.equal(listJson.notifications[0].id, notifId);
  assert.equal(listJson.notifications[0].status, 'sent');

  // 2. PUT /api/notifications/:id/read
  const readRes = await handleService(call('PUT', `/api/notifications/${notifId}/read`), { env, fetcher });
  assert.equal(readRes.status, 200);
  const readJson = await readRes.json();
  assert.equal(readJson.notification.status, 'read');

  // 3. 404 for invalid notification ID
  const notFound = await handleService(call('PUT', '/api/notifications/00000000-0000-0000-0000-000000000000/read'), { env, fetcher });
  assert.equal(notFound.status, 404);
});

test('Phase 5B: FCM HTTP v1 — buildFcmV1Payload constructs valid v1 payload without legacy fields', () => {
  const payload = buildFcmV1Payload({
    token: 'device-target-fcm-token',
    title: 'New Artifact Generated',
    body: 'Artifact "Q3 Deck" was updated.',
    data: { artifactId: 'art_123', versionNum: 2 },
  });

  assert.ok(payload.message);
  assert.equal(payload.message.token, 'device-target-fcm-token');
  assert.equal(payload.message.notification.title, 'New Artifact Generated');
  assert.equal(payload.message.notification.body, 'Artifact "Q3 Deck" was updated.');
  assert.equal(payload.message.data.artifactId, 'art_123');
  assert.equal(payload.message.data.versionNum, '2'); // Stringified for FCM v1 compliance
  assert.equal(payload.message.android.priority, 'high');

  // Ensure NO legacy fields are present
  assert.equal(payload.to, undefined);
  assert.equal(payload.registration_ids, undefined);
  assert.equal(payload.message.to, undefined);
});

test('Phase 5B: FCM HTTP v1 — sendFcmV1Message calls v1 URL and sets Authorization header', async () => {
  let requestedUrl = '';
  let authHeader = '';

  const mockFetcher = async (url, init) => {
    requestedUrl = url;
    authHeader = new Headers(init.headers).get('authorization');
    return Response.json({ name: 'projects/dua-project/messages/123' }, { status: 200 });
  };

  const payload = buildFcmV1Payload({
    token: 'token-xyz',
    title: 'Test',
    body: 'Test Body',
  });

  const res = await sendFcmV1Message({
    projectId: 'dua-project',
    accessToken: 'test-oauth2-token',
    messagePayload: payload,
    fetcher: mockFetcher,
  });

  assert.equal(res.status, 200);
  assert.equal(requestedUrl, 'https://fcm.googleapis.com/v1/projects/dua-project/messages:send');
  assert.equal(authHeader, 'Bearer test-oauth2-token');
});

test('Phase 5B: FCM HTTP v1 — dispatchPushNotification gracefully handles unset FCM_PROJECT_ID without throwing', async () => {
  const noFcmEnv = { ...env, FCM_PROJECT_ID: '' };
  const result = await dispatchPushNotification({
    ownerId: UID,
    ownerToken: 'user-token',
    notification: { title: 'Test', body: 'Test body' },
    env: noFcmEnv,
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'fcm_not_configured');
});

test('Phase 5B: Security & owner lock: unauthenticated and non-owner requests are blocked', async () => {
  const db = database();
  const fetcher = router(db.routes);

  // 1. Unauthenticated -> 401
  const noAuth = await handleService(call('GET', '/api/notifications', undefined, { token: '' }), { env, fetcher });
  assert.equal(noAuth.status, 401);

  // 2. Stranger account -> 403
  const badOwnerFetcher = router(db.routes, { email: 'stranger@example.com' });
  const forbidden = await handleService(call('GET', '/api/notifications'), { env, fetcher: badOwnerFetcher });
  assert.equal(forbidden.status, 403);
});
