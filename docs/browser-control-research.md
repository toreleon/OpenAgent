# Built-in Browser Control — Design Doc

**Status:** Proposed · **Owner:** Lead engineer · **Runtime:** Next.js Node.js (long-lived process) · **Effort:** L (P0–P1), +M (P2–P3)

> ⚠️ **Read §11 first.** A verification pass against the actual codebase found the reuse story in §4/§7 is partly overstated — an idle process reaper, a human-in-the-loop approval channel, and the `playwright` build wiring are **net-new**, not clones. §11 has the ground-truth-verified must-fix list; §12 has the fact-checked external claims.

---

## 1. TL;DR / Recommendation

Build **in-app, per-conversation headless Playwright Chromium**, driven by the model through a small set of plain `@openai/agents` v0.0.5 function-tools that act on an **accessibility-tree snapshot by stable `ref`** (`browser_navigate` / `browser_snapshot` / `browser_click(ref)` / `browser_type(ref,text)` / `browser_read` / `browser_screenshot`). Grounding happens *in-app* off Playwright's aria snapshot — no provider computer-use tool, no vision model — so it runs identically on OpenAI / Azure / Claude endpoints. Live screenshots and a per-step tool trace stream into a new **Browser panel** by cloning the proven `run_subagents` "stream-from-inside-a-tool → SSE → store → panel" pipeline **verbatim** (full-snapshot upsert-by-stable-id), and rehydrate on reload from a new `Message.browser` JSON column.

**Why it won (judge aggregate 25.5, next 17.5):** it hits every reuse contract in the codebase natively — `RunContext.onEvent` (`src/lib/agent.ts:344-357`), the subagent panel template (`src/lib/subagents/runner.ts`), the `confine.ts` `globalThis` per-conversation cache, `safe-fetch.ts` SSRF guards, and the `Message.subagents` persistence trio — at **L** effort, and is the *only fully provider-portable* design. It is also the **safest by default** (fresh sandboxed context, no real user credentials at risk; security lens winner 8.5). We graft the runners-up in later phases: a **pixel/computer-use fallback** (Candidate B) behind a flag for canvas/WebGL, and the **Playwright-MCP server** (Candidate C) as an optional fast bootstrap for the tool schemas.

---

## 2. How the leaders do it

| System | Transport | Grounding | Reusable here? |
|---|---|---|---|
| **Claude Code + Playwright MCP** (`microsoft/playwright-mcp`) | stdio MCP server (`npx @playwright/mcp@latest`), also `--port` HTTP mode; launches its **own** Chromium/Firefox/WebKit | **a11y-tree first**: `browser_snapshot` returns a compact tree, each interactive element gets a stable `ref`; act by ref (`browser_click`/`browser_type`), *not* pixels. Screenshots secondary; pixel via `--caps=vision` | **Partially** — only the **HTTP** mode is registerable via `RemoteMCPServer` (`discover.ts` rejects stdio). Good bootstrap for the tool surface. |
| **Claude in Chrome** (`claude-in-chrome`) | Native-messaging host → the **user's real** Chrome/Edge tab with existing login state; `claude --chrome` | Hybrid: `read_page` (a11y tree w/ `ref_id`s), `get_page_text`, `find`→refs **plus** a pixel `computer()` (Computer-Use style click/type/scroll at x,y or by ref). Per-site permission model; pauses for login/CAPTCHA; asks before publish/purchase/PII | **No** — Anthropic first-party, requires direct Anthropic plan, drives the user's browser (this is Candidate D, which lost on isolation & extension-distribution tax). |
| **Anthropic computer-use** (Messages API beta) | Client-executed `tool_use`/`tool_result` loop; reference impl = Docker + Xvfb + Mutter + Firefox + xdotool + VNC/noVNC | **Pure pixel**: screenshot in → `left_click(x,y)`/`type`/`key`/`scroll` out → fresh base64 screenshot back. ~1–1.8k input tokens/screenshot step | **No shim** — needs `@anthropic-ai/sdk` (absent) + a parallel Messages-API branch. |
| **OpenAI Operator / CUA** | Responses API `computer_use_preview` tool, `computer-use-preview` model (newer builds gpt-5.4). You host the browser (Playwright) | **Pure pixel**: model returns `computer_call{action(s), call_id}`; you execute; reply `computer_call_output{computer_screenshot, image_url:data:…}` chained by `previous_response_id`. `pending_safety_checks` → echo `acknowledged_safety_checks`. No `goto`/DOM refs | **Partial** — `@openai/agents-core@0.0.5` ships `computerTool()` + `Computer` interface but **no safety-check flow** (`safety` absent from dist); risky-action HITL needs a raw `openai` Responses loop. This is our **P3 fallback**. |
| **OSS landscape** | Playwright / Puppeteer over CDP; **Stagehand** (TS-native, `act`/`extract`/`observe`/`agent`); browser-use / Skyvern (Python); hosted Browserbase / Steel / Browserless (CDP WS URL) | Playwright's own aria snapshot reproduces MCP's a11y layer in Node. `chromium.launch()` = native protocol (full fidelity) vs `connectOverCDP()` = lower fidelity. Per-conversation isolation = one `browser.newContext()` per `conversationId` | **Yes** — the baseline we adopt: `playwright` `chromium.launch()`, one `BrowserContext` per conversation, a11y-snapshot loop reproduced in-app. |

