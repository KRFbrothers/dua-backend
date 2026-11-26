// Agents and Skills: the owner's custom AI agents and specialized skills (dua_agents, dua_agent_skills).
//
// AUTH: every request goes through resolveOwner, which verifies the Supabase access token and
// refuses any account other than DUA_ALLOWED_EMAIL. Database calls use the USER's token with the
// anon key, never a service key, so row level security decides every row (docs/MASTER_PLAN.md).
//
// Starter skills keep a single source of truth: apps/ai-engine/dua_engine/agent/dua_agent_prompts.json.
// They are not seeded into the database. dua_agent_skills stores user-created skills plus starter
// overrides (e.g. enable/disable).
//
// Two official pinned agents ('personal-agent' and 'dua-agent') cannot be deleted.
import { readFileSync } from 'node:fs';
import { readJsonLimited } from './limited-json.mjs';
import { resolveOwner, StorageError } from './storage.mjs';
import { guardChatAccess } from './access-policy.mjs';
import { extractReply } from './adapters.mjs';
import { agentTriggerDefinition, enqueueExecution, requireEnabled, WorkflowError } from './workflow-execution.mjs';

const noStore = (error, status) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
const ok = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const TRIGGER_TYPES = new Set(['schedule', 'webhook', 'missed_summary']);
const MAX_BODY = 64 * 1024;
const MODES = new Set(['auto', 'agent', 'reasoning', 'build']);

export const OFFICIAL_AGENTS = Object.freeze([
  {
    id: 'personal-agent',
    name: 'Personal Agent',
    description: 'Fast everyday chat, thinking and quick tasks.',
    mode: 'auto',
    systemPrompt: '',
    model: null,
    pinned: true,
    isOfficial: true,
  },
  {
    id: 'dua-agent',
    name: 'Dua Agent',
    description: 'Specialized skills, tools, and multi-step tasks.',
    mode: 'agent',
    systemPrompt: '',
    model: null,
    pinned: true,
    isOfficial: true,
  },
]);

let STARTER_SKILLS = null;
export function getStarterSkills() {
  if (!STARTER_SKILLS) {
    for (const relative of [
      './dua_agent_prompts.json',
      '../../../ai-engine/dua_engine/agent/dua_agent_prompts.json',
      '../../ai-engine/dua_engine/agent/dua_agent_prompts.json',
    ]) {
      try {
        const url = new URL(relative, import.meta.url);
        const parsed = JSON.parse(readFileSync(url, 'utf8'));
        if (Array.isArray(parsed?.skills) && parsed.skills.length > 0) {
          STARTER_SKILLS = parsed.skills;
          break;
        }
      } catch {}
    }
    if (!STARTER_SKILLS) STARTER_SKILLS = [];
  }
  return STARTER_SKILLS;
}

