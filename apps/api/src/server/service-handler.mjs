import { handleWebAgentAction } from '../core/web-agent-action.mjs';
import { handleChat } from '../core/providers.mjs';
import { handleSearch } from '../core/search.mjs';
import { handleAccount, handleCloudRead } from '../core/account.mjs';
import { handleSetup } from '../core/setup.mjs';
import { handleAdvanced } from '../core/advanced-integrations.mjs';
import { guardChatAccess } from '../core/access-policy.mjs';
import { envInteger } from '../core/adapters.mjs';
import { handleFiles } from '../core/files.mjs';
import { handleImagine } from '../core/imagine.mjs';
import { handleVoice } from '../core/voice.mjs';
import { handleWorkflowRuns } from '../core/workflow-runs.mjs';
import { handleOrhanTasks } from '../core/orhan-tasks.mjs';
import { handleWorkflowExecution } from '../core/workflow-execution.mjs';
import { handleWorkflowAutomation } from '../core/workflow-automation.mjs';
import { handleBuildPr } from '../core/build-pr.mjs';
import { handleArtifactsMemories } from '../core/artifacts-memories.mjs';
import { handleConversations } from '../core/conversations.mjs';
import { handleAgentsSkills } from '../core/agents-skills.mjs';
import { handleNotifications } from '../core/notifications.mjs';
import { withRequestLog } from '../core/request-logging.mjs';
import { switchResponse, killSwitches, PAUSED } from '../core/kill-switches.mjs';
import { applyCors, corsPreflight, requestOriginAllowed } from '../core/cors.mjs';
import { DEFAULT_ENGINE_URL, engineEndpoint, engineHeaders } from '../core/engine-client.mjs';

/** DUA_CHAT_DEADLINE_SECONDS: whole-request chat deadline (default 280 s, allowed 10\u2013790 s). */
export const chatDeadlineMs = env => envInteger(env, 'DUA_CHAT_DEADLINE_SECONDS', 280, 10, 790) * 1000;

export async function handleService(request, options = {}) {
 const env = options.env || process.env;
 const url = new URL(request.url);
 const preflight = corsPreflight(request, url, env);
 if (preflight) return withRequestLog(request, async () => preflight, { logWriter: options.logWriter });
 if (!requestOriginAllowed(request, url, env)) {
  return withRequestLog(request, async () => Response.json({ error: 'Request origin is not allowed.' }, { status: 403, headers: { 'Cache-Control': 'no-store' } }), { logWriter: options.logWriter });
 }
 const response = await withRequestLog(request, () => routeService(request, options), { logWriter: options.logWriter });
 return applyCors(response, request);
}

