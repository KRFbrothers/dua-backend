import test from 'node:test';
import assert from 'node:assert/strict';
import { healthResponse, readinessResponse, handleHealth } from '../src/core/health.mjs';
import { handleService } from '../src/server/service-handler.mjs';

const get = path => new Request('https://dua.test' + path, { method: 'GET' });

test('liveness answers 200 without touching the network', async () => {
  const response = healthResponse({ service: 'dua-api', version: 'abc123' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'dua-api');
  assert.equal(body.version, 'abc123');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('readiness is 503 when Supabase is not configured', async () => {
  const response = await readinessResponse({ env: {}, fetcher: () => assert.fail('must not call out'), required: ['supabase'] });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.status, 'not_ready');
  assert.deepEqual(body.failed, ['supabase']);
  assert.equal(body.checks.supabase.reason, 'not_configured');
});

test('readiness is 200 when Supabase answers and the engine is not required', async () => {
  const fetcher = async url => {
    assert.match(String(url), /\/auth\/v1\/health$/);
    return Response.json({ ok: true });
  };
  const response = await readinessResponse({
    env: { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_test' },
    fetcher, required: ['supabase'],
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ready');
});

test('readiness fails when a required engine is unreachable', async () => {
  const fetcher = async url => {
    if (String(url).includes('/auth/v1/health')) return Response.json({ ok: true });
    throw new Error('network down');
  };
  const response = await readinessResponse({
    env: { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_test', DUA_ENGINE_URL: 'https://engine.test' },
    fetcher, required: ['supabase', 'engine'],
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.deepEqual(body.failed, ['engine']);
  assert.equal(body.checks.engine.reason, 'unreachable');
});

test('an unconfigured engine is skipped, not failed', async () => {
  const fetcher = async () => Response.json({ ok: true });
  const response = await readinessResponse({
    env: { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_test' },
    fetcher, required: ['supabase', 'engine'],
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).checks.engine.skipped, 'not_configured');
});

test('handleHealth ignores non-health paths and rejects non-GET', async () => {
  assert.equal(await handleHealth(get('/api/chat'), {}), null);
  const post = await handleHealth(new Request('https://dua.test/healthz', { method: 'POST' }), {});
  assert.equal(post.status, 405);
});

test('health routes are served before CORS and origin checks', async () => {
  // No Origin header, no allowed origin configured: a probe must still get 200.
  const response = await handleService(get('/healthz'), { env: {} });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('readiness through the router reports not_ready without Supabase', async () => {
  const response = await handleService(get('/readyz'), { env: {} });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, 'not_ready');
});
