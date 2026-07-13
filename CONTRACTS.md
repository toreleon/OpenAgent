# Integration Contracts — OpenAgent

This document is the single source of truth for the 4 parallel feature agents.
Build against it **verbatim**: route paths, JSON shapes, exported symbol names,
and component prop names are all fixed. Do not rename anything. Do not change
shared/foundation files.

- **Stack:** Next.js 14 App Router, TypeScript, Tailwind 3.4, Prisma 5 (SQLite),
  NextAuth 4, `@openai/agents` + `openai`, zustand, react-markdown.
- **Path alias:** `@/*` → `./src/*`.
- **Theme:** dark by default. Use semantic Tailwind classes (`bg-sidebar`,
  `bg-main`, `bg-user-bubble`, `bg-composer`, `text-text-primary`,
  `text-text-secondary`, `border-border`, `bg-accent`, `hover:bg-hover`).

---

## 1. File-ownership map

Foundation has already created (DO NOT TOUCH): `package.json`, `tsconfig.json`,
`next.config.js`, `tailwind.config.ts`, `postcss.config.js`, `.gitignore`,
`.env.example`, `prisma/schema.prisma`, `src/lib/db.ts`, `src/lib/types.ts`,
`src/app/layout.tsx`, `src/app/providers.tsx`, `src/app/globals.css`,
`CONTRACTS.md`.

### Agent A — **Auth**
Owns authentication, registration, and the session helper.
- `src/lib/auth.ts` — exports `authOptions` and `auth()`.
- `src/app/api/auth/[...nextauth]/route.ts`
- `src/app/api/register/route.ts`
- `src/app/(auth)/login/page.tsx`
- `src/app/(auth)/register/page.tsx`
- `src/components/auth/*` (login/register forms, sign-out button)

### Agent B — **Chat-UI**
Owns all client UI: sidebar, message list, composer, model picker, stores.
- `src/app/page.tsx` (authenticated chat home)
- `src/app/c/[id]/page.tsx` (a specific conversation)
- `src/components/chat/*` (Sidebar, MessageList, MessageItem, Composer, ModelPicker, EmptyState)
- `src/components/markdown/Markdown.tsx`
- `src/store/*` (zustand stores)
- `src/lib/sse.ts` (client-side SSE parser helper — Chat-UI owns this)
- **Imports** `FileUpload` from `@/components/upload/FileUpload` (owned by Files).

### Agent C — **Chat-API**
Owns the agent backend and all conversation/message routes.
- `src/lib/agent.ts` — exports `streamChat(...)`.
- `src/app/api/chat/route.ts` (SSE)
- `src/app/api/conversations/route.ts` (GET list, POST create)
- `src/app/api/conversations/[id]/route.ts` (GET, PATCH, DELETE)

### Agent D — **Files**
Owns uploads.
- `src/app/api/upload/route.ts`
- `src/components/upload/FileUpload.tsx` — exports default `FileUpload` with `FileUploadProps`.
- Writes uploaded files to `/uploads` at repo root (served via the upload route or a static path). The `.gitignore` already ignores `/uploads`.

**Rule:** an agent edits only files under its list. Shared types live in
`@/lib/types` (Foundation). If you need a new shared type, it must already be in
`@/lib/types` — coordinate, do not redefine locally.

---

## 2. Exported symbols (the import surface)

### From `@/lib/types` (Foundation — already exists)
Types: `ChatRole`, `Attachment`, `ToolCallRecord`, `ChatMessage`,
`ConversationSummary`, `ConversationDetail`, `AvailableModel`, `StreamEvent`,
`ChatRequest`, `RegisterRequest`, `CreateConversationRequest`,
`UpdateConversationRequest`, `UploadResponse`, `ApiError`, `FileUploadProps`,
`ComposerProps`, `MessageItemProps`, `ReasoningEffort`, `ReasoningEffortOption`,
`McpAuthStatus`, `McpToolInfo`, `McpConnector`, `CreateMcpConnectorRequest`,
`UpdateMcpConnectorRequest`, `McpConnectResponse`.
Values: `MODELS`, `DEFAULT_MODEL`, `REASONING_EFFORTS`, `DEFAULT_EFFORT`.

```ts
type ChatRole = "user" | "assistant" | "system" | "tool";

interface Attachment {
  id: string;
  name: string;
  type: string;      // MIME type
  size: number;      // bytes
  url: string;       // e.g. "/uploads/<id>.png"
  kind: "image" | "file";
}

interface ToolCallRecord { id: string; name: string; args: unknown; output?: unknown; }

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  attachments?: Attachment[];
  toolCalls?: ToolCallRecord[];
  reasoning?: string;    // reasoning summary text (assistant only); see §9
  reasoningMs?: number;  // thinking duration in ms
  createdAt: string; // ISO 8601
}

interface ConversationSummary { id: string; title: string; model: string; updatedAt: string; }
interface ConversationDetail extends ConversationSummary { createdAt: string; messages: ChatMessage[]; }

interface AvailableModel { id: string; label: string; description: string; }

type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "reasoning_delta"; text: string } // reasoning summary chunk; see §9
  | { type: "reasoning_done" }                 // reasoning finished / answer begins; see §9
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; output: unknown }
  | { type: "message_id"; id: string }
  | { type: "title"; title: string }
  | { type: "done" }
  | { type: "error"; message: string };

// Reasoning-effort tiers (UI picker). VERIFIED supported values for the effective
// model gpt-5.4-mini: low | medium | high (also none/xhigh server-side). `minimal`
// is rejected by this model (400) — REASONING_EFFORTS marks it supported:false.
type ReasoningEffort = "minimal" | "low" | "medium" | "high";
interface ReasoningEffortOption { id: ReasoningEffort; label: string; description: string; supported: boolean; }
declare const REASONING_EFFORTS: ReasoningEffortOption[];
declare const DEFAULT_EFFORT: ReasoningEffort; // "medium"

interface ChatRequest { conversationId?: string; message: string; model: string; attachments?: Attachment[]; effort?: ReasoningEffort; }
interface RegisterRequest { name: string; email: string; password: string; }
interface CreateConversationRequest { title?: string; model?: string; }
interface UpdateConversationRequest { title: string; }
interface UploadResponse { attachments: Attachment[]; }
interface ApiError { error: string; }

interface FileUploadProps { onUploaded: (attachments: Attachment[]) => void; disabled?: boolean; }

// --- Connectors (remote MCP servers) ---
type McpAuthStatus = "none" | "pending" | "connected" | "error";
interface McpToolInfo { name: string; description?: string; }
interface McpConnector {
  id: string; name: string; url: string; description?: string;
  enabled: boolean; trusted: boolean;
  authStatus: McpAuthStatus; tools: McpToolInfo[];
  lastError?: string; updatedAt: string; // ISO 8601
}
interface CreateMcpConnectorRequest { name: string; url: string; description?: string; trusted: boolean; }
interface UpdateMcpConnectorRequest { name?: string; description?: string; enabled?: boolean; trusted?: boolean; }
interface McpConnectResponse { connector: McpConnector; authorizationUrl?: string; }
```

