import { timingSafeEqual } from 'node:crypto';
import { providerConfiguration } from './providers.mjs';
import { accountCapabilities, ownerEmail } from './account.mjs';
import { searchConfiguration } from './search.mjs';
import { advancedConfiguration } from './advanced-integrations.mjs';
import { filesConfiguration } from './files.mjs';
import { publicImagineConfiguration } from './imagine.mjs';
import { voiceConfiguration } from './voice.mjs';
import { codeExecutionConfiguration } from './code-execution.mjs';
import { userToken } from './storage.mjs';
import { PROVIDER_DEFINITIONS } from './providers.mjs';

export function setupConfiguration(env = {}) {
 const providers = providerConfiguration(env);
 const account = {...accountCapabilities({url:env.SUPABASE_URL,key:env.SUPABASE_ANON_KEY,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY}),requireLogin:['1','true'].includes(String(env.DUA_REQUIRE_LOGIN).toLowerCase()) || Boolean(env.DUA_ALLOWED_EMAIL?.trim()) || Number(env.DUA_DAILY_REQUEST_LIMIT)>0,ownerRestricted:Boolean(env.DUA_ALLOWED_EMAIL?.trim()),dailyRequestLimit:Number(env.DUA_DAILY_REQUEST_LIMIT) || 0};
 const search = searchConfiguration(env);
 const advanced = advancedConfiguration(env);
 const group=(id,title,state,requires,limitations)=>({id,title,state,requires,limitations});
 const files = filesConfiguration(env);
 const imagine = publicImagineConfiguration(env);
 const voice = voiceConfiguration(env);
 const code = codeExecutionConfiguration(env, PROVIDER_DEFINITIONS, new Set(providers.filter(p=>p.configured).map(p=>p.name)));
 const codeLine = code.enabled ? 'Run code: '+code.providers.join(', ')+' can run Python in the provider\'s own sandbox when you turn on Run code (Gemini: no extra charge, 30 s per run). Code and output are shown in the reply and kept in the server snapshot and phone cache.' : 'Run code is off: '+code.reason;
 const ttsLine = voice.tts.enabled ? 'AI reply voices (signed-in owner only): '+voice.tts.providers.map(p=>p.name+' ('+p.voices.length+(p.voices.length===1?' voice':' voices')+')').join(', ')+'. Long replies play in short chunks and are cached on the device for this session.' : 'AI reply voices are off: '+voice.tts.reason;
 const imagineLine = !imagine.image.enabled&&!imagine.video.enabled&&imagine.image.reason===imagine.video.reason ? 'Imagine is off: '+imagine.image.reason : 'Imagine (signed-in owner only): '+(imagine.image.enabled?'images with '+imagine.image.providers.map(p=>p.name).join(' or ')+' (up to '+imagine.image.dailyLimit+' a day)':'images off. '+imagine.image.reason)+' \u00b7 '+(imagine.video.enabled?'video with Grok Imagine (up to '+imagine.video.dailyLimit+' seconds a day, '+imagine.video.resolutions.join('/')+')':'video off. '+imagine.video.reason)+' Results are saved to the private dua-files bucket.';
 const liveLine = voice.live.enabled ? ' Live voice: Grok '+voice.live.model+', up to '+voice.live.dailyMinutes+' min a day and '+voice.live.maxSessionMinutes+' min per session (about '+voice.live.pricePerMinute+'/min); needs the Phase 4 migration.' : ' Live voice is off: '+voice.live.reason+' Hands-free mode uses device speech instead.';
 return {providers,account,search,advanced,files,imagine,voice,groups:[
  group('providers','AI providers',providers.slice(2).every(p=>p.configured)?'configured':providers.some(p=>p.configured)?'partial':'needs-configuration',['API key and model for each provider'],['All providers accept UTF-8 text and code files (TXT, CSV, MD, JSON, XML, YAML, logs, source code; 256 KB each). Image/PDF support depends on configured model capabilities; Grok accepts JPEG/PNG only (the app converts WebP to JPEG); Grok/Kimi do not accept inline PDF.','Stored files (signed-in owner only, up to '+Math.floor(files.maxBytes/1048576)+' MB): PDFs, spreadsheets (XLSX/XLS/ODS/CSV, parsed to CSV), text, images and audio (transcribed first). Grok reads stored PDFs through xAI file inputs; Kimi gets extracted PDF text.','Reasoning mode shows thinking for Dua/Gemini, Grok and ChatGPT reasoning models; Claude and Kimi answer normally.',codeLine,imagineLine]),
  group('search','Web search and page reading',search.configured?'configured':'partial',['Brave Search API key for Search with Claude/Kimi (and as fallback)','Public HTTPS URL for Read link'],['Chat Web mode starts Off. Dua/Gemini, ChatGPT and Grok search natively (Google Search grounding / web_search, billed by the provider per search); Claude and Kimi use Brave snippets. DUA_SEARCH_PREFER_BRAVE=1 uses Brave everywhere. X search (Grok only, about $5 per 1,000 posts) is off per message by default; DUA_X_SEARCH=0 removes it. Read link reads one public text page. Login pages, JavaScript rendering and crawling are unsupported.']),
  group('sync','Automatic cloud sync',account.configured?'available':'needs-configuration',['Supabase cloud migration','Sign in and enable on this device'],['Defaults off. Conflicts and deletions pause for review. No file or audio bytes (stored files live in the private dua-files bucket; references, project settings and instructions are in the server snapshot and phone cache).']),
  group('memory','Memory suggestions','available',['Enable suggestions and approve each note'],['Explicit remember statements become proposals; saved notes are used only when memory is enabled in Personal chats.']),
  group('connectors','Connectors and plugins',advanced.connectors.github.configured&&env.DUA_ALLOWED_EMAIL?'configured':'needs-configuration',['GitHub read-only token','Allowed personal account email','Enable connector and sign in'],['Read-only GitHub: repository list, file tree, file contents (100 KB per file) and code search. Build mode (Dua/Gemini) reads one chosen repository and answers with diffs; writes require a separately configured write token and an owner-confirmed Create PR action. This creates a branch, commit and draft PR after a diff review. Running repository commands is not implemented.']),
  group('computer','Screen and video','partial',['Device camera app for photo attachments'],['Android can attach a captured photo to a chat. No screen sharing, video upload, recording or remote computer control. Native screen capture and remote sessions remain pending.']),
  group('voice','Voice',voice.tts.enabled?'configured':'partial',['Device speech service','GROK_API_KEY and/or GEMINI_API_KEY (or ElevenLabs settings) for AI reply voices','GROK_API_KEY and the Phase 4 migration (202610100001_dua_voice.sql) for live voice','Allowed personal account email and sign in'],['Device speech recognition and device voices work everywhere, with a chosen language. '+ttsLine+liveLine]),
  group('account','Account and access protection',account.configured?'partial':'needs-configuration',['Supabase Google provider','Optional deletion service key','Allowed personal account email and optional daily request limit'],['Sign-in is Google only: native Android Google Sign-In verified by the backend. There is no email/password sign-in. With an allowed email set, only that account can sign in, sync or delete. Request limits are not currency spending limits.'])
 ]};
}

