import test from 'node:test';
import assert from 'node:assert/strict';
import { handleService, DEFAULT_ENGINE_URL } from '../src/server/service-handler.mjs';
import { mockFetch, sseResponse, sse } from './helpers.mjs';
import { PAUSED } from '../src/core/kill-switches.mjs';
import { DEFAULT_ENGINE_URL as SHARED_ENGINE_URL, engineEndpoint, engineHeaders } from '../src/core/engine-client.mjs';

const origin='https://dua.test';
// No access policy by default so engine-proxy tests need no Supabase fakes; quota tests add it.
const env={DUA_ENGINE_URL:'https://engine.test'};
const body={model:'Dua',mode:'agent',messages:[{role:'user',text:'hi'}]};
const req=(headers={},method='POST')=>new Request(origin+'/api/web/chat',{method,headers:{'content-type':'application/json',origin,'sec-fetch-site':'same-origin',cookie:'dua_access=fake-access; dua_refresh=fake-refresh',...headers},body:method==='POST'?JSON.stringify(body):undefined});
const run=(request,fetcher,extra={})=>handleService(request,{env:{...env,...extra},fetcher,logWriter:()=>{}});

test('web chat requires the cookie session before contacting the engine',async()=>{
 const fetcher=mockFetch();
 for(const cookie of ['','dua_access=bad token','dua_refresh=only'])
  assert.equal((await run(req({cookie}),fetcher)).status,401);
 assert.equal(fetcher.calls.length,0);
});

test('web chat enforces same-origin browser requests and POST',async()=>{
 const fetcher=mockFetch();
 assert.equal((await run(req({origin:'https://evil.test'}),fetcher)).status,403);
 assert.equal((await run(req({'sec-fetch-site':'cross-site'}),fetcher)).status,403);
 const noOrigin=new Request(origin+'/api/web/chat',{method:'POST',headers:{cookie:'dua_access=fake-access'},body:JSON.stringify(body)});
 assert.equal((await run(noOrigin,fetcher)).status,403);
 assert.equal((await run(req({},'GET'),fetcher)).status,405);
 assert.equal(fetcher.calls.length,0);
});

test('web chat forwards the owner bearer token and streams the engine SSE through',async()=>{
 const fetcher=mockFetch(sseResponse([sse({type:'text',delta:'Hel'},'text'),sse({type:'text',delta:'lo'},'text'),sse({type:'done'},'done')],{delayMs:5}));
 const response=await run(req(),fetcher,{DUA_APP_TOKEN:'fake-app-token'});
 assert.equal(response.status,200);
 assert.match(response.headers.get('content-type'),/text\/event-stream/);
 assert.equal(response.headers.get('x-accel-buffering'),'no');
 const text=await response.text();
 assert.match(text,/"delta":"Hel"/);assert.match(text,/event: done/);
 const call=fetcher.calls[0];
 assert.equal(call.url,'https://engine.test/api/chat');
 assert.equal(call.init.headers.Authorization,'Bearer fake-access');
 assert.equal(call.init.headers['X-Dua-App-Token'],'fake-app-token');
 assert.deepEqual(call.body,{model:'Dua',messages:body.messages,attachments:[],memory:'',stream:true,mode:'agent'});
});

test('web chat forwards Dua Agent skill ids and rejects anything else',async()=>{
 const skills=['code-reviewer','frontend-developer'];
 const fetcher=mockFetch(sseResponse([sse({type:'done'},'done')]));
 const request=new Request(origin+'/api/web/chat',{method:'POST',headers:{'content-type':'application/json',origin,'sec-fetch-site':'same-origin',cookie:'dua_access=fake-access'},body:JSON.stringify({...body,skills})});
 const response=await run(request,fetcher);
 assert.equal(response.status,200);
 await response.text();
 assert.deepEqual(fetcher.calls[0].body.skills,skills);
 const bad=new Request(origin+'/api/web/chat',{method:'POST',headers:{'content-type':'application/json',origin,'sec-fetch-site':'same-origin',cookie:'dua_access=fake-access'},body:JSON.stringify({...body,mode:'auto',skills})});
 assert.equal((await run(bad,mockFetch())).status,400);
});

test('web chat forwards custom skill ids unchanged (bodies are resolved by the engine, never sent by Node)',async()=>{
 const skills=['code-reviewer','my-custom-skill'];
 const fetcher=mockFetch(sseResponse([sse({type:'done'},'done')]));
 const request=new Request(origin+'/api/web/chat',{method:'POST',headers:{'content-type':'application/json',origin,'sec-fetch-site':'same-origin',cookie:'dua_access=fake-access'},body:JSON.stringify({...body,skills})});
 const response=await run(request,fetcher);
 assert.equal(response.status,200);
 await response.text();
 assert.equal(fetcher.calls.length,1);
 assert.deepEqual(fetcher.calls[0].body.skills,skills);
 assert.equal(Object.hasOwn(fetcher.calls[0].body,'customSkills'),false);
 assert.equal(JSON.stringify(fetcher.calls[0].body).includes('body'),false);
});

