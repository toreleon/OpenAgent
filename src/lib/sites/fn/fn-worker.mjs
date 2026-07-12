/**
 * Phase 4 sandbox executor — runs INSIDE a worker_thread. Loaded at RUNTIME by
 * pool.ts via `new Worker(<abs path>)`, so Next/webpack never bundles it; it
 * imports ONLY quickjs-emscripten (resolved from node_modules at runtime).
 *
 * The guest (untrusted, model-authored JS) runs in a fresh QuickJS-WASM runtime
 * with zero ambient authority. Its only capabilities are `Sites.*` bridges, each
 * of which is a DEFERRED PROMISE that round-trips to the main thread (postMessage)
 * where the already-hardened, tenant-scoped siteStore / invokeEndpoint run. We use
 * the deferred-promise pattern (NOT asyncify, which deadlocks sequential await)
 * plus a manual drain loop.
 *
 * Safety invariants (see docs/sites-phase4-design.md §5):
 *  - Per-invocation Scope + a deferred ledger: NO live handle reaches rt.dispose()
 *    on any path. A dispose abort ⇒ the module is poisoned ⇒ self-report + exit,
 *    so main recycles the worker (a poisoned worker is never reused).
 *  - Per-segment CPU deadline (bumpCpu) measures GUEST cpu, not time awaiting the
 *    bridge. Wall-clock self-check terminates a wedged run.
 *  - Every host binding self-settles (callHost timeout) so the drain loop can't
 *    wait forever.
 */
import { parentPort } from "node:worker_threads";
import { newQuickJSAsyncWASMModule, RELEASE_ASYNC, Scope } from "quickjs-emscripten";

// Keep in sync with pool.ts MSG.
const MSG = { RUN: "run", CAP: "cap", CAP_RESULT: "capResult", DONE: "done" };
const CAP_ARG_MAX = 64 * 1024;
const CAPS = [
  "kv.get", "kv.put", "kv.delete",
  "me.get", "me.put", "me.delete",
  "docs.append", "docs.list", "call",
];

let activeId = null;
process.on("unhandledRejection", () => {
  try {
    parentPort.postMessage({ t: MSG.DONE, invocationId: activeId, ok: false, code: 500, error: "fn_error", _terminate: true });
  } catch {}
  process.exit(1);
});

let modP;
const getModule = () => (modP ??= newQuickJSAsyncWASMModule(RELEASE_ASYNC));

// Outstanding host round-trips, keyed by callId.
const pending = new Map();
let seq = 0;

/** Worker → main capability call; ALWAYS settles (own timeout) so the drain loop can't hang. */
function callHost(cap, args) {
  const callId = ++seq;
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { pending.delete(callId); reject(new Error("host_timeout")); }, 3000);
    pending.set(callId, {
      resolve: (v) => { clearTimeout(to); resolve(v); },
      reject: (e) => { clearTimeout(to); reject(e); },
    });
    parentPort.postMessage({ t: MSG.CAP, invocationId: activeId, callId, cap, args });
  });
}

parentPort.on("message", async (m) => {
  if (m.t === MSG.CAP_RESULT) {
    const p = pending.get(m.callId);
    if (!p) return;
    pending.delete(m.callId);
    return m.ok ? p.resolve(m.value) : p.reject(new Error(m.error));
  }
  if (m.t !== MSG.RUN) return;
  activeId = m.invocationId;
  try {
    parentPort.postMessage({ t: MSG.DONE, invocationId: m.invocationId, ...(await runGuest(m)) });
  } catch {
    parentPort.postMessage({ t: MSG.DONE, invocationId: m.invocationId, ok: false, code: 500, error: "fn_error" });
  }
});

// Map an engine/limit error to a SAFE, non-sensitive code; anything unrecognized
// (e.g. a guest-thrown error that may contain secrets) collapses to "fn_error".
const SAFE_CODES = ["op_budget", "egress_budget", "value_too_large", "quota_exceeded", "arg_too_large", "cap_timeout", "host_timeout", "output_too_large"];
function classify(e) {
  const s = String((e && e.message) || e);
  if (/interrupt/i.test(s)) return "cpu_timeout";
  if (/out of memory|allocation failed/i.test(s)) return "out_of_memory";
  if (/stack/i.test(s)) return "stack_overflow";
  for (const k of SAFE_CODES) if (s.includes(k)) return k;
  return "fn_error";
}