**Verified-fact anchors:** Playwright MCP is a11y-tree first by default ("Uses Playwright's accessibility tree, not pixel-based input"); Claude in Chrome drives the *real* logged-in tab and is not reusable here; `agents-core@0.0.5` has `computerTool` but zero safety-check support; SeeAct on Mind2Web = DOM refs **40.6%** vs Set-of-Marks pixel **~13%** step success (3× gap), grounding (not planning) is the bottleneck.

---

## 3. The two grounding paradigms — build DOM/a11y first

| | Pixel / vision (CUA, Operator, Anthropic computer-use) | DOM / accessibility-tree (Playwright MCP, WebArena) |
|---|---|---|
| **Observation** | Raw screenshot (~1–1.8k tokens/step) | Compact ref-tagged aria tree (~200–400 tokens) |
| **Action** | `click(x,y)`, `type`, `scroll` — absolute pixels | `click(ref)`, `type(ref,text)`, `select(ref,value)` |
| **Reliability (SeeAct/Mind2Web)** | ~13% step success (Set-of-Marks); ~4.7% attributes | **40.6%** step success |
| **Cost / latency** | 10–100× tokens; screenshot round-trip/step; coord drift under downscaling; Retina @2× scaling bugs | Instant text parse; deterministic; no vision model |
| **Coverage** | Canvas / WebGL / video / non-DOM UIs (the *only* thing it uniquely does) | Anything with decent ARIA/DOM; blind to canvas |
| **Provider portability** | Provider-locked (`computer-use-preview` access-gated; Azure may not expose it; Anthropic = separate SDK) | **Fully portable** — grounding never leaves the app |

**Decision: build the DOM/a11y-tree paradigm first.** It is the empirically more reliable, ~10–100× cheaper, deterministic, and provider-portable foundation. The evidence is decisive (3× reliability gap in the *same* system; grounding is the bottleneck). Pixel is added as a **P3 opt-in fallback** for the narrow canvas/WebGL minority — never the core loop. This mirrors the repo's existing snapshot-then-act posture (`web_search`/`web_fetch`).

---

## 4. Recommended architecture for THIS repo

### Data flow (prose diagram)

```
Lead model (streamChat, src/lib/agent.ts)
   │  emits tool_call: browser_navigate / browser_snapshot / browser_click(ref) / …
   ▼
browser tool.execute(args, ctx)                         [src/lib/tools/browser.ts]
   │  conversationId = ctx.context.conversationId        (never a model arg)
   │  onEvent        = ctx.context.onEvent               (onEventFromContext pattern)
   ▼
getBrowserSession(conversationId)                        [src/lib/browser/session.ts]
   │  globalThis-cached Browser + one BrowserContext per conversationId
   │  (LRU MAX_BROWSERS, trackPid/untrackPid, idle reaper — clone of confine.ts:46-127)
   │  egress forced through 127.0.0.1 CONNECT guard-proxy [src/lib/browser/guard-proxy.ts]
   │  every nav URL pre-validated: validateUrl/isBlockedIp [safe-fetch.ts:100-191]
   ▼
Playwright action → aria snapshot → ref-tagged tree      [src/lib/browser/snapshot.ts]
   │  each step: onEvent({ type:"browser_activity", activity: <FULL snapshot> })
   ▼
handleBrowserEvent (route)                               [src/app/api/chat/route.ts]
   │  upsert by activity.id into browserActivities[]  AND  send() over SSE (sse()/guarded enqueue)
   │  intercept browser tool in tool_call/tool_result switch → suppress generic tool card
   ▼
SSE  ──►  store reducer case "browser_activity"          [src/store/chat.ts]
   │        upsert event.activity by id into message.browser.steps
   ▼
<BrowserActivity/>  live panel                           [src/components/chat/BrowserActivity.tsx]
   │  screenshots + expandable per-step trace + live timers + collapse-to-pill
   │  (clone of SubagentActivity.tsx:286-479), mounted in MessageItem.tsx:250-252

On turn end:  finalizeBrowser → encodeBrowser → prisma.message.update({ browser })
On reload:    GET /api/conversations/[id] → decodeBrowser → message.browser  (identical shape)
```

**The load-bearing contract (from `streaming-panel`):** every emit is a **FULL upsert-by-stable-id snapshot, never a delta**, so the SSE-live path and the DB-rehydrate path converge on identical state with the same reducer. The browser tool needs **zero new plumbing in `agent.ts`** — `onEvent`/`model`/`effort`/`conversationId`/`userId` are already threaded into `RunContext` at `agent.ts:344-357`.

