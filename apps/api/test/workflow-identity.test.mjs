import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowIdentity, sealSession, openSession, identityConfig } from '../src/core/workflow-identity.mjs';
import { filesEnv, router, SUPA, UID, OTHER } from './files-helpers.mjs';

// Synthetic fixtures only; no valid session or production secret.
const PROJECT = 'dua-test-project';
const SECRET = 'DUA_WORKFLOW_OWNER_SESSION';
const META_TOKEN = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const SM_ACCESS = `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${SECRET}/versions/latest:access`;
const SM_ADD = `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${SECRET}:addVersion`;
const env = { ...filesEnv, DUA_WORKFLOW_OWNER_ID: UID, DUA_WORKFLOW_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'), GOOGLE_CLOUD_PROJECT: PROJECT };
const token = seconds => 'fixture.' + Buffer.from(JSON.stringify({ sub: UID, exp: Math.floor(Date.now() / 1000) + seconds })).toString('base64url') + '.fixture';
const pack = value => Buffer.from(value, 'utf8').toString('base64');

function smRoutes({ latest, onAdd, addStatus = 200 }) {
  return [
    [META_TOKEN, () => Response.json({ access_token: 'metadata-token' })],
    [SM_ACCESS, () => {
      if (latest === null) return Response.json({ error: 'not found' }, { status: 404 });
      return Response.json({ payload: { data: pack(latest) } });
    }],
    [SM_ADD, (_url, _init, call) => {
      assert.equal(call.headers.get('authorization'), 'Bearer metadata-token');
      const text = Buffer.from(call.json.payload.data, 'base64').toString('utf8');
      onAdd?.(text);
      if (addStatus !== 200) return Response.json({ error: 'write failed' }, { status: addStatus });
      latest = text;
      return Response.json({ name: `projects/${PROJECT}/secrets/${SECRET}/versions/2` });
    }],
  ];
}

test('credential ciphertext is bound to owner/project and detects tampering', () => {
  const session = { access_token: token(3600), refresh_token: 'fixture-refresh', expires_at: 1 };
  const sealed = sealSession(session, env);
  assert.deepEqual(openSession(sealed, env), session);
  assert.throws(() => openSession(sealed, { ...env, DUA_WORKFLOW_OWNER_ID: OTHER }), /cannot be decrypted/);
  const bytes = Buffer.from(sealed, 'base64'); bytes[20] ^= 1;
  assert.throws(() => openSession(bytes.toString('base64'), env), /cannot be decrypted/);
  assert.equal(sealed.includes('fixture-refresh'), false);
  assert.throws(() => identityConfig({ ...env, DUA_WORKFLOW_OWNER_TOKEN_FILE: '/legacy-access-jwt' }), /Legacy access-token files/);
});

test('rotation persists the NEW refresh token before exposing a verified access token', async () => {
  const old = { access_token: token(30), refresh_token: 'old-fixture', expires_at: Math.floor(Date.now() / 1000) + 30 };
  const freshToken = token(3600);
  let latest = sealSession(old, env), committed = false;
  const fetcher = router([
    ...smRoutes({
      get latest() { return latest; },
      onAdd(text) {
        assert.equal(openSession(text, env).refresh_token, 'new-fixture');
        latest = text; committed = true;
      },
    }),
    [SUPA + '/auth/v1/token?grant_type=refresh_token', (_url, _init, call) => {
      assert.equal(call.json.refresh_token, 'old-fixture');
      assert.equal(committed, false);
      return Response.json({ access_token: freshToken, refresh_token: 'new-fixture', user: { email_confirmed_at: 'synthetic-confirmation' } });
    }],
  ]);
  const owner = await createWorkflowIdentity({ env, fetcher }).getOwner();
  assert.equal(committed, true);
  assert.equal(owner.user.id, UID);
  assert.equal(owner.token, freshToken);
  assert.equal(fetcher.find(SUPA + '/rest/v1/rpc/dua_workflow_identity').length, 0);
});

test('a missing, revoked or unreadable session never refreshes the old token', async () => {
  for (const latest of [null, '{"state":"reauthorize"}', 'unreadable']) {
    const fetcher = router(smRoutes({ latest }));
    await assert.rejects(createWorkflowIdentity({ env, fetcher }).getOwner());
    assert.equal(fetcher.find(SUPA + '/auth/v1/token').length, 0);
    assert.equal(fetcher.find(SM_ADD).length, 0);
  }
});

test('unknown refresh result or a failed secret write never exposes a new access token', async () => {
  const old = sealSession({ access_token: token(1), refresh_token: 'fixture', expires_at: 1 }, env);
  const lost = router([
    ...smRoutes({ latest: old }),
    [SUPA + '/auth/v1/token?grant_type=refresh_token', () => { throw Error('synthetic lost response'); }],
  ]);
  await assert.rejects(createWorkflowIdentity({ env, fetcher: lost }).getOwner(), /rotation was not confirmed/);
  assert.equal(lost.find(SM_ADD).length, 0);

  let wrote = false;
  const writeFail = router([
    ...smRoutes({ latest: old, addStatus: 503, onAdd() { wrote = true; } }),
    [SUPA + '/auth/v1/token?grant_type=refresh_token', () => Response.json({ access_token: token(3600), refresh_token: 'new-fixture', user: { email_confirmed_at: 'synthetic-confirmation' } })],
  ]);
  await assert.rejects(createWorkflowIdentity({ env, fetcher: writeFail }).getOwner(), /rotation was not confirmed/);
  assert.equal(wrote, true);
});
