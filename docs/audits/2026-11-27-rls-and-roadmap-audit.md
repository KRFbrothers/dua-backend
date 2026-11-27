# Dua backend audit: roadmap ke claims vs asli code

Repo: `KRFbrothers/dua-backend` @ `43135d80e867dd7660aad84be9de8c7be79fc570` (main)
Roadmap: `teamily-backend-roadmap/index.html`, 997 lines
Clone: `/workspace/arch-audit/dua` (fresh, main, clean)
Date: 2026-11-27
Sab kuch is turn me chala. Purane run pe bharosa nahi kiya, har number dobara nikala.

---

## 0. Ek line ka jawab

Roadmap ka **dhancha supported hai**, par **teen headline numbers galat hain jo maine hi galat likhe the**. Aur mera pichla sabse bada claim ("koi delegation nahi hai") **over-stated tha**: engine me asli ADK `sub_agents` graph hai (planner se 4 specialist helpers, phir merger, phir optional reviewer/reviser). Wo delegation hai, par **engine ke andar** hai, database me nahi.

---

## 1. Numbers dobara verify (raw)

```
$ find apps/api -name "*.mjs" -not -path "*/node_modules/*" -exec cat {} + | wc -l
21196
$ find apps/ai-engine -name "*.py" -exec cat {} + | wc -l
19312
$ cat supabase/migrations/*.sql | wc -l
1859
sum = 42367

api_mjs_files   = 133
engine_py_files = 103
migrations      = 25
create_policy   = 61
alter table ... enable rls = 26  (26 unique tables)
```

### Per-table RLS map (python se parse kiya, grep se cross-check)

| Table | owner_id | policies |
|---|---|---|
| agent_notes | YES | 3 |
| dua_agent_instructions | YES | 4 |
| dua_agent_skills | YES | 4 |
| dua_agent_triggers | YES | 4 |
| dua_agents | YES | 4 |
| dua_artifact_versions | YES | 3 |
| dua_artifacts | YES | 4 |
| dua_cloud_snapshots | YES | 1 |
| dua_conversation_agents | YES | 3 |
| dua_conversations | YES | 4 |
| dua_daily_usage | YES | **0** |
| dua_device_tokens | YES | 4 |
| dua_imagine_usage | YES | **0** |
| dua_memories | YES | 4 |
| dua_messages | YES | 2 |
| dua_notifications | YES | 4 |
| dua_orhan_tasks | YES | 3 |
| dua_task_events | YES | 2 |
| dua_voice_sessions | YES | **0** |
| dua_voice_usage | YES | **0** |
| dua_workers | **no** | 0 |
| dua_workflow_automation | YES | 1 |
| dua_workflow_credentials | YES | **0** |
| dua_workflow_deliveries | **no** | 0 |
| dua_workflow_executions | YES | 1 |
| dua_workflow_runs | YES | 3 |

26 tables, 24 me `owner_id`, 61 policies, 26/26 pe `alter table ... enable row level security`.

**Ye ek cheez mere pichle assessment se behtar hai:** maine pichle run me likha tha ki RLS enable hai ya nahi wo verify nahi kiya. Ab verify kar liya, aur **26/26 pe enabled hai**. Yani mera "pehla check yahi hona chahiye" wala risk mitigation bekaar nahi tha, par risk khud maujood nahi nikla.

---

## 2. Roadmap ke bade claims: claim by claim

### 2.1 Architecture (control plane vs execution plane)

**Claim:** aaj sab kuch ek Node process me hai, `server.mjs` 86 lines, `/api/*` guard karke handlers pe bhejta hai. Single-owner ke liye theek, multi-tenant me do problem: ek tenant ka slow request event loop kha jata hai, aur chat vs sandbox ka scaling mismatch.

**Code:** `apps/api/src/server.mjs` rehta hai, 133 `.mjs` files `core/` me. Engine alag process hai (`apps/ai-engine/app.py`, Flask).

**Verdict: supported.** Split asli hai, diagnosis asli hai. `apps/api/src/core/health.mjs:4` khud kehta hai "a TCP check, which passes even when Supabase or the engine is unreachable", yani wo gap bhi real hai.

### 2.2 Data model / 22 tables