> The `McpConnector` DTO is the ONLY MCP shape that crosses the network. Server-only
> secrets on the `McpServer` row (tokens, client secret, PKCE verifier, oauthState,
> oauthMetadata) are NEVER serialized — see §7.

### From `@/lib/db` (Foundation — already exists)
- `export default prisma` — a singleton `PrismaClient`. Import as:
  ```ts
  import prisma from "@/lib/db";
  ```

### From `@/lib/auth` (Agent A — to build)
Exact exports required:
```ts
export const authOptions: NextAuthOptions; // configured below
// Server-side session helper usable in Route Handlers and Server Components:
export function auth(): Promise<Session | null>;
```
- `authOptions` MUST use the Prisma adapter (`@auth/prisma-adapter` or
  `@next-auth/prisma-adapter`) with `prisma` from `@/lib/db`, a **Credentials**
  provider (email + password, verified with `bcryptjs.compare` against
  `User.hashedPassword`), and an **optional** GitHub provider enabled only when
  `process.env.GITHUB_ID` and `GITHUB_SECRET` are set.
- Session strategy: `"jwt"`. The JWT/session callbacks MUST put the user id on
  `session.user.id` (string). Other agents rely on `session.user.id`.
- `auth()` is implemented as `getServerSession(authOptions)`.

### From `@/lib/agent` (Agent C — to build)
Exact signature required:
```ts
import type { ChatMessage, StreamEvent } from "@/lib/types";

export interface StreamChatParams {
  model: string;
  /** Full prior conversation history (oldest first), excluding the new user turn. */
  history: ChatMessage[];
  /** The new user message (already persisted by the caller). */
  userMessage: ChatMessage;
  /** Reasoning effort for this turn (defaults to DEFAULT_EFFORT). See §9. */
  effort?: ReasoningEffort;
}

/** Returns an async iterable of StreamEvent objects produced by the agent. */
export function streamChat(params: StreamChatParams): AsyncIterable<StreamEvent>;
```
- `streamChat` uses `@openai/agents` (+ `openai`) and `process.env.OPENAI_API_KEY`.
- It yields `delta` events for text chunks, `reasoning_delta`/`reasoning_done`
  events for the reasoning summary (§9), optional `tool_call`/`tool_result`
  events, and is expected NOT to yield `message_id`, `title`, or `done` — those
  framing events are emitted by the `/api/chat` route itself. On internal
  failure it may yield an `error` event, but the route is also responsible for
  catching thrown errors and emitting `{ type: "error" }`.

### From `@/lib/mcp` (Connectors — to build)
Server-only helpers for loading and exposing a user's connectors.
```ts
import type { McpConnector } from "@/lib/types";
import type { McpServer } from "@prisma/client";

/** Sanitize a McpServer row to the public DTO (strips all server-only secrets). */
export function toConnectorDTO(row: McpServer): McpConnector;

/** Load a user's enabled + trusted + connected servers as live, connected MCPServer
 *  instances ready to pass to the Agent. Caller MUST close() each in a finally. */
export function loadUserMcpServers(userId: string): Promise<RemoteMCPServer[]>;

/** Ensure a valid (non-expired) access token for a row, refreshing via the OAuth
 *  refresh_token grant when needed; persists rotated tokens. Returns the token or
 *  null when re-auth is required. */
export function ensureAccessToken(row: McpServer): Promise<string | null>;
```

### From `@/lib/mcp/client` (Connectors — to build)
The MCPServer implementation over JSON-RPC 2.0 / Streamable HTTP (§10), plus a probe.
```ts
import type { MCPServer, MCPTool, CallToolResultContent } from "@openai/agents-core";
import type { McpToolInfo } from "@/lib/types";

/** Implements the @openai/agents-core MCPServer interface for a remote
 *  Streamable-HTTP server. Handles initialize + session id + SSE/JSON
 *  responses + Bearer auth. */
export class RemoteMCPServer implements MCPServer {
  cacheToolsList: boolean;
  readonly name: string;
  constructor(opts: { name: string; url: string; token?: string });
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<MCPTool[]>;
  callTool(toolName: string, args: Record<string, unknown> | null): Promise<CallToolResultContent>;
}

/** One-shot connectivity/tools check: initialize + tools/list. On 401 returns
 *  { needsAuth: true, wwwAuthenticate? }; on success returns the tool list. */
export function probeMcpServer(url: string, token?: string): Promise<
  | { ok: true; tools: McpToolInfo[] }
  | { ok: false; needsAuth: boolean; wwwAuthenticate?: string; error?: string }
>;
```

### From `@/lib/mcp/oauth` (Connectors — to build)
OAuth 2.1 helpers (PKCE, dynamic client registration, authorization-server metadata
discovery, code + refresh token exchange). Redirect URI is fixed:
`${process.env.NEXTAUTH_URL}/api/mcp/oauth/callback`. All secrets stay server-side.
```ts
/** Generate a PKCE verifier/challenge pair (S256) via Node crypto. */
export function generatePkce(): { verifier: string; challenge: string };

/** Discover the authorization server metadata + register a client if needed,
 *  then build the authorization URL (with PKCE + state). Persists clientId/secret,
 *  pkceVerifier, oauthState, oauthMetadata on the row. */
export function beginAuthorization(row: McpServer, wwwAuthenticate?: string): Promise<string>; // authorizationUrl

/** Exchange an authorization code for tokens (validates state, uses pkceVerifier),
 *  persists accessToken/refreshToken/tokenExpiresAt and clears the verifier/state. */
export function completeAuthorization(state: string, code: string): Promise<McpServer>;
```