async function routeService(request,{env=process.env,fetcher=fetch}={}) {
 const url=new URL(request.url),path=url.pathname;
 const deadlineAt=path==='/api/chat'?Date.now()+chatDeadlineMs(env):undefined;
 // Include authentication/quota work in the chat deadline. Keep it below the Cloud Run request
 // timeout (900 s; deploy-cloudrun.sh sets 780 s) so the reply can end cleanly.
 if(path==='/api/chat')request=new Request(request,{signal:AbortSignal.any([request.signal,AbortSignal.timeout(chatDeadlineMs(env))])});
 // Remote kill switches (DUA_MAINTENANCE, DUA_DISABLE_IMAGINE, DUA_DISABLE_VOICE): refused before any provider work.
 const paused=switchResponse(path,env);
 if(paused)return paused;
 if(path==='/api/web/chat')return handleWebChat(request,{env,fetcher});
 if(path==='/api/web/agent/action')return handleWebAgentAction(request,{env,fetcher});
 if(path==='/api/workflow-runs')return handleWorkflowRuns(request,{env,fetcher});
 if(path.startsWith('/api/orhan/tasks'))return handleOrhanTasks(request,{env,fetcher});
 if(path==='/api/workflow-executions'||path.startsWith('/api/workflow-executions/'))return handleWorkflowExecution(request,{env,fetcher});
 if(path==='/api/workflow-automation'||path.startsWith('/api/workflow-automation/'))return handleWorkflowAutomation(request,{env,fetcher});
 if(path==='/api/setup')return handleSetup(request,{env,fetcher});
 if(path==='/api/config')return handleChat(request,{env,fetcher});
 // Account and cloud routes: owner-locked by DUA_ALLOWED_EMAIL inside handleAccount (session, features and logout stay open).
 if(path==='/api/auth/reset-password'||path==='/api/cloud'||path==='/api/cloud/chat'||/^\/api\/account\/(session|refresh|logout|features|google-token|email-login|email-signup|password|reset-password|phone|delete)$/.test(path)) {
  const handler=path==='/api/cloud'&&request.method==='GET'?handleCloudRead:handleAccount;
  return handler(request,{url:env.SUPABASE_URL,key:env.SUPABASE_ANON_KEY,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,filesBucket:env.DUA_FILES_BUCKET,allowedEmail:env.DUA_ALLOWED_EMAIL,webOrigins:env.WEB_ORIGINS,fetcher});
 }
 // Stored files: owner-only (Supabase sign-in + DUA_ALLOWED_EMAIL), checked inside handleFiles.
 if(path.startsWith('/api/files/'))return handleFiles(request,{env,fetcher});
 // Imagine (image + video generation): owner-only, daily caps, checked inside handleImagine.
 if(path.startsWith('/api/imagine/'))return handleImagine(request,{env,fetcher});
 // Voice (reply voices, live voice sessions): owner-only, checked inside handleVoice. Not counted as chat requests.
 if(path.startsWith('/api/voice/'))return handleVoice(request,{env,fetcher});
 if(path==='/api/build/pr')return handleBuildPr(request,{env,fetcher});
 // Artifacts and Memory lists: owner-only (Supabase sign-in + DUA_ALLOWED_EMAIL), checked inside
 // handleArtifactsMemories. Both resources share one handler, so one dispatch covers both.
 if(path==='/api/artifacts'||path.startsWith('/api/artifacts/')||path==='/api/memories'||path.startsWith('/api/memories/'))return handleArtifactsMemories(request,{env,fetcher});
 // Conversations and messages: owner-only (Supabase sign-in + DUA_ALLOWED_EMAIL), user token + anon key, checked inside handleConversations.
 if(path==='/api/conversations'||path.startsWith('/api/conversations/'))return handleConversations(request,{env,fetcher});
 // Agents and skills: owner-only (Supabase sign-in + DUA_ALLOWED_EMAIL), user token + anon key, checked inside handleAgentsSkills.
 if(path==='/api/agents'||path.startsWith('/api/agents/')||path==='/api/skills'||path.startsWith('/api/skills/'))return handleAgentsSkills(request,{env,fetcher});
 // Device tokens and notifications: owner-only (Supabase sign-in + DUA_ALLOWED_EMAIL), user token + anon key, checked inside handleNotifications.
 if(path.startsWith('/api/devices')||path==='/api/notifications'||path.startsWith('/api/notifications/'))return handleNotifications(request,{env,fetcher});
 if(['/api/chat','/api/search','/api/connectors/github'].includes(path)) {
  if(request.method!=='POST')return Response.json({error:'Method not allowed.'},{status:405,headers:{'Cache-Control':'no-store'}});
  const advanced=path==='/api/connectors/github';
  if(advanced&&!env.DUA_ALLOWED_EMAIL)return Response.json({error:'Set the allowed personal account email before enabling shared integrations.'},{status:503,headers:{'Cache-Control':'no-store'}});
  const access=await guardChatAccess(request,{env:advanced?{...env,DUA_REQUIRE_LOGIN:'1'}:env,fetcher});
  if(!access.allowed)return access.response;
  const response=path==='/api/chat'?await handleChat(request,{env,fetcher,deadlineAt}):path==='/api/search'?await handleSearch(request,{env,fetcher}):await handleAdvanced(request,{env,fetcher,authorized:true});
  // Keep renewed HttpOnly sessions returned by the access guard.
  if(access.headers){const headers=new Headers(access.headers);for(const [key,value] of headers)if(!['set-cookie','content-type','cache-control'].includes(key))response.headers.set(key,value);for(const cookie of headers.getSetCookie())response.headers.append('Set-Cookie',cookie);}
  return response;
 }
 return Response.json({error:'Not found.'},{status:404,headers:{'Cache-Control':'no-store'}});
}