**Reuses, one-to-one:**
- **Streaming:** `run_subagents` pipeline (`onEventFromContext` → guarded `onActivity` → `send()`).
- **Isolation:** `confine.ts` `getWorkspace/WorkspaceState` globalThis cache → `getBrowserSession`.
- **Egress:** `safe-fetch.ts` `isBlockedIp`/`validateUrl` + `git.ts:156-260` loopback CONNECT guard-proxy.
- **File I/O:** `resolveInside(conversationId, relPath, {forWrite})` for screenshots/downloads.
- **Persistence:** `Message.subagents` column trio (`finalize`/`encode`/`decode`).
- **Capability tiering:** `subagentTools` exclusion pattern (`runner.ts:105-242`) → read-only browser subset.

---

## 5. Tool surface

New file **`src/lib/tools/browser.ts`** — plain `@openai/agents` function-tools added to `agentTools` in `agent.ts`. All `execute()` read `conversationId`/`onEvent` off `RunContext`, emit full `browser_activity` snapshots, **return `{ok, code, error, …}` and never throw**.

> **`@openai/agents` v0.0.5 strict-schema constraints:** use `.nullable()` (never `.optional()`) for non-required params, **no `.url()`/`.email()`/other refinements** on strings, no `.default()`. Model-facing params only — `conversationId` comes from context, never the schema.

| Tool | Params (zod-ish) | Returns | Notes |
|---|---|---|---|
| `browser_navigate` | `{ url: z.string() }` | `{ ok, url, title, snapshot }` | Pre-validated by `validateUrl`/`isBlockedIp` before handing to Chromium. Inline snapshot cuts a round-trip. **State-changing → gated in P2.** |
| `browser_snapshot` | `{}` | `{ ok, url, title, tree }` | Aria snapshot → compact `role + name + state + ref` tree. Refs valid **only** against latest snapshot. **Read-only → auto-allow.** |
| `browser_click` | `{ ref: z.string() }` | `{ ok, snapshot }` | Resolve `ref`→locator; re-snapshot after (staleness). **State-changing.** |
| `browser_type` | `{ ref: z.string(), text: z.string(), submit: z.boolean().nullable() }` | `{ ok, snapshot }` | `submit` presses Enter. **State-changing.** |
| `browser_select` | `{ ref: z.string(), value: z.string() }` | `{ ok, snapshot }` | Dropdowns. **State-changing.** |
| `browser_press` | `{ key: z.string() }` | `{ ok, snapshot }` | e.g. `Enter`, `Escape`, `PageDown`. |
| `browser_read` | `{ }` | `{ ok, text }` | Bulk page text (`get_page_text` equivalent). Wrapped `<web_content untrusted>`. **Read-only.** |
| `browser_screenshot` | `{ fullPage: z.boolean().nullable() }` | `{ ok, dataUrl }` | Secondary/diagnostic; streamed to panel, path via `resolveInside` if saved. **Read-only.** |
| `browser_back` | `{}` | `{ ok, snapshot }` | `page.goBack()`. |
| `browser_wait` | `{ ms: z.number().nullable(), text: z.string().nullable() }` | `{ ok, snapshot }` | Wait for timeout or text/selector to appear. |

**Read-only subset** exported for subagents/untrusted contexts (`subagentTools` pattern): `browser_navigate` (pre-validated), `browser_snapshot`, `browser_read`, `browser_screenshot`, `browser_wait`. Excludes `click`/`type`/`select`/`press`. **`browser_evaluate` is deliberately omitted** — a full page-eval is far stronger than `run_javascript`'s best-effort in-process eval and must not inherit its weak guarantees.

**Ref-tagged tree shape** (`snapshot.ts`):
```
button "Sign in" [ref=e12]
textbox "Email" [ref=e5] value=""
link "Forgot password?" [ref=e18]
```

---

## 6. StreamEvent + data model additions

**`src/lib/types.ts`** — add alongside `subagent_activity` (`types.ts:437-444`) and mirror `SubagentActivity`/`SubagentState`/`SubagentTraceStep` (`types.ts:190-246`):

```ts
// StreamEvent union variant (emitted from INSIDE browser tools via RunContext.onEvent — NOT the SDK loop)
| { type: "browser_activity"; activity: BrowserActivity }

export type BrowserStepStatus = "running" | "done" | "failed";

export interface BrowserTraceStep { label: string; icon: ToolIconKey; status: BrowserStepStatus; }

export interface BrowserActivity {          // FULL upsert-by-id snapshot
  id: string;                               // stable across lifecycle, e.g. "browser-<n>"
  status: BrowserStepStatus;
  url?: string; title?: string;
  action?: string;                          // "Clicking Sign in", "Typing email…"
  thumbnailDataUrl?: string;                // latest screenshot for the panel
  steps?: number;
  trace?: BrowserTraceStep[];               // deep-copied before emit (trace.map(s=>({...s})))
  startedAt?: number; endedAt?: number;
}

export interface BrowserState { steps: BrowserActivity[]; }

// on Message:
browser?: BrowserState;                     // mirrors Message.subagents (types.ts:122-127)
```