### From `@/components/upload/FileUpload` (Agent D — to build)
```ts
import type { FileUploadProps } from "@/lib/types";
export default function FileUpload(props: FileUploadProps): JSX.Element;
```
Renders an attach button (and file input). On successful upload it calls
`props.onUploaded(attachments)` with the parsed `Attachment[]` from the upload
endpoint. Honors `props.disabled`.

---

## 3. Auth & session pattern for Route Handlers

All app API routes (except `/api/auth/*` and `/api/register`) require an
authenticated user. Use this exact pattern:

```ts
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
  }
  const userId = session.user.id;
  // ...
}
```

`session.user.id` is guaranteed present by Agent A's callbacks. A NextAuth
module augmentation declaring `id` on `Session["user"]` lives in `@/lib/auth`
(or a `types/next-auth.d.ts` owned by Agent A). Other agents simply read
`session.user.id` and may rely on it being a `string` after the null check.

Ownership checks: routes that touch a conversation MUST verify the conversation
`userId === session.user.id` and return `404` (not 403) if not found/owned.

---

## 4. API routes

### `POST /api/chat` — stream a reply (SSE) — **Auth required** — Agent C
**Request body** (`ChatRequest`):
```json
{ "conversationId": "abc123", "message": "Hello", "model": "gpt-4o", "attachments": [], "effort": "medium" }
```
- `conversationId` optional. If omitted, the route creates a new conversation
  owned by the user (title `"New chat"`, given `model`) and emits its id (see below).
- `message` required, non-empty after trim.
- `model` required; must be one of `MODELS[].id`. Reject unknown with `400`.
- `attachments` optional `Attachment[]`.
- `effort` optional `ReasoningEffort`. Defaults to `DEFAULT_EFFORT` (`"medium"`)
  when omitted. The server coerces unsupported values (e.g. `"minimal"` for the
  current model) to `DEFAULT_EFFORT`; never reject with `400` on effort. Passed
  through to `streamChat({ ..., effort })`. See §9.

**Behavior:**
1. Auth-check. Persist the user `Message` (role `"user"`, content = `message`,
   attachments JSON-encoded).
2. Stream the assistant reply via `streamChat(...)`, forwarding `effort`.
3. Persist the final assistant `Message` (role `"assistant"`), including the
   accumulated `reasoning` summary text and `reasoningMs` (null if none), and
   update the conversation `updatedAt`.
4. If the conversation had the default title and this is the first exchange,
   generate a short title and emit a `title` event.

**Response:** `Content-Type: text/event-stream`. The conversation id (new or
existing) is returned via the response header `X-Conversation-Id`. The client
reads this header BEFORE iterating the stream. The body is a sequence of SSE
events (see §5) in this order:
1. `{ "type": "message_id", "id": "<assistantMessageId>" }` once, near the start.
   This is the id of the assistant message being streamed (NOT the conversation id).
2. zero or more `{ "type": "reasoning_delta", "text": "..." }` (reasoning summary,
   streamed BEFORE the answer text), then `{ "type": "reasoning_done" }` once when
   the summary ends / the answer begins. Omitted entirely when there is no
   reasoning summary. See §9.
3. zero or more `{ "type": "delta", "text": "..." }`
4. optional `tool_call` / `tool_result` pairs interleaved
5. optional `{ "type": "title", "title": "..." }`
6. terminal `{ "type": "done" }` — always sent on success.
7. On error at any point: `{ "type": "error", "message": "..." }` then close.

> **Conversation id contract (authoritative):** The response sets header
> `X-Conversation-Id` to the conversation id (new or existing). The assistant
> message id is delivered via the `message_id` stream event. Clients: read the
> header, then parse the stream.

**Status codes:** `200` (stream), `400` (bad body/model), `401` (unauth),
`404` (conversationId not found/owned).

---

### `GET /api/conversations` — list — **Auth required** — Agent C
**Response 200:** `ConversationSummary[]`, ordered by `updatedAt` desc.
```json
[ { "id": "c1", "title": "Trip ideas", "model": "gpt-4o", "updatedAt": "2026-06-17T10:00:00.000Z" } ]
```

### `POST /api/conversations` — create — **Auth required** — Agent C
**Request** (`CreateConversationRequest`): `{ "title"?: string, "model"?: string }`.
Defaults: `title = "New chat"`, `model = DEFAULT_MODEL`.
**Response 201:** `ConversationSummary`.

### `GET /api/conversations/[id]` — fetch one — **Auth required** — Agent C
**Response 200:** `ConversationDetail` (includes `messages` oldest-first, with
`attachments`/`toolCalls` decoded from JSON into arrays).
**404** if not found/owned.

### `PATCH /api/conversations/[id]` — rename — **Auth required** — Agent C
**Request** (`UpdateConversationRequest`): `{ "title": "New title" }` (non-empty).
**Response 200:** `ConversationSummary`. **400** empty title. **404** if not owned.

### `DELETE /api/conversations/[id]` — delete — **Auth required** — Agent C
Cascades to messages (Prisma `onDelete: Cascade`).
**Response 200:** `{ "success": true }`. **404** if not owned.

---

### `GET /api/mcp` — list connectors — **Auth required** — Connectors
**Response 200:** `McpConnector[]` (sanitized; no secrets), ordered by `updatedAt` desc.

### `POST /api/mcp` — add a connector — **Auth required** — Connectors
**Request** (`CreateMcpConnectorRequest`): `{ "name": string, "url": string, "description"?: string, "trusted": boolean }`.
- `name`/`url` required, non-empty; `url` must be a valid http(s) URL. Reject with `400`.
Creates the `McpServer` row (`enabled` default true, `authStatus` "pending"). Does
NOT connect/authorize yet (that is `POST /api/mcp/[id]/connect`).
**Response 201:** `McpConnector`.

### `GET /api/mcp/[id]` — fetch one — **Auth required** — Connectors
**Response 200:** `McpConnector`. **404** if not found/owned.

### `PATCH /api/mcp/[id]` — update — **Auth required** — Connectors
**Request** (`UpdateMcpConnectorRequest`): any of `{ name?, description?, enabled?, trusted? }`.
Flipping the per-connector trust toggle is done here (`trusted`).
**Response 200:** `McpConnector`. **400** empty `name`. **404** if not owned.

### `DELETE /api/mcp/[id]` — remove — **Auth required** — Connectors
Deletes the row (and its cached tokens/tools).
**Response 200:** `{ "success": true }`. **404** if not owned.

