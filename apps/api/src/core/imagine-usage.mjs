// Durable per-feature daily caps for Imagine (Supabase RPCs from infra/database/migrations/202610090001_dua_imagine.sql).
// F-01: dua_consume_imagine is service_role-only, so the cap is charged with the server's service-role key.
// The caller is still verified as the owner upstream (resolveOwner) and that user's id is sent as `owner`
// (202611160001_owner_scoped_quota_rpcs.sql); the limit is chosen by the server, never the client.
import { readJsonLimited } from './limited-json.mjs';
import { ImagineError } from './imagine-providers.mjs';

const SETUP = 'Imagine usage caps need the Phase 3 Supabase migration (infra/database/migrations/202610090001_dua_imagine.sql). Run it in the Supabase SQL editor.';

async function rpc(config, token, name, body, { fetcher = fetch, signal, service = false } = {}) {
  const serviceKey = service ? String(config.serviceRoleKey || '').trim() : '';
  if (service && !serviceKey) throw new ImagineError('Imagine usage caps need SUPABASE_SERVICE_ROLE_KEY on the server after the F-01 migration.', 503, { code: 'setup' });
  let response;
  try {
    response = await fetcher(`${config.url}/rest/v1/rpc/${name}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)]),
      headers: { apikey: service ? serviceKey : config.key, Authorization: 'Bearer ' + (service ? serviceKey : token), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ImagineError('Imagine usage storage is unavailable. Retry.', 503);
  }
  let data = null;
  try { data = await readJsonLimited(response, 65536); } catch {}
  if (response.status === 404 || data?.code === 'PGRST202' || data?.code === '42883') throw new ImagineError(SETUP, 503, { code: 'setup' });
  if (response.status === 401) throw new ImagineError('Session expired. Sign in again to use Imagine.', 401);
  if (!response.ok) throw new ImagineError('Imagine usage storage is unavailable. Retry after checking setup.', 503);
  return data;
}

/**
 * Atomically adds `amount` (images or video seconds) to `ownerId`'s today's UTC usage when it fits `limit`.
 * `ownerId` is the verified owner's Supabase user id from resolveOwner.
 * Returns {used, limit, resetAt}; throws 429 ImagineError when the cap would be exceeded.
 */
export async function consumeImagine(config, token, ownerId, feature, amount, limit, options = {}) {
  // F-01: dua_consume_imagine is service_role-only now, so auth.uid() is empty; the account is
  // passed explicitly as `owner` (verified upstream by resolveOwner), never chosen by the client.
  if (typeof ownerId !== 'string' || !ownerId) throw new ImagineError('Imagine usage storage is unavailable. Retry.', 503);
  const data = await rpc(config, token, 'dua_consume_imagine', { owner: ownerId, feature, amount, daily_limit: limit }, { ...options, service: true });
  if (typeof data?.allowed !== 'boolean' || !Number.isSafeInteger(data.used) || data.used < 0 || !Number.isSafeInteger(data.resetAt)) throw new ImagineError('Imagine usage storage returned an invalid response. Retry.', 503);
  const usage = { used: data.used, limit, resetAt: data.resetAt };
  if (!data.allowed) {
    const unit = feature === 'image' ? 'images' : 'video seconds';
    const left = Math.max(0, limit - data.used);
    throw Object.assign(new ImagineError(`Daily Imagine limit reached: ${data.used} of ${limit} ${unit} used${left ? ` (${left} left, this request needs ${amount})` : ''}. It resets at midnight UTC.`, 429, { code: 'cap' }),
      { usage, retryAfterSeconds: Math.max(1, data.resetAt - Math.floor(Date.now() / 1000)) });
  }
  return usage;
}

/** Today's usage: {images, videoSeconds, resetAt}. */
export async function readImagineUsage(config, token, options = {}) {
  const data = await rpc(config, token, 'dua_read_imagine_usage', {}, options);
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return { images: count(data?.images), videoSeconds: count(data?.videoSeconds), resetAt: Number.isSafeInteger(data?.resetAt) ? data.resetAt : null };
}