**Persistence:** new **`Message.browser` JSON column** via hand-SQL `ALTER` (exactly how `Message.subagents` was added — not a tracked prisma migration in this checkout):
```sql
ALTER TABLE "Message" ADD COLUMN "browser" TEXT;
```

**Chat-route interception point** (`src/app/api/chat/route.ts`):
- **`handleBrowserEvent`** — clone of `handleSubagentEvent` (`route.ts:552-565`): filter to `browser_activity`, upsert full snapshot by `activity.id` into an in-memory `browserActivities[]`, `send(event)`. Wire via `streamChat({ …, onEvent: composed })` (compose with `handleSubagentEvent`, or one dispatcher switching on `event.type`).
- **Tool interception** — in the `tool_call`/`tool_result` switch (`route.ts:895-928`, beside artifact/site/subagent): `if (isBrowserToolName(event.name)) { browserAttempted = true; break; }` to suppress the generic tool card so the rich panel renders.
- **Finalize + persist** on turn end (`route.ts:127-149, 988-1003`): `finalizeBrowser(browserActivities)` (running→failed, stamp `endedAt`, close trailing trace) → `encodeBrowser(...)` → `prisma.message.update({ data: { …, browser } })`.
- **Rehydrate** in `GET /api/conversations/[id]` (`route.ts:53-107`): `decodeBrowser` with array-nonempty guard → `message.browser`.

**Store** (`src/store/chat.ts`):
- `case "browser_activity"` — clone of the `subagent_activity` upsert (`chat.ts:910-927`): find streaming assistant message, upsert `event.activity` by id into `message.browser.steps`.
- `failRunningBrowser(id, set)` — clone of `failRunningSubagents` (`chat.ts:1159-1172`), called from stop/error paths (941/1090) so an abort never strands a spinner.

---

## 7. Security model

The chosen design is safest-by-default because it uses a **fresh, sandboxed, per-conversation `BrowserContext` with no real user sessions** — a successful prompt injection can at most abuse a throwaway browser (bounded blast radius). Layer the repo's existing defenses onto the one genuinely new surface: a server-side browser whose navigations bypass `safeFetch`.

1. **SSRF / local-network (the sharpest new gap).** Page navigations, in-page `fetch`, redirects, and subresources do **not** flow through `safeFetch`. Two layers:
   - **Pre-navigation:** `validateUrl` + `isBlockedIp` (`safe-fetch.ts:100-191`) on every target *before* handing it to Chromium (blocks `localhost`/`*.internal`/`169.254.169.254` IMDS/literal reserved IPs).
   - **Connect-time:** force Chromium through a **127.0.0.1 CONNECT guard-proxy** (`src/lib/browser/guard-proxy.ts`, cloning `git.ts:156-260` `startGuardProxy`) that re-runs `isBlockedIp` at CONNECT time on **top-level + redirects + subresources**, defeating DNS-rebind. Launch with `--proxy-server=127.0.0.1:<port>`.

2. **Prompt injection (untrusted DOM as data).** All snapshot / `browser_read` / console output is fenced as **`<web_content untrusted>`** (the `web_fetch` convention + `run-subagents` `wrapFindings`), so page-borne instructions reach the write/shell/deploy-capable lead agent as **data, not instructions**. Anthropic baseline = 23.6% attack success; `playwright-mcp` issue #1479 confirms the a11y snapshot itself is an injection surface.

3. **Read-vs-state-changing action split (human-in-the-loop).** Auto-allow `browser_snapshot`/`browser_read`/`browser_screenshot`/`browser_wait`; **gate** `browser_click`/`type`/`select`/`navigate` behind the app's existing approval UX (the `TELEGRAM_REQUIRE_APPROVAL` / tool-policy precedent). Always-prompt on high-risk (publish/purchase/PII), mirroring Operator's `pending_safety_checks` and Claude-in-Chrome's confirmation model. The tool's `await` releases only on Approve.