### `POST /api/mcp/[id]/connect` — connect / (re)authorize — **Auth required** — Connectors
Probes the server (initialize + tools/list, §10) using any stored token.
- On success: caches tools (`toolsCache`), sets `authStatus` "connected", clears `lastError`.
- On `401` (OAuth required): begins OAuth (§4 callback), sets `authStatus` "pending",
  returns the `authorizationUrl` for the client to open in a popup.
- On other failure: `authStatus` "error", records `lastError`.
**Response 200** (`McpConnectResponse`): `{ "connector": McpConnector, "authorizationUrl"?: string }`.
**404** if not owned.

### `GET /api/mcp/oauth/callback` — OAuth redirect target — **public** — Connectors
The fixed redirect URI `${NEXTAUTH_URL}/api/mcp/oauth/callback`. Query: `code`, `state`
(or `error`). Validates `state` against the matching row, exchanges `code` for tokens
(PKCE), persists tokens, sets `authStatus` "connected", and re-probes/caches tools.
**Response 200:** an HTML page (not JSON) that closes the OAuth popup (e.g.
`window.close()` / posts to the opener) so the connectors UI can refresh. Renders a
short error page on failure.

---

### `GET/POST /api/auth/[...nextauth]` — NextAuth — Agent A
Standard NextAuth handler: `const handler = NextAuth(authOptions); export { handler as GET, handler as POST };`

### `POST /api/register` — create account — **public** — Agent A
**Request** (`RegisterRequest`): `{ "name": string, "email": string, "password": string }`.
- Validate: name non-empty, email looks valid, password length ≥ 8.
- `409` if email already exists.
- Hash password with `bcryptjs` (≥ 10 rounds), create `User` with `hashedPassword`.
**Response 201:** `{ "id": string, "email": string, "name": string | null }`.
**400** on validation error (`ApiError` shape), **409** on duplicate.

---

### `POST /api/upload` — upload files/images — **Auth required** — Agent D
**Request:** `multipart/form-data` with one or more parts under field name
`files` (the client may append multiple `files` entries). Accept images and
common documents. Enforce a per-file size cap (recommended 20 MB) and return
`400` for rejected files.
**Behavior:** persist each file under `/uploads` (repo root) with a `nanoid`-based
filename, preserving extension. Build an `Attachment` per file:
- `id`: `nanoid()`
- `name`: original filename
- `type`: the file's MIME type
- `size`: bytes
- `url`: `"/uploads/<storedFilename>"`
- `kind`: `"image"` if `type` starts with `image/`, else `"file"`.
**Response 200** (`UploadResponse`): `{ "attachments": Attachment[] }`.
**401** unauth, **400** bad/oversized.

> Files written to `/uploads` are served by the upload area. If Next.js static
> serving of `/uploads` is needed, Agent D may add a GET route at
> `src/app/api/upload/[...path]/route.ts` OR write into `public/uploads` and use
> `/uploads/...` URLs. **Decision:** write to `public/uploads/` so URLs of the
> form `/uploads/<file>` are statically served by Next. `url` is therefore
> `"/uploads/<storedFilename>"`. (`.gitignore` ignores top-level `/uploads`;
> Agent D adds `public/uploads/` ignore if desired — do not edit `.gitignore`,
> just create the dir at runtime.)

---

## 5. SSE wire format (authoritative)

The server writes UTF-8 text. Each `StreamEvent` is serialized as JSON and sent
as exactly one SSE message:

```
data: {"type":"delta","text":"Hello"}\n\n
```

- One `data:` line per event, followed by a blank line (`\n\n`).
- No `event:` field is used; the discriminant is the JSON `type`.
- The client splits the incoming text stream on `\n\n`, strips the leading
  `data: ` (5 chars + space) from each chunk, and `JSON.parse`s the remainder
  into a `StreamEvent`. Ignore empty segments and lines that don't start with
  `data:` (e.g. SSE comments / keep-alive `: ping`).

**Server helper pattern (Agent C):**
```ts
const encoder = new TextEncoder();
function sse(event: StreamEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}
return new Response(stream, {
  headers: {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Conversation-Id": conversationId,
  },
});
```

**Client parse pattern (Agent B, in `@/lib/sse.ts`):**
```ts
import type { StreamEvent } from "@/lib/types";

export async function* parseSSE(res: Response): AsyncGenerator<StreamEvent> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const json = line.slice(line.indexOf(":") + 1).trim();
      if (!json) continue;
      yield JSON.parse(json) as StreamEvent;
    }
  }
}
```

The client reads `res.headers.get("X-Conversation-Id")` before iterating.

---

## 6. Component contract (Chat-UI ↔ Files)

The composer (owned by Chat-UI) renders the upload button by importing the
Files-owned component:

```tsx
import FileUpload from "@/components/upload/FileUpload";
import type { Attachment } from "@/lib/types";

<FileUpload
  onUploaded={(a: Attachment[]) => setAttachments((prev) => [...prev, ...a])}
  disabled={isStreaming}
/>
```

- `FileUpload` MUST call `POST /api/upload` itself and return parsed
  `Attachment[]` via `onUploaded`. The composer does not perform the upload.
- `FileUpload` must accept exactly `FileUploadProps` ({ `onUploaded`, `disabled?` }).
- Chat-UI is responsible for displaying attachment chips/previews from the
  `Attachment[]` it accumulates, and for clearing them after send.

The composer's own props are `ComposerProps` (see `@/lib/types`). The message
renderer uses `MessageItemProps`.

---

## 7. Data model reference (Prisma — Foundation, fixed)

- `User(id, name?, email unique, hashedPassword?, image?, createdAt, accounts, sessions, conversations)`
- `Account`, `Session`, `VerificationToken` — standard NextAuth shapes.
- `Conversation(id, title default "New chat", userId, model, createdAt, updatedAt, messages)` — index on `userId`.
- `Message(id, conversationId, role, content, attachments? (JSON string), toolCalls? (JSON string), reasoning? (String), reasoningMs? (Int), createdAt)` — index on `conversationId`.
  - `reasoning` / `reasoningMs` are nullable columns holding the assistant's
    reasoning summary text and thinking duration (ms). Decode straight to
    `ChatMessage.reasoning` / `ChatMessage.reasoningMs` (or `undefined` when null).

