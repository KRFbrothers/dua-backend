import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { executionConfig, WorkflowError } from './workflow-execution.mjs';
import { resolveOwner, storageConfig } from './storage.mjs';
import { readJsonLimited } from './limited-json.mjs';

const METADATA_TOKEN = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const METADATA_PROJECT = 'http://metadata.google.internal/computeMetadata/v1/project/project-id';
const SM_ROOT = 'https://secretmanager.googleapis.com/v1';
const REVOKED = '{"state":"reauthorize"}';

export function identityConfig(env) {
  executionConfig(env);
  const owner = String(env.DUA_WORKFLOW_OWNER_ID || '');
  const key = Buffer.from(env.DUA_WORKFLOW_CREDENTIAL_KEY || '', 'base64');
  if (env.DUA_WORKFLOW_OWNER_TOKEN_FILE) throw new WorkflowError('Legacy access-token files are unsupported. Provision a refreshable dedicated worker session.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner) || key.length !== 32 || !env.DUA_ALLOWED_EMAIL || !authConfig(env).enabled)
    throw new WorkflowError('Worker identity requires its owner ID, public Auth configuration and a 32-byte credential encryption key.');
  sessionSecretConfig(env);
  return { owner, key };
}
const authConfig = env => storageConfig({ ...env, DUA_FILES: '1', DUA_FILES_BUCKET: 'dua-files' });

export function sessionSecretConfig(env) {
  const project = String(env.GOOGLE_CLOUD_PROJECT || env.PROJECT_ID || env.GCLOUD_PROJECT || '').trim();
  const secret = String(env.DUA_WORKFLOW_OWNER_SESSION_SECRET || 'DUA_WORKFLOW_OWNER_SESSION').trim();
  if (project && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw new WorkflowError('Worker session secret project is invalid.');
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(secret)) throw new WorkflowError('Worker session secret name is invalid.');
  return { project, secret };
}

export function sealSession(session, env) {
  const { owner, key } = identityConfig(env), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${executionConfig(env).base}:${owner}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function openSession(ciphertext, env) {
  try {
    const { owner, key } = identityConfig(env), bytes = Buffer.from(ciphertext, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(`${executionConfig(env).base}:${owner}`)); cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
  } catch { throw new WorkflowError('Worker credential cannot be decrypted. Restore its key or provision a new dedicated owner session.'); }
}

const validToken = t => typeof t === 'string' && /^[A-Za-z0-9._-]{1,10000}$/.test(t);
function normalizeSession(data) {
  // Expiry is a refresh hint, never proof of identity; Auth verifies every use.
  let claims;
  try { claims = JSON.parse(Buffer.from(data.access_token.split('.')[1], 'base64url')); } catch {}
  if (!validToken(data?.access_token) || !validToken(data?.refresh_token) || !Number.isSafeInteger(claims?.exp) || claims.exp * 1000 < Date.now() + 360000)
    throw new WorkflowError('Owner session is invalid or too short for a complete workflow step.');
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: claims.exp };
}

async function verifiedOwner(session, env, fetcher, signal) {
  const request = new Request('https://workflow.internal/api/chat', { signal, headers: { authorization: `Bearer ${session.access_token}`, 'x-dua-native': '1' } });
  const owner = await resolveOwner(request, { env, fetcher, feature: 'workflow worker' });
  if (owner.user.id !== identityConfig(env).owner) throw new WorkflowError('Worker session does not belong to its configured owner.', 403);
  return { ...owner, request };
}

async function refreshSession(refreshToken, env, fetcher, signal) {
  const { url, key } = authConfig(env);
  const response = await fetcher(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST', redirect: 'error', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }), signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok) throw new WorkflowError('Worker session refresh was refused or unconfirmed. Provision a dedicated owner session again.');
  const data = await readJsonLimited(response, 65536);
  if (!data?.user?.email_confirmed_at || data.user.is_anonymous === true) throw new WorkflowError('Worker needs a confirmed owner session.');
  return normalizeSession(data);
}

async function smCall(env, fetcher, signal, path, { method = 'GET', body } = {}) {
  const { project, secret } = sessionSecretConfig(env);
  const resolved = project || await metadataText(fetcher, signal, METADATA_PROJECT);
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(resolved)) throw new WorkflowError('Worker session secret project is invalid.');
  const access = await metadataJson(fetcher, signal, METADATA_TOKEN);
  if (typeof access?.access_token !== 'string' || !access.access_token) throw new WorkflowError('Worker could not obtain a Secret Manager access token.');
  const response = await fetcher(`${SM_ROOT}/projects/${resolved}/secrets/${secret}${path}`, {
    method, redirect: 'error',
    headers: { Authorization: `Bearer ${access.access_token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)]),
  });
  const data = await readJsonLimited(response, 65536).catch(() => null);
  return { ok: response.ok, status: response.status, data };
}

async function metadataJson(fetcher, signal, url) {
  const response = await fetcher(url, {
    redirect: 'error', headers: { 'Metadata-Flavor': 'Google' },
    signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok) throw new WorkflowError('Worker metadata token is unavailable.');
  return readJsonLimited(response, 65536);
}

async function metadataText(fetcher, signal, url) {
  const response = await fetcher(url, {
    redirect: 'error', headers: { 'Metadata-Flavor': 'Google' },
    signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok) throw new WorkflowError('Worker session secret project is invalid.');
  const text = await response.text();
  return String(text || '').trim();
}

async function readOwnerSession(env, fetcher, signal) {
  const result = await smCall(env, fetcher, signal, '/versions/latest:access');
  if (result.status === 404 || result.status === 403) throw new WorkflowError('Worker owner authorization is missing, revoked or its last rotation was interrupted. Reauthorize it.');
  if (!result.ok || typeof result.data?.payload?.data !== 'string') throw new WorkflowError('Worker session secret is unavailable.');
  let payload;
  try { payload = Buffer.from(result.data.payload.data, 'base64').toString('utf8'); } catch { payload = ''; }
  if (!payload || payload === REVOKED) throw new WorkflowError('Worker owner authorization is missing, revoked or its last rotation was interrupted. Reauthorize it.');
  return payload;
}

async function writeOwnerSession(env, fetcher, signal, ciphertext) {
  const result = await smCall(env, fetcher, signal, ':addVersion', {
    method: 'POST', body: { payload: { data: Buffer.from(ciphertext, 'utf8').toString('base64') } },
  });
  if (!result.ok) throw new WorkflowError('Worker credential rotation was not confirmed. Reauthorize if identity state requires it.');
}

export function createWorkflowIdentity({ env = process.env, fetcher = fetch } = {}) {
  identityConfig(env);
  return {
    async getOwner(_env, _fetcher, signal) {
      const ciphertext = await readOwnerSession(env, fetcher, signal);
      let session = openSession(ciphertext, env);
      if (session.expires_at * 1000 < Date.now() + 360000) {
        try {
          session = await refreshSession(session.refresh_token, env, fetcher, signal);
          await verifiedOwner(session, env, fetcher, signal);
          // Persist the rotated refresh token BEFORE exposing the access token.
          await writeOwnerSession(env, fetcher, signal, sealSession(session, env));
        } catch (error) {
          if (error instanceof WorkflowError && /rotation was not confirmed|Reauthorize if identity/.test(error.message)) throw error;
          throw new WorkflowError('Worker credential rotation was not confirmed. Reauthorize if identity state requires it.');
        }
      }
      try { return await verifiedOwner(session, env, fetcher, signal); }
      catch { throw new WorkflowError('Worker owner verification failed. Check session revocation or Auth availability.'); }
    },
    async provision(refreshToken, signal) {
      if (!validToken(refreshToken)) throw new WorkflowError('A dedicated owner refresh token is required for provisioning.');
      const session = await refreshSession(refreshToken, env, fetcher, signal);
      await verifiedOwner(session, env, fetcher, signal);
      await writeOwnerSession(env, fetcher, signal, sealSession(session, env));
    },
    async revoke(signal) {
      let session = null;
      try { session = openSession(await readOwnerSession(env, fetcher, signal), env); } catch { /* already missing or unreadable */ }
      await writeOwnerSession(env, fetcher, signal, REVOKED);
      if (!session) return false;
      const { url, key } = authConfig(env);
      const result = await fetcher(`${url}/auth/v1/logout?scope=local`, {
        method: 'POST', redirect: 'error', headers: { apikey: key, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: '{}', signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)]),
      });
      if (!result.ok) throw new WorkflowError('Worker credential is disabled locally; Auth session revocation is unconfirmed. Revoke that dedicated session through Auth administration.');
      return true;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!['provision', 'revoke'].includes(process.argv[2])) throw new WorkflowError('Use an operator identity command.');
    const refresh = process.env.DUA_WORKFLOW_BOOTSTRAP_REFRESH_TOKEN;
    delete process.env.DUA_WORKFLOW_BOOTSTRAP_REFRESH_TOKEN;
    const identity = createWorkflowIdentity();
    if (process.argv[2] === 'revoke') {
      const revoked = await identity.revoke();
      console.info(revoked ? 'Worker credential disabled; dedicated Auth session revocation confirmed.' : 'No registered worker credential; no Auth logout was attempted.');
    }
    else { await identity.provision(refresh); console.info('Worker owner session provisioned. Remove the bootstrap secret from the environment.'); }
  } catch { console.error('Worker identity operation was not fully confirmed. Check credential state, owner, encryption key, Auth and Secret Manager; revoke only the dedicated worker session when needed. No credentials are logged.'); process.exitCode = 1; }
}
