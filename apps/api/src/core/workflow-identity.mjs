import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { executionConfig, executionDb, WorkflowError } from './workflow-execution.mjs';
import { resolveOwner, storageConfig } from './storage.mjs';
import { readJsonLimited } from './limited-json.mjs';

export function identityConfig(env) {
  executionConfig(env);
  const owner = String(env.DUA_WORKFLOW_OWNER_ID || '');
  const key = Buffer.from(env.DUA_WORKFLOW_CREDENTIAL_KEY || '', 'base64');
  if (env.DUA_WORKFLOW_OWNER_TOKEN_FILE) throw new WorkflowError('Legacy access-token files are unsupported. Provision a refreshable dedicated worker session.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner) || key.length !== 32 || !env.DUA_ALLOWED_EMAIL || !authConfig(env).enabled)
    throw new WorkflowError('Worker identity requires its owner ID, public Auth configuration and a 32-byte credential encryption key.');
  return { owner, key };
}
const authConfig = env => storageConfig({ ...env, DUA_FILES: '1', DUA_FILES_BUCKET: 'dua-files' });

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

export function createWorkflowIdentity({ env = process.env, fetcher = fetch } = {}) {
  const { owner } = identityConfig(env);
  const rpc = (action, holder = null, revision = null, ciphertext = null) => executionDb('rpc/dua_workflow_identity', {
    env, fetcher, body: { p_owner: owner, p_action: action, p_holder: holder, p_revision: revision, p_ciphertext: ciphertext },
  });
  return {
    async getOwner(_env, _fetcher, signal) {
      let row = await rpc('read');
      if (!row?.ciphertext || row.state === 'reauthorize') throw new WorkflowError('Worker owner authorization is missing, revoked or its last rotation was interrupted. Reauthorize it.');
      if (row.state !== 'ready') throw new WorkflowError('Another worker is rotating the owner session. Retry later.');
      let session = openSession(row.ciphertext, env);
      if (session.expires_at * 1000 < Date.now() + 360000) {
        const holder = randomUUID();
        const claim = await rpc('acquire', holder, row.revision);
        if (claim?.state !== 'refreshing' || claim.holder !== holder) throw new WorkflowError('Another worker owns session rotation.');
        try {
          session = await refreshSession(session.refresh_token, env, fetcher, signal);
          await verifiedOwner(session, env, fetcher, signal);
          // Persist the rotated refresh token BEFORE exposing the access token.
          // A commit timeout may have succeeded; never replay the old grant.
          row = await rpc('commit', holder, row.revision, sealSession(session, env));
        } catch {
          try { await rpc('invalidate', holder, row.revision); } catch { /* expired refresh lease fails closed on read */ }
          throw new WorkflowError('Worker credential rotation was not confirmed. Reauthorize if identity state requires it.');
        }
      }
      try { return await verifiedOwner(session, env, fetcher, signal); }
      catch (e) {
        if (e.status === 401 || e.status === 403) {
          const holder = randomUUID();
          try {
            const claim = await rpc('acquire', holder, row.revision);
            if (claim?.holder === holder) await rpc('invalidate', holder, row.revision);
          } catch { /* no work is dispatched on an invalid identity */ }
        }
        throw new WorkflowError('Worker owner verification failed. Check session revocation or Auth availability.');
      }
    },
    async provision(refreshToken, signal) {
      if (!validToken(refreshToken)) throw new WorkflowError('A dedicated owner refresh token is required for provisioning.');
      // Operator-only CLI; never an unauthenticated API and never a phone-token upload.
      const row = await rpc('read');
      if (row?.state === 'refreshing') throw new WorkflowError('Stop rotation before replacing worker identity.');
      const session = await refreshSession(refreshToken, env, fetcher, signal);
      await verifiedOwner(session, env, fetcher, signal);
      await rpc('provision', null, null, sealSession(session, env));
    },
    async revoke(signal) {
      const row = await rpc('read');
      // Fence rotation/dispatch BEFORE asking Auth to revoke this session only.
      await rpc('revoke');
      if (!row?.ciphertext) return false;
      const session = openSession(row.ciphertext, env), { url, key } = authConfig(env);
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
  } catch { console.error('Worker identity operation was not fully confirmed. Check credential state, owner, encryption key, Auth and migration; revoke only the dedicated worker session when needed. No credentials are logged.'); process.exitCode = 1; }
}