async function runGuest({ invocationId, code, request, limits }) {
  const mod = await getModule();
  const rt = mod.newRuntime();
  rt.setMemoryLimit(limits.memoryBytes);
  rt.setMaxStackSize(limits.stackBytes);

  let cpuDeadline = Date.now() + limits.guestCpuMs;
  const bumpCpu = () => { cpuDeadline = Date.now() + limits.guestCpuMs; };
  rt.setInterruptHandler(() => Date.now() > cpuDeadline);

  const scope = new Scope();
  const deferreds = new Set();
  const wallDeadline = Date.now() + limits.wallClockMs;
  let poisoned = false;
  let terminate = false;
  const ctx = scope.manage(rt.newContext());

  try {
    // ---- deferred-promise capability bridges ----
    const Sites = scope.manage(ctx.newObject());
    const ns = {
      kv: scope.manage(ctx.newObject()),
      me: scope.manage(ctx.newObject()),
      docs: scope.manage(ctx.newObject()),
    };
    for (const dotted of CAPS) {
      const [a, b] = dotted.split(".");
      const parent = b ? ns[a] : Sites;
      const method = b ? b : a;
      const f = scope.manage(ctx.newFunction(dotted, (...argH) => {
        const args = argH.map((h) => ctx.dump(h));
        let payload;
        try { payload = JSON.stringify(args); } catch { payload = null; }
        const d = ctx.newPromise();
        deferreds.add(d);
        if (payload == null || payload.length > CAP_ARG_MAX) {
          const h = ctx.newString("arg_too_large"); d.reject(h); h.dispose();
        } else {
          callHost(dotted, args).then(
            (v) => { const h = ctx.newString(JSON.stringify(v ?? null)); d.resolve(h); h.dispose(); },
            (e) => { const h = ctx.newString(String((e && e.message) || e)); d.reject(h); h.dispose(); },
          );
        }
        d.settled.then(() => { bumpCpu(); rt.executePendingJobs(); });
        return d.handle;
      }));
      ctx.setProp(parent, method, f);
    }
    for (const [k, o] of Object.entries(ns)) ctx.setProp(Sites, k, o);
    ctx.setProp(ctx.global, "Sites", Sites);

    // Thin unwrap: host bridges resolve JSON strings → guest sees real values.
    ctx.unwrapResult(ctx.evalCode(
      "for (const g of [Sites, Sites.kv, Sites.me, Sites.docs]) " +
      "for (const k of Object.keys(g)) { const raw = g[k]; " +
      "if (typeof raw === 'function') g[k] = async (...a) => JSON.parse(await raw(...a)); }",
    )).dispose();

    // ---- load the guest as a MODULE; deny every other import ----
    rt.setModuleLoader((name) => {
      if (name === "guest") return code;
      throw new Error(`import "${name}" not allowed`);
    });
    ctx.unwrapResult(ctx.evalCode(
      "import h from 'guest'; globalThis.__run = (r) => h(JSON.parse(r));",
      "boot.mjs",
      { type: "module" },
    )).dispose();
    bumpCpu();
    rt.executePendingJobs();

    // ---- invoke handler(request) ----
    let promiseHandle;
    {
      const runFn = ctx.getProp(ctx.global, "__run");
      const reqH = ctx.newString(JSON.stringify(request));
      const call = ctx.callFunction(runFn, ctx.undefined, [reqH]);
      runFn.dispose();
      reqH.dispose();
      if (call.error) {
        const msg = ctx.dump(call.error); call.error.dispose();
        return { ok: false, code: 500, error: "fn_error", _log: `guest_threw:${(msg && msg.message) || msg}` };
      }
      promiseHandle = call.value;
    }

    // ---- drain loop (load-bearing): pump jobs + host round-trips until settled ----
    const settle = ctx.resolvePromise(promiseHandle);
    promiseHandle.dispose();
    let done;
    settle.then((r) => (done = r), (e) => (done = { hostThrow: e }));
    while (!done) {
      bumpCpu();
      rt.executePendingJobs();
      if (Date.now() > wallDeadline) { terminate = true; return { ok: false, code: 504, error: "timeout", _terminate: true }; }
      await new Promise((r) => setTimeout(r, 0));
    }
    if (done.hostThrow) return { ok: false, code: 500, error: "fn_error" };
    if (done.error) {
      const m = ctx.dump(done.error); done.error.dispose();
      // Engine/limit rejections surface here (interrupt/OOM/stack/op_budget/…).
      // classify() keeps operational codes but collapses guest-thrown messages
      // (which may contain secrets) to opaque "fn_error".
      return { ok: false, code: 500, error: classify(m), _log: `fn_error:${(m && m.message) || m}` };
    }
    const value = ctx.dump(done.value); done.value.dispose();
    if (JSON.stringify((value && value.body) ?? null).length > limits.outputBytes) {
      return { ok: false, code: 500, error: "output_too_large" };
    }
    return { ok: true, value };
  } catch (e) {
    return { ok: false, code: 500, error: classify(e), _log: String((e && e.message) || e) };
  } finally {
    for (const d of deferreds) { try { d.dispose(); } catch {} }
    if (!terminate) {
      try { scope.dispose(); rt.dispose(); }
      catch { poisoned = true; }
    }
    if (poisoned) {
      try { parentPort.postMessage({ t: MSG.DONE, invocationId, ok: false, code: 500, error: "fn_error", _terminate: true }); } catch {}
      process.exit(1);
    }
  }
}