// Website chat proxy (docs/WEBSITE.md roadmap item 2). The website's owner session lives in HttpOnly
// cookies the page cannot read, so dua-api forwards a same-origin browser request to dua-ai-engine
// /api/chat with that session as the bearer token and streams the SSE reply back unbuffered.
// DUA_ENGINE_URL overrides the engine origin; DUA_APP_TOKEN (optional) is added server-side only.
export { DEFAULT_ENGINE_URL };
const WEB_CHAT_MAX_BYTES=4*1024*1024;
const WEB_CHAT_MAX_MESSAGES=200;
// The website sends {role,text}; accept the engine's `content` too (string or parts array).
const validTurn=m=>!!m&&typeof m==='object'&&!Array.isArray(m)&&typeof m.role==='string'&&m.role.length<=32&&(typeof m.text==='string'||typeof m.content==='string'||Array.isArray(m.content));
// The engine reads only `text`; turn `content` (string or parts) into text and drop `content`.
const normalizeTurn=({content,...m})=>typeof m.text==='string'?m:{...m,text:typeof content==='string'?content:content.filter(p=>p&&typeof p.text==='string').map(p=>p.text).join('')};
const noStore=(error,status)=>Response.json({error},{status,headers:{'Cache-Control':'no-store'}});
const SKILL_ID=/^[a-z0-9][a-z0-9-]{0,63}$/;
function duaAgentSkills(data,mode){
 if(!Object.prototype.hasOwnProperty.call(data,'skills'))return undefined;
 const skills=data.skills;
 if(mode!=='agent'||!Array.isArray(skills)||skills.length>100||new Set(skills).size!==skills.length||skills.some(id=>typeof id!=='string'||!SKILL_ID.test(id)))return null;
 return skills;
}
const engineUrl=env=>engineEndpoint(env,'/api/chat');
export async function handleWebChat(request,{env=process.env,fetcher=fetch}={}){
 if(request.method!=='POST')return noStore('Method not allowed.',405);
 const url=new URL(request.url);
 if(request.headers.get('origin')!==url.origin||!['','same-origin'].includes(request.headers.get('sec-fetch-site')||''))return noStore('Request origin is not allowed.',403);
 const cookie=Object.fromEntries((request.headers.get('cookie')||'').split(';').map(v=>v.trim().split('=')).filter(p=>p.length===2));
 const token=cookie.dua_access;
 if(!token||token.length>10000||!/^[A-Za-z0-9._-]+$/.test(token))return noStore('Sign in to chat.',401);
 const target=engineUrl(env);
 if(!target)return noStore('Chat engine is not configured.',503);
 const tooLarge=()=>noStore('Conversation too large. Start a new chat.',413);
 const declared=Number(request.headers.get('content-length'));
 if(Number.isFinite(declared)&&declared>WEB_CHAT_MAX_BYTES)return tooLarge();
 const body=await request.text();
 if(Buffer.byteLength(body,'utf8')>WEB_CHAT_MAX_BYTES)return tooLarge();
 let data;try{data=JSON.parse(body);}catch{return noStore('Invalid request.',400);}
 if(!data||typeof data!=='object'||Array.isArray(data)||!Array.isArray(data.messages))return noStore('Invalid request.',400);
 if(data.messages.length>WEB_CHAT_MAX_MESSAGES)return noStore('Conversation too long. Start a new chat.',413);
 if(!data.messages.every(validTurn))return noStore('Invalid request.',400);
 // Agent kill switch: refuse before the quota so no daily request is used (maintenance is refused in routeService).
 if(data.mode==='agent'&&killSwitches(env).agent)return Response.json({error:PAUSED.agent,paused:'agent'},{status:503,headers:{'Cache-Control':'no-store'}});
 // Same login/owner/daily-quota policy as /api/chat (shared Supabase counter), only after input is valid.
 const access=await guardChatAccess(request,{env,fetcher});
 if(!access.allowed)return access.response;
 // A refreshed session returns a new access cookie; forward that token, not the expired one.
 let bearer=token;
 for(const c of new Headers(access.headers||undefined).getSetCookie()){const m=/^dua_access=([^;]*)/.exec(c);if(m&&m[1].length<=10000&&/^[A-Za-z0-9._-]+$/.test(m[1]))bearer=m[1];}
 // Plain chat or Agent only from the website; Build/persistence stay Android-only.
 const mode=data.mode==='agent'?'agent':data.mode==='reasoning'?'reasoning':'auto';
 const skills=duaAgentSkills(data,mode);
 if(skills===null)return noStore('Invalid skills.',400);
 const payload={model:typeof data.model==='string'?data.model:'Dua',messages:data.messages.map(normalizeTurn),attachments:[],memory:typeof data.memory==='string'?data.memory:'',stream:true,mode};
 if(skills)payload.skills=skills;
 const headers=engineHeaders(env,bearer,{accept:'text/event-stream, application/json',native:true});
 let upstream;
 try{upstream=await fetcher(target,{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.any([request.signal,AbortSignal.timeout(chatDeadlineMs(env))])});}
 catch{return withAccess(noStore('Chat engine is not reachable. Try again.',502),access);}
 const type=upstream.headers.get('content-type')||'';
 if(type.includes('text/event-stream')&&upstream.body)
  return withAccess(new Response(upstream.body,{status:upstream.status,headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'}}),access);
 // Non-stream answers (errors): pass a short JSON error only, never upstream details beyond `error`.
 let message='Reply failed. Try again.';
 try{const json=await upstream.json();if(typeof json?.error==='string')message=json.error.slice(0,300);}catch{}
 return withAccess(noStore(message,upstream.ok?502:upstream.status),access);
}
// Keep renewed HttpOnly session cookies and the remaining-requests header from the access guard.
function withAccess(response,access){
 const headers=new Headers(access.headers||undefined);
 const remaining=headers.get('x-dua-requests-remaining');if(remaining)response.headers.set('X-Dua-Requests-Remaining',remaining);
 for(const cookie of headers.getSetCookie())response.headers.append('Set-Cookie',cookie);
 return response;
}