const presentAgent = row => ({
  id: row.id,
  name: row.name,
  description: row.description || '',
  mode: row.mode || 'auto',
  systemPrompt: row.system_prompt || '',
  model: row.model ?? null,
  pinned: row.pinned === true,
  isOfficial: row.is_official === true,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const presentSkill = (row, isStarter = false) => ({
  id: row.id,
  agentId: row.agent_id || 'dua-agent',
  title: row.title,
  summary: row.summary || '',
  body: row.body || '',
  enabled: row.enabled !== false,
  isStarter,
  createdAt: row.created_at || null,
  updatedAt: row.updated_at || null,
});

export const presentInstruction = row => ({
  id: row.id,
  agentId: row.agent_id,
  instruction: row.instruction,
  isActive: row.is_active !== false,
  createdAt: row.created_at,
});

export const presentTrigger = row => ({
  id: row.id,
  agentId: row.agent_id,
  conversationId: row.conversation_id || null,
  triggerType: row.trigger_type,
  cronExpr: row.cron_expr || null,
  prompt: row.prompt,
  enabled: row.enabled !== false,
  lastRunAt: row.last_run_at || null,
  createdAt: row.created_at,
});

function upstreamFailure(status, feature = 'Agents and skills') {
  if (status === 401) return noStore('Session expired. Sign in again.', 401);
  if (status === 403) return noStore(`This account cannot use ${feature}.`, 403);
  if (status === 409) return noStore('That id is already used.', 409);
  if (status === 404) return noStore(`${feature} storage is not set up. Apply the dua-agents-skills migration.`, 503);
  if (status === 429) return noStore('Too many requests. Retry shortly.', 429);
  return noStore(`${feature} are temporarily unavailable. Retry.`, 502);
}

async function readBody(request) {
  try { return { data: await readJsonLimited(request, MAX_BODY) }; }
  catch (error) { return { response: noStore(error.status === 413 ? 'This request is too large.' : 'Invalid request.', error.status || 400) }; }
}

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export async function handleAgentsSkills(request, { env = process.env, fetcher = fetch } = {}) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || !['agents', 'skills'].includes(parts[1])) {
    return noStore('Not found.', 404);
  }

  const resource = parts[1]; // 'agents' | 'skills'
  const sub = parts[2] || '';

  if (resource === 'skills' && parts.length > 3) {
    return noStore('Not found.', 404);
  }
  if (resource === 'agents' && parts.length > 6) {
    return noStore('Not found.', 404);
  }

  // AI generator endpoints in Node
  if (resource === 'agents' && sub === 'generate-prompt') {
    if (request.method !== 'POST') return noStore('Method not allowed.', 405);
    return handleGeneratePrompt(request, { env, fetcher });
  }
  if (resource === 'skills' && sub === 'generate') {
    if (request.method !== 'POST') return noStore('Method not allowed.', 405);
    return handleGenerateSkill(request, { env, fetcher });
  }

  let allowedMethods;
  if (parts.length === 2) {
    allowedMethods = ['GET', 'POST'];
  } else if (parts.length === 3) {
    allowedMethods = ['GET', 'PUT', 'DELETE'];
  } else if (parts.length === 4) {
    if (resource !== 'agents' || !['instructions', 'triggers'].includes(parts[3])) {
      return noStore('Not found.', 404);
    }
    allowedMethods = ['GET', 'POST'];
  } else if (parts.length === 5) {
    if (resource !== 'agents' || !['instructions', 'triggers'].includes(parts[3])) {
      return noStore('Not found.', 404);
    }
    allowedMethods = ['GET', 'PUT', 'DELETE'];
  } else if (parts.length === 6) {
    if (resource !== 'agents' || parts[3] !== 'triggers' || parts[5] !== 'run') {
      return noStore('Not found.', 404);
    }
    allowedMethods = ['POST'];
  }
  if (!allowedMethods || !allowedMethods.includes(request.method)) return noStore('Method not allowed.', 405);

  let owner;
  try {
    owner = await resolveOwner(request, { env, fetcher, feature: resource === 'agents' ? 'Agents' : 'Skills' });
  } catch (error) {
    return noStore(error instanceof StorageError ? error.message : 'Account verification is unavailable. Retry.', error.status || 503);
  }

  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_ANON_KEY || '');
  if (!base.startsWith('https://') || !key || key.startsWith('sb_secret_')) {
    return noStore(`${resource === 'agents' ? 'Agents' : 'Skills'} storage is not configured.`, 503);
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
    if (resource === 'agents') {
      // GET /api/agents
      if (parts.length === 2 && request.method === 'GET') {
        const response = await db('dua_agents', `?select=*&${ownerFilter}&order=pinned.desc,updated_at.desc,id.asc`, { method: 'GET' });
        if (!response.ok) return upstreamFailure(response.status, 'Agents');
        const rows = await rowsOf(response);
        if (!rows) return noStore('Agents returned an invalid list.', 502);

        const customMap = new Map(rows.map(r => [r.id, r]));
        const mergedOfficial = OFFICIAL_AGENTS.map(official => {
          const custom = customMap.get(official.id);
          if (!custom) return { ...official, createdAt: null, updatedAt: null };
          return {
            ...official,
            name: custom.name || official.name,
            description: custom.description || official.description,
            systemPrompt: custom.system_prompt || '',
            model: custom.model ?? null,
            createdAt: custom.created_at,
            updatedAt: custom.updated_at,
          };
        });

        const customAgents = rows.filter(r => !OFFICIAL_AGENTS.some(o => o.id === r.id)).map(presentAgent);
        return ok({ agents: [...mergedOfficial, ...customAgents] });
      }

      // POST /api/agents
      if (parts.length === 2 && request.method === 'POST') {
        const { data, response: invalid } = await readBody(request);
        if (invalid) return invalid;
        if (!isObject(data)) return noStore('Invalid request.', 400);

        const name = typeof data.name === 'string' ? data.name.trim() : '';
        if (!name || name.length > 100) return noStore('Invalid name.', 400);

        let id = typeof data.id === 'string' ? data.id.trim().toLowerCase() : '';
        if (!id) id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || crypto.randomUUID();
        if (!SLUG_REGEX.test(id)) return noStore('Invalid id.', 400);
        if (OFFICIAL_AGENTS.some(o => o.id === id)) return noStore('Cannot create an official agent id.', 400);

        const mode = typeof data.mode === 'string' ? data.mode.trim().toLowerCase() : 'auto';
        if (!MODES.has(mode)) return noStore('Invalid mode.', 400);

        const description = typeof data.description === 'string' ? data.description.trim() : '';
        if (description.length > 500) return noStore('Invalid description.', 400);

        const systemPrompt = typeof data.systemPrompt === 'string' ? data.systemPrompt : '';
        if (systemPrompt.length > 20000) return noStore('Invalid systemPrompt.', 400);

        const model = typeof data.model === 'string' && data.model.trim() ? data.model.trim() : null;
        if (model && model.length > 120) return noStore('Invalid model.', 400);

        const pinned = data.pinned === true;
        const now = new Date().toISOString();
        const row = {
          id,
          owner_id: owner.user.id,
          name,
          description,
          mode,
          system_prompt: systemPrompt,
          model,
          pinned,
          is_official: false,
          created_at: now,
          updated_at: now,
        };

        const response = await db('dua_agents', '?select=*', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify(row),
        });
        if (!response.ok) return upstreamFailure(response.status, 'Agents');
        const stored = (await rowsOf(response))?.[0];
        if (!stored) return noStore('Agents did not confirm the save.', 502);
        return ok({ agent: presentAgent(stored) }, 201);
      }

      if (parts.length >= 4) {
        const agentId = sub.toLowerCase();
        if (!SLUG_REGEX.test(agentId)) return noStore('Not found.', 404);
        const isOfficial = OFFICIAL_AGENTS.some(o => o.id === agentId);
        if (!isOfficial) {
          const chk = await db('dua_agents', `?select=id&id=eq.${encodeURIComponent(agentId)}&${ownerFilter}&limit=1`, { method: 'GET' });
          if (!chk.ok) return upstreamFailure(chk.status, 'Agents');
          const found = await rowsOf(chk);
          if (!found || !found.length) return noStore('That agent was not found.', 404);
        }

        const subResource = parts[3];

        if (subResource === 'instructions') {
          // GET /api/agents/:id/instructions
          if (parts.length === 4 && request.method === 'GET') {
            const response = await db('dua_agent_instructions', `?select=*&agent_id=eq.${encodeURIComponent(agentId)}&${ownerFilter}&order=created_at.desc`, { method: 'GET' });
            if (!response.ok) return upstreamFailure(response.status, 'Instructions');
            const rows = await rowsOf(response);
            if (!rows) return noStore('Instructions returned an invalid list.', 502);
            return ok({ instructions: rows.map(presentInstruction) });
          }

          // POST /api/agents/:id/instructions
          if (parts.length === 4 && request.method === 'POST') {
            const { data, response: invalid } = await readBody(request);
            if (invalid) return invalid;
            if (!isObject(data)) return noStore('Invalid request.', 400);

            const instruction = typeof data.instruction === 'string' ? data.instruction.trim() : '';
            if (!instruction || instruction.length > 20000) return noStore('Invalid instruction.', 400);

            const isActive = data.isActive !== false;
            const now = new Date().toISOString();
            const row = {
              owner_id: owner.user.id,
              agent_id: agentId,
              instruction,
              is_active: isActive,
              created_at: now,
            };

            const response = await db('dua_agent_instructions', '?select=*', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
              body: JSON.stringify(row),
            });
            if (!response.ok) return upstreamFailure(response.status, 'Instructions');
            const stored = (await rowsOf(response))?.[0];
            if (!stored) return noStore('Instructions did not confirm the save.', 502);
            return ok({ instruction: presentInstruction(stored) }, 201);
          }

          if (parts.length === 5) {
            const instructionId = parts[4];
            if (!UUID_REGEX.test(instructionId)) return noStore('Not found.', 404);

            // GET /api/agents/:id/instructions/:instructionId
            if (request.method === 'GET') {
              const response = await db('dua_agent_instructions', `?select=*&id=eq.${encodeURIComponent(instructionId)}&agent_id=eq.${encodeURIComponent(agentId)}&${ownerFilter}&limit=1`, { method: 'GET' });
              if (!response.ok) return upstreamFailure(response.status, 'Instructions');
              const stored = (await rowsOf(response))?.[0];
              if (!stored) return noStore('That instruction was not found.', 404);
              return ok({ instruction: presentInstruction(stored) });
            }

            // PUT /api/agents/:id/instructions/:instructionId
            if (request.method === 'PUT') {
              const { data, response: invalid } = await readBody(request);
              if (invalid) return invalid;
              if (!isObject(data)) return noStore('Invalid request.', 400);

              const patch = {};
              if (data.instruction !== undefined) {
                const inst = typeof data.instruction === 'string' ? data.instruction.trim() : '';
                if (!inst || inst.length > 20000) return noStore('Invalid instruction.', 400);
                patch.instruction = inst;
              }
              if (data.isActive !== undefined) {
                if (typeof data.isActive !== 'boolean') return noStore('Invalid isActive.', 400);
                patch.is_active = data.isActive;
              }
              if (Object.keys(patch).length === 0) return noStore('No fields to update.', 400);

              const response = await db('dua_agent_instructions', `?select=*&id=eq.${encodeURIComponent(instructionId)}&agent_id=eq.${encodeURIComponent(agentId)}&${ownerFilter}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
                body: JSON.stringify(patch),
              });
              if (!response.ok) return upstreamFailure(response.status, 'Instructions');
              const rows = await rowsOf(response);
              if (!rows || !rows.length) return noStore('That instruction was not found.', 404);
              return ok({ instruction: presentInstruction(rows[0]) });
            }

            // DELETE /api/agents/:id/instructions/:instructionId
            if (request.method === 'DELETE') {
              const response = await db('dua_agent_instructions', `?id=eq.${encodeURIComponent(instructionId)}&agent_id=eq.${encodeURIComponent(agentId)}&${ownerFilter}`, {
                method: 'DELETE',
                headers: { Prefer: 'return=representation' },
              });
              if (!response.ok) return upstreamFailure(response.status, 'Instructions');
              const removed = await rowsOf(response);
              if (!removed || !removed.length) return noStore('That instruction was not found.', 404);
              return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
            }
          }

          return noStore('Not found.', 404);
        }

        if (subResource === 'triggers') {
          // GET /api/agents/:id/triggers
          if (parts.length === 4 && request.method === 'GET') {
            const response = await db('dua_agent_triggers', `?select=*&agent_id=eq.${encodeURIComponent(agentId)}&${ownerFilter}&order=created_at.desc`, { method: 'GET' });
            if (!response.ok) return upstreamFailure(response.status, 'Triggers');
            const rows = await rowsOf(response);
            if (!rows) return noStore('Triggers returned an invalid list.', 502);
            return ok({ triggers: rows.map(presentTrigger) });
          }

          // POST /api/agents/:id/triggers
          if (parts.length === 4 && request.method === 'POST') {
            const { data, response: invalid } = await readBody(request);
            if (invalid) return invalid;
            if (!isObject(data)) return noStore('Invalid request.', 400);

            const triggerType = typeof data.triggerType === 'string' ? data.triggerType.trim().toLowerCase() : '';
            if (!TRIGGER_TYPES.has(triggerType)) return noStore('Invalid triggerType. Must be schedule, webhook, or missed_summary.', 400);

            const prompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
            if (!prompt || prompt.length > 10000) return noStore('Invalid prompt.', 400);

            let cronExpr = null;
            if (data.cronExpr !== undefined && data.cronExpr !== null) {
              if (typeof data.cronExpr !== 'string' || data.cronExpr.length > 100) return noStore('Invalid cronExpr.', 400);
              cronExpr = data.cronExpr.trim() || null;
            }
            if (triggerType === 'schedule' && !cronExpr) {
              return noStore('cronExpr is required for schedule triggers.', 400);
            }

            let conversationId = null;
            if (data.conversationId !== undefined && data.conversationId !== null) {
              if (typeof data.conversationId !== 'string' || !UUID_REGEX.test(data.conversationId)) {
                return noStore('Invalid conversationId.', 400);
              }
              conversationId = data.conversationId;
            }

            const enabled = data.enabled !== false;
            const now = new Date().toISOString();
            const row = {
              owner_id: owner.user.id,
              agent_id: agentId,
              trigger_type: triggerType,
              cron_expr: cronExpr,
              prompt,
              conversation_id: conversationId,
              enabled,
              created_at: now,
            };

            const response = await db('dua_agent_triggers', '?select=*', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
              body: JSON.stringify(row),
            });
            if (!response.ok) return upstreamFailure(response.status, 'Triggers');
            const stored = (await rowsOf(response))?.[0];
            if (!stored) return noStore('Triggers did not confirm the save.', 502);
            return ok({ trigger: presentTrigger(stored) }, 201);
          }

          if (parts.length === 5) {
            const triggerId = parts[4];
            if (!UUID_REGEX.test(triggerId)) return noStore('Not found.', 404);

            // GET /api/agents/:id/triggers/:triggerId
            if (request.method === 'GET') {
              const response = await db('dua_agent_triggers', `?select=*&id=eq.${encodeURIComponent(triggerId)}&agent_id=eq.${encodeURIComponent(agentId)}&${ownerFilter}&limit=1`, { method: 'GET' });
              if (!response.ok) return upstreamFailure(response.status, 'Triggers');
              const stored = (await rowsOf(response))?.[0];
              if (!stored) return noStore('That trigger was not found.', 404);
              return ok({ trigger: presentTrigger(stored) });
            }

            // PUT /api/agents/:id/triggers/:triggerId
            if (request.method === 'PUT') {
              const { data, response: invalid } = await readBody(request);
              if (invalid) return invalid;
              if (!isObject(data)) return noStore('Invalid request.', 400);

              const patch = {};
              if (data.triggerType !== undefined) {
                const tt = typeof data.triggerType === 'string' ? data.triggerType.trim().toLowerCase() : '';
                if (!TRIGGER_TYPES.has(tt)) return noStore('Invalid triggerType.', 400);
                patch.trigger_type = tt;
              }
              if (data.prompt !== undefined) {
                const p = typeof data.prompt === 'string' ? data.prompt.trim() : '';
                if (!p || p.length > 10000) return noStore('Invalid prompt.', 400);
                patch.prompt = p;
              }
              if (data.cronExpr !== undefined) {
                if (data.cronExpr === null || data.cronExpr === '') {
                  patch.cron_expr = null;
                } else {
                  if (typeof data.cronExpr !== 'string' || data.cronExpr.length > 100) return noStore('Invalid cronExpr.', 400);
                  patch.cron_expr = data.cronExpr.trim();
                }
              }
              if (data.conversationId !== undefined) {
                if (data.conversationId === null || data.conversationId === '') {
                  patch.conversation_id = null;
                } else {
                  if (typeof data.conversationId !== 'string' || !UUID_REGEX.test(data.conversationId)) {
                    return noStore('Invalid conversationId.', 400);
                  }
                  patch.conversation_id = data.conversationId;
                }
              }
              if (data.enabled !== undefined) {
                if (typeof data.enabled !== 'boolean') return noStore('Invalid enabled.', 400);
                patch.enabled = data.enabled;
              }
              if (Object.keys(patch).length === 0) return noStore('No fields to update.', 400);

              const response = await db('dua_agent_triggers', `?select=*&id=eq.${encodeURIComponent(triggerId)}&agent_id=eq.${encodeURIComponent(agentId)}&${ownerFilter}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
                body: JSON.stringify(patch),
              });
              if (!response.ok) return upstreamFailure(response.status, 'Triggers');
              const rows = await rowsOf(response);
              if (!rows || !rows.length) return noStore('That trigger was not found.', 404);
              return ok({ trigger: presentTrigger(rows[0]) });
            }

            // DELETE /api/agents/:id/triggers/:triggerId
            if (request.method === 'DELETE') {
              const response = await db('dua_agent_triggers', `?id=eq.${encodeURIComponent(triggerId)}&agent_id=eq.${encodeURIComponent(agentId)}&${ownerFilter}`, {
                method: 'DELETE',
                headers: { Prefer: 'return=representation' },
              });
              if (!response.ok) return upstreamFailure(response.status, 'Triggers');
              const removed = await rowsOf(response);
              if (!removed || !removed.length) return noStore('That trigger was not found.', 404);
              return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
            }
          }

          // POST /api/agents/:id/triggers/:triggerId/run
          // K6: queues a real agent run for the one server worker. The worker sends the push and the
          // notification when the run finishes (and saves the reply into conversationId, when set).
          if (parts.length === 6 && parts[5] === 'run') {
            const triggerId = parts[4];
            if (!UUID_REGEX.test(triggerId)) return noStore('Not found.', 404);
            const found = await db('dua_agent_triggers', `?select=*&id=eq.${encodeURIComponent(triggerId)}&agent_id=eq.${encodeURIComponent(agentId)}&${ownerFilter}&limit=1`, { method: 'GET' });
            if (!found.ok) return upstreamFailure(found.status, 'Triggers');
            const trigger = (await rowsOf(found))?.[0];
            if (!trigger) return noStore('That trigger was not found.', 404);
            try { requireEnabled(env); }
            catch (error) { return noStore(error.message, error.status || 503); }

            let agentName = OFFICIAL_AGENTS.find(agent => agent.id === agentId)?.name || null;
            const agentRes = await db('dua_agents', `?select=name&id=eq.${encodeURIComponent(agentId)}&${ownerFilter}&limit=1`, { method: 'GET' });
            if (agentRes.ok) agentName = (await rowsOf(agentRes))?.[0]?.name || agentName;

            let run;
            try {
              const job = agentTriggerDefinition(trigger, agentName);
              run = await enqueueExecution({ ownerId: owner.user.id, requestKey: `run:${trigger.id}:${Date.now()}`, ...job },
                { env, fetcher, signal: request.signal, token: owner.token });
            } catch (error) {
              return noStore(error instanceof WorkflowError ? error.message : 'Workflow execution is unavailable. Retry.', error.status || 503);
            }

            const now = new Date().toISOString();
            const response = await db('dua_agent_triggers', `?select=*&id=eq.${encodeURIComponent(triggerId)}&agent_id=eq.${encodeURIComponent(agentId)}&${ownerFilter}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
              body: JSON.stringify({ last_run_at: now }),
            });
            const updated = response.ok ? (await rowsOf(response))?.[0] : null;
            return ok({
              triggered: true,
              trigger: presentTrigger(updated || trigger),
              // Kept for older clients: the push now comes from the worker when the run finishes.
              push: { dispatched: false, reason: 'queued', count: 0 },
              runId: run.id,
              status: run.status,
            });
          }

          return noStore('Not found.', 404);
        }

        return noStore('Not found.', 404);
      }

      const id = sub.toLowerCase();
      if (!SLUG_REGEX.test(id)) return noStore('Not found.', 404);
      const isOfficial = OFFICIAL_AGENTS.some(o => o.id === id);

      // GET /api/agents/:id
      if (request.method === 'GET') {
        const response = await db('dua_agents', `?select=*&id=eq.${encodeURIComponent(id)}&${ownerFilter}&limit=1`, { method: 'GET' });
        if (!response.ok) return upstreamFailure(response.status, 'Agents');
        const stored = (await rowsOf(response))?.[0];
        if (!stored) {
          if (isOfficial) {
            const official = OFFICIAL_AGENTS.find(o => o.id === id);
            return ok({ agent: { ...official, createdAt: null, updatedAt: null } });
          }
          return noStore('That agent was not found.', 404);
        }
        return ok({ agent: presentAgent(stored) });
      }

      // PUT /api/agents/:id
      if (request.method === 'PUT') {
        const { data, response: invalid } = await readBody(request);
        if (invalid) return invalid;
        if (!isObject(data)) return noStore('Invalid request.', 400);

        const now = new Date().toISOString();
        const patch = { updated_at: now };

        if (data.name !== undefined) {
          const name = typeof data.name === 'string' ? data.name.trim() : '';
          if (!name || name.length > 100) return noStore('Invalid name.', 400);
          patch.name = name;
        }
        if (data.description !== undefined) {
          const desc = typeof data.description === 'string' ? data.description.trim() : '';
          if (desc.length > 500) return noStore('Invalid description.', 400);
          patch.description = desc;
        }
        if (data.systemPrompt !== undefined) {
          const prompt = typeof data.systemPrompt === 'string' ? data.systemPrompt : '';
          if (prompt.length > 20000) return noStore('Invalid systemPrompt.', 400);
          patch.system_prompt = prompt;
        }
        if (data.model !== undefined) {
          const model = typeof data.model === 'string' && data.model.trim() ? data.model.trim() : null;
          if (model && model.length > 120) return noStore('Invalid model.', 400);
          patch.model = model;
        }

        if (isOfficial) {
          // Official agent: upsert customization row
          const official = OFFICIAL_AGENTS.find(o => o.id === id);
          const upsertRow = {
            id,
            owner_id: owner.user.id,
            name: patch.name || official.name,
            description: patch.description !== undefined ? patch.description : official.description,
            mode: official.mode,
            system_prompt: patch.system_prompt !== undefined ? patch.system_prompt : '',
            model: patch.model !== undefined ? patch.model : null,
            pinned: true,
            is_official: true,
            updated_at: now,
          };
          const response = await db('dua_agents', '?select=*&on_conflict=id,owner_id', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
            body: JSON.stringify(upsertRow),
          });
          if (!response.ok) return upstreamFailure(response.status, 'Agents');
          const stored = (await rowsOf(response))?.[0];
          return ok({ agent: presentAgent(stored || upsertRow) });
        }

        if (data.mode !== undefined) {
          const mode = typeof data.mode === 'string' ? data.mode.trim().toLowerCase() : '';
          if (!MODES.has(mode)) return noStore('Invalid mode.', 400);
          patch.mode = mode;
        }
        if (data.pinned !== undefined) {
          if (typeof data.pinned !== 'boolean') return noStore('Invalid pinned.', 400);
          patch.pinned = data.pinned;
        }

        const response = await db('dua_agents', `?select=*&id=eq.${encodeURIComponent(id)}&${ownerFilter}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify(patch),
        });
        if (!response.ok) return upstreamFailure(response.status, 'Agents');
        const rows = await rowsOf(response);
        if (!rows || !rows.length) return noStore('That agent was not found.', 404);
        return ok({ agent: presentAgent(rows[0]) });
      }

      // DELETE /api/agents/:id
      if (isOfficial) return noStore('Official agents cannot be deleted.', 400);
      const response = await db('dua_agents', `?id=eq.${encodeURIComponent(id)}&${ownerFilter}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=representation' },
      });
      if (!response.ok) return upstreamFailure(response.status, 'Agents');
      const removed = await rowsOf(response);
      if (!removed || !removed.length) return noStore('That agent was not found.', 404);
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    }

    if (resource === 'skills') {
      const starters = getStarterSkills();
      const starterMap = new Map(starters.map(s => [s.id, s]));

      // GET /api/skills
      if (parts.length === 2 && request.method === 'GET') {
        const response = await db('dua_agent_skills', `?select=*&${ownerFilter}&order=updated_at.desc,id.asc`, { method: 'GET' });
        if (!response.ok) return upstreamFailure(response.status, 'Skills');
        const rows = await rowsOf(response);
        if (!rows) return noStore('Skills returned an invalid list.', 502);

        const overrideMap = new Map(rows.map(r => [r.id, r]));
        const mergedStarters = starters.map(starter => {
          const override = overrideMap.get(starter.id);
          if (!override) return { ...starter, agentId: 'dua-agent', enabled: true, isStarter: true, createdAt: null, updatedAt: null };
          return {
            id: starter.id,
            agentId: override.agent_id || 'dua-agent',
            title: override.title || starter.title,
            summary: override.summary !== undefined ? override.summary : starter.summary,
            body: override.body !== undefined ? override.body : starter.body,
            enabled: override.enabled !== false,
            isStarter: true,
            createdAt: override.created_at,
            updatedAt: override.updated_at,
          };
        });

        const customSkills = rows.filter(r => !starterMap.has(r.id)).map(r => presentSkill(r, false));
        return ok({ skills: [...mergedStarters, ...customSkills] });
      }

      // POST /api/skills
      if (parts.length === 2 && request.method === 'POST') {
        const { data, response: invalid } = await readBody(request);
        if (invalid) return invalid;
        if (!isObject(data)) return noStore('Invalid request.', 400);

        const title = typeof data.title === 'string' ? data.title.trim() : '';
        if (!title || title.length > 100) return noStore('Invalid title.', 400);

        let id = typeof data.id === 'string' ? data.id.trim().toLowerCase() : '';
        if (!id) id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || crypto.randomUUID();
        if (!SLUG_REGEX.test(id)) return noStore('Invalid id.', 400);
        if (starterMap.has(id)) return noStore('That skill id is a starter skill. Use PUT to customize it.', 409);

        const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
        if (summary.length > 500) return noStore('Invalid summary.', 400);

        const body = typeof data.body === 'string' ? data.body : '';
        if (body.length > 50000) return noStore('Invalid body.', 400);

        const agentId = typeof data.agentId === 'string' && SLUG_REGEX.test(data.agentId.trim()) ? data.agentId.trim() : 'dua-agent';
        const enabled = data.enabled !== false;
        const now = new Date().toISOString();
        const row = {
          id,
          owner_id: owner.user.id,
          agent_id: agentId,
          title,
          summary,
          body,
          enabled,
          created_at: now,
          updated_at: now,
        };

        const response = await db('dua_agent_skills', '?select=*', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify(row),
        });
        if (!response.ok) return upstreamFailure(response.status, 'Skills');
        const stored = (await rowsOf(response))?.[0];
        if (!stored) return noStore('Skills did not confirm the save.', 502);
        return ok({ skill: presentSkill(stored, false) }, 201);
      }

      const id = sub.toLowerCase();
      if (!SLUG_REGEX.test(id)) return noStore('Not found.', 404);
      const isStarter = starterMap.has(id);

      // GET /api/skills/:id
      if (request.method === 'GET') {
        const response = await db('dua_agent_skills', `?select=*&id=eq.${encodeURIComponent(id)}&${ownerFilter}&limit=1`, { method: 'GET' });
        if (!response.ok) return upstreamFailure(response.status, 'Skills');
        const stored = (await rowsOf(response))?.[0];
        if (!stored) {
          if (isStarter) {
            const starter = starterMap.get(id);
            return ok({ skill: { ...starter, agentId: 'dua-agent', enabled: true, isStarter: true, createdAt: null, updatedAt: null } });
          }
          return noStore('That skill was not found.', 404);
        }
        return ok({ skill: presentSkill(stored, isStarter) });
      }

      // PUT /api/skills/:id
      if (request.method === 'PUT') {
        const { data, response: invalid } = await readBody(request);
        if (invalid) return invalid;
        if (!isObject(data)) return noStore('Invalid request.', 400);

        const now = new Date().toISOString();
        const patch = { updated_at: now };

        if (data.title !== undefined) {
          const title = typeof data.title === 'string' ? data.title.trim() : '';
          if (!title || title.length > 100) return noStore('Invalid title.', 400);
          patch.title = title;
        }
        if (data.summary !== undefined) {
          const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
          if (summary.length > 500) return noStore('Invalid summary.', 400);
          patch.summary = summary;
        }
        if (data.body !== undefined) {
          const body = typeof data.body === 'string' ? data.body : '';
          if (body.length > 50000) return noStore('Invalid body.', 400);
          patch.body = body;
        }
        if (data.enabled !== undefined) {
          if (typeof data.enabled !== 'boolean') return noStore('Invalid enabled.', 400);
          patch.enabled = data.enabled;
        }
        if (data.agentId !== undefined) {
          const agentId = typeof data.agentId === 'string' ? data.agentId.trim() : '';
          if (!SLUG_REGEX.test(agentId)) return noStore('Invalid agentId.', 400);
          patch.agent_id = agentId;
        }

        if (isStarter) {
          const starter = starterMap.get(id);
          const upsertRow = {
            id,
            owner_id: owner.user.id,
            agent_id: patch.agent_id || 'dua-agent',
            title: patch.title || starter.title,
            summary: patch.summary !== undefined ? patch.summary : starter.summary,
            body: patch.body !== undefined ? patch.body : starter.body,
            enabled: patch.enabled !== undefined ? patch.enabled : true,
            updated_at: now,
          };
          const response = await db('dua_agent_skills', '?select=*&on_conflict=id,owner_id', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
            body: JSON.stringify(upsertRow),
          });
          if (!response.ok) return upstreamFailure(response.status, 'Skills');
          const stored = (await rowsOf(response))?.[0];
          return ok({ skill: presentSkill(stored || upsertRow, true) });
        }

        const response = await db('dua_agent_skills', `?select=*&id=eq.${encodeURIComponent(id)}&${ownerFilter}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify(patch),
        });
        if (!response.ok) return upstreamFailure(response.status, 'Skills');
        const rows = await rowsOf(response);
        if (!rows || !rows.length) return noStore('That skill was not found.', 404);
        return ok({ skill: presentSkill(rows[0], false) });
      }

      // DELETE /api/skills/:id
      if (isStarter) return noStore('Starter skills cannot be deleted. You can disable them instead.', 400);
      const response = await db('dua_agent_skills', `?id=eq.${encodeURIComponent(id)}&${ownerFilter}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=representation' },
      });
      if (!response.ok) return upstreamFailure(response.status, 'Skills');
      const removed = await rowsOf(response);
      if (!removed || !removed.length) return noStore('That skill was not found.', 404);
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    }

    return noStore('Not found.', 404);
  } catch (error) {
    if (error instanceof Response) return error;
    return noStore('Operation temporarily unavailable. Retry.', 502);
  }
}

/** AI generator for agent system prompts in Node using configured provider. */
async function handleGeneratePrompt(request, { env = process.env, fetcher = fetch } = {}) {
  const access = await guardChatAccess(request, { env, fetcher });
  if (!access.allowed) return access.response;

  const { data, response: invalid } = await readBody(request);
  if (invalid) return invalid;
  if (!isObject(data) || typeof data.description !== 'string' || !data.description.trim() || data.description.length > 2000) {
    return noStore('Invalid description.', 400);
  }

  const prompt = `You are an expert AI prompt engineer. Given the user's description of an AI agent, generate a clear, highly effective, and structured system prompt (instructions) for this agent. Return ONLY the system prompt without extra preamble or conversational filler.\n\nAgent Name: ${data.name || 'Custom Agent'}\nMode: ${data.mode || 'auto'}\nDescription:\n${data.description.trim()}`;

  const key = env.GEMINI_API_KEY;
  const model = env.GEMINI_MODEL || 'gemini-3.8-flash';
  if (!key) return noStore('AI generation is not configured on this server.', 503);

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const upstream = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 2048, temperature: 0.7 }
      }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(30000)]),
    });
    if (!upstream.ok) return noStore('Prompt generation failed. Retry.', 502);
    const json = await upstream.json().catch(() => ({}));
    const reply = extractReply('gemini', json).text.trim();
    if (!reply) return noStore('Prompt generation returned an empty result.', 502);
    return ok({ systemPrompt: reply });
  } catch {
    return noStore('Prompt generation is temporarily unavailable. Retry.', 502);
  }
}