test('web chat passes engine errors without leaking details and validates input',async()=>{
 const fetcher=mockFetch(Response.json({error:'This Dua AI engine is private.',detail:'secret'},{status:401}));
 const response=await run(req(),fetcher);
 assert.equal(response.status,401);assert.deepEqual(await response.json(),{error:'This Dua AI engine is private.'});
 const bad=new Request(origin+'/api/web/chat',{method:'POST',headers:{origin,cookie:'dua_access=fake-access'},body:'{"messages":"x"}'});
 assert.equal((await run(bad,mockFetch())).status,400);
 assert.equal((await run(req(),mockFetch(),{DUA_ENGINE_URL:'http://insecure.test'})).status,503);
 assert.ok(DEFAULT_ENGINE_URL.startsWith('https://'));
});

const SUPA='https://project.supabase.co';
const quotaEnv={DUA_REQUIRE_LOGIN:'1',DUA_DAILY_REQUEST_LIMIT:'5',SUPABASE_URL:SUPA,SUPABASE_ANON_KEY:'public-key',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_fake'};
const user=()=>Response.json({id:'11111111-1111-4111-8111-111111111111',email:'owner@example.com'});
const rawReq=(text,headers={})=>new Request(origin+'/api/web/chat',{method:'POST',headers:{'content-type':'application/json',origin,'sec-fetch-site':'same-origin',cookie:'dua_access=fake-access',...headers},body:text});

test('web chat shares the /api/chat daily quota and returns 429 when it is used up',async()=>{
 const resetAt=Math.floor(Date.now()/1000)+3600;
 const fetcher=mockFetch(user(),Response.json({allowed:false,used:5,resetAt}));
 const response=await run(req(),fetcher,quotaEnv);
 assert.equal(response.status,429);
 const json=await response.json();
 assert.match(json.error,/Daily request limit reached/);
 assert.ok(Number(response.headers.get('retry-after'))>0);
 assert.equal(fetcher.calls.length,2);
 assert.ok(fetcher.calls[1].url.endsWith('/rest/v1/rpc/dua_consume_daily_request'));
 assert.ok(!fetcher.calls.some(c=>c.url.startsWith('https://engine.test')));
});

test('web chat counts an allowed request then proxies with remaining header',async()=>{
 const fetcher=mockFetch(user(),Response.json({allowed:true,used:1,resetAt:Math.floor(Date.now()/1000)+3600}),sseResponse([sse({type:'done'},'done')]));
 const response=await run(req(),fetcher,quotaEnv);
 assert.equal(response.status,200);
 assert.equal(response.headers.get('x-dua-requests-remaining'),'4');
 await response.text();
 assert.equal(fetcher.calls[2].url,'https://engine.test/api/chat');
});

test('web chat rejects multibyte oversize bodies and oversize content-length early',async()=>{
 const fetcher=mockFetch();
 // ~1.5M chars of a 3-byte character: under 4 MiB by .length, over by UTF-8 bytes.
 const big=JSON.stringify({messages:[{role:'user',text:'\u0939'.repeat(1_500_000)}]});
 assert.ok(big.length<4*1024*1024&&Buffer.byteLength(big,'utf8')>4*1024*1024);
 assert.equal((await run(rawReq(big),fetcher)).status,413);
 assert.equal((await run(rawReq('{}',{'content-length':String(5*1024*1024)}),fetcher)).status,413);
 assert.equal(fetcher.calls.length,0);
});

test('web chat caps message count and validates each turn before quota or engine',async()=>{
 const fetcher=mockFetch();
 const many={messages:Array.from({length:201},()=>({role:'user',text:'x'}))};
 assert.equal((await run(rawReq(JSON.stringify(many)),fetcher,quotaEnv)).status,413);
 for(const messages of [[null],['hi'],[{text:'no role'}],[{role:'user'}],[{role:1,text:'x'}],[{role:'user',content:5}]])
  assert.equal((await run(rawReq(JSON.stringify({messages})),fetcher,quotaEnv)).status,400);
 assert.equal(fetcher.calls.length,0);
 const ok=mockFetch(sseResponse([sse({type:'done'},'done')]));
 const response=await run(rawReq(JSON.stringify({messages:Array.from({length:200},()=>({role:'user',content:'x'}))})),ok);
 assert.equal(response.status,200);await response.text();
});

test('web chat forwards a combined abort signal with the chat deadline to the engine',async()=>{
 const controller=new AbortController();
 let seen;
 const fetcher=mockFetch((url,init)=>{seen=init.signal;return sseResponse([sse({type:'done'},'done')]);});
 const request=new Request(origin+'/api/web/chat',{method:'POST',signal:controller.signal,headers:{'content-type':'application/json',origin,'sec-fetch-site':'same-origin',cookie:'dua_access=fake-access'},body:JSON.stringify(body)});
 const response=await run(request,fetcher);
 await response.text();
 assert.ok(seen instanceof AbortSignal);
 assert.equal(seen.aborted,false);
 controller.abort();
 assert.equal(seen.aborted,true);
});

test('web chat forwards the refreshed access token after the guard renews the session',async()=>{
 const refreshed=Response.json({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600,user:{id:'11111111-1111-4111-8111-111111111111',email:'owner@example.com'}});
 const fetcher=mockFetch(Response.json({error:'expired'},{status:401}),refreshed,Response.json({allowed:true,used:1,resetAt:Math.floor(Date.now()/1000)+3600}),sseResponse([sse({type:'done'},'done')]));
 const response=await run(req(),fetcher,quotaEnv);
 assert.equal(response.status,200);await response.text();
 assert.ok(response.headers.getSetCookie().some(c=>c.startsWith('dua_access=new-access')));
 const engine=fetcher.calls.find(c=>c.url==='https://engine.test/api/chat');
 assert.equal(engine.init.headers.Authorization,'Bearer new-access');
});

test('web chat keeps the original access token when the guard does not refresh',async()=>{
 const fetcher=mockFetch(user(),Response.json({allowed:true,used:1,resetAt:Math.floor(Date.now()/1000)+3600}),sseResponse([sse({type:'done'},'done')]));
 const response=await run(req(),fetcher,quotaEnv);
 assert.equal(response.status,200);await response.text();
 assert.equal(fetcher.calls[2].init.headers.Authorization,'Bearer fake-access');
});

test('web chat returns the maintenance 503 before the quota or engine',async()=>{
 const fetcher=mockFetch();
 const response=await run(req(),fetcher,{...quotaEnv,DUA_MAINTENANCE:'1'});
 assert.equal(response.status,503);
 assert.equal((await response.json()).maintenance,true);
 assert.equal(fetcher.calls.length,0);
});

test('web chat refuses paused Agent mode before the quota but still allows normal chat',async()=>{
 const fetcher=mockFetch();
 const response=await run(req(),fetcher,{...quotaEnv,DUA_DISABLE_AGENT:'1'});
 assert.equal(response.status,503);
 assert.deepEqual(await response.json(),{error:PAUSED.agent,paused:'agent'});
 assert.equal(fetcher.calls.length,0);
 const ok=mockFetch(sseResponse([sse({type:'done'},'done')]));
 const plain=rawReq(JSON.stringify({mode:'auto',messages:[{role:'user',text:'hi'}]}));
 const res=await run(plain,ok,{DUA_DISABLE_AGENT:'1'});
 assert.equal(res.status,200);await res.text();
});

test('web chat turns content strings and parts into text for the engine',async()=>{
 const fetcher=mockFetch(sseResponse([sse({type:'done'},'done')]));
 const messages=[{role:'user',text:'a'},{role:'assistant',content:'b'},{role:'user',content:[{type:'text',text:'c'},{type:'image',url:'x'},{type:'text',text:'d'}],attachments:[]}];
 const res=await run(rawReq(JSON.stringify({messages})),fetcher);
 assert.equal(res.status,200);await res.text();
 assert.deepEqual(fetcher.calls[0].body.messages,[{role:'user',text:'a'},{role:'assistant',text:'b'},{role:'user',attachments:[],text:'cd'}]);
});

test('engine client: one default origin, strict URL validation and shared headers', () => {
 assert.equal(DEFAULT_ENGINE_URL,SHARED_ENGINE_URL);
 assert.equal(engineEndpoint({},'/api/chat').href,SHARED_ENGINE_URL+'/api/chat');
 assert.equal(engineEndpoint({DUA_ENGINE_URL:'https://engine.test/'},'/api/orhan/plan').href,'https://engine.test/api/orhan/plan');
 for(const bad of ['http://engine.test','https://u:p@engine.test','https://engine.test/x','https://engine.test/?a=1','https://engine.test/#h','not a url'])
  assert.equal(engineEndpoint({DUA_ENGINE_URL:bad},'/api/chat'),null,bad);
 assert.equal(engineEndpoint({},'/api/chat',{allowDefault:false}),null);
 assert.equal(engineEndpoint({DUA_ENGINE_URL:'https://engine.test'},'/api/chat',{allowDefault:false}).href,'https://engine.test/api/chat');
 assert.deepEqual(engineHeaders({},'tok'),{'Content-Type':'application/json',Accept:'application/json',Authorization:'Bearer tok'});
 assert.deepEqual(engineHeaders({DUA_APP_TOKEN:'app'},'tok',{accept:'text/event-stream',native:true}),{'Content-Type':'application/json',Accept:'text/event-stream',Authorization:'Bearer tok','x-dua-native':'1','X-Dua-App-Token':'app'});
 assert.deepEqual(engineHeaders({},'tok',{accept:null}),{'Content-Type':'application/json',Authorization:'Bearer tok'});
});

test('website chat proxy sends the Android-native engine headers via the shared client', async () => {
 const fetcher=mockFetch(sseResponse([sse({type:'done'})]));
 await run(req(),fetcher,{DUA_APP_TOKEN:'fake-app-token'});
 const {init}=fetcher.calls[0];
 assert.equal(init.headers['x-dua-native'],'1');
 assert.equal(init.headers.Accept,'text/event-stream, application/json');
 assert.equal(init.headers['X-Dua-App-Token'],'fake-app-token');
});