- `McpServer(id, userId, name, url, description?, enabled (Bool, default true), trusted (Bool, default false), authStatus (String, default "pending"), oauthClientId?, oauthClientSecret?, oauthMetadata? (JSON string), accessToken?, refreshToken?, tokenExpiresAt? (DateTime), pkceVerifier?, oauthState?, toolsCache? (JSON string of McpToolInfo[]), lastError?, createdAt, updatedAt)` — relation `User.mcpServers`; index on `userId`.
  - **Server-only columns (NEVER serialized over the API):** `oauthClientId`,
    `oauthClientSecret`, `oauthMetadata`, `accessToken`, `refreshToken`,
    `tokenExpiresAt`, `pkceVerifier`, `oauthState`. The API returns the sanitized
    `McpConnector` DTO only (via `toConnectorDTO`, §2): `tools` is decoded from
    `toolsCache` (or `[]`), `authStatus` is cast to `McpAuthStatus`, `updatedAt` is
    `date.toISOString()`.

**Serialization rule:** `Message.attachments` and `Message.toolCalls` are stored
as JSON strings (or `null`). When returning `ChatMessage` over the API, decode
them to `Attachment[]` / `ToolCallRecord[]` (or `undefined`). When persisting,
`JSON.stringify` the arrays (store `null` if empty/absent). `createdAt` is sent
as `date.toISOString()`.

---

## 8. Conventions

- All route handlers: `export const runtime = "nodejs";` (Prisma + bcrypt +
  filesystem require Node, not Edge). The chat route also needs Node for streaming.
- JSON responses use `Response.json(...)`. Errors use `{ error: string }` (`ApiError`).
- Use `nanoid` for upload ids; Prisma `cuid()` for DB ids (already defaulted).
- Client state: zustand stores under `src/store/` (Agent B). Do not put server
  secrets in client code; only `NEXT_PUBLIC_*` env vars are client-visible (none required).
- After auth, unauthenticated users hitting `/` are redirected to `/login`
  (Agent B/A coordinate via `auth()` in the server component or middleware;
  middleware, if added, is owned by Agent A as `src/middleware.ts`).

---

## 9. Reasoning / "Thinking" (authoritative)

The effective model (`gpt-5.4-mini`) is a reasoning model. Users pick a
reasoning effort next to the model picker; the model streams a reasoning
*summary* which the UI renders in a collapsible "Thinking" block
above the answer.

### Wire flow
1. Client sends `ChatRequest.effort` (one of `ReasoningEffort`; default
   `DEFAULT_EFFORT = "medium"`).
2. `/api/chat` forwards it to `streamChat({ ..., effort })`. The server coerces
   any value the model doesn't support to `DEFAULT_EFFORT` (do NOT 400).
3. As the model reasons, the server emits ordered SSE events:
   `{ "type": "reasoning_delta", "text": "<chunk>" }` (0..N), then exactly one
   `{ "type": "reasoning_done" }` when the summary finishes / the answer text
   begins. Then the normal `delta` answer events follow. If the model produces
   no summary, neither reasoning event is emitted.
4. Client accumulates `reasoning_delta.text` into the current assistant
   message's `reasoning` field; while reasoning streams it shows an animated
   "Thinking…" block. On `reasoning_done` (or when the first answer `delta`
   arrives) it records the elapsed time as `reasoningMs` and collapses the block
   to "Thought for Ns" (re-expandable).
5. The route persists `reasoning` + `reasoningMs` on the assistant `Message`, so
   the Thinking block survives reloads (`GET /api/conversations/[id]` returns
   them on each `ChatMessage`).

### Backend implementation (VERIFIED — build verbatim)
The SDK in use is `@openai/agents-core` whose `ModelSettings` has **no**
top-level `reasoning` field; reasoning is passed via `providerData`, which the
OpenAI-Responses provider spreads directly into the request body. Pass it on the
Agent (verified working against the Azure endpoint):

```ts
const agent = new Agent({
  name: "Assistant",
  instructions: INSTRUCTIONS,
  model: resolveModel(model),
  tools: agentTools,
  modelSettings: {
    providerData: { reasoning: { effort, summary: "auto" } },
  },
});
```

`summary: "auto"` is required for the endpoint to STREAM a summary.

Reasoning summary deltas arrive as `raw_model_stream_event`s. The Agents SDK
wraps the provider's native Responses SSE event: `event.data.type === "model"`
and the native event is at `event.data.event` with its own `.type`. Map them:

```ts
if (event.type === "raw_model_stream_event") {
  const data = event.data as { type?: string; delta?: unknown; event?: { type?: string; delta?: unknown } };

  // Final answer text:
  if (data.type === "output_text_delta" && typeof data.delta === "string") {
    if (data.delta.length) yield { type: "delta", text: data.delta };
    return; // (continue in the loop)
  }

  // Reasoning summary text (wrapped under the "model" raw event):
  if (data.type === "model" && data.event) {
    const ev = data.event;
    if (ev.type === "response.reasoning_summary_text.delta" && typeof ev.delta === "string") {
      if (ev.delta.length) yield { type: "reasoning_delta", text: ev.delta };
    } else if (ev.type === "response.reasoning_summary_text.done") {
      yield { type: "reasoning_done" };
    }
  }
}
```

VERIFIED native event type strings (Azure Responses, streaming):
- reasoning summary chunk: **`response.reasoning_summary_text.delta`** (string `.delta`)
- reasoning summary end:   **`response.reasoning_summary_text.done`**
- (also seen: `response.reasoning_summary_part.added` / `...part.done` — boundaries)
- final answer chunk:      **`response.output_text.delta`**, surfaced by the SDK
  directly as `event.data.type === "output_text_delta"` (string `.delta`).

If `reasoning_done` is never observed but answer `delta`s start, emit
`reasoning_done` on the first answer `delta` so the client can collapse.

### VERIFIED effort support (effective model `gpt-5.4-mini` / `gpt-5.4-mini-2026-03-17`)
- `minimal` → **400** `unsupported_value`: *"'minimal' is not supported … Supported
  values are: 'none', 'low', 'medium', 'high', and 'xhigh'."*
- `low` → **200**, `medium` → **200**, `high` → **200**.
- Non-streaming summary JSON path: `output[]` contains an item with
  `type:"reasoning"` whose `summary` is an array of `{ type:"summary_text", text }`
  → `response.output[?type=="reasoning"].summary[].text`. The top-level request
  echo `reasoning:{effort,summary}` is also present.

---