**Claim (roadmap line 755):** `grep -c "create table if not exists public" = 22`

**Code:** `22`. Exact match, roadmap ka formula sahi hai.

**Verdict: supported (formula ke hisaab se).** Par sirf 22 hi batana adhoora hai: `create table` ke **26** blocks hain, kyunki 4 tables `if not exists public` pattern se nahi likhe (`dua_workflow_automation`, `dua_workflow_deliveries`, `dua_workflow_credentials`, `dua_workflow_executions`). Schema ka asli aakar 26 hai.

### 2.3 Multi-tenancy: "single owner, workspace naya hai"

**Claim:** Dua single-owner hai, workspace/member/invite sab naya banana padega.

**Code:**

```
$ grep -rh 'workspace_id' supabase/migrations/*.sql | wc -l
0
$ grep -r 'workspace_id' apps/api/src | wc -l
0
$ grep -r 'workspace_id' apps/ai-engine | wc -l
0
$ grep -hiE "create table.*(member|invite|workspace|tenant|team)" supabase/migrations/*.sql | wc -l
0
```

**Verdict: fully supported.** Workspace, member, invite, role, tenant ka code me **ek bhi hit nahi** hai. Ye roadmap ka sabse kamzor, aur sabse imandaar, hissa hai. Har table `owner_id uuid ... default auth.uid()` pe hai.

### 2.4 Agent orchestration: "koi delegation nahi, sirf parallel same-prompt"

**Claim (roadmap line 246, 251):** "Aaj panel discussion hai, team delegation nahi. Max 3 agents, sab same prompt pe alag answers. providers.mjs:313 me `Promise.allSettled(agents.map(...))`. Pipeline Research, Checker, Writer hardcoded hai (coordinator.py:10-32). Koi handoff nahi."

**Code, part 1 (sahi):** `apps/api/src/core/providers.mjs:313` exactly `await Promise.allSettled(agents.map(async agent => {`, aur 412 pe bhi. `coordinator.py` me `AGENTS = { research, checker, writer }` fixed hai.

**Code, part 2 (roadmap ne miss kiya):** `apps/ai-engine/dua_engine/agent/agent_adk.py` me asli ADK graph hai:

```
:758-767   planner se subtasks (JSON), warna default ek research task
:773-800   har subtask ka apna LlmAgent, apna title, apne tools,
           apna output_key ("{kind}_result"), apna task prompt
:821       stages = [helper_stage(sub_agents=helpers), merger]
:822-866   optional reviewer + reviser stages
:866       root = adk.SequentialAgent(name="dua_root", sub_agents=stages)
:110-112   helpers_sequential() default "1", yani sequential
:134-135   enabled() = AGENT_ENGINE == "adk"
```

Yani: planner khud decide karta hai kitne subtasks, kaunse `kind` (`research|code|notes|actions`), kya task. Har helper ko **alag** task milta hai (`context(attach_task(...))`, line 786-800), same prompt nahi. Phir merger unke `output_key` padh ke ek answer banata hai (`merge_instruction`, line 806-817). Reviewer/reviser bhi ADK agents hain.

**Maine pichle runs me kaha tha: "delegation nahi hai, sirf parallel same-prompt calls."** Ye **galat tha**. Do cheezein alag hain:

* **Engine ke andar (ADK):** asli task decomposition aur per-specialist assignment. Ye delegation ke bahut kareeb hai, par static roles hain, agent-to-agent peer handoff nahi.
* **DB layer me:** koi `from_agent`/`to_agent` nahi hai. `grep -r "delegate\|subagent\|sub_agent" apps/api/src` ka sirf ek hit hai aur wo `dua_agent_prompts.json` me ek skill description hai, code nahi.

**Verdict: partially supported.** Roadmap ka core point ("peer delegation, agent-to-agent handoff nahi hai") sahi hai. Par "sab same prompt pe alag answers" wala hissa **galat** hai, kyunki ADK path me har helper ka apna task hai. Aur roadmap ye ADK graph, jo file me maujood hai, **kabhi mention nahi karta**. Ye roadmap ka sabse bada omission hai.

### 2.5 Connectors: "read-only"