4. **Ephemeral profile / no real session.** Each conversation gets its own `browser.newContext()` (isolated cookies/storage), locked-down profile, **no host cookies, no extensions**. No real user login is ever exposed — this is the structural advantage over Candidates C (shared profile) and D (user's real Chrome).

5. **Filesystem confinement.** Screenshot output, downloads dir, HAR, upload source all routed through `resolveInside(conversationId, relPath, {forWrite})` (`confine.ts:170-257`) → jailed to `.workspaces/<id>/repo`.

6. **Least privilege.** `browser_evaluate`/page-eval **omitted** (or tightly gated behind confirmation). Subagent/untrusted contexts get the read-only subset only.

7. **Process sandboxing.** If a browser CLI is spawned rather than the in-process API, reuse `run-shell.ts:26-212`: detached process-group + `process.kill(-pid)` reaping + `scrubbedEnv()` allowlist (**extended** deliberately with `DISPLAY`/`XDG_*` for Chromium — never `process.env` passthrough, so `OPENAI_API_KEY`/`DATABASE_URL`/`AWS_*` never reach the browser). Bounded concurrent contexts, per-context memory cap, per-conversation kill/idle-reaper so a stuck page can't leak a Chromium process.

8. **Portability.** Because grounding is in-app (no provider computer-use, no vision model), the security posture is identical across OpenAI/Azure/Claude — no provider-gated safety flow to hand-wire.

**Residual:** this is a no-container local trust model — the guard-proxy + approval gate **are** the boundary (as `confine.ts` states for the sandbox), not OS isolation. Both are explicit and reuse battle-tested repo primitives.

---

## 8. Phased implementation plan

### P0 — Walking skeleton (headless Playwright, basic panel)
**Goal:** model navigates a real site, snapshots, clicks, screenshots; a minimal panel shows steps.

| Add / change | What |
|---|---|
| `package.json` | Add `playwright` dep; download Chromium in image (`npx playwright install --with-deps chromium`). |
| `src/lib/browser/session.ts` (new) | `getBrowserSession(conversationId)` — globalThis `Browser` + per-conversation `BrowserContext`, LRU + `trackPid`/reaper (clone `confine.ts:46-127`). `chromium.launch()` (native protocol). |
| `src/lib/browser/snapshot.ts` (new) | Aria snapshot → ref-tagged tree; `ref`→locator resolution; staleness invalidation. |
| `src/lib/tools/browser.ts` (new) | `browser_navigate`/`browser_snapshot`/`browser_click`/`browser_type`/`browser_screenshot`; read off `RunContext`; emit `browser_activity`; never throw. |
| `src/lib/agent.ts` | Add browser tools to `agentTools`. Pin chat route to **Node runtime**. |
| `src/lib/types.ts` | `browser_activity` variant + `BrowserActivity`/`BrowserState` + `Message.browser`. |
| `src/app/api/chat/route.ts` | `handleBrowserEvent` (upsert+`send`) + tool interception. |
| `src/store/chat.ts` | `case "browser_activity"` reducer. |
| `src/components/chat/BrowserActivity.tsx` (new) | Minimal: list of steps + latest screenshot. Mount in `MessageItem.tsx:250-252` gated on `message.browser`. |

**Acceptance:** In the browser UI, ask the model to "go to example.com and read the heading." Panel shows navigate→snapshot→read steps with a screenshot; `tsc`/lint green; no generic tool card appears (interception works).

### P1 — Full action set + live streaming panel + persistence
| Add / change | What |
|---|---|
| `src/lib/tools/browser.ts` | Add `browser_select`/`browser_press`/`browser_read`/`browser_back`/`browser_wait`; inline-snapshot-in-response to cut round-trips (~26–40% fewer calls). |
| `src/lib/browser/session.ts` | Idle reaper + `dispose`; bounded concurrency; per-context memory cap. |
| `src/components/chat/BrowserActivity.tsx` | Full clone of `SubagentActivity.tsx:286-479`: `useNow(active)` timers, expandable per-step trace (reuse `toolActivity.ts` label/icon), `pinnedRef`/`onScroll` autoscroll guard, collapse-to-pill ("Used browser · N steps · Ns"). |
| `src/app/api/chat/route.ts` | `finalizeBrowser` + `encodeBrowser` + prisma write (`route.ts:988-1003`). |
| `src/app/api/conversations/[id]/route.ts` | `decodeBrowser` on reload. |
| `src/store/chat.ts` | `failRunningBrowser` on stop/error (941/1090). |
| prisma (hand-SQL) | `ALTER TABLE "Message" ADD COLUMN "browser"`. |

**Acceptance:** A multi-step form fill streams live into the panel (timers tick, trace expands mid-run without scroll-hijack); Stop mid-run → step flips to failed, no eternal spinner; **reload → panel rehydrates identically** from `Message.browser`.

### P2 — Confirmation / allowlist + isolation hardening
| Add / change | What |
|---|---|
| `src/lib/browser/guard-proxy.ts` (new) | 127.0.0.1 CONNECT guard-proxy (clone `git.ts:156-260`); `--proxy-server` on launch; pre-nav `validateUrl`/`isBlockedIp`. |
| `src/lib/tools/browser.ts` | Read-vs-state split: gate `click`/`type`/`select`/`navigate` behind approval UX (`TELEGRAM_REQUIRE_APPROVAL` precedent); untrusted-fence all page text (`<web_content untrusted>`); read-only subset export for `subagentTools`. |
| `src/lib/tools/index.ts` / `subagents/runner.ts` | Wire read-only browser subset into subagent toolset (exclusion pattern). |
| `session.ts` | `scrubbedEnv` + `DISPLAY`/`XDG_*` if spawning CLI; process-group kill. |

**Acceptance:** Navigating to `http://169.254.169.254/` and `http://localhost:<app-port>/` is **blocked** at both pre-nav and CONNECT time (redirect/subresource too). A state-changing action prompts for confirmation; Deny is a clean no-op. Subagent context can snapshot/read but cannot click/type.

### P3 — Pixel/computer-use fallback + MCP bootstrap (optional)
| Option | What |
|---|---|
| **Pixel fallback (Candidate B graft)** | Behind a flag for canvas/WebGL: `src/lib/browser/computer.ts` (Playwright `Computer` impl — screenshot/click/scroll/type + Retina @2× coordinate scaling) + `src/lib/browser/cua-loop.ts` (raw `openai` `responses.create` loop, `previous_response_id` chaining, `pending_safety_checks`→approval UX, max-iterations guard, screenshot pruning keep-last-3). Wrapped as one function-tool `browser_operate`. **Provider-gated** — degrade gracefully if `computer-use-preview` unavailable (Azure). |
| **Playwright-MCP bootstrap (Candidate C graft)** | For fast v1 tool coverage: run `npx @playwright/mcp@latest --host 127.0.0.1 --port 8931 --isolated` in **HTTP** mode, register as an `McpServer` row (enabled+trusted+connected) → surfaces ~21 `browser_*` tools with zero `agent.ts` change. Loopback reachable because `RemoteMCPServer` uses plain `fetch` (`client.ts:123`). **Caveat:** single shared `sessionId` = no native per-conversation isolation, generic tool cards not the rich panel — use only as a throwaway prototype, not the shipped path. |

**Acceptance:** A canvas/chart page the a11y tree can't express completes via the pixel fallback with confirmation gating; the MCP bootstrap (if used) is retired once P0–P1 lands.

---

## 9. Risks & open questions

| Risk | Mitigation / note |
|---|---|
| **Chromium under Next.js Node runtime** — route handlers are request-scoped; Playwright needs a long-lived process. | Own the browser in a `globalThis`-cached module (`session.ts`) that survives HMR, exactly like `confine.ts` `__sandboxStates` and the subagent bus. Route handlers *talk to* it. Pin route to Node (Playwright can't run on Edge). |
| **Serverless / multi-instance hosting** breaks the `globalThis` cache (not shared, killed between requests). | Design assumes a **single long-lived Node process** — matches how the repo already runs locally. Document as a deployment constraint; a hosted-CDP seam (Browserbase/Steel `connectOverCDP`) is the escape hatch if scaled later. |
| **Binary size / image weight** — `playwright` + Chromium + system libs (absent today). | One-time, bounded. `npx playwright install --with-deps chromium` in the image build. |
| **Concurrency / process leaks** — a runaway page leaks a Chromium process. | Bounded concurrent contexts, per-context memory cap, `trackPid`/`untrackPid` + idle reaper + per-conversation kill (clone sandbox reaper). |
| **Cost** — screenshots are expensive *if* used as the primary channel. | a11y grounding is ~200–400 tokens/step vs ~1–1.8k for pixel; screenshots are diagnostic-only in P0–P2. Pixel fallback (P3) gets a max-iterations guard + screenshot pruning. |
| **Ref staleness** — refs reset on navigation/DOM mutation → mis-clicks. | Invalidate refs per snapshot; re-snapshot after every state-changing action; inline-snapshot-in-response (P1) to cut round-trips and keep refs fresh. Instrument per-step ref-resolution success separately from model reasoning. |
| **SSRF asymmetry** — browser navigations bypass `safeFetch` entirely. | The single most important new defense: pre-nav validate **and** CONNECT guard-proxy covering redirects+subresources (P2). |
| **Prompt injection** — a11y snapshot / page text is a hostile-instruction surface (23.6% baseline). | Untrusted-fencing + read-vs-state split are **load-bearing, not optional**, before autonomous runs. |
| **Shared hot-file contention** — `types.ts`, `route.ts`, `store/chat.ts`, `MessageItem.tsx`, `conversations/[id]/route.ts` carry concurrent multi-feature WIP (Sites/branching/research/subagents) in one working tree. | Per memory: **stage mine-only hunks** when committing; commit self-contained new files (`browser/*`, `BrowserActivity.tsx`) early. |
| **Headless ceiling** (open question) — server-side headless can't pass CAPTCHA/2FA, is bot-detectable, starts auth flows cold. | Accepted for v1 (this is *why* Candidate D scored higher on the capability lens). Revisit only if authenticated-real-site tasks become a requirement — that would mean the extension-CDP path, a separate feature with a much larger security/distribution cost. |

---

## 10. Alternatives considered

| Candidate | Effort | Aggregate | fit-effort | capability | security | Why it did / didn't win |
|---|---|---|---|---|---|---|
| **A — In-app Playwright + a11y (per-conversation server browser)** ✅ | **L** | **25.5** | **9** | 8.0 | **8.5** | **WON.** Only fully provider-portable design; clones every repo contract natively (onEvent/panel/sandbox/SSRF/persistence); safest-by-default (fresh context, no real credentials). Sole friction: new `playwright` dep + Chromium. |
| **C — Reuse Playwright-MCP via `RemoteMCPServer`** | M | 17.5 | 7 | 6.5 | 4 | Fastest bare v1 (~21 tools, zero `agent.ts` change) but single shared `sessionId` = no per-conversation isolation, external process nothing supervises, generic tool cards not the rich panel, all 21 tools (incl. `browser_evaluate`) exposed at once with no approval split. Adopted only as a **P3 bootstrap**. |
| **D — Claude-in-Chrome-style CDP bridge to user's real Chrome** | XL | 17.5 | 3 | **8.5** | 6 | Highest real-world capability (acts in the user's *logged-in* sessions, human takeover for CAPTCHA/2FA) but inverts the server-side-tool assumption (every action → a killable client MV3 socket), ships an installable extension, and **drives the user's real credentials** (largest blast radius, 23.6% injection baseline). Isolation loss disqualifies it as the default. |
| **B — Provider-native computer-use (pixel loop)** | XL | 16.5 | 4 | 5.0 | 7.5 | Pixel grounding is the empirical bottleneck (~3× worse than DOM refs), worst latency/cost, provider-locked/access-gated (breaks Azure/Claude portability), needs a bespoke raw `responses.create` loop (`agents-core@0.0.5` has no safety flow). Its one unique win (canvas/WebGL) is grafted into A as the **P3 opt-in fallback** without paying the pixel penalty on ordinary pages. |

---

### Appendix — files to create

```
src/lib/browser/session.ts       # per-conversation Browser+Context cache, LRU, reaper (clones confine.ts:46-127)
src/lib/browser/snapshot.ts      # aria snapshot → ref-tagged tree; ref→locator; staleness
src/lib/browser/guard-proxy.ts   # 127.0.0.1 CONNECT guard-proxy (clones git.ts:156-260) + pre-nav validateUrl
src/lib/tools/browser.ts         # browser_* function-tools + read-only subset export
src/components/chat/BrowserActivity.tsx  # live panel (clones SubagentActivity.tsx:286-479)
prisma (hand-SQL)                # ALTER TABLE "Message" ADD COLUMN "browser"
# P3 (optional):
src/lib/browser/computer.ts      # Playwright Computer impl (pixel fallback)
src/lib/browser/cua-loop.ts      # raw openai responses.create loop + safety-check HITL
```

**Edits (stage mine-only hunks):** `src/lib/agent.ts` (register tools, pin Node), `src/lib/types.ts` (`browser_activity` + shapes + `Message.browser`), `src/app/api/chat/route.ts` (`handleBrowserEvent` + interception + finalize/encode + prisma), `src/app/api/conversations/[id]/route.ts` (`decodeBrowser`), `src/store/chat.ts` (reducer + `failRunningBrowser`), `src/components/chat/MessageItem.tsx` (mount panel), `package.json` (`playwright`).

---

## 11. Reviewer critique — must-fix before building (verified against the actual codebase)

An adversarial review pass (2 skeptics) plus a direct read of the real files found that the blueprint above is **architecturally sound but oversells "reuse" in four places** where the thing being "cloned" is actually net-new or needs extension. Each item below was confirmed against the checkout on `main`. Treat these as gating work, not polish.

### 11.1 — There is no idle process reaper to clone (⚠️ major)
`confine.ts` really does hold per-conversation state on `globalThis` (`src/lib/sandbox/confine.ts:63-67`, survives HMR) and tracks child pids (`:336-339`), but it only **reaps on shutdown** (`:56`, `:315`) — there is **no timeout-based idle reaper** (`grep setInterval src/lib/sandbox` finds none). A leaked headless Chromium is a much heavier resource than a shell child, so `session.ts` must **build** an idle-timeout reaper + bounded-concurrency LRU + per-conversation kill from scratch. Clone the globalThis cache pattern; do **not** assume the reaper exists.

### 11.2 — No in-app human-in-the-loop approval mechanism exists (❌ blocker for P2)
The doc's §7.3 gates state-changing actions "behind the app's existing approval UX (`TELEGRAM_REQUIRE_APPROVAL` precedent)". That precedent is **not in this tree** (`grep TELEGRAM_REQUIRE_APPROVAL src/` → nothing; per project memory it lives in the uncommitted `feat/telegram-dispatch` worktree). The main chat flow has **no** approve/deny round-trip. So the P2 security gate requires **net-new plumbing**: a tool `await` that emits an SSE `browser_approval_request`, the panel renders Approve/Deny, the client POSTs the decision, and the paused tool resumes — a genuine bidirectional control channel this app does not have today. Size P2 accordingly (this is the single biggest under-estimate in the plan).

### 11.3 — `playwright` must be added to the dependency **and** the Next externalize list (❌ blocker for P0)
`playwright` is not in `package.json`, and — critically — not in `next.config.js` → `experimental.serverComponentsExternalPackages` (which today lists `@prisma/client`, `@openai/agents`, `@mozilla/readability`, `linkedom`, `turndown`, `unpdf`). Playwright pulls in Node-only internals exactly like those parsers; **omitting it from that list risks the chat route failing to bundle**. P0 must: add the dep, run `npx playwright install --with-deps chromium` in the image, **and** add `"playwright"` to `serverComponentsExternalPackages`.

### 11.4 — The guard-proxy is CONNECT-oriented; confirm HTTP + subresource coverage (⚠️ major)
`startGuardProxy` is real (`src/lib/plugins/git.ts:181`, `http.createServer()`) and is the right thing to clone. But it was written for **HTTPS git over CONNECT tunnels**. A browser also issues **plain-HTTP** navigations/subresources (absolute-form GET through the proxy, no CONNECT) and follows **redirects**. Verify the cloned proxy re-runs `isBlockedIp` on the HTTP request path and on every redirect/subresource, not just at CONNECT — otherwise `http://169.254.169.254/…` (IMDS) or `http://localhost:<app-port>/` can slip the connect-time check. Pre-nav `validateUrl` covers the top-level URL only, so the proxy is load-bearing for everything the page fetches after.

### 11.5 — Security sequencing ships an insecure window (❌ blocker if exposed early)
Every load-bearing defense (SSRF proxy §11.4, untrusted-DOM fencing, the approval gate §11.2) lands in **P2**, but P0/P1 already give the write/shell/deploy-capable lead agent a live server-side browser. **Gate the entire feature behind an off-by-default flag until P2 is complete.** Do not wire the read-only browser subset into `run_subagents` (untrusted workers) until fencing + the navigate reclassification below are in.

### 11.6 — `browser_navigate` is not read-only; don't hand it to untrusted contexts (⚠️ major)
§5 exports `browser_navigate` in the "read-only subset" for subagents. Navigation is **state-affecting** (GET side effects, auth-flow initiation, and an SSRF vector even when pre-validated, via injected page content steering the next hop). Keep `navigate` out of the untrusted-subagent subset, or restrict it there to an explicit allowlist.

### 11.7 — Screenshots + page text land in the DB and the panel (⚠️ minor→major)
`Message.browser` will persist base64 screenshots (`thumbnailDataUrl`) and page-derived `action`/snapshot strings. That is (a) a **PII/secret sink** in the database and (b) a **panel-render injection** surface. Cap/limit stored screenshots, treat all page-derived strings as untrusted at render time (the panel must not interpret them as markup), and consider not persisting full-resolution shots.

### 11.8 — Provenance note on the research
Two of the workflow's helper agents degraded (one codebase mapper for the sandbox/net/mcp layer failed its structured-output cap; one security research agent returned a placeholder). That is **why** several §4/§7 "reuse" claims were under-grounded and needed the corrections above. The streaming-panel and tool-contract maps were clean, and the external verified-facts (§12) come from the passing agents; the corrections in §11 come from a direct read of the code.

---

## 12. Verified external facts (independent fact-check pass)

These claims were re-checked by independent agents against primary sources (Anthropic/OpenAI/Microsoft docs and repos):

- ✅ **Playwright MCP `browser_snapshot` returns an accessibility-tree snapshot with a per-element `ref`** — act by `ref`, not pixels (a11y-first by default).
- ✅ **Playwright MCP drives real Chromium/Firefox/WebKit that Playwright launches** (its own browser, not the user's).
- ✅ **Claude in Chrome drives the user's REAL Chrome/Edge tab** with existing login state (this is why it can't be the isolated default — Candidate D).
- ✅ **Claude in Chrome exposes an a11y reader** (`read_page` → a11y tree with element refs) alongside a pixel `computer()`.
- ✅ **Claude in Chrome enforces a per-site permission model** (grant/revoke per website).
- ✅ **To the agent, both browser servers are ordinary MCP servers** — tools namespaced `mcp__<server>__*`.
- ⚠️ **Partly true:** Playwright MCP's inline-snapshot mode exists but the exact flag/mode name is version-dependent — verify against the installed `@playwright/mcp` version before relying on it.
- ⚠️ **Partly true:** `computer_20241022` was the original computer-use tool version (Claude 3.5 Sonnet era); the current version string differs — pin against live Anthropic docs if you build the P3 pixel fallback.
- *(One verifier hit the structured-output retry cap and returned no verdict; its claim is unverified.)*

**Cross-check with the [claude-api] reference before implementing the P3 pixel fallback** — computer-use tool `type`/version strings and which Claude models support computer use change over time, and the app currently talks to models via an OpenAI-compatible client (no `@anthropic-ai/sdk`), so a Claude computer-use branch is additional work.