## 10. Scheduled tasks (authoritative)

Claude-Desktop-style **automations**: a saved prompt + cron schedule fires on its own
cadence. **New conversation per run** — each fire seeds a brand-new `Conversation`
(with the schedule's prompt as the first user message), runs the agent as the owning
user, persists the assistant reply, and links the thread back via
`Conversation.scheduleId`. Every fire attempt is logged as a `ScheduleRun`. The UI lives
at `/schedules`.

### Data model (Prisma — Foundation, fixed; do NOT edit the schema)
- `Schedule` — `id`, `userId`, `title`, `prompt`, `model`, `effort` (String, default
  `"medium"`), `cron` (String, 5-field), `timezone` (String, default `"UTC"`),
  `enabled` (Boolean, default true), `nextRunAt` (DateTime?), `lastRunAt` (DateTime?),
  `createdAt`, `updatedAt`. Relations: `user`, `runs` (`ScheduleRun[]`),
  `conversations` (`Conversation[]`).
- `ScheduleRun` — `id`, `scheduleId`, `status` (String, default `"running"` →
  `"running" | "success" | "error"`), `trigger` (String, default `"cron"` →
  `"cron" | "manual"`), `conversationId` (String?), `error` (String?), `startedAt`
  (DateTime, default now), `finishedAt` (DateTime?). Relation `schedule` with real FK
  `onDelete: Cascade`.
- `Conversation.scheduleId` (String?) — new nullable column. **Caveat:** SQLite could
  not add the FK via `ALTER`, so there is **NO database-level FK** from
  `Conversation.scheduleId → Schedule`. Therefore `DELETE /api/schedules/[id]` MUST
  manually null `Conversation.scheduleId` for that schedule **before** deleting the
  `Schedule` (only `ScheduleRun` rows cascade, via their real FK).

### DTOs (from `@/lib/types` — Foundation, already exists)
`ScheduleTrigger`, `ScheduleRunStatus`, `ScheduleRunSummary`, `ScheduleSummary`
(adds enriched `description` + `lastRun`), `ScheduleDetail` (adds `runs[]`),
`CreateScheduleRequest`, `UpdateScheduleRequest`, `CronPreviewResponse`,
`CronTriggerResult`. Dates serialize as `toISOString()`; `null` stays `null`.

### `src/lib/schedule/cron.ts` (SERVER-ONLY — never import from a client component)
- `DEFAULT_TIMEZONE = "UTC"`, `PREVIEW_RUN_COUNT = 3`.
- `isValidTimeZone(tz)`, `normalizeTimeZone(tz)` → valid IANA or `"UTC"`.
- `describeCron(expr)` (cronstrue, safe fallback).
- `validateCron(expr)` → `{ valid, description?, error? }` (requires 5 fields).
- `computeNextRun(expr, timezone, from?=now)` → next fire strictly after `from`, in `tz`.
- `nextRuns(expr, timezone, count?=3, from?=now)` → `Date[]`.

### `src/lib/schedule/presets.ts` (PURE, client-safe — no external deps)
- `PresetId = "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom"`.
- `SchedulePreset`, `SCHEDULE_PRESETS`, `WEEKDAYS`, `PresetOptions`.
- `buildCron(preset, opts?)` → cron string; `detectPreset(cron)` → `{ preset } & PresetOptions`.

### `src/lib/schedule/runner.ts` (frozen API — others import it)
- `runDueSchedules(opts?: { now?, wait? })` → `{ started }`.
  - Finds enabled schedules with `nextRunAt <= now`.
  - Claims each **atomically** via compare-and-swap on `nextRunAt`:
    `updateMany({ where: { id, nextRunAt: <exact current value>, enabled: true },
    data: { nextRunAt: computeNextRun(cron, timezone, now), lastRunAt: now } })` — proceed
    only when the update count `=== 1`. This is what prevents ticker + cron double-firing.
  - `wait === true` → await every claimed run (used by `/api/cron` so serverless finishes
    the work); `wait === false` → fire-and-forget, return the claimed count immediately
    (used by the ticker). Returns `{ started }` = schedules claimed this tick.
- `runScheduleNow(scheduleId, userId)` →
  `{ runId, conversationId } | null`. Ownership check (`schedule.userId === userId`;
  `null` if missing/not owned). `trigger = "manual"`; does **not** shift
  `nextRunAt`/`lastRunAt` (manual runs never change the cadence).
- Internal `executeScheduleRun` per fire: (1) create `ScheduleRun` `running`; (2) create
  `Conversation { userId, title, model, scheduleId }`; (3) set `ScheduleRun.conversationId`;
  (4) persist user `Message` (the prompt); (5) `runChatCompletion({ model, history:[],
  userMessage, effort, userId })`; (6) persist assistant `Message` (`toolCalls`/`reasoning`/
  `reasoningMs`; JSON columns store `JSON.stringify(arr)` when non-empty else `null`);
  (7) bump `Conversation.updatedAt`; (8) update `ScheduleRun` → `success`/`error` + `error`
  + `finishedAt`. Wrapped in try/catch so one schedule's failure never aborts the loop.

### `src/lib/schedule/ticker.ts`
- `startScheduler()` — idempotent (guard on `globalThis`); `setInterval(60s)` →
  `runDueSchedules({ wait: false })`, plus one warm-up tick ~5s after boot; the interval
  handle is stored on `globalThis` (HMR-safe). Started from the Next.js **instrumentation**
  hook only when `SCHEDULER_ENABLED=1`.

### API routes (all `runtime="nodejs"`; auth required unless noted)
- `GET /api/schedules` — `ScheduleSummary[]` (this user's, newest first; enrich
  `description` + `lastRun`).
- `POST /api/schedules` — **201** `ScheduleSummary`. Validate cron (**400** on invalid),
  normalize tz, compute `nextRunAt` (`enabled ? computeNextRun : null`). Body:
  `CreateScheduleRequest`.
- `GET /api/schedules/preview?cron=..&tz=..` — `CronPreviewResponse` (`validateCron` +
  `nextRuns`). Auth required.
- `GET /api/schedules/[id]` — `ScheduleDetail` (include recent runs, newest first, cap
  ~20). **404** if not owned.
- `PATCH /api/schedules/[id]` — `ScheduleSummary` (edit-in-place). If
  `cron`/`timezone`/`enabled` changed, recompute `nextRunAt` (`= null` when disabled).
  Validate cron if provided.
- `DELETE /api/schedules/[id]` — `{ success: true }`. **FIRST** null
  `Conversation.scheduleId` for this schedule, **THEN** delete the schedule (runs cascade).
  **404** if not owned.
- `POST /api/schedules/[id]/run` — run now (manual). Returns the created
  `ScheduleRunSummary` (**200**) or **404**.
- `GET/POST /api/cron` — **public**, guarded by `CRON_SECRET`. Accept the secret via
  `Authorization: Bearer <CRON_SECRET>` **or** `X-Cron-Secret: <CRON_SECRET>`.
  `CRON_SECRET` unset → **503** `{ error }`; bad/missing secret → **401**. On success calls
  `runDueSchedules({ wait: true })` and returns `CronTriggerResult` (`{ started, at }`).

### Triggers & env
Both an in-process 60s ticker (`SCHEDULER_ENABLED=1`, via instrumentation; needs a
persistent Node server) and the `CRON_SECRET`-guarded `/api/cron` endpoint funnel into the
**same** `runDueSchedules()`. The CAS claim above makes concurrent triggers safe.

---

## 11. Projects (workspaces — authoritative)

A **Project** groups conversations around a shared purpose and carries **custom
instructions** + **knowledge files** that are injected into the system prompt for
**every chat in the project**. UI lives at `/projects` and `/projects/[id]`.

### Data model (Prisma — additive; applied to dev.db via hand-written SQL, NOT
`prisma db push`, because dev.db carries orphan tables a full push would drop)
- `Project` — `id`, `userId`, `name`, `description?`, `instructions?`, `createdAt`,
  `updatedAt`. Relations: `user`, `files` (`ProjectFile[]`), `conversations`
  (`Conversation[]`). Index on `userId`.