**Claim (roadmap line 323):** `Access | read-only | advanced-integrations.mjs:15`

**Code:**

```
apps/api/src/core/advanced-integrations.mjs:9   "There are no write actions."
apps/api/src/core/github-write.mjs   EXISTS, 81 lines
  :5  "The allowlist below is the complete list of requests it can make. It has GET and POST only:"
  :6  "no PATCH (so no force-push or ref moves), no PUT (no merge) and no DELETE (no branch deletion)."
  :7  "New refs must be refs/heads/dua/*, and pull requests can only come from a dua/* branch."
  :22-26  POST git/blobs, git/trees, git/commits, git/refs, pulls
  :54  "Dua can only create new dua/* branches."
  :56  "Pull requests can only come from a dua/* branch."
```

**Verdict: partially supported.** `advanced-integrations.mjs` ka connector genuinely read-only hai, wo line 15 sahi hai. Par poora picture nahi: **Dua GitHub me write kar sakta hai** via `github-write.mjs`, ek alag route se (`/api/build/pr`, `build-pr.mjs`). Wo write tightly fenced hai (dua/* branch, no merge, no delete), par "connectors read-only hain" kehna incomplete hai. Mera pichla "github connector genuinely read-only" bhi incomplete tha.

### 2.6 Memory: "engine me pgvector hai, chat me keyword"

**Claim (roadmap line 404):** "Engine me pgvector hai (agent_documents.py:24,34), par chat memory retrieval keyword ilike karta hai (artifacts-memories.mjs:361)."

**Code:**

```
agent_documents.py:34   Column('embedding',Vector().with_variant(JSON,'sqlite'))
agent_documents.py:157  def search(self, query, kind='document', limit=5)
agent_documents.py:173  distance = indexed.c.embedding.cosine_distance(query_vector)
agent_documents.py:176  non-postgres branch: limit(6000) phir python cosine
artifacts-memories.mjs:361  title.ilike.<q>,summary.ilike.<q>
agent_notes.py:158-162  notes ke liye semantic search use hota hai, phir lexical
app.py:1077-1078        notes.semantic = agent_documents.Documents(...)
```

**Verdict: supported, aur maine pichle run me ise under-stated.** Main sahi tha ki `artifacts-memories.mjs` keyword search karta hai. Main galat tha jab maine implication diya ki semantic retrieval maujood hi nahi. **Notes ke liye semantic search wired hai** (`agent_notes.py` + `app.py`), sirf artifacts/memories ka retrieval path keyword pe hai. Roadmap ka "sabse bada contradiction" framing theek hai, par wo apne hi engine ke notes path ko count nahi karta.

Aur ek design limit jo file khud maanti hai (`agent_documents.py:5-6`): "Exact cosine search is intentionally bounded for this personal app; large-corpus approximate indexing is not implied." Yani Python side me 6000 rows tak brute force, uske baad nahi. Ye scale limit asli hai.

### 2.7 Realtime / streaming

**Claim:** streaming hai, realtime channel hai.

**Code:**

```
apps/api/src/core/sse.mjs  125 lines, poora SSE wire format documented
  events: thinking, text, sources, context, notice, files, code, build, proposal
providers.mjs  data.stream === true -> eventStreamResponse(...)
realtime-push migration ka zikr: notifications.mjs:44 "Apply the realtime-push migration"
android: 71 .kt files, streaming repository code maujood
```

**Verdict: supported.** SSE asli hai aur seriously designed hai (per-event types, delta, cap 20,000 chars per code output, 10 runs per reply). Supabase Realtime ka zikr bhi hai par maine usko runtime pe verify nahi kiya (neeche section 4).

### 2.8 Billing, quota, usage

**Claim:** "Aaj sirf counter hai, per-call cost nahi" (roadmap line 242).

**Code:**

```
202610040002_dua_usage.sql:1..   dua_daily_usage table + dua_consume_daily_request RPC
  :18  pg_advisory_xact_lock(hashtextextended(account_id||day_utc, 7))   <- race-safe
  :22  30 din se purane rows delete
202611160001_owner_scoped_quota_rpcs.sql   owner-scoped quota RPCs
access-policy.mjs:32  "Optional owner policy and durable request count; this is not a token or billing cap."
```

Plus 4 billing/stripe hits, sab non-code (ek error message, ek search header, ek policy comment).

**Verdict: supported.** Quota asli hai, durable hai, advisory lock se race-safe hai. Billing/Stripe ka **koi code nahi** hai, sirf comments me "billing" shabd. Yani "counter hai, per-call cost nahi" bilkul sahi hai. Aur mera pichla "advisory lock asli hai" claim sahi tha, ab 17 jagah confirm hua (7 files me `pg_advisory_xact_lock`).

### 2.9 Task lifecycle

**Claim:** "production-grade hai".

**Code:** `202611270001_*.sql:67` me states: `heartbeat, retry, cancelled, completed, failed, timed_out, reaped`. `:114-153` me `dua_workers` heartbeat function, `draining`, capacity.

**Verdict: fully supported.** Ye roadmap ka sabse strong claim hai aur code usse back karta hai.

### 2.10 Reuse list aur 22 hafte ka estimate

**Claim:** 131 rows, "55% file level reuse", 22 hafte.

**Verdict: assumption, aur roadmap khud aisa bolta hai.** Line 814: "55% reuse estimate | File level judgement, line level nahi". Line 22 hafte ka koi code evidence nahi. Ye estimate hai, measurement nahi. Roadmap ne khud mark kiya, jo imandaari hai.

---

## 3. "Maine assumption se kaha"

Ye section kaam ka sabse important hissa hai. Ye wo cheezein hain jo maine fact ki tarah pesh ki, par thi nahi.

| # | Maine kya kaha | Asli sach | Kitna galat |
|---|---|---|---|
| 1 | "`30,140 total lines`" (pichle run) | 42,367 | 12,227 lines ka farq. Maine baad me fix kiya, par pehle deliver hua |
| 2 | "27 migration files" | 25 | 2 zyada |
| 3 | "18 tables me owner_id" | **24** (26 me se) | 6 kam, aur "18" roadmap ka number tha jo `create table if not exists public` (22) se aaya tha, `owner_id` se nahi |
| 4 | "4 RLS policies per table" | 0 se 4, 61 total | Blanket claim. 7 tables pe 0 policies hain |
| 5 | "Delegation nahi hai, sirf parallel same-prompt calls" | ADK me planner + per-subtask agents + merger + reviewer hai | **Sabse bada over-statement.** Roadmap ke "same prompt" wale hisse ko maine endorse kiya bina `agent_adk.py` padhe |
| 6 | "github connector genuinely read-only" | `advanced-integrations.mjs` read-only, par `github-write.mjs` PR create kar sakta hai | Incomplete. Write path ko maine miss kiya |
| 7 | "Memory retrieval keyword hai, semantic nahi" | Artifacts/memories keyword, par notes semantic hai | Adha sach. Maine implication diya ki semantic nahi hai |
| 8 | "RLS enable hai ya nahi verify nahi kiya" (pichla) | Ab verify: 26/26 enabled | Ye maine assumption mark kiya tha, jo sahi practice thi. Ab confirmed |
| 9 | "`108 test files` sahi hai" | `git ls-files \| grep -cE "test.*\.(mjs\|py)$"` = 108 | Ye sahi tha, par mera apna `find` 101 deta hai. Farq pattern ka hai: 60 .mjs + 41 python test files, aur 7 files aise hain jo `test*.(mjs\|py)` pattern me aate hain par mere `*.test.mjs` / `test_*.py` me nahi. Dono numbers theek hain, definition alag |
| 10 | "`22 tables`" | 22 (`if not exists public` pattern), 26 (saare `create table`) | Roadmap ke formula ke hisaab se sahi. Schema ka aakar 26. Maine 22 quote kiya bina 26 batane |
| 11 | "50 routes" | 50 (`'/api/...'` literals) | Sahi |
| 12 | "`verify-rls.mjs` 87 lines" | **86** (`wc -l` = 86) | 1 line ka farq |
| 13 | "CI me `verify:rls` wired nahi" | `checks.yml` me 0 hits, sirf `apps/api/package.json:12` me script hai | Sahi. Ab confirm |
| 14 | "10 tables pe 4 policies" | 9 tables pe 4 | 1 ka farq, mera count galat tha |

### Sabse zyada nuksaan dene wali galti

Point 5. Maine do runs tak kaha ki "Dua me delegation nahi hai". Wo code ke saath match nahi karta. `agent_adk.py` me planner, 4 specialist LlmAgents, merger, reviewer, reviser sab maujood hain aur ADK ke `sub_agents` se wired hain. Maine `coordinator.py` aur `providers.mjs` padh ke poora verdict de diya, `agent_adk.py` (900+ lines) nahi padha. Ye ek structural error tha: maine do files se poore orchestration layer ka faisla kiya.

Agar aapne us verdict pe Phase 3 (delegation layer) ka scope decide kiya hota, to aap double kaam kar rahe hote.

---

## 4. "Verify nahi ho paya"

| Kya | Kyun nahi hua |
|---|---|
| ADK path production me chalu hai ya nahi | `agent_adk.enabled()` sirf `AGENT_ENGINE=adk` env pe true hota hai. Mujhe production env nahi mila. Yani code maujood hai, par **live traffic us path se ja raha hai ya nahi, ye main nahi keh sakta** |
| `helpers_sequential()` default "1" production me override hai ya nahi | Same wajah, env nahi mila |
| Supabase Realtime publications actually configured | Repo me migration files hain, live project nahi |
| RLS policies ka runtime behaviour | Static SQL padha, koi live DB query nahi |
| `dua_consume_daily_request` live limits | RPC padha, `DUA_DAILY_LIMIT` ka asli value nahi mila |
| Roadmap ke base commits `97da61f`, `c455a68` | Shallow clone. `fatal: Not a valid object name` |
| 22 hafte ka estimate | Code se derive nahi hota |
| Android app ka SSE consumption runtime | Build nahi chala (no Android SDK) |
| `github-write.mjs` ka asli use | Route `build-pr.mjs` hai, par Build mode production me on hai ya nahi, env pe depend karta hai |
| Kaunse tables pe production me rows hain | DB access nahi |

---

## 5. Roadmap ke apne numbers ka final scorecard

| Roadmap ka claim | Code | Verdict |
|---|---|---|
| `server.mjs` 86 lines | alag process, 133 core files | **supported** |
| 22 tables | 22 (pattern) / 26 (saare) | **supported, incomplete** |
| 50 routes | 50 | **supported** |
| 108 test files | 108 | **supported** |
| 71 kt files / 43,581 lines | 71 / 43,581 | **supported** |
| `owner_id` "18 me se kam se kam 18" | 24 of 26 | **under-stated, galat** |
| "4 RLS policies per table" | 0 se 4, 61 total | **galat** |
| 27 migration files ¹ | 25 | **galat** |
| 30,140 total lines ¹ | 42,367 | **galat** |
| providers.mjs:313 allSettled | line 313 | **supported** |
| coordinator.py:10-32 fixed 3 agents | line 10-32 | **supported** |
| "koi handoff nahi" | ADK me planner/helpers/merger/reviewer hai | **partially, aur maine endorse kiya** |
| advanced-integrations:15 read-only | line 15, par github-write.mjs bhi hai | **partially** |
| artifacts-memories:361 ilike | line 361 | **supported** |
| pgvector agent_documents:24,34 | line 34 | **supported** |
| task states 202611270001:67 | line 67 | **supported** |
| advisory lock | 17 jagah, 7 files | **supported** |
| 55% reuse | file-level judgement, roadmap khud kehta hai | **assumption (labelled)** |
| 22 hafte | koi evidence nahi | **assumption (labelled)** |

¹ ye do numbers (27 migrations, 30,140 lines) maine roadmap me introduce kiye the correction PR ke pehle, aur wo galat the. Roadmap ka original bhi galat tha. Ab dono fix ho chuke hain: 25 migrations, 42,367 lines.

---

## 6. Honest answer: "kya ye sach me Teamily AI jaisa backend hai?"

**Nahi, aur roadmap bhi ye nahi kehta.** Roadmap kehta hai "ban sakta hai", aur us dawa ke liye uski diagnosis zyadatar sahi hai:

**Jo Teamily me hai aur Dua me nahi (verified):**

| Capability | Dua me | Evidence |
|---|---|---|
| Workspace / multi-user | zero | `workspace_id` = 0 hits, member/invite table = 0 |
| Peer agent-to-agent delegation, DB me | zero | koi `from_agent`/`to_agent` nahi |
| Agent as first-class member with identity | nahi | `dua_agents` rows hain, par member/role concept nahi |
| Billing / subscription | zero code | sirf comments |
| Cross-tenant isolation tests | nahi | `verify-rls.mjs:34` khud "not a policy audit. Never submits a row" |

**Jo Teamily me hai aur Dua me bhi hai, aur ye roadmap ne sahi pakda:**

| Capability | Evidence |
|---|---|
| Task lifecycle (heartbeat, retry, reaped) | `202611270001:67` |
| Durable quota with advisory lock | 17 sites |
| Sandbox isolation | `coding_runner_server.py:149 --network=none --read-only` |
| SSE streaming with typed events | `sse.mjs`, 9 event types |
| RLS on every table | 26/26 enabled |
| Multi-model parallel answers | `providers.mjs:313,412` |
| Planner + specialist agents + merger | `agent_adk.py:758-866` |

**Sach ye hai:** Dua ek **mature single-owner AI workspace** hai jisme agent orchestration ka asli engine already hai (ADK), aur jisme multi-tenancy ka **ek bhi line** nahi hai. Roadmap ka 22 hafte ka estimate isi gap ke liye hai. Gap ka aakar sahi pakda gaya, par do bade hisse (ADK orchestration, GitHub write) roadmap me **miss** hain, aur teen numbers galat hain.

---

## 7. Roadmap me kya badalna chahiye

Priority order me:

1. **ADK orchestration section add karo.** `agent_adk.py` ka planner/helpers/merger/reviewer graph. Abhi roadmap kehta hai "koi handoff nahi", jo code se match nahi karta. Ye Phase 3 ka scope kam kar dega.
2. **`owner_id` ka number 24 karo**, 18 nahi.
3. **"4 RLS policies per table" hatao**, per-table breakdown do (ye fix ho chuka hai correction PR me).
4. **Migration count 25 karo.**
5. **Total lines 42,367 karo.**
6. **GitHub write path mention karo** (`github-write.mjs`), warna "read-only connectors" galat impression deta hai.
7. **Table count 26 likho** jab schema ki baat ho, 22 sirf tab jab `if not exists public` pattern ki baat ho.
8. **Notes ka semantic retrieval mention karo** memory section me, par scale limit bhi likho (6000 rows, exact cosine).

---

## 8. Evidence index

| File | Lines cited |
|---|---|
| `apps/api/src/core/providers.mjs` | 313, 412 |
| `apps/api/src/core/advanced-integrations.mjs` | 9, 15 |
| `apps/api/src/core/github-write.mjs` | 5, 6, 7, 22-26, 54, 56 |
| `apps/api/src/core/artifacts-memories.mjs` | 361 |
| `apps/api/src/core/sse.mjs` | 1-20 |
| `apps/api/src/core/access-policy.mjs` | 32 |
| `apps/api/src/core/health.mjs` | 4 |
| `apps/api/scripts/verify-rls.mjs` | 6, 34 |
| `apps/ai-engine/dua_engine/agent/agent_adk.py` | 110-112, 134-135, 758-767, 773-800, 821, 822-866 |
| `apps/ai-engine/dua_engine/agent/agent_documents.py` | 5, 6, 34, 157, 173, 176 |
| `apps/ai-engine/dua_engine/agent/agent_notes.py` | 113, 145-152, 158-162 |
| `apps/ai-engine/dua_engine/orhan/coordinator.py` | 10-32 |
| `apps/ai-engine/app.py` | 735, 756, 1077-1078 |
| `supabase/migrations/202610040002_dua_usage.sql` | 18, 22 |
| `supabase/migrations/202611270001_*.sql` | 67, 114-153 |
| `supabase/migrations/202611160001_owner_scoped_quota_rpcs.sql` | 43, 81 |
| `.github/workflows/checks.yml` | poora (verify:rls 0 hits) |
| `apps/api/package.json` | 12 |
