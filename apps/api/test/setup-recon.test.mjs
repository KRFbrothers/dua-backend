// F-03: /api/setup must not enumerate the deployment to anonymous callers.
// Full detail (provider names, model IDs, daily limits, prices, "why disabled" reasons)
// is owner-only; everyone else gets a coarse on/off summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleService } from '../src/server/service-handler.mjs';
import { setupConfiguration, setupPublicSummary } from '../src/core/setup.mjs';
import { imagineEnv, world } from './imagine-helpers.mjs';
import { voiceEnv, voiceWorld } from './voice-helpers.mjs';

const setupRequest = (headers = {}) => new Request('https://dua.test/api/setup', { headers });

test('anonymous /api/setup returns a coarse summary, not the deployment inventory', async () => {
  const response = await handleService(setupRequest(), { env: imagineEnv, fetcher: world() });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();

  // No inventory: no groups, no provider list, no model IDs, no limits, no reason strings.
  assert.equal(data.groups, undefined);
  assert.equal(data.providers, undefined);
  assert.equal(data.imagine, undefined);
  assert.equal(data.voice, undefined);
  assert.equal(data.search, undefined);
  assert.equal(data.advanced, undefined);
  assert.equal(data.files, undefined);

  // Coarse booleans/counts only.
  assert.equal(typeof data.configured, 'object');
  assert.equal(typeof data.configured.providers, 'number');
  assert.equal(typeof data.configured.imagine, 'boolean');
  assert.equal(typeof data.configured.voice, 'boolean');
  assert.equal(typeof data.account.requireLogin, 'boolean');
});

test('anonymous /api/setup leaks no model IDs, prices, limits or disabled reasons', async () => {
  const body = await (await handleService(setupRequest(), { env: imagineEnv, fetcher: world() })).text();
  // Model identifiers and provider names that the full payload exposes.
  assert.doesNotMatch(body, /grok-imagine-video|gemini-3|gpt-|claude-|kimi-/i);
  // Daily caps, per-minute prices and "why it is off" reason strings.
  assert.doesNotMatch(body, /dailyLimit|dailyMinutes|pricePerMinute|maxSessionMinutes/);
  assert.doesNotMatch(body, /GROK_API_KEY|GEMINI_API_KEY|BRAVE_API_KEY|DUA_ALLOWED_EMAIL/);
  assert.doesNotMatch(body, /is off:|needs-configuration|Phase 4 migration/);
});

test('owner session gets the full setup detail', async () => {
  const response = await handleService(setupRequest({ authorization: 'Bearer user-token' }), { env: imagineEnv, fetcher: world() });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.groups.map(g => g.id), ['providers', 'search', 'sync', 'memory', 'connectors', 'computer', 'voice', 'account']);
  assert.ok(Array.isArray(data.providers));
  assert.equal(data.imagine.image.enabled, true);
});

test('a session for a different account does not get the full detail', async () => {
  const response = await handleService(setupRequest({ authorization: 'Bearer user-token' }), { env: imagineEnv, fetcher: world({ email: 'someone-else@example.com' }) });
  const data = await response.json();
  assert.equal(data.groups, undefined);
  assert.equal(typeof data.configured, 'object');
});

test('an invalid or expired session falls back to the coarse summary', async () => {
  const fetcher = async url => String(url).endsWith('/auth/v1/user')
    ? Response.json({ message: 'invalid claim' }, { status: 401 })
    : assert.fail('unexpected fetch ' + url);
  const data = await (await handleService(setupRequest({ authorization: 'Bearer expired-token' }), { env: imagineEnv, fetcher })).json();
  assert.equal(data.groups, undefined);
  assert.equal(typeof data.configured, 'object');
});

test('DUA_APP_TOKEN grants the full detail without a Supabase round trip', async () => {
  const env = { ...imagineEnv, DUA_APP_TOKEN: 'app-token-value' };
  const fetcher = () => assert.fail('must not call Supabase when the app token matches');
  const ok = await (await handleService(setupRequest({ 'x-dua-app-token': 'app-token-value' }), { env, fetcher })).json();
  assert.ok(Array.isArray(ok.groups));
  const wrong = await (await handleService(setupRequest({ 'x-dua-app-token': 'wrong' }), { env, fetcher })).json();
  assert.equal(wrong.groups, undefined);
});

test('no owner configured means no auth round trip and a coarse summary', async () => {
  const env = { ...voiceEnv, DUA_ALLOWED_EMAIL: '' };
  const fetcher = () => assert.fail('must not call Supabase without an owner email');
  const data = await (await handleService(setupRequest({ authorization: 'Bearer user-token' }), { env, fetcher })).json();
  assert.equal(data.groups, undefined);
  assert.equal(data.account.ownerRestricted, false);
});

test('non-GET is still rejected', async () => {
  const response = await handleService(new Request('https://dua.test/api/setup', { method: 'POST' }), { env: imagineEnv, fetcher: world() });
  assert.equal(response.status, 405);
});

test('the coarse summary keeps the fields the app already reads', () => {
  const summary = setupPublicSummary(imagineEnv);
  assert.equal(summary.account.requireLogin, true);
  assert.equal(summary.account.ownerRestricted, true);
  assert.equal(summary.account.configured, true);
  assert.equal(summary.configured.imagine, true);
  // The full configuration still exists for the owner path.
  assert.ok(Array.isArray(setupConfiguration(imagineEnv).groups));
});