function safeEqual(a, b) {
 const left = Buffer.from(String(a));
 const right = Buffer.from(String(b));
 return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

/**
 * F-03: /api/setup no longer enumerates the deployment to anonymous callers.
 * Full detail (provider names, model IDs, daily limits, prices, "why disabled" reasons)
 * is returned only to the owner: a matching DUA_APP_TOKEN (X-Dua-App-Token), or the owner's
 * Supabase session verified against /auth/v1/user. Everyone else gets a coarse summary.
 * No network call is made when no owner/token is configured, so smoke tests stay offline.
 */
async function setupAuthorized(request, env = {}, fetcher = fetch) {
 const appToken = String(env.DUA_APP_TOKEN || '');
 if (appToken && safeEqual(request.headers.get('x-dua-app-token') || '', appToken)) return true;
 const owner = ownerEmail(env.DUA_ALLOWED_EMAIL);
 const token = userToken(request);
 const url = String(env.SUPABASE_URL || '').trim().replace(/\/$/, '');
 const key = String(env.SUPABASE_ANON_KEY || '').trim();
 if (!owner || !token || !url || !key) return false;
 try {
  const response = await fetcher(url + '/auth/v1/user', {
   headers: { apikey: key, Authorization: 'Bearer ' + token },
   signal: AbortSignal.timeout(10000), redirect: 'error'
  });
  if (!response.ok) return false;
  const user = await response.json();
  return Boolean(user && String(user.email || '').toLowerCase() === owner);
 } catch { return false; }
}

/**
 * Coarse /api/setup for callers who are not the owner: on/off booleans and counts only.
 * No provider names or model IDs, no daily limits or prices, no "why disabled" reason strings.
 * The boolean capability flags mirror what /api/config already exposes publicly.
 */
export function setupPublicSummary(env = {}) {
 const providers = providerConfiguration(env);
 const account = accountCapabilities({ url: env.SUPABASE_URL, key: env.SUPABASE_ANON_KEY, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY });
 const advanced = advancedConfiguration(env);
 const imagine = publicImagineConfiguration(env);
 const voice = voiceConfiguration(env);
 return {
  configured: {
   providers: providers.filter(provider => provider.configured).length,
   search: searchConfiguration(env).configured,
   sync: account.configured,
   memory: true,
   connectors: advanced.connectors.github.configured && Boolean(env.DUA_ALLOWED_EMAIL),
   computer: true,
   imagine: imagine.image.enabled || imagine.video.enabled,
   voice: voice.tts.enabled || voice.live.enabled,
  },
  account: {
   configured: account.configured,
   deletionConfigured: account.deletionConfigured,
   requireLogin: ['1','true'].includes(String(env.DUA_REQUIRE_LOGIN).toLowerCase()) || Boolean(env.DUA_ALLOWED_EMAIL?.trim()) || Number(env.DUA_DAILY_REQUEST_LIMIT) > 0,
   ownerRestricted: Boolean(env.DUA_ALLOWED_EMAIL?.trim()),
   dailyRequestLimit: Number(env.DUA_DAILY_REQUEST_LIMIT) || 0,
  },
 };
}

export async function handleSetup(req, { env = {}, fetcher = fetch } = {}) {
 if (req.method !== 'GET') return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: { 'Cache-Control': 'no-store' } });
 const headers = { 'Cache-Control': 'no-store' };
 const authorized = await setupAuthorized(req, env, fetcher).catch(() => false);
 return Response.json(authorized ? setupConfiguration(env) : setupPublicSummary(env), { headers });
}
