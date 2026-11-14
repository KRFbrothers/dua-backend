import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowIdentity, sealSession, openSession, identityConfig } from '../src/core/workflow-identity.mjs';
import { filesEnv, router, SUPA, UID, OTHER } from './files-helpers.mjs';

// Synthetic fixtures only; no valid session or production secret.
const env = { ...filesEnv, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_fixture', DUA_WORKFLOW_OWNER_ID: UID, DUA_WORKFLOW_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64') };
const token = seconds => 'fixture.' + Buffer.from(JSON.stringify({ sub: UID, exp: Math.floor(Date.now() / 1000) + seconds })).toString('base64url') + '.fixture';

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
  let row = { owner_id: UID, state: 'ready', revision: 1, ciphertext: sealSession(old, env) }, committed = false;
  const fetcher = router([
    [SUPA + '/rest/v1/rpc/dua_workflow_identity', (_url, _init, call) => {
      const data = call.json;
      if (data.p_action === 'acquire') row = { ...row, state: 'refreshing', holder: data.p_holder };
      if (data.p_action === 'commit') {
        assert.equal(openSession(data.p_ciphertext, env).refresh_token, 'new-fixture');
        assert.equal(data.p_revision, 1);
        row = { ...row, ciphertext: data.p_ciphertext, revision: 2, state: 'ready', holder: null }; committed = true;
      }
      return Response.json(row);
    }],
    [SUPA + '/auth/v1/token?grant_type=refresh_token', (_url, _init, call) => {
      assert.equal(call.json.refresh_token, 'old-fixture');
      return Response.json({ access_token: freshToken, refresh_token: 'new-fixture', user: { email_confirmed_at: 'synthetic-confirmation' } });
    }],
  ]);
  const owner = await createWorkflowIdentity({ env, fetcher }).getOwner();
  assert.equal(committed, true);
  assert.equal(owner.user.id, UID);
  assert.equal(owner.token, freshToken);
});

test('another rotation holder or a crashed grant never replays the old token', async () => {
  for (const state of ['refreshing', 'reauthorize']) {
    const fetcher = router([[SUPA + '/rest/v1/rpc/dua_workflow_identity', () => Response.json({ state, ciphertext: 'unreadable' })]]);
    await assert.rejects(createWorkflowIdentity({ env, fetcher }).getOwner());
    assert.equal(fetcher.find(SUPA + '/auth/v1/token').length, 0);
  }
});

test('unknown refresh result invalidates the held revision instead of replaying a grant', async () => {
  let row = { state: 'ready', revision: 5, ciphertext: sealSession({ access_token: token(1), refresh_token: 'fixture', expires_at: 1 }, env) };
  let invalidated = false;
  const fetcher = router([
    [SUPA + '/rest/v1/rpc/dua_workflow_identity', (_url, _init, call) => {
      if (call.json.p_action === 'acquire') row = { ...row, state: 'refreshing', holder: call.json.p_holder };
      if (call.json.p_action === 'invalidate') { invalidated = true; row = { ...row, state: 'reauthorize' }; }
      return Response.json(row);
    }],
    [SUPA + '/auth/v1/token?grant_type=refresh_token', () => { throw Error('synthetic lost response'); }],
  ]);
  await assert.rejects(createWorkflowIdentity({ env, fetcher }).getOwner(), /rotation was not confirmed/);
  assert.equal(invalidated, true);
  await assert.rejects(createWorkflowIdentity({ env, fetcher }).getOwner());
  assert.equal(fetcher.find(SUPA + '/auth/v1/token').length, 1);
});
