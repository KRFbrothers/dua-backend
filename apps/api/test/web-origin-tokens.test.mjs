// F-02: a listed web origin must never receive the refresh token in a response body.
// Native mode (raw refresh token in JSON) is reserved for clients that send no Origin at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAccount } from '../src/core/account.mjs';
import { mockFetch } from './helpers.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const owner = 'owner@example.com';
const UI = 'https://ui.example';
const settings = () => Response.json({ external: { email: true }, mailer_autoconfirm: false });
const session = () => Response.json({
  access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600,
  user: { id, email: owner, email_confirmed_at: '2026-10-12T00:00:00Z', user_metadata: {} }
});
const env = fetcher => ({ url: 'https://project.supabase.co', key: 'public-anon-key', allowedEmail: owner, webOrigins: UI, fetcher });
const credentials = { email: owner, password: 'test-password-only' };

const login = (headers, fetcher) => handleAccount(new Request('https://dua.example/api/account/email-login', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(credentials)
}), env(fetcher));

const refresh = (headers, body, fetcher) => handleAccount(new Request('https://dua.example/api/account/refresh', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
}), env(fetcher));

test('a listed web origin gets an access token but never the refresh token in the body', async () => {
  const response = await login({ origin: UI }, mockFetch(settings(), session()));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.session.accessToken, 'access-token');
  assert.equal(body.session.refreshToken, undefined, 'refresh token must not reach page scripts');
  assert.equal(JSON.stringify(body).includes('refresh-token'), false, 'no refresh token anywhere in the body');
});

test('the web refresh token is delivered in an HttpOnly, Secure, SameSite=None cookie', async () => {
  const response = await login({ origin: UI }, mockFetch(settings(), session()));
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 1, 'only the refresh cookie is set for a listed web origin');
  const cookie = cookies[0];
  assert.match(cookie, /^dua_refresh=refresh-token;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=None/);
  assert.match(cookie, /Path=\/api/);
});

test('a listed web origin cannot refresh from a token in the request body', async () => {
  const fetcher = mockFetch();
  const response = await refresh({ origin: UI }, { refreshToken: 'refresh-token' }, fetcher);
  assert.equal(response.status, 401, 'body refresh tokens are ignored for web origins');
  assert.equal(fetcher.calls.length, 0, 'no Supabase call is made');
});

test('a listed web origin refreshes from its cookie and gets a new access token only', async () => {
  const response = await refresh({ origin: UI, cookie: 'dua_refresh=refresh-token' }, {}, mockFetch(session()));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.session.accessToken, 'access-token');
  assert.equal(body.session.refreshToken, undefined);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  assert.match(cookies[0], /^dua_refresh=refresh-token;/);
  assert.match(cookies[0], /SameSite=None/);
});

test('the Android app still receives both tokens in JSON', async () => {
  const response = await login({ 'x-dua-native': '1' }, mockFetch(settings(), session()));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.session.accessToken, 'access-token');
  assert.equal(body.session.refreshToken, 'refresh-token', 'native clients keep the documented contract');
  assert.equal(response.headers.getSetCookie().length, 0, 'native clients get no cookies');
});

test('X-Dua-Native with an Origin does not switch a browser into native mode', async () => {
  const response = await login({ origin: UI, 'x-dua-native': '1' }, mockFetch(settings(), session()));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.session.accessToken, 'access-token');
  assert.equal(body.session.refreshToken, undefined, 'an Origin always wins over the native header');
});

test('a same-origin browser still gets HttpOnly Strict cookies and no tokens', async () => {
  const response = await login({ origin: 'https://dua.example', 'sec-fetch-site': 'same-origin' }, mockFetch(settings(), session()));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.session, undefined, 'same-origin pages never see tokens');
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  for (const cookie of cookies) assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
});

test('logout clears the web refresh cookie with the same attributes', async () => {
  const response = await handleAccount(new Request('https://dua.example/api/account/logout', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: UI }, body: '{}'
  }), env(mockFetch()));
  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  assert.match(cookies[0], /^dua_refresh=;/);
  assert.match(cookies[0], /Max-Age=0/);
  assert.match(cookies[0], /SameSite=None/);
});
