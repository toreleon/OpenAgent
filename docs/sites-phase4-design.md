All load-bearing symbols confirmed against the real repo: `quickjs-emscripten@0.31.0` exports `newQuickJSAsyncWASMModule`/`RELEASE_ASYNC`/`shouldInterruptAfterDeadline`/`Scope`; `siteStore.kvGet/kvPut/kvDelete/docAppend/docList/checkWriteRate/purgeSite/proposeEndpoint/armEndpoint/getEndpoint` exist; `invokeEndpoint`→`ProxyResult`, `resolveBackendSite`, `ENDPOINT_NAME_RE` (L96), route helpers `json`/`getIdentity`/`identityPublicId`/`ipBlock`/`validName`/`readJsonBody` + the `call` branch (L405), shim `call:` (L85), and `SiteEndpoint` all present; Next 14.2.35. Crucially, `armEndpoint` pins an **owner-supplied** `approvedHost` — confirming Critique-1 #4 that the drafted `armFunction` (hash-what's-stored) is strictly weaker and must take an owner-supplied hash.

Here is the final buildable design.

---

# Sites Phase 4 — Custom Compute Tier (QuickJS-WASM server functions) — FINAL

## TL;DR

- **Mechanism:** a Site may run model-authored `export default async function handler(request, ctx){ … return {status, body} }` server code, executed by `quickjs-emscripten@0.31.0` (`RELEASE_ASYNC`) inside a **kill-able `worker_thread`** using the **deferred-promise** async bridge (asyncify is a proven deadlock on the required sequential-`await` contract — kept as a non-option). The guest has **zero ambient authority**: every `Sites.*` call is a `postMessage` round-trip to main, where the already-hardened Phase 0-3 `siteStore`/`invokeEndpoint` run unchanged. `siteId` never leaves the main thread.
- **Gate (all required, default OFF at every layer):** (1) operator flag `SITES_FUNCTIONS_ENABLED` **or** a live DB kill-switch → `/api/fn/*` 404s; (2) backend master switch + link-visible + live deploy (`resolveBackendSite`); (3) per-function **arm-and-pin** where the owner approves the **exact source they reviewed** (`armedHash = sha256(owner-supplied code)`, TOCTOU-closed); (4) `armedHash === sha256(storedCode)` re-checked at run (any code change auto-disarms). A tripped **circuit breaker** or **disarm** disables one function live with no restart.
- **One-line execution model:** `POST /api/fn/<name>` → main gates+arms-checks → checks out a pooled worker → ships `{code, request, limits}` → worker runs a fresh QuickJS runtime whose only host bindings are deferred-promise proxies back to main's tenant-scoped capabilities → worker returns `{status, body}` → main stamps the hardened `json()` contract. Clean completions release the worker; any timeout/poison/crash **terminates + respawns** it (blast radius = one worker).

## Where I held my position (critiques I did not adopt as written)

