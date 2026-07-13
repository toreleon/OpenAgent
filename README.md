# OpenAgent

A clean, batteries-included starting point for building **production agent apps** with the
[OpenAI Agents SDK](https://github.com/openai/openai-agents-js) and **Next.js 14** (App Router).

It looks and behaves like a modern assistant app — auth, a streaming chat UI, a "Thinking" panel,
file/image uploads, and **Connectors** — but it is really a *template*: a small,
readable, well-typed codebase you can fork and extend into your own agent product. Out of the box
you get authentication, persistent conversations, server-streamed chat over the OpenAI **Responses
API**, built-in tools, and full **OAuth 2.1** for remote MCP servers — all wired together with a
single authoritative contract document (`CONTRACTS.md`). `tsc --noEmit` and `next build` are clean.

It runs against the public OpenAI API **or** any OpenAI-compatible endpoint (e.g. Azure AI Services'
`/openai/v1/` surface) by changing two environment variables.

---

## Features

- **Auth** — NextAuth (Credentials + optional GitHub), JWT sessions, Prisma adapter, bcrypt password hashing.
- **Streaming chat** — server-sent events over the OpenAI Responses API via `@openai/agents`; token-by-token deltas.
- **Reasoning / "Thinking" UI** — streams the model's reasoning summary into a collapsible panel and persists it across reloads.
- **Built-in tools** — hosted web search (with a dependency-free DuckDuckGo fallback), `run_javascript`, and `get_current_time`.
- **File & image uploads** — drag-and-drop attachments surfaced to vision-capable models as `input_image` / `input_file`.
- **Deep Research** — a composer toggle that runs a research flow: the agent asks clarifying questions, then plans ~4 subtopics, runs ~12 `web_search`/`web_fetch` reads, and streams a **cited report inline** in the chat message beneath a live "Research" activity panel.
- **MCP Connectors** — register remote Streamable-HTTP MCP servers with **full OAuth 2.1**: metadata discovery, dynamic client registration, PKCE, callback, and automatic token refresh. Server secrets/tokens never leave the server.
- **OpenAI / Azure-compatible** — point at OpenAI or any compatible endpoint with `OPENAI_BASE_URL` + `OPENAI_MODEL`.
- **Tailwind dark theme**, Markdown + KaTeX + syntax highlighting, Zustand stores, SQLite via Prisma.

---

## Tech stack

| Layer         | Choice                                                              |
| ------------- | ------------------------------------------------------------------- |
| Framework     | Next.js 14 (App Router), React 18, TypeScript                       |
| Agent runtime | `@openai/agents` over the OpenAI Responses API                      |
| Auth          | NextAuth 4 (Credentials + GitHub), JWT, `@next-auth/prisma-adapter` |
| Data          | Prisma 5 + SQLite (swap the datasource for Postgres/MySQL)          |
| State (client)| Zustand                                                             |
| UI            | Tailwind CSS, lucide-react, react-markdown + remark/rehype + KaTeX  |
| Validation    | Zod                                                                 |

### Architecture overview

A chat turn flows from the composer to the model and streams back as SSE:

```
Browser (Zustand store)
   │  POST /api/chat  { conversationId?, message, model, effort, attachments }
   ▼
/api/chat (route handler, runtime="nodejs")
   │  • getServerSession(authOptions)  → ownership by userId
   │  • persist user Message, pre-create assistant Message
   │  • owns framing events: message_id, title, done
   ▼
streamChat()  (src/lib/agent.ts)
   │  • configures OpenAI/Azure client (OPENAI_BASE_URL)
   │  • loadUserMcpServers(userId) → connect() trusted+enabled connectors
   ▼
new Agent({ tools: agentTools, mcpServers, modelSettings.providerData.reasoning })
   │  run(agent, input, { stream: true })
   ▼
OpenAI Responses API (or Azure /openai/v1/)
   │  raw deltas, reasoning summary, tool calls
   ▼
StreamEvent union ──► SSE `data: <json>\n\n` ──► store applies events ──► UI
```

- **SSE protocol** — the wire union lives in `src/lib/types.ts` as `StreamEvent`
  (`delta`, `reasoning_delta`, `reasoning_done`, `tool_call`, `tool_result`, `message_id`, `title`, `done`, `error`).
  `streamChat` yields the content events; `/api/chat` owns `message_id`/`title`/`done`.
- **Data model** — `prisma/schema.prisma`: `User`, NextAuth `Account`/`Session`, `Conversation`,
  `Message`, and `McpServer`. `Message.attachments` and `Message.toolCalls` are JSON-string columns;
  `reasoning`/`reasoningMs` persist the Thinking panel.
- **Contracts** — `CONTRACTS.md` is authoritative for route conventions
  (`runtime="nodejs"`, `getServerSession(authOptions)`, errors as `Response.json({ error }, { status })`,
  ownership-by-404, JSON-column encode/decode, the SSE ordering, and the MCP DTO rules).

---

## Quick start

### Prerequisites

- Node.js 18.18+ (or 20+) and npm
- An OpenAI API key, **or** an OpenAI-compatible endpoint + key (e.g. Azure AI Services)

### 1. Install

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill it in:

```bash
cp .env.example .env
```

| Variable          | Required | Purpose                                                                                                  |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`  | yes      | API key for OpenAI or your compatible endpoint. Without it, chat returns a graceful error.               |
| `OPENAI_BASE_URL` | no       | Point at a custom/Azure endpoint, e.g. `https://<resource>.services.ai.azure.com/openai/v1/`. Unset = public OpenAI. |
| `OPENAI_MODEL`    | no       | Force a specific model / Azure **deployment** name; overrides the UI picker for the actual request.      |
| `NEXTAUTH_SECRET` | yes      | Session/JWT signing secret. Generate with `openssl rand -base64 32`.                                     |
| `NEXTAUTH_URL`    | yes      | Public origin, no trailing slash. **Required for MCP OAuth** — the redirect URI is `${NEXTAUTH_URL}/api/mcp/oauth/callback`. |
| `DATABASE_URL`    | yes      | Prisma datasource. Default `file:./dev.db` (SQLite).                                                      |
| `GITHUB_ID`       | no       | GitHub OAuth client id (enables the GitHub sign-in button).                                              |
| `GITHUB_SECRET`   | no       | GitHub OAuth client secret.                                                                              |
| `SCHEDULER_ENABLED` | no     | Set to `1` to start the in-process 60s ticker (needs a persistent Node server; leave blank on serverless). See **Scheduled tasks**. |
| `CRON_SECRET`     | no       | Shared secret that guards `POST/GET /api/cron` for external schedulers. Unset = the cron endpoint returns `503`. |

### 3. Create the database

```bash
npm run db:push
```

### 4. Run

```bash
npm run dev
```

Open http://localhost:3000, click **Sign up**, create an account, and start chatting. New
conversations are created automatically on your first message; pick a model and reasoning effort in
the composer.

---

## How to extend

This is the point of the template. Everything below is a small, local edit.

### (a) Add a tool

Tools are defined with the SDK's `tool()` helper and a Zod parameter schema, then registered in one
array. Mirror `src/lib/tools/get-current-time.ts`:

```ts
// src/lib/tools/uppercase.ts
import { tool } from "@openai/agents";
import { z } from "zod";

export const uppercaseTool = tool({
  name: "uppercase",
  description: "Uppercase a string. Use when the user asks to shout text.",
  parameters: z.object({
    text: z.string().describe("The text to uppercase."),
  }),
  async execute({ text }) {
    return { result: text.toUpperCase() };
  },
});
```

Register it in `src/lib/tools/index.ts`:

```ts
import { uppercaseTool } from "./uppercase";

export const agentTools: Tool[] = [
  hostedWebSearchTool,
  fallbackWebSearchTool,
  runJavascriptTool,
  getCurrentTimeTool,
  uppercaseTool, // ← new
];
```

The model now sees the tool automatically; `tool_call`/`tool_result` events stream to the UI and are
persisted on the assistant `Message.toolCalls` JSON column. (See the note on `run_javascript` below
before relying on the bundled sandbox.)

### (b) Add or swap a model

Models displayed in the picker live in `src/lib/types.ts` (`MODELS`). Add an entry:

```ts
export const MODELS: AvailableModel[] = [
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini", description: "Fast, capable model for most tasks" },
  { id: "gpt-5.4",      label: "GPT-5.4",      description: "Higher quality, slower" },
];
```

The `id` is passed verbatim to the agent. If `OPENAI_MODEL` is set in the environment, it overrides
the picker for the actual request (useful when the wire name is an Azure **deployment** name that
differs from the user-facing label).

### (c) Add an MCP connector

No code required. Sign in, open **Settings → Connectors**, and add a connector by name + URL (a
remote Streamable-HTTP MCP endpoint). If the server requires auth, the app runs the full OAuth flow
(see below). Once **connected, enabled, and trusted**, that server's tools are loaded for the user on
each chat turn and offered to the model alongside the built-in tools.

### (d) Point at Azure or another OpenAI-compatible endpoint

Set `OPENAI_BASE_URL` to the endpoint and `OPENAI_MODEL` to the deployment/model name; keep
`OPENAI_API_KEY` as the key. `src/lib/agent.ts` builds an OpenAI client pointed at the base URL and
sends both a bearer token and an `api-key` header so it works against OpenAI or Azure auth schemes,
and disables tracing for non-OpenAI endpoints. See the Azure note under **Known limitations**.

---

## Web search & fetch tools

Two built-in tools give the agent access to the live web:

- **`web_search`** — runs a query against a pluggable search backend and returns a ranked list of
  results (title, URL, snippet) for the model to reason over or hand to `web_fetch`.
- **`web_fetch`** — downloads a single URL and returns **cleaned Markdown** (readability extraction →
  Markdown; PDFs are parsed too), so the model gets readable content instead of raw HTML.

### Zero-key by default, upgrade with a key

Both tools work with **no configuration**. Out of the box `web_search` scrapes **DuckDuckGo HTML**,
which is keyless but **fragile** (it can break when the page markup changes and is easy to rate-limit).
For reliable results, set one credential and it is auto-selected by precedence
(`tavily` > `serper` > `brave` > `searxng` > `duckduckgo`), or pin one explicitly with
`WEB_SEARCH_PROVIDER`:

- `TAVILY_API_KEY` — Tavily, an LLM-oriented search API (**recommended**).
- `SERPER_API_KEY` — Serper (Google SERP API).
- `BRAVE_API_KEY` — Brave Search API.
- `SEARXNG_URL` — a self-hosted, **keyless** SearXNG instance (JSON format enabled).

See the **Web tools** block in `.env.example` for every knob, including `web_fetch`'s size/timeout caps
(`WEBFETCH_MAX_BYTES`, `WEBFETCH_TIMEOUT_MS`) and the opt-in model-extraction pass
(`WEBFETCH_EXTRACT_MODEL`).

### Security posture

- **SSRF-guarded.** Every outbound request goes through a hardened fetch (`src/lib/net/safe-fetch.ts`)
  that resolves DNS and **blocks loopback / private / link-local / reserved ranges** (including cloud
  metadata endpoints like `169.254.169.254`), rejects bad schemes and embedded credentials, and
  re-validates each redirect hop. Private-network access is off unless you set
  `WEBFETCH_ALLOW_PRIVATE_NETWORK=1` (**local dev only**).
- **Untrusted content.** Fetched page text is treated as **data, not instructions**: `web_fetch` wraps
  it in a `<web_content untrusted="true">…</web_content>` envelope and its tool description tells the
  model to ignore any instructions found inside — a basic guard against prompt injection from web pages.

---

## Deep Research

A composer **Deep Research** toggle turns a normal chat turn into a research run: the
agent scopes the request, gathers sources from the live web, and streams a **cited report inline in the
chat message** (not a side panel) beneath a collapsible **Research** activity panel that shows the plan
and each live search/source as it happens.

### Clarify → answer → report

Deep Research is **two-phase**:

1. **Clarify.** On the first Deep-Research turn the agent replies with **2–3 concise clarifying
   questions** (a short numbered list, streamed as a normal assistant message) to pin down scope,
   audience, and constraints.
2. **Research + report.** On the next turn — the user's answers — the agent runs the full pipeline: it
   emits a **plan** (title + ~4 subtopics, each with search queries), fires the searches and page reads,
   then streams the final **report** as ordinary `delta` events so it renders as the assistant message's
   content, with inline source citations.

### What a run does

Depth is fixed at **"Standard"** (no depth picker): roughly **4 subtopics × 3 sources ≈ 12 total page
reads**. The orchestrator plans the subtopics, calls the built-in **`web_search`** tool per query, reads
the most relevant hits with **`web_fetch`**, analyzes each source, then synthesizes the cited report.
Every step surfaces in the live activity panel as a `research_activity` event
(`search` / `source` / `analyze` / `synthesize`, each transitioning `active → done | failed`).

### Reuses the existing plumbing

Deep Research adds **no new transport or network primitives** — it rides the same rails as normal chat:

- **Same SSE stream.** The plan and activity updates travel as two new `StreamEvent` variants
  (`research_plan`, `research_activity`); the report streams as the usual `reasoning_*` + `delta` events.
  The final `ResearchState` persists on the assistant `Message.research` JSON column so the activity
  panel and report survive reloads.
- **Same web tools + SSRF guard.** All fetches go through `web_search` / `web_fetch`, so every request is
  SSRF-guarded (`src/lib/net/safe-fetch.ts`) and fetched page text stays wrapped as **untrusted data** —
  the analysis prompts treat it as content, never instructions.

See **§11** of `CONTRACTS.md` for the wire contract: the request flag, the new stream events and state
types, the two-phase route logic, and the orchestrator/agent APIs.

---

## MCP Connectors

Connectors are remote **MCP** (Model Context Protocol) servers spoken over **Streamable HTTP**
(JSON-RPC, `text/event-stream` responses). Each connector belongs to a user and is exposed to the
agent only when it is **enabled + trusted + connected**.

### OAuth 2.1 flow

When a server responds `401` with a `WWW-Authenticate` challenge, the app performs the full
authorization-code-with-PKCE dance:

```
discover  →  OAuth Authorization Server metadata (.well-known)
register  →  Dynamic Client Registration (RFC 7591) if no client exists
PKCE      →  generate verifier + challenge, generate CSRF state
authorize →  redirect the user to the provider's authorize URL
callback  →  GET /api/mcp/oauth/callback exchanges the code for tokens
refresh   →  ensureAccessToken() auto-refreshes expired tokens (30s skew)
```

Helpers live in `src/lib/mcp/oauth.ts`; the JSON-RPC client is `src/lib/mcp/client.ts`; the
DTO/token layer is `src/lib/mcp/index.ts`. The OAuth `state` maps the callback back to the originating
`McpServer` row (CSRF protection), and the PKCE verifier/state are cleared after use.

### Trust model & secret storage

- **Server-only secrets.** OAuth client secrets, access/refresh tokens, PKCE verifiers, and discovery
  metadata live **only** on the `McpServer` row. The API returns the sanitized `McpConnector` DTO
  (`toConnectorDTO`), which strips all of them — the client store (`src/store/mcp.ts`) only ever
  handles that DTO.
- **Ownership by 404.** Every connector route scopes by `id + userId` and returns 404 (not 403) for
  rows you don't own.
- **Trust is an explicit toggle.** A connector's tools are only loaded once you mark it trusted; this
  is a coarse per-connector toggle, not a per-call approval prompt (see notes).

---

## Scheduled tasks

Claude-Desktop-style **automations**: save a prompt + a cron schedule, and the app fires it on its own
cadence. Each fire seeds a **brand-new conversation** (seeded with the schedule's prompt as the first
user message), runs the agent as the owning user, and persists the assistant reply — so every run is a
self-contained thread you can open later, linked back via `Conversation.scheduleId`. Every fire attempt
is recorded as a `ScheduleRun` row (`running → success | error`). Manage schedules in the UI at
**`/schedules`**.

### Cron & timezone model

A schedule stores a standard **5-field cron** expression (`min hour day month weekday`) plus an **IANA
timezone** (e.g. `America/New_York`, default `UTC`). The next fire time is computed strictly in that
timezone, so a "9am daily" job stays at 9am local across DST. Validation, human-readable descriptions,
and the next-run preview live in `src/lib/schedule/cron.ts`; the `/schedules` UI builds expressions from
presets (hourly / daily / weekdays / weekly / monthly / custom) via `src/lib/schedule/presets.ts`.

### Enabling the triggers

Two independent triggers funnel into the **same** `runDueSchedules()` runner; enable either or both.

- **In-process ticker** — set `SCHEDULER_ENABLED=1`. A Next.js instrumentation hook starts a 60s
  `setInterval` (plus one warm-up tick shortly after boot) that claims and fires any due schedules.
  This needs a **long-lived Node process** (`npm run dev` / `npm run start`); leave it blank on
  serverless, where the process is not persistent.

- **`/api/cron` endpoint** — set `CRON_SECRET` and have an external scheduler hit the route. It is
  guarded by the secret (unset → `503`; bad/missing secret → `401`) sent as either
  `Authorization: Bearer <secret>` or `X-Cron-Secret: <secret>`, and runs due schedules to completion
  before responding (safe for serverless). Both `GET` and `POST` work.

  ```bash
  curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron
  ```

  A crontab entry that ticks every minute:

  ```cron
  * * * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://your-app.example.com/api/cron
  ```

Double-firing is prevented regardless of how many triggers run: each schedule is claimed with an atomic
compare-and-swap on its `nextRunAt` before it runs, so only one caller ever wins a given fire.

---

## Scripts

From `package.json`:

| Script             | Description                                        |
| ------------------ | -------------------------------------------------- |
| `npm run dev`      | Start the Next.js dev server.                      |
| `npm run build`    | `prisma generate && next build`.                   |
| `npm run start`    | Start the production server (after build).         |
| `npm run lint`     | Run ESLint (`eslint-config-next`).                 |
| `npm run db:push`  | `prisma db push` — sync the schema to the database.|

### Directory map (`src/`)

```
src/
  app/
    (auth)/                 login + register pages
    api/
      auth/[...nextauth]/   NextAuth handler
      register/             credentials sign-up
      chat/                 POST → SSE streaming chat (owns framing events)
      conversations/        list / create / get / rename / delete
      upload/               file & image uploads
      mcp/                  connector CRUD
        [id]/               get / update / delete
        [id]/connect/       probe + start OAuth
        oauth/callback/     OAuth redirect handler
    c/[id]/                 a conversation view
  components/
    chat/                   Composer, MessageList, MessageItem, ThinkingBlock, pickers
    sidebar/                conversation list + Settings entry
    settings/               SettingsModal (Connectors UI)
    markdown/ ui/ upload/ auth/
  hooks/                    useAutoScroll, useCopyToClipboard
  lib/
    agent.ts                streamChat — Agent setup + Responses streaming
    tools/                  index.ts + get-current-time, run-javascript, web-search
    mcp/                    client.ts (JSON-RPC), oauth.ts (OAuth 2.1), index.ts (DTO/tokens)
    types.ts                StreamEvent, MODELS, DTOs — shared contracts
    auth.ts db.ts sse.ts storage.ts
  store/                    chat.ts, mcp.ts (Zustand)
  middleware.ts             route protection
CONTRACTS.md                authoritative conventions
prisma/schema.prisma        data model
```

---

## Known limitations / notes

This template was code-reviewed (every exported function and route handler traced; findings
adversarially re-verified). The safe, no-tradeoff issues that surfaced have been **fixed**; the items
that involve a genuine design decision are listed below as open.

Genuine simplifications (intentional for a template): **SQLite** by default, **no automated test
suite**, MCP trust is a **per-connector toggle** rather than a per-call approval prompt, and OAuth
**tokens are stored unencrypted at rest** (fine for local dev — encrypt or use a secrets manager in
production).

**Hardened in this revision:** SVG and `text/html` removed from upload allow-list (stored-XSS vector);
hosted `web_search` now registered only for the public OpenAI endpoint, not Azure-compatible ones (it
serializes as `web_search_preview` and would 400 the request); MCP SSE reader flushes a final
non-`\n\n`-terminated event; the `title` SSE event is suppressed after an `error`; connector `none`
status no longer mislabeled "Needs sign-in"; and assorted hook/UI nits (`useCopyToClipboard` unmount
cleanup, `useAutoScroll` JSDoc, `Modal` scroll-lock deps, `Dropdown` honors a `disabled` trigger).

**Open — address before production (each needs a design decision):**

- **`run_javascript` is intentionally inert.** It currently throws on every call (`import`/`eval` are
  illegal `Function` parameter names), so **no user code executes** — which is the *safe* state. The
  naive fix (make it run) is dangerous: the `new Function` + shadowed-params design is escapable via
  `({}).constructor.constructor(...)`, yielding full Node access server-side. To enable a real code
  interpreter, run snippets in a true isolate (`isolated-vm` or a locked-down child process) — do not
  simply un-break the existing implementation.
- **SSRF in MCP connect/probe.** User-supplied connector URLs are fetched server-side after only a
  protocol check (`src/app/api/mcp/route.ts`, `[id]/connect/route.ts`), so an authenticated user can
  point a connector at `127.0.0.1`, `169.254.169.254`, or RFC1918 addresses. Add a shared guard that
  resolves DNS and rejects loopback/link-local/private/reserved ranges before any fetch (incl.
  `oauth.ts`).
- **`POST /api/mcp` connects on create.** It probes + starts OAuth on create and returns a nested
  `McpConnectResponse` (connector at `result.connector`, not `result`). This is deliberate (one-step
  add+connect in the UI) but differs from a stricter "create row only, connect via
  `POST /api/mcp/[id]/connect`" contract — reconcile if you want create to be pure.
- **`regenerate()` duplicates history server-side.** It slices messages client-side and re-POSTs to the
  existing conversation; the server always appends a new user + assistant turn, so a reload shows a
  duplicated user turn (`src/store/chat.ts`). Needs a server-side delete/replace of the prior turn.

**Minor (left as-is):** an empty assistant row can persist (rendering as a blank turn after reload) on
immediate stream failure; the client-selected model is ignored for existing conversations (pinned to
the conversation's stored model); the auth middleware matcher uses unanchored prefix negation
(`login`/`register`, harmless given no such routes exist); and the MCP probe-path 401 retry does no
real token refresh (refresh happens in `ensureAccessToken`).

**Keep set:** `NEXTAUTH_URL` is required — when unset, the OAuth `redirectUri` becomes the literal
`undefined/api/mcp/oauth/callback` and the postMessage `targetOrigin` falls back to `"*"`.

---

## License & credits

Built on Next.js, the OpenAI Agents SDK, NextAuth, Prisma, and Tailwind. Use it as a template for your
own agent app. No license is asserted here — add one before distributing.