- `ProjectFile` — `id`, `projectId`, `name`, `type` (MIME), `size` (Int), `url`
  (`/uploads/<stored>`), `content?` (extracted UTF-8 text; null when unsupported/
  failed), `createdAt`. Real FK `onDelete: Cascade`. Index on `projectId`.
- `Conversation.projectId` (String?) — new nullable column + `project` relation.
  **Caveat (same as `scheduleId`):** SQLite has **NO enforced DB-level FK** on this
  column, so `DELETE /api/projects/[id]` MUST cascade conversations **manually**.

### DTOs (from `@/lib/types`)
`ProjectSummary` (`+conversationCount/fileCount`), `ProjectFileInfo`
(`hasContent` = text was extracted), `ProjectDetail` (`+files[] +conversations[]`),
`CreateProjectRequest`, `UpdateProjectRequest` (partial; `description`/`instructions`
accept string OR null-to-clear), `UploadProjectFilesResponse`. Consts
`MAX_PROJECT_FILES = 20`, `MAX_PROJECT_KNOWLEDGE_CHARS = 100_000`.
`ConversationSummary` gained `projectId: string | null`; `CreateConversationRequest`
and `ChatRequest` gained optional `projectId`; `UpdateConversationRequest` is now
`{ title?; projectId?: string | null }` (rename and/or move; ≥1 field required).

### Serializers / helpers
- `@/lib/conversations` → `toConversationSummary(row)`.
- `@/lib/projects/dto` → `toProjectSummary`, `toProjectDetail`, `toProjectFileInfo`.
- `@/lib/projects/prompt` → `composeProjectContext(project)` (pure; null when nothing
  to inject; caps knowledge at `MAX_PROJECT_KNOWLEDGE_CHARS`) and
  `loadProjectContext(prisma, projectId)` (never throws → null).