1. **invocationId→{siteId} registry as cross-tenant defense (C1 #5b): rejected as load-bearing.** A pooled worker runs exactly one invocation at a time and `siteId` never leaves main, so `runCap`'s closure over `inv` already binds every cap to the running invocation (C2 #6b is right). I keep only a cheap `activeInvocationId` **staleness** check (drops a stray cap from a prior run on a reused worker) and fix the prose — not a tenant-authority mechanism.
2. **OS-sandboxed child process instead of worker_thread (C1 #5): deferred to v2.** A WASM escape needs a QuickJS 0-day (an accepted opt-in-tier residual); `worker_thread` + `env:{}` scrub + `resourceLimits` contains blast radius. Full seccomp/container is the graduation path *when the tier stops being opt-in* — disproportionate for a default-off tier.
3. **2-3s wall clock (C1 #6): set to 4s, not 3s.** `call`/egress is retained in v1, so a legitimate function may `await` one ~2.5s upstream. If egress were dropped, 3s would be right.
4. **Full existence-oracle removal (C1 #9): partially rejected.** An armed function is a *public endpoint by definition*; when it returns 200 its existence is inherent and unclosable. I strip **all** guest error detail and keep absent/disarmed/breaker/flag-off a **uniform 404** — that closes the only oracle worth closing.

Everything else in both critiques (2 blockers, all majors, all minors, all "missing") is folded into the design below.

---

## 1. Execution model

### Function signature (shown to the model)
```js
export default async function handler(request, ctx) {   // ctx === globalThis.Sites
  const n = (await Sites.kv.get("stats", "views")) ?? 0;
  await Sites.kv.put("stats", "views", n + 1);
  const [v, recent] = await Promise.all([Sites.kv.get("stats", "views"), Sites.docs.list("log", 10)]);
  return { status: 200, body: { views: v, recent, city: request.query.city ?? null } };
}
```
Real sequential `await`, `Promise.all`, and guest `throw` all work (empirically verified — deferred-promise, not asyncify).

### Request / Response (`src/lib/sites/fn/protocol.mjs` — plain ESM, one source of truth; see §5 contract note)
```ts
// protocol.d.ts (types) + protocol.mjs (runtime constants + shape asserts) — BOTH sides import the .mjs
export const MSG = { RUN: "run", CAP: "cap", CAP_RESULT: "capResult", DONE: "done" };
export interface FnRequest {
  method: "POST"; path: string; query: Record<string,string>;
  body: unknown;                            // parsed JSON input, ≤64 KiB
  visitorId: string;                        // identityPublicId(scope) — NON-secret, stable
  account: { username: string } | null;     // never the raw sa/sv cookie
}
export interface FnResponse { status?: number; body?: unknown; headers?: Record<string,string>; } // headers IGNORED v1
```

### `ctx` contract (guest surface — every method returns a real awaited value)

| Guest call | Scope | Backed by (main, unchanged) |
|---|---|---|
| `await Sites.kv.get/put/delete(c,k[,v])` | **shared** site | `siteStore.kv*(siteId,…,"shared")` |
| `await Sites.me.get/put/delete(c,k[,v])` | **this visitor/account** | `siteStore.kv*(siteId,…,scope)` — `scope` bound server-side |
| `await Sites.docs.append(c,obj)` / `list(c[,limit≤100])` | shared | `siteStore.docAppend/docList` |
| `await Sites.call(name, params)` → `{status, body}` | **only egress** | `invokeEndpoint(siteId,name,params)` — host-pinned, secrets injected server-side |
| `request.visitorId / account / query / body` | — | delivered on the request object (no round-trip) |

**`blob.*` is deferred to v2** (C2 #6a): it adds base64 marshaling for marginal value against v1's stated purpose (server-side aggregation/validation/computed responses). The design leaves a clean seam to add it.

The `ctx` boundary IS the security boundary; `siteId` and `scope` are held only in the main-thread invocation record and are **never named by the guest**.

---

## 2. The QuickJS runner (`src/lib/sites/fn/fn-worker.mjs`)

Plain ESM so Next's webpack never traces it (verified: no `serverComponentsExternalPackages` entry needed); imports **only** `quickjs-emscripten` and the shared `protocol.mjs`. Deferred-promise bridge; **per-invocation `Scope` + deferred ledger** (closes the dispose-abort blocker); **mutable per-segment CPU deadline** (fixes the wall-vs-CPU bug); **poison self-report → main recycle**.

```js
// fn-worker.mjs — runs INSIDE a worker_thread. Imports ONLY quickjs-emscripten + protocol.mjs.
import { parentPort } from "node:worker_threads";
import { newQuickJSAsyncWASMModule, RELEASE_ASYNC, Scope } from "quickjs-emscripten";
import { MSG, assertRunMsg, assertCapResultMsg } from "./protocol.mjs";

process.on("unhandledRejection", (e) => {           // this server has been crashed once by an unhandled rejection
  try { parentPort.postMessage({ t: MSG.DONE, invocationId: activeId, ok: false, code: 500, error: "fn_error", _terminate: true }); } catch {}
  process.exit(1);
});

let modP; const getModule = () => (modP ??= newQuickJSAsyncWASMModule(RELEASE_ASYNC)); // one module per worker
const pending = new Map(); let seq = 0, activeId = null;

function callHost(cap, args) {                        // worker-side: ALWAYS settles → drain loop can't hang
  const callId = ++seq;
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { pending.delete(callId); reject(new Error("host_timeout")); }, 3000);
    pending.set(callId, { resolve: v => { clearTimeout(to); resolve(v); }, reject: e => { clearTimeout(to); reject(e); } });
    parentPort.postMessage({ t: MSG.CAP, invocationId: activeId, callId, cap, args });
  });
}
parentPort.on("message", async (m) => {
  if (m.t === MSG.CAP_RESULT) { assertCapResultMsg(m); const p = pending.get(m.callId); if (!p) return; pending.delete(m.callId); return m.ok ? p.resolve(m.value) : p.reject(new Error(m.error)); }
  if (m.t !== MSG.RUN) return; assertRunMsg(m); activeId = m.invocationId;
  try { parentPort.postMessage({ t: MSG.DONE, invocationId: m.invocationId, ...(await runGuest(m)) }); }
  catch { parentPort.postMessage({ t: MSG.DONE, invocationId: m.invocationId, ok: false, code: 500, error: "fn_error" }); }
});

const CAP_ARG_MAX = 64 * 1024;                        // worker caps marshaled arg size BEFORE postMessage (C1 #8)
const CAPS = ["kv.get","kv.put","kv.delete","me.get","me.put","me.delete","docs.append","docs.list","call"];

async function runGuest({ invocationId, code, request, limits }) {
  const mod = await getModule();
  const rt = mod.newRuntime({ memoryLimitBytes: limits.memoryBytes, maxStackSizeBytes: limits.stackBytes });
  let cpuDeadline = Date.now() + limits.guestCpuMs;    // RESET per guest-CPU segment (C1 #7)
  const bumpCpu = () => { cpuDeadline = Date.now() + limits.guestCpuMs; };
  rt.setInterruptHandler(() => Date.now() > cpuDeadline);   // measures GUEST CPU, not time awaiting the bridge

  const scope = new Scope();                           // tracks EVERY sync handle → auto-disposed together
  const deferreds = new Set();                         // async-created promise handles the Scope can't see
  const wallDeadline = Date.now() + limits.wallClockMs;
  let poisoned = false, terminate = false;
  const ctx = scope.manage(rt.newContext());
  try {
    // ---- deferred-promise bridges ----
    const Sites = scope.manage(ctx.newObject());
    const ns = { kv: scope.manage(ctx.newObject()), me: scope.manage(ctx.newObject()), docs: scope.manage(ctx.newObject()) };
    for (const dotted of CAPS) {
      const [a, b] = dotted.split(".");
      const [parent, method] = b ? [ns[a], b] : [Sites, a];
      const f = scope.manage(ctx.newFunction(dotted, (...argH) => {
        const args = argH.map(h => ctx.dump(h));                       // marshal OUT as plain JSON values
        let payload;
        try { payload = JSON.stringify(args); } catch { payload = null; }
        const d = ctx.newPromise(); deferreds.add(d);                  // LEDGER: force-freed in finally
        if (payload == null || payload.length > CAP_ARG_MAX) {
          d.reject(ctx.newString("arg_too_large"));                    // reject in-guest, no postMessage
        } else {
          callHost(dotted, args).then(
            v => { const h = ctx.newString(JSON.stringify(v ?? null)); d.resolve(h); h.dispose(); },
            e => { const h = ctx.newString(String(e?.message ?? e));    d.reject(h);  h.dispose(); },
          );
        }
        d.settled.then(() => { bumpCpu(); rt.executePendingJobs(); });  // pump continuation on a FRESH CPU budget
        return d.handle;                                               // ownership → guest caller
      }));
      ctx.setProp(parent, method, f);
    }
    for (const [k, o] of Object.entries(ns)) ctx.setProp(Sites, k, o);
    ctx.setProp(ctx.global, "Sites", Sites);
    // thin unwrap: host returns JSON strings → guest sees real values
    ctx.unwrapResult(ctx.evalCode(
      `for (const g of [Sites,Sites.kv,Sites.me,Sites.docs]) for (const k of Object.keys(g)) { const raw=g[k];
         if (typeof raw==='function') g[k]=async(...a)=>JSON.parse(await raw(...a)); }`)).dispose();

    // ---- load guest as a MODULE, deny every other import ----
    rt.setModuleLoader((name) => { if (name === "guest") return code; throw new Error(`import "${name}" not allowed`); });
    ctx.unwrapResult(ctx.evalCode(`import h from "guest"; globalThis.__run=(r)=>h(JSON.parse(r));`, "boot.mjs", { type: "module" })).dispose();
    bumpCpu(); rt.executePendingJobs();

    // ---- invoke handler(request) ----
    let promiseHandle;
    { using runFn = ctx.getProp(ctx.global, "__run"); using reqH = ctx.newString(JSON.stringify(request));
      const call = ctx.callFunction(runFn, ctx.undefined, [reqH]);
      if (call.error) { const msg = ctx.dump(call.error); call.error.dispose(); return { ok:false, code:500, error:"fn_error", _log:`guest_threw:${msg?.message??msg}` }; }
      promiseHandle = call.value; }

    // ---- DRAIN LOOP (load-bearing) ----
    const settle = ctx.resolvePromise(promiseHandle); promiseHandle.dispose();
    let done; settle.then(r => (done = r), e => (done = { hostThrow: e }));
    while (!done) {
      bumpCpu(); rt.executePendingJobs();
      if (Date.now() > wallDeadline) { terminate = true; return { ok:false, code:504, error:"timeout", _terminate:true }; }
      await new Promise(r => setTimeout(r, 0));                        // let host round-trips + .settled run
    }
    if (done.hostThrow) return { ok:false, code:500, error:"fn_error" };
    if (done.error)   { const m = ctx.dump(done.error); done.error.dispose(); return { ok:false, code:500, error:"fn_error", _log:`fn_error:${m?.message??m}` }; }
    const value = ctx.dump(done.value); done.value.dispose();
    if (JSON.stringify(value?.body ?? null).length > limits.outputBytes) return { ok:false, code:500, error:"output_too_large" };
    return { ok:true, value };
  } catch (e) {
    return { ok:false, code:500, error: classify(e), _log:String(e?.message ?? e) };   // interrupt/OOM/stack land here — catchable
  } finally {
    // FORCE-FREE the ledger BEFORE rt.dispose(), then dispose Scope+runtime. Any throw ⇒ module poisoned ⇒ recycle.
    for (const d of deferreds) { try { d.dispose(); } catch {} }
    if (!terminate) {
      try { scope.dispose(); rt.dispose(); }
      catch { poisoned = true; }
    }
    if (poisoned) { try { parentPort.postMessage({ t: MSG.DONE, invocationId, ok:false, code:500, error:"fn_error", _terminate:true }); } catch {} process.exit(1); }
  }
}
function classify(e){ const s=String(e?.message||e); return /interrupt/i.test(s)?"cpu_timeout":/out of memory/i.test(s)?"out_of_memory":/stack/i.test(s)?"stack_overflow":"fn_error"; }
```

**Correctness anchors (all empirically confirmed by the reviews):**
- Guest is a **module** (`{type:"module"}`) — required for `export default`; loader serves only `"guest"`, throws for every other name (denies arbitrary imports).
- `resolvePromise` attaches its own `.then` job ⇒ the `while(!done)` **drain loop with `setTimeout(0)` yield** is mandatory (one `executePendingJobs()` is not enough).
- **Deferred ledger + Scope** guarantee no live handle reaches `rt.dispose()` on *any* path — including fire-and-forget calls, `Promise.race`, throw-after-dispatch, and interrupt-after-dispatch (Critique-1 **blocker #1**). If `rt.dispose()` still aborts (Emscripten `list_empty` — catchable, poisons the module), the worker **self-reports poison and exits** → main recycles; the poisoned worker is **never** returned to `pool.free` (Critique-2 **major #1**).
- Per-segment `bumpCpu()` makes the 500 ms budget measure **guest CPU**, not time spent awaiting the bridge (Critique-1 #7) — sequential real awaits no longer spuriously `cpu_timeout`.
- Clean interrupt/OOM/stack dispose cleanly and keep the worker (module reusable — verified). Only `_terminate`/poison respawns.

### Resource limits (concrete — passed in `limits`, enforced as shown)

| Guard | Value | Where | On breach |
|---|---|---|---|
| Guest CPU (per host-call segment, **reset each segment**) | **500 ms** | `setInterruptHandler` + `bumpCpu()` | catchable interrupt → `cpu_timeout`, clean, worker reused |
| Memory | **64 MiB** | `newRuntime({memoryLimitBytes})` | catchable OOM, clean |
| Stack | **512 KiB** | `newRuntime({maxStackSizeBytes})` | catchable overflow, clean |
| Per-cap host timeout (main) | **2500 ms** | `withTimeout` in `runCap` | cap rejects in-guest |
| Worker callHost safety | **3000 ms** (> main, main authoritative) | `callHost` | binding always settles |
| Wall-clock self-check → `_terminate` | **4000 ms** | worker drain loop | `504`, worker recycled |
| Main hard `terminate()` backstop | **4500 ms** | pool `backstop` | force-kill for native wedge |
| Output body | **128 KiB** | worker | `output_too_large` |
| Input body | **64 KiB** | route `readJsonBody` | `413` |
| Marshaled cap-arg (worker, pre-postMessage) | **64 KiB** | worker `CAP_ARG_MAX` | `arg_too_large` (no postMessage) |
| Stored value / op | **32 KiB** | `runCap` `sized()` | `value_too_large` |
| Store ops / invocation | **50** | `runCap` `bumpStore` | `op_budget` |
| Egress (`call`) / invocation | **2** | `runCap` `bumpEgress` | `egress_budget` |
| Code size / function | **64 KiB** | `applyBackendManifest` | not stored |
| Functions / site | **20** | `applyBackendManifest` | excess dropped |
| Rate limit | **20 / 60 s** per (site,/24) | `checkWriteRate("fn:"+siteId)` | `429` |
| Global admission | **60 / 60 s** process-wide token bucket | pool | `503` |
| Per-site compute budget | **300 invocations / hour / site** | `checkWriteRate("fnbudget:"+siteId, {windowSec:3600,max:300})` | `429` |
| Concurrency | **4** workers, **per-site ≤ 2**, queue 8, 2 s wait | pool | `503 busy` |
| Circuit breaker | open after **3** timeouts/poisons / 60 s per (site,name), 60 s cooldown | pool breaker map | uniform `404` |

Wall-clock 4000 ms bounds a core-pegging catastrophic-regex call to ≤4 s (Critique-1 #6 — the JS interrupt cannot see native `libregexp` backtracking; the 64 KiB input cap + `worker.terminate()` are the real bounds). Per-site fairness (≤2 of 4) + the global bucket ensure one tenant cannot 503 the whole tier; `POOL_SIZE` (`SITES_FN_MAX_CONCURRENCY`, default 4) should be ≤ cores-1 on small boxes.

---

## 3. Data model + storage + router wiring + feature gate

### Prisma — `prisma/sites-data.prisma` (after `SiteEndpoint`, ~L121)
```prisma
/// Model-authored SERVER FUNCTION (Phase 4). MODEL proposes {name, code} UNARMED via create_site;
/// OWNER arms by approving the EXACT source they reviewed (arm carries the sha256 of the rendered code;
/// armFunction rejects if stored code changed since — closes the arm-TOCTOU). Un-runnable until
/// armedHash === sha256(storedCode). Any code change re-disarms (proposeFunction nulls armedHash).
model SiteFunction {
  id        String   @id @default(cuid())
  siteId    String
  name      String
  code      String   // JS source, ≤64 KiB, ≤20 rows/site (manifest-time)
  armedHash String?  // sha256 the OWNER approved; null = disarmed
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@unique([siteId, name])
  @@index([siteId])
}
/// Operator LIVE kill-switch (no restart) — single row, cached 5 s in pool.ts.
model SiteFnRuntime { id String @id @default("singleton"); globalDisabled Boolean @default(false); updatedAt DateTime @updatedAt }
```
Migration (**do not skip the restart** — the known globalThis-pinned-client gotcha, build step 1):
```
SITES_DATA_URL="file:./sites-data.db" npx prisma db push --schema=prisma/sites-data.prisma
npx prisma generate --schema=prisma/sites-data.prisma
# then RESTART `npm run dev` — a stale client has no `siteFunction`/`siteFnRuntime` delegate → runtime TypeError.
```

### `siteStore` — `src/lib/sites/data-db.ts` (endpoints region + `purgeSite`)
```ts
async proposeFunction(siteId, { name, code }) {                 // disarm-on-change (mirrors proposeEndpoint)
  const ex = await sitesDataDb.siteFunction.findUnique({ where:{siteId_name:{siteId,name}}, select:{code:true} });
  if (!ex) return void sitesDataDb.siteFunction.create({ data:{siteId,name,code} });
  if (ex.code !== code) await sitesDataDb.siteFunction.update({ where:{siteId_name:{siteId,name}}, data:{code, armedHash:null} });
},
async getFunction(siteId, name)  { return sitesDataDb.siteFunction.findUnique({ where:{siteId_name:{siteId,name}}, select:{code:true,armedHash:true} }); },
async listFunctions(siteId)      { return sitesDataDb.siteFunction.findMany({ where:{siteId}, orderBy:{name:"asc"}, select:{name:true,code:true,armedHash:true,updatedAt:true}, take:200 }); },
async countFunctions(siteId)     { return sitesDataDb.siteFunction.count({ where:{siteId} }); },
// OWNER arms — pin ONLY IF the stored code STILL hashes to what the owner reviewed (closes arm-TOCTOU, C1 #4)
async armFunction(siteId, name, expectedHash) {
  const row = await sitesDataDb.siteFunction.findUnique({ where:{siteId_name:{siteId,name}}, select:{code:true} });
  if (!row) return { ok:false, reason:"not_found" };
  const h = createHash("sha256").update(row.code).digest("hex");
  if (h !== expectedHash) return { ok:false, reason:"stale" };        // code changed since render → force re-review
  await sitesDataDb.siteFunction.updateMany({ where:{siteId,name}, data:{armedHash:h} });
  return { ok:true };
},
async disarmFunction(siteId, name) { await sitesDataDb.siteFunction.updateMany({ where:{siteId,name}, data:{armedHash:null} }); },
async deleteFunction(siteId, name) { await sitesDataDb.siteFunction.deleteMany({ where:{siteId,name} }); },
async functionsGloballyDisabled()  { const r = await sitesDataDb.siteFnRuntime.findUnique({ where:{id:"singleton"} }); return !!r?.globalDisabled; },
```
Add to the `purgeSite` transaction array: `sitesDataDb.siteFunction.deleteMany({ where:{ siteId } }),`.

**Draft-vs-live atomicity (unchanged from `SiteEndpoint`, flagged not assumed):** `code` tracks the latest applied *manifest*, not the snapshotted live version. The run-time `armedHash===sha256(storedCode)` check closes the *security* half (changed code ⇒ mismatch ⇒ disarmed). Full parity (re-apply the manifest on `deploy_site`/rollback) is a scoped follow-up.

### Feature gate — `src/lib/sites/fn/pool.ts`
```ts
export function functionsEnabled(): boolean { const v = process.env.SITES_FUNCTIONS_ENABLED; return v === "1" || v === "true"; }
let killCache = { at: 0, off: false };                              // live operator kill, cached 5 s
export async function functionsGloballyEnabled(): Promise<boolean> {
  if (!functionsEnabled()) return false;
  if (Date.now() - killCache.at > 5000) killCache = { at: Date.now(), off: await siteStore.functionsGloballyDisabled() };
  return !killCache.off;
}
```

### Router branch — `src/app/s/[slug]/api/[...path]/route.ts`, `POST`, after the `call` branch (L405-419)
```ts
if (path[0] === "fn" && path.length === 2) {
  if (!(await functionsGloballyEnabled())) return notFound();                       // 404, no oracle
  if (!validName(path[1])) return json({ error: "bad_name" }, 400);
  if (!(await siteStore.checkWriteRate(`fn:${r.siteId}`, ipBlock(req), { windowSec:60, max:20 })))    return json({ error:"rate_limited" }, 429);
  if (!(await siteStore.checkWriteRate(`fnbudget:${r.siteId}`, "", { windowSec:3600, max:300 })))     return json({ error:"rate_limited" }, 429);
  const parsed = await readJsonBody(req); if ("deny" in parsed) return parsed.deny;
  const rec = parsed.value as Record<string, unknown> | null;
  const id = await getIdentity(req, r.siteId);
  const request: FnRequest = {
    method: "POST", path: "/", query: Object.fromEntries(new URL(req.url).searchParams),
    body: rec && "input" in rec ? rec.input : rec,
    visitorId: identityPublicId(id.scope), account: id.account ? { username: id.account.username } : null,
  };
  const out = await runSiteFunction(r.siteId, path[1], { scope: id.scope, account: id.account ? { username: id.account.username } : null }, request);
  if (!out.ok) return json({ error: out.error }, out.code, id.setCookie);           // OPAQUE code only (no guest detail)
  const status = Math.min(599, Math.max(100, out.value.status ?? 200));
  return json(out.value.body ?? null, status, id.setCookie);                        // hardened headers ALWAYS win
}
```
Inherits `resolveBackendSite` (link-visible + live + backendEnabled), the hardened `json()` (CSP `sandbox; default-src 'none'`, nosniff, `application/json`, no CORS, no-store), and `id.setCookie` threading. Guest `headers` ignored; status clamped 100..599.

### Pool driver + capability host — `src/lib/sites/fn/pool.ts` (the rest)
```ts
const WORKER = path.join(process.cwd(), "src/lib/sites/fn/fn-worker.mjs");
const SCRUB_ENV = { NODE_ENV: process.env.NODE_ENV ?? "production" };               // NOTHING sensitive (C1 #5, C2-missing)
function spawn() {
  const w = new Worker(WORKER, { env: SCRUB_ENV, resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 } });
  pool.all.add(w);
  w.on("exit", () => onWorkerDeath(w));                                             // PERSISTENT (attached at spawn), C1#2/C2#2
  w.on("error", () => onWorkerDeath(w));
  return w;
}
function onWorkerDeath(w) {                                                          // evict from ALL pools + fail in-flight + refill
  pool.all.delete(w); const i = pool.free.indexOf(w); if (i >= 0) pool.free.splice(i, 1);
  w.__inflight?.({ ok:false, code:500, error:"worker_error" }, true); w.__inflight = null;
  pool.q.shift()?.(); if (pool.all.size < POOL_SIZE) release(spawn());
}
async function checkout(): Promise<Worker | null> {
  if (pool.free.length) return pool.free.pop()!;
  if (pool.all.size < POOL_SIZE) return spawn();
  if (pool.q.length >= QUEUE_MAX) return null;
  return new Promise((res) => {
    let settled = false;
    const to = setTimeout(() => { if (settled) return; settled = true; const i = pool.q.indexOf(give); if (i>=0) pool.q.splice(i,1); res(null); }, 2000);
    const give = () => { if (settled) return; settled = true; clearTimeout(to); res(pool.free.pop() ?? spawn()); };  // splice-on-timeout (C1 #3)
    pool.q.push(give);
  });
}
```
`runSiteFunction` (gate → per-site fairness + global bucket + breaker → checkout → run):
```ts
export async function runSiteFunction(siteId, name, who, request) {
  const fn = await siteStore.getFunction(siteId, name);
  if (!fn || !fn.armedHash || fn.armedHash !== createHash("sha256").update(fn.code).digest("hex")) return { ok:false, code:404, error:"not_found" };
  if (breakerOpen(siteId, name)) return { ok:false, code:404, error:"not_found" };                 // tripped ⇒ uniform 404
  if (!admitGlobal() || perSiteInFlight(siteId) >= 2) return { ok:false, code:503, error:"busy" };  // fairness + global bucket
  const w = await checkout(); if (!w) return { ok:false, code:503, error:"busy" };
  const invocationId = randomId(24); const inv = { id: invocationId, siteId, scope: who.scope, account: who.account, store: 0, egress: 0 };
  incInFlight(siteId); const started = Date.now();
  return await new Promise((resolve) => {
    let finished = false;
    const backstop = setTimeout(() => finish({ ok:false, code:504, error:"timeout" }, true), 4500);
    const onMessage = async (m) => {
      if (m.t === MSG.CAP) { if (m.invocationId !== inv.id) return;                                 // staleness guard (defense-in-depth)
        const res = await runCap(inv, m.cap, m.args); w.postMessage({ t: MSG.CAP_RESULT, callId: m.callId, ...res }); return; }
      if (m.t === MSG.DONE) { if (m._log) logFn(inv, name, fn.armedHash, "detail", m._log);          // detail SERVER-SIDE only (C1 #9)
        finish(m._terminate ? { ok:false, code:504, error:"timeout" } : m, !!m._terminate); }
    };
    function finish(out, kill) {
      if (finished) return; finished = true; clearTimeout(backstop); w.off("message", onMessage); w.__inflight = null; decInFlight(siteId);
      const outcome = out.ok ? "ok" : out.error;
      if (out.code === 504 || kill) recordFailure(siteId, name);                                     // breaker fuel
      logFn(inv, name, fn.armedHash, outcome, undefined, Date.now()-started, out.code);              // AUDIT (C1-missing)
      kill ? recycle(w) : release(w);
      resolve(out.ok ? { ok:true, value: out.value } : { ok:false, code: out.code ?? 500, error: out.error });
    }
    w.__inflight = finish;                                                                            // exit handler can fail THIS run
    w.on("message", onMessage);
    w.postMessage({ t: MSG.RUN, invocationId, code: fn.code, request, limits: LIMITS });
  });
}
```
`runCap` (the boundary — `siteId` from `inv`, **never** from the worker; blob dropped; opaque):
```ts
async function runCap(inv, cap, args) {
  const T = <T>(p:Promise<T>) => Promise.race([p, new Promise<never>((_,r)=>setTimeout(()=>r(new Error("cap_timeout")),2500))]);
  const bumpStore=()=>{ if(++inv.store>50) throw new Error("op_budget"); };
  const bumpEgress=()=>{ if(++inv.egress>2) throw new Error("egress_budget"); };
  const nm=(s)=> (typeof s==="string" && NAME_RE.test(s) ? s : null);
  const sized=(v)=>{ const s=JSON.stringify(v??null); if(s.length>32*1024) throw new Error("value_too_large"); return s; };  // extract exact fields, never spread guest objects
  const { siteId, scope } = inv;
  try { switch (cap) {
    case "kv.get":    { const c=nm(args[0]),k=nm(args[1]); if(!c||!k) throw new Error("bad_name"); bumpStore(); const raw=await T(siteStore.kvGet(siteId,c,k,"shared")); return {ok:true,value: raw==null?null:JSON.parse(raw)}; }
    case "kv.put":    { const c=nm(args[0]),k=nm(args[1]); if(!c||!k) throw new Error("bad_name"); bumpStore(); await T(siteStore.kvPut(siteId,c,k,sized(args[2]),"shared")); return {ok:true,value:true}; }
    case "kv.delete": { const c=nm(args[0]),k=nm(args[1]); if(!c||!k) throw new Error("bad_name"); bumpStore(); return {ok:true,value:await T(siteStore.kvDelete(siteId,c,k,"shared"))}; }
    case "me.get":    { const c=nm(args[0]),k=nm(args[1]); if(!c||!k) throw new Error("bad_name"); bumpStore(); const raw=await T(siteStore.kvGet(siteId,c,k,scope));  return {ok:true,value: raw==null?null:JSON.parse(raw)}; }
    case "me.put":    { const c=nm(args[0]),k=nm(args[1]); if(!c||!k) throw new Error("bad_name"); bumpStore(); await T(siteStore.kvPut(siteId,c,k,sized(args[2]),scope));  return {ok:true,value:true}; }
    case "me.delete": { const c=nm(args[0]),k=nm(args[1]); if(!c||!k) throw new Error("bad_name"); bumpStore(); return {ok:true,value:await T(siteStore.kvDelete(siteId,c,k,scope))}; }
    case "docs.append": { const c=nm(args[0]); if(!c) throw new Error("bad_name"); bumpStore(); return {ok:true,value:await T(siteStore.docAppend(siteId,c,sized(args[1])))}; }
    case "docs.list":   { const c=nm(args[0]); if(!c) throw new Error("bad_name"); bumpStore(); const lim=Math.min(100,Math.max(1,Number(args[1])||100));
                          const rows=await T(siteStore.docList(siteId,c,lim)); return {ok:true,value:rows.map(d=>({id:d.id,data:safeParse(d.data),createdAt:d.createdAt.toISOString()}))}; }
    case "call":        { const n=nm(args[0]); if(!n) throw new Error("bad_name"); bumpEgress();
                          const p=(args[1]&&typeof args[1]==="object")?args[1] as Record<string,unknown>:{};
                          const res=await T(invokeEndpoint(siteId,n,p)); return res.ok?{ok:true,value:{status:res.status,body:res.body}}:{ok:false,error:res.error}; }
    default: return { ok:false, error:"unknown_cap" };
  } } catch (e) { return { ok:false, error: e instanceof SiteQuotaExceededError ? "quota_exceeded" : (e instanceof Error ? e.message : "cap_error") }; }
}
```

---

## 4. Model-facing surface + owner UI

### Tool schema — `src/lib/tools/sites.ts` (inside `backend`, ~L96; `.nullable().optional()`, never `.url()` — strict rule)
```ts
functions: z.array(z.object({
  name: z.string().describe("Short name; the page calls Sites.fn('<name>', input)."),
  code: z.string().describe("JS: `export default async function handler(request, ctx){ … return {status,body} }`. May await Sites.kv/me/docs/call. NO network/fs/process/require/import — only the Sites bridge."),
})).nullable().optional()
  .describe("ADVANCED opt-in server compute. Runs sandboxed JS server-side, reachable via Sites.fn(name,input). Created DISARMED; runs ONLY after the operator enables the tier AND the owner approves the EXACT code in the dashboard. Use only when kv/docs/endpoints can't express server-side aggregation/validation/computed responses. Max 20 per site, 64 KiB each."),
```

### Prompt — `src/lib/agent.ts` (bullet after L110)
> `Sites.fn(name, input)` runs an OPT-IN server function (sandboxed JS: `export default async function handler(request, ctx){ … return {status, body} }`) that can `await Sites.kv/me/docs/call`. No fs/network/process — only the Sites bridge. Declare it in `backend.functions`. It is created DISARMED and runs only after the operator enables the tier AND the owner approves the exact code in the dashboard — tell the user this. Reach for it only when kv/docs/endpoints can't express server-side aggregation/validation/computed logic.

### Shim — `src/lib/sites/shim.ts` (alongside `call:` at L85)
```js
fn: function (name, input) { return req("POST", "/api/fn/" + enc(name), { input: input || {} }); }, // resolves to the handler's returned body
```

### Manifest application — `src/lib/sites.ts` `applyBackendManifest` (~L104-130)
```ts
const fns = b["functions"];
const wants = b["kv"]===true || (Array.isArray(cols)&&cols.length>0) || (Array.isArray(eps)&&eps.length>0) || (Array.isArray(fns)&&fns.length>0);
// … after the endpoints loop:
if (Array.isArray(fns)) {
  const existing = await siteStore.countFunctions(siteId); let added = 0;
  for (const raw of fns) {
    if (existing + added >= 20) break;                                // cap functions/site (C1 #10)
    const f = asRecord(raw); const name = typeof f?.["name"]==="string" ? f["name"] : null; const code = typeof f?.["code"]==="string" ? f["code"] : null;
    if (name && code && ENDPOINT_NAME_RE.test(name) && code.length <= 64*1024) { await siteStore.proposeFunction(siteId, { name, code }); added++; }  // stored DISARMED (inert)
  }
}
```
Storage is **not** gated on the env flag (the owner must see proposed functions to arm them); execution is gated by the 4 layers.

### Owner API — `src/app/api/sites/[id]/functions/route.ts` (NEW; copy `endpoints/route.ts` `requireOwner`)
- `GET` → `{ functions: [{ name, code, hash: sha256(code), armed: !!armedHash, upToDate: armedHash===sha256(code), updatedAt }], flagEnabled: functionsEnabled(), globalKill }`
- `POST { name, expectedHash }` → `siteStore.armFunction(id, name, expectedHash)`; on `{reason:"stale"}` return 409 "code changed — re-review". **The arm carries the hash of the exact code the panel rendered** (closes the arm-TOCTOU, C1 #4 — mirrors `armEndpoint` pinning an owner-supplied value).
- `POST { name, action:"disarm" }` → `disarmFunction` (**this is the per-function live kill — instant uniform 404, no restart**).
- `DELETE ?name=` → `deleteFunction`.

### Owner UI — `src/components/sites/SiteBackendPanel.tsx` (Functions section after Endpoints, ~L214)
Add `functions` to `loadDetails`'s `Promise.all` (~L60). Each row: name, an expandable **read-only `<code>` block of the exact source** (the human review surface), an armed/disarmed badge, an **Arm** button (disabled unless `flagEnabled`; POSTs `{name, expectedHash: hash}` from the rendered GET payload), a **Disarm** button, and Trash delete. When `!upToDate` show "code changed — re-arm to run". When `!flagEnabled` show a banner: "Server functions are disabled by the operator (`SITES_FUNCTIONS_ENABLED`)." When `globalKill` show "Functions are disabled live by the operator."

### The 4-layer human/operator gate (all required)
1. **Operator flag** `SITES_FUNCTIONS_ENABLED` **or** live DB kill (`SiteFnRuntime.globalDisabled`, cached 5 s) → `/api/fn/*` 404s.
2. **Backend master switch + link-visible + live deploy** (`resolveBackendSite`).
3. **Per-function arm** — owner approves the exact source; `armedHash = sha256(owner-supplied code)`, TOCTOU-closed.
4. **Hash still matches at run** — any change auto-disarms; disarmed/absent/breaker/flag-off are a **uniform 404**.

---

## 5. Security hardening checklist (acceptance criteria — every item is a build requirement)

**Isolation / process safety**
- [ ] Execute in a `worker_thread`; main never runs QuickJS (main can never hit the `list_empty` abort).
- [ ] Spawn with **`env: SCRUB_ENV`** (nothing sensitive — no DB URLs, `NEXTAUTH_SECRET`, or Sites encryption key) and **`resourceLimits`** bounding worker V8 heap.
- [ ] **Per-invocation `Scope` + deferred ledger**; in `finally`, force-dispose the ledger and guest/resolve handles **before** `rt.dispose()`. No handle reaches dispose on *any* path (fire-and-forget, `Promise.race`, throw-after-dispatch, interrupt-after-dispatch).
- [ ] **Never release a poisoned worker.** A caught `rt.dispose()` abort ⇒ worker `postMessage(_terminate)` + `process.exit(1)`; main `recycle()`s (terminate+respawn). Clean interrupt/OOM/stack keep the worker.
- [ ] **Persistent `exit`/`error` handlers at spawn** (not per-invocation): evict from `all`/`free`/`q`, fail the bound in-flight invocation (`w.__inflight`), refill to `POOL_SIZE`. No dead worker is ever handed out.
- [ ] **Queue resolver splice-on-timeout** with a `settled` guard — no leaked/double-handed worker; no permanent-503 drain.
- [ ] One `QuickJSAsyncWASMModule` per worker; one **fresh** runtime+context per invocation (no state/secret carryover across visitors).
- [ ] Global concurrency cap + **per-site fairness (≤2 of 4)** + bounded queue → `503`; no unbounded spawn.

**Resource abuse**
- [ ] `setInterruptHandler` with a **per-segment-reset** deadline (guest CPU, not wall) — 500 ms.
- [ ] `memoryLimitBytes` (64 MiB) + `maxStackSizeBytes` (512 KiB).
- [ ] Every host binding self-times-out (worker `callHost` 3 s + main `withTimeout` 2.5 s) so the drain loop can never wait on an unsettleable promise.
- [ ] Outer **`worker.terminate()`** wall-clock backstop (4.5 s main / 4 s worker self-check) — the only bound on native-op CPU burn / ReDoS the interrupt cannot see.
- [ ] **Cap guest INPUT** (64 KiB body) — the defense against small-input catastrophic-regex on `libregexp`.
- [ ] Drain loop checks the wall deadline **between** `executePendingJobs()` calls; a microtask flood cannot spin the host forever.
- [ ] **Worker caps marshaled cap-arg size (64 KiB) before `postMessage`**; `runCap` re-caps stored values (32 KiB) — no 64-MiB-heap arg crosses the channel.
- [ ] Per-invocation **store-op (50)** and **egress (2)** caps; per-site **compute budget (300/hr)**; **global admission bucket (60/60 s)**.
- [ ] **Output size cap** (128 KiB).
- [ ] **Circuit breaker**: 3 timeouts/poisons/60 s per (site,name) ⇒ uniform 404 for a 60 s cooldown.

**Bridge = boundary**
- [ ] `siteId`/`scope` captured from `resolveBackendSite`+`getIdentity`, held only in the main-thread `inv`; **the guest never names a tenant**. A `activeInvocationId` staleness check drops stray caps (defense-in-depth, not the tenant-authority mechanism).
- [ ] Re-validate **every** guest arg with the route's exact validators (`NAME_RE`, 32 KiB value cap); the guest is no more trusted than an anonymous `curl`.
- [ ] Route only through tenant-scoped `siteStore` and owner-armed `invokeEndpoint`. **Never** bridge `sitesDataDb`, raw `fetch`, `getDecryptedSecret`, `listSecretNames`, or `getEndpoint`. `call` is the ONLY egress; secrets injected inside `invokeEndpoint`, never entering WASM.
- [ ] Same rate/quota/budget consumed on the bridged path (`checkWriteRate` fn + fnbudget buckets; `kvPut`/`docAppend` `assertQuota`; `invokeEndpoint` budget + host-pin + no-redirect `safeFetch`).

**Marshaling**
- [ ] Both directions **JSON strings** (`JSON.stringify` in guest / `ctx.dump` args out) — no prototype chain crosses, no live handle escapes, no getter-driven host recursion.
- [ ] In `runCap`, never spread/`Object.assign` a guest-derived object into a Prisma/options bag — extract exact fields (`__proto__`/`constructor` safety).
- [ ] Guest never receives a `QuickJSHandle`.

**Engine hygiene**
- [ ] `DefaultIntrinsics` only — **no `os`/`std`**. `setModuleLoader` serves only `"guest"`, throws for every other name.
- [ ] Guest is a module (`{type:"module"}`); no bridge invokes a guest callback that re-enters a bridge (kept flat; deferred pattern sidesteps asyncify reentrancy).

**Crash-safety**
- [ ] Every `evalCode`/`callFunction`/`resolvePromise`/drain wrapped so a guest throw or rejected promise becomes a normalized result, **never** an unhandled rejection. A `process.on("unhandledRejection")` guard in the worker `_terminate`s + exits.

**Provenance / human gate**
- [ ] Model code treated as fully hostile: 4-layer gate (§4), **arm-and-pin with owner-supplied hash** (TOCTOU-closed), auto-disarm on change, default OFF, disarm = per-function live kill, DB global live kill.

**Response safety & audit**
- [ ] Public responses return **opaque error codes only** (`fn_error`/`timeout`/`busy`); guest exception detail is logged **server-side only**. Absent/disarmed/breaker/flag-off = uniform 404. `json()` hardened contract always stamped; guest `headers` ignored; status clamped 100..599.
- [ ] **Structured per-invocation audit log**: `{ siteId, name, armedHash, visitorScope, durationMs, outcome, storeOps, egressOps, httpStatus }`.

**Honest residual risks (to the reviewer):**
1. **ReDoS / long native builtins** on attacker-controlled input in one invocation: bounded only by the 64 KiB input cap + memory limit + the **4 s** `terminate()`. A worker can burn one core up to 4 s.
2. **A QuickJS/WASM 0-day** escaping into worker JS: contained by `env:{}` scrub + `resourceLimits` + no DB/net/app imports in the worker + `siteId`-never-leaves-main. Not zero. Accepted for an opt-in tier; OS-sandbox is the v2 graduation path.
3. **Draft-vs-live code atomicity** (§3): the hash-pin closes the security half; full parity (re-apply manifest on deploy) is a scoped follow-up.

---

## 6. Live-verification plan

Prereqs: `SITES_DOMAIN=localtest.me:3000`, `SITES_FUNCTIONS_ENABLED=1`, a deployed link-visible backend-enabled site, one function `bump` armed via the panel. **Green bar:** `npx tsc --noEmit` + `npm run lint` clean; Phase A 9/9, Phase B 6/6, Phase C interactive.

**Phase A — runner harness (Node-native TS, BEFORE any HTTP).** Seat: seed a **real armed `SiteFunction` row** against a test `sites-data.db` and call `runSiteFunction` (real worker — the point is to test the runner); **also export `runCap`** for a separate arg-validation unit test (test seam, C2 #5).
1. **Async contract:** `const n=(await Sites.kv.get('s','v'))??0; await Sites.kv.put('s','v',n+1); const [a,b]=await Promise.all([Sites.kv.get('s','v'),Sites.docs.list('c')]); return {status:200,body:{n:n+1,a,len:b.length}}` → incrementing `n` (proves sequential awaits + `Promise.all` → deferred, not asyncify deadlock).
2. **Escapes → `"undefined"`:** `return {body:{p:typeof process,f:typeof fetch,r:typeof require,d:typeof Deno,i:typeof importScripts}}`.
3. **Sync CPU:** `while(true){}` → `cpu_timeout`; **run #2 succeeds** (module not poisoned, worker reused).
4. **Wall-clock (fixed, C2 #4):** guest awaits a host call the stub **deliberately stalls past 4 s** (does NOT consume the op budget) → `504 timeout`; worker **recycled**; a following invocation succeeds on the respawned worker.
5. **Op budget:** `for(let i=0;i<100;i++) await Sites.kv.put('s',''+i,i)` → `op_budget` after 50 (separate from #4).
6. **Memory:** `const a=[]; while(true) a.push('x'.repeat(1e5))` → `out_of_memory`, clean, reused.
7. **Stack:** `(function r(){return r()})()` → `stack_overflow`, clean, reused.
8. **Fire-and-forget dispose safety (blocker #1 regression test):** `Sites.kv.get('a','b'); return {body:1}` (missing `await`) and a variant that throws after dispatch → normal result, **and the next invocation on the pool still succeeds** (no abort, no `MODULE ERR: null`).
9. **Poison→recycle (C2 #1 regression test):** force a deliberate undisposed-handle leak in a test build → assert the worker self-reports poison, main recycles, and the next invocation succeeds.

**Phase B — HTTP E2E (curl, real site origin):**
10. `POST /api/fn/bump` → incrementing computed body; value appears in the owner **Data** panel (same `siteStore`).
11. **Egress:** armed `call` returns upstream body; un-armed endpoint → `endpoint_not_available`; 3rd `call` → `egress_budget`.
12. **Gate:** flag unset → `404` despite stored+deployed; flip `SiteFnRuntime.globalDisabled` → live `404` (no restart); Disarm in panel → `404` same request; unpublish → `404`.
13. **Arm-pin + TOCTOU:** re-`create_site` with changed `bump` code (owner not re-arming) → `404`; owner opens panel, code changed → Arm shows re-review; arming with the **rendered hash** succeeds; a concurrent re-propose between render and arm → arm returns **409 stale** (TOCTOU closed).
14. **Opaque errors:** a guest `throw new Error('secret')` returns `{error:"fn_error"}` with **no** `secret` in the body; detail present only in server logs.
15. **Header contract:** response is `application/json` + `content-security-policy: sandbox` + no `access-control-allow-origin`; a guest `return {headers:{'content-type':'text/html'}}` does NOT change the response type.

**Phase C — full browser (Playwright MCP):** ask the model to build a site with a server function (server-validated poll rejecting duplicate votes per `request.visitorId`); confirm `create_site` carries `backend.functions`, the panel shows it **disarmed**, arming makes the live `Sites.fn(...)` work, reload persists. Screenshot light+dark.

---

## 7. Build order (file-by-file, each independently testable)

1. **Prisma:** add `SiteFunction` + `SiteFnRuntime` to `prisma/sites-data.prisma` → `db push` + `generate --schema=prisma/sites-data.prisma` → **RESTART dev** → add `proposeFunction/getFunction/listFunctions/countFunctions/armFunction(expectedHash)/disarmFunction/deleteFunction/functionsGloballyDisabled` + the `purgeSite` line to `src/lib/sites/data-db.ts`.
2. **Runner core (only novel/risky code):** `src/lib/sites/fn/protocol.mjs` (+ `protocol.d.ts`) with `MSG` constants + runtime shape asserts (shared contract, C2 #3); `src/lib/sites/fn/fn-worker.mjs` (deferred-promise + Scope+ledger + per-segment CPU + poison self-report + unhandledRejection); `src/lib/sites/fn/pool.ts` (persistent exit/error handlers, queue splice-guard, env-scrub+resourceLimits, per-site fairness, global bucket, breaker, audit log, `runCap`, `functionsEnabled`/`functionsGloballyEnabled`). **Run Phase A here, before any HTTP.**
3. **Router:** add the gated `fn` branch to `src/app/s/[slug]/api/[...path]/route.ts` (after the `call` branch, ~L419). Verify with Phase B #10.
4. **Model surface:** `applyBackendManifest` storage + 20-cap in `src/lib/sites.ts`; `functions` zod in `src/lib/tools/sites.ts`; the `agent.ts` bullet; `Sites.fn` in `src/lib/sites/shim.ts` (confirm `call:` at L85 first).
5. **Owner surface:** `src/app/api/sites/[id]/functions/route.ts` (GET/arm-with-hash/disarm/DELETE, copy `endpoints/route.ts`); Functions section + arm/disarm UI in `src/components/sites/SiteBackendPanel.tsx` (~L214).
6. **Config:** `SITES_FUNCTIONS_ENABLED` (default unset) + `SITES_FN_MAX_CONCURRENCY` in `.env.example`. If the project ever adopts `output:'standalone'`, add `src/lib/sites/fn/fn-worker.mjs` **and** the `quickjs-emscripten` `.wasm`/`@jitl` variant files to output-file-tracing (not needed for plain `next dev`/`next start` from the project root — verified).
7. **Verify:** Phase B + Phase C; `tsc`+`lint` green.

---

## Bottom-line build order

1. **Prisma** `SiteFunction` + `SiteFnRuntime` → `db push`/`generate` → **restart** → `siteStore` methods (`armFunction` takes `expectedHash`) + `purgeSite`. →
2. **`protocol.mjs` + `fn-worker.mjs` + `pool.ts`** (deferred-promise + Scope+ledger + per-segment CPU + poison-self-report + persistent exit handlers + queue splice-guard + env-scrub/resourceLimits + per-site fairness + global bucket + breaker + audit + opaque `runCap`) — **gate the whole thing behind Phase A (9/9) before any HTTP**; this is the only novel code. →
3. **`fn` router branch** behind `functionsGloballyEnabled()`. →
4. **Manifest storage (20-cap) + tool schema + agent bullet + `Sites.fn` shim.** →
5. **Owner `/functions` route (arm-with-rendered-hash) + `SiteBackendPanel` Functions/arm/disarm UI.** →
6. **`.env.example`** + standalone tracing note. →
7. **Phase B (6/6) + Phase C browser** live verification; `tsc`+`lint` green.

The two decisions that make this safe *and* correct remain: **(1) deferred-promise, not asyncify** (the asyncify sketch deadlocks the required sequential-await contract), and **(2) worker-thread with message-proxied capabilities** (`terminate()` is the only clean kill for a wedged or poisoned execution, and `siteId`-never-leaves-main makes closure-captured capabilities sufficient without a tenant registry). Every Phase 0-3 boundary is reused unchanged behind a 4-layer, default-off human/operator gate.