/** AI generator for skill definitions in Node using configured provider. */
async function handleGenerateSkill(request, { env = process.env, fetcher = fetch } = {}) {
  const access = await guardChatAccess(request, { env, fetcher });
  if (!access.allowed) return access.response;

  const { data, response: invalid } = await readBody(request);
  if (invalid) return invalid;
  if (!isObject(data) || typeof data.description !== 'string' || !data.description.trim() || data.description.length > 2000) {
    return noStore('Invalid description.', 400);
  }

  const prompt = `You are an expert AI skill designer. Given the user's description, create a specialized skill specification for Dua Agent.\nReturn a JSON object with exactly these fields:\n- "title": A concise title for the skill (max 50 chars)\n- "summary": A 1-2 sentence summary of what the skill does and when to use it (max 200 chars)\n- "body": Detailed instructions, steps, and guidelines for the skill in Markdown format.\n\nReturn ONLY the raw JSON object without markdown fences or other text.\n\nSkill Title: ${data.title || ''}\nDescription:\n${data.description.trim()}`;

  const key = env.GEMINI_API_KEY;
  const model = env.GEMINI_MODEL || 'gemini-3.8-flash';
  if (!key) return noStore('AI generation is not configured on this server.', 503);

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const upstream = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 3000, temperature: 0.7 }
      }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(30000)]),
    });
    if (!upstream.ok) return noStore('Skill generation failed. Retry.', 502);
    const json = await upstream.json().catch(() => ({}));
    const rawText = extractReply('gemini', json).text.trim();
    const cleanJson = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let skillData;
    try { skillData = JSON.parse(cleanJson); }
    catch { return noStore('Skill generation produced an invalid response format.', 502); }

    if (!skillData || typeof skillData !== 'object' || typeof skillData.title !== 'string' || typeof skillData.body !== 'string') {
      return noStore('Skill generation produced incomplete skill fields.', 502);
    }
    return ok({
      skill: {
        title: skillData.title.slice(0, 100),
        summary: (skillData.summary || '').slice(0, 500),
        body: skillData.body.slice(0, 50000),
      }
    });
  } catch {
    return noStore('Skill generation is temporarily unavailable. Retry.', 502);
  }
}