- `@/lib/projects/extract` → `extractProjectFileText(filePath, mime)` (text/* + PDF via
  `unpdf`; null otherwise; cap `MAX_EXTRACTED_CHARS = 200_000`).

### Prompt injection (the point of the feature)
`StreamChatParams.projectContext?: string` is appended after the base `INSTRUCTIONS`
in `@/lib/agent`. `POST /api/chat` resolves the conversation's `projectId`, calls
`loadProjectContext`, and forwards it. Non-project chats get no extra context.
New chats attach to a project via `ChatRequest.projectId` (server validates ownership;
unknown/unowned id ignored). Scheduled-run chats have no project.

### API routes (all `runtime="nodejs"`; auth required; ownership → 404, never 403)
- `GET /api/projects` → `ProjectSummary[]` (this user's, newest first, `_count`).
- `POST /api/projects` → **201** `ProjectSummary`. `name` required (400 empty).
- `GET /api/projects/[id]` → `ProjectDetail` (files newest-first, member chats).
- `PATCH /api/projects/[id]` → `ProjectSummary` (edit-in-place; ≥1 field).
- `DELETE /api/projects/[id]` → `{ success: true }`. Order: capture file urls →
  `conversation.deleteMany({ projectId, userId })` (chats+messages+artifacts cascade
  via real FKs) → `project.delete` (ProjectFile rows cascade) → best-effort `unlink`
  the on-disk uploads. **Deleting a project deletes its chats**.
- `POST /api/projects/[id]/files` (multipart `files`) → **200** `UploadProjectFilesResponse`.
  Reuses `@/lib/storage` (`validateFile`/`saveFiles`), enforces `MAX_PROJECT_FILES`,
  extracts text per file. `GET` lists them. `DELETE …/files/[fileId]` removes one
  (row + best-effort disk unlink).
- Conversation move: `PATCH /api/conversations/[id]` with `{ projectId: "<id>" | null }`
  (validates target ownership → 404).

### Client
- `@/store/projects` (`useProjectStore`): list + open `detail`, `load/loadDetail`
  (out-of-order-safe via a request token), `create/update/remove`, `uploadFiles/removeFile`.
- `@/store/chat`: `activeProjectId`, `newChat(projectId?)`, `moveConversationToProject`
  (reverts list **and** `activeProjectId` on failure; refreshes project counts on success);
  `sendMessage` seeds `projectId` only for brand-new conversations.
- UI: Sidebar Projects nav + recent-projects list + "Move to project" dialog; `/projects`
  grid + create modal (`ProjectForm`); `/projects/[id]` detail (`ProjectDetail`: editable
  instructions, knowledge upload/list, member chats, "New chat" → `/?project=<id>`);
  ChatApp reads `?project=` and shows a project chip.

### Upload security (shared `@/lib/storage`)
The stored on-disk extension is derived from the **validated MIME type**
(`MIME_TO_EXTENSION`), never the untrusted filename — an allowlisted type can never be
written with an active-content extension (`.html`/`.svg`), closing a same-origin stored-XSS
vector (`/uploads` is public). Applies to all upload paths (attachments + project files).

---

## 12. Deep Research (authoritative)

**Deep Research**: a composer toggle runs a two-phase research flow that streams a
**cited report inline** as the assistant message's content, beneath a live **Research** activity panel.
It reuses the existing SSE stream, the `web_search`/`web_fetch` tools (SSRF-guarded), and the reasoning
plumbing (§9). Depth is fixed **"Standard"**: ~4 subtopics × ~3 sources ≈ ~12 page reads. No depth picker.

### Request flag (from `@/lib/types` — Foundation, already exists)
`ChatRequest` gains an optional `deepResearch` flag:
```ts
interface ChatRequest {
  conversationId?: string; message: string; model: string;
  attachments?: Attachment[]; effort?: ReasoningEffort;
  deepResearch?: boolean; // ← turns this turn into a Deep Research run
}
```

### Stream events + state types (from `@/lib/types` — Foundation, already exists)
`StreamEvent` gains two variants alongside the existing ones (§5):
```ts
type StreamEvent =
  | /* ...existing delta / reasoning_* / tool_* / message_id / title / done / error... */
  | { type: "research_plan"; plan: ResearchPlan }
  | { type: "research_activity"; activity: ResearchActivity };

type ResearchPhase = "clarifying" | "researching" | "report";
interface ResearchPlan { title: string; subtopics: { title: string; queries: string[] }[]; }

type ResearchActivityKind = "search" | "source" | "analyze" | "synthesize";
type ResearchActivityStatus = "active" | "done" | "failed";
interface ResearchActivity {
  id: string; kind: ResearchActivityKind; title: string; url?: string;
  status: ResearchActivityStatus;
}

interface ResearchState {
  phase: ResearchPhase; brief?: string; plan?: ResearchPlan;
  activities?: ResearchActivity[]; sourceCount?: number;
}
```
`ChatMessage` gains `research?: ResearchState` (assistant only). The client accumulates the
`research_plan` + `research_activity` events into it and renders the collapsible **Research** panel
above the report; the panel and report survive reloads via the persisted column below.

### Data model (Prisma — Foundation, fixed; do NOT edit the schema)
- `Message.research` (`String?`) — nullable JSON-encoded `ResearchState`. Persist with
  `JSON.stringify(state)` (or `null` when absent); decode straight to `ChatMessage.research`
  (or `undefined` when null), same serialization rule as `attachments`/`toolCalls` (§7).

### Route logic — `POST /api/chat` with `deepResearch: true` (Agent C)
When the request body carries `deepResearch: true`, the route runs a **two-phase** branch instead of
`streamChat(...)`. Framing (`message_id` / `title` / `done` / `X-Conversation-Id`), persistence, and
`effort` handling are unchanged (§4); only the event source differs, and the route still owns all
framing events (the orchestrator never yields `message_id` / `title` / `done`):

1. **Clarify (first Deep-Research turn).** If this is the first Deep-Research turn in the conversation
   (no prior research answers), stream **`streamClarifyingQuestions(...)`** — 2–3 concise clarifying
   questions as an ordinary assistant `delta` message. Persist it like any assistant turn; do NOT run
   research yet. The assistant `Message.research.phase` is `"clarifying"`.
2. **Research + report (next turn).** On the following turn — the user's answers — build a `brief` from
   the original query + answers and stream **`streamDeepResearch(...)`**: one `research_plan`, then many
   `research_activity` events (searches, per-source reads, an analyze step, a synthesize step), then the
   `reasoning_*` + `delta` report. The route accumulates the plan/activities/deltas into the final
   `ResearchState` and persists it on `Message.research`.

### Orchestrator API — `@/lib/research/orchestrator` (to build)
Both functions return `AsyncIterable<StreamEvent>` and **never throw** — they yield an `error` event on
failure:
```ts
import type { ChatMessage, StreamEvent, ReasoningEffort } from "@/lib/types";

/** First turn: stream 2–3 concise clarifying questions (a short numbered markdown list) as `delta`
 *  (+ optional reasoning_*). Never throws. */
export function streamClarifyingQuestions(p: {
  query: string; history: ChatMessage[]; model: string; effort?: ReasoningEffort;
}): AsyncIterable<StreamEvent>;

/** Full pipeline. Yields (in order): one `research_plan`; many `research_activity` (search
 *  started/finished, each source reading/read/failed, an analyze step, a synthesize step); then
 *  `reasoning_*` + `delta` for the streamed cited report. Runs ~12 web_search/web_fetch reads.
 *  Never throws. */
export function streamDeepResearch(p: {
  brief: string; model: string; effort?: ReasoningEffort;
  userId: string; conversationId: string;
}): AsyncIterable<StreamEvent>;
```

### Agent primitives — `@/lib/agent` (Foundation, already exists)
Tool-less LLM helpers the orchestrator builds on (separate from `streamChat` / `runChatCompletion`):
```ts
interface CompletionParams { system: string; user: string; model: string; effort?: ReasoningEffort; }

/** Streamed, tool-less completion — yields reasoning_delta / reasoning_done / delta / error.
 *  Use for the STREAMED final report. */
export function streamCompletion(p: CompletionParams): AsyncIterable<StreamEvent>;

/** Non-streaming, tool-less completion; never throws. Use for planning + per-source analysis. */
export function runCompletion(p: CompletionParams): Promise<{ content: string; error?: string }>;
```

### Web-tool call convention (Foundation — `web_search` / `web_fetch`)
The orchestrator invokes the web tools **programmatically**, not via the Agent loop:
`tool.invoke({}, JSON.stringify(args))` returns a JSON **string** to `JSON.parse`.
- `web_search` args `{ query, count, allowed_domains: null, blocked_domains: null }` →
  `{ ok: true, query, provider, results: { title, url, snippet }[], note? } | { ok: false, error }`.
- `web_fetch` args `{ url, prompt: null, maxChars, format: "markdown" | null }` →
  `{ ok: true, url, title?, content /* <web_content untrusted="true"> wrapped */, truncated, ... } | { ok: false, error, code }`.

Fetched `content` is **untrusted** page text — analysis prompts must treat it as data, never
instructions (same posture as the web tools in the README **Security posture** note).